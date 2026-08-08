import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { writePsdBuffer, type Layer, type PixelData, type Psd } from 'ag-psd'
import sharp from 'sharp'
import {
  composeTextMaskFromRegions,
  mergeTextRegions,
  refineGlyphMaskInBox,
  type DetectedTextRegion
} from './ai/textRegions'
import {
  detectTextBoxesRemote as detectTextBoxes,
  inpaintImageRemote as inpaintImage,
  segmentSubjectRemote as segmentSubject
} from './ai/workerClient'

const execFileAsync = promisify(execFile)

type TextRegion = {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  text: string
}

type VisionAnalysis = {
  instanceCount: number
  textRegions: TextRegion[]
}

export type PsdProcessOptions = {
  writeLayerMasks: boolean
  subjectProtection: boolean
}

// ai：抠图与背景修复均由本地 AI 模型完成；mixed：部分环节回退；compat：全部走 Vision + 插值旧管线
export type PsdEngine = 'ai' | 'mixed' | 'compat'

export type PsdProcessResult = {
  path: string
  width: number
  height: number
  size: number
  layerNames: string[]
  textRegionCount: number
  instanceCount: number
  engine: PsdEngine
}

function safeName(value: string): string {
  return value.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product-image'
}

export async function uniquePsdPath(directory: string, sourceName: string): Promise<string> {
  const base = `${safeName(path.basename(sourceName, path.extname(sourceName)))}-layered`
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index ? `-${index + 1}` : ''
    const candidate = path.join(directory, `${base}${suffix}.psd`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(directory, `${base}-${Date.now()}.psd`)
}

function rgbaPixelData(data: Buffer | Uint8Array | Uint8ClampedArray, width: number, height: number): PixelData {
  return { data: new Uint8ClampedArray(data), width, height }
}

function maskPixelData(mask: Uint8Array, width: number, height: number): PixelData {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    rgba[offset] = mask[index]
    rgba[offset + 1] = mask[index]
    rgba[offset + 2] = mask[index]
    rgba[offset + 3] = 255
  }
  return { data: rgba, width, height }
}

function applyAlpha(source: Uint8Array, mask: Uint8Array): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length)
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    output[offset] = source[offset]
    output[offset + 1] = source[offset + 1]
    output[offset + 2] = source[offset + 2]
    output[offset + 3] = Math.round((source[offset + 3] * mask[index]) / 255)
  }
  return output
}

function blend(source: Uint8Array, replacement: Uint8Array, mask: Uint8Array): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length)
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    const amount = mask[index] / 255
    const keep = 1 - amount
    output[offset] = Math.round(source[offset] * keep + replacement[offset] * amount)
    output[offset + 1] = Math.round(source[offset + 1] * keep + replacement[offset + 1] * amount)
    output[offset + 2] = Math.round(source[offset + 2] * keep + replacement[offset + 2] * amount)
    output[offset + 3] = 255
  }
  return output
}

function directionalBackgroundFill(source: Uint8Array, mask: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const pixelCount = width * height
  const left = new Int32Array(pixelCount)
  const right = new Int32Array(pixelCount)
  const top = new Int32Array(pixelCount)
  const bottom = new Int32Array(pixelCount)
  left.fill(-1)
  right.fill(-1)
  top.fill(-1)
  bottom.fill(-1)
  for (let y = 0; y < height; y += 1) {
    let nearest = -1
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (mask[index] < 128) nearest = index
      left[index] = nearest
    }
    nearest = -1
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x
      if (mask[index] < 128) nearest = index
      right[index] = nearest
    }
  }
  for (let x = 0; x < width; x += 1) {
    let nearest = -1
    for (let y = 0; y < height; y += 1) {
      const index = y * width + x
      if (mask[index] < 128) nearest = index
      top[index] = nearest
    }
    nearest = -1
    for (let y = height - 1; y >= 0; y -= 1) {
      const index = y * width + x
      if (mask[index] < 128) nearest = index
      bottom[index] = nearest
    }
  }
  const output = new Uint8ClampedArray(source.length)
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    if (mask[index] < 128) {
      output[offset] = source[offset]
      output[offset + 1] = source[offset + 1]
      output[offset + 2] = source[offset + 2]
      output[offset + 3] = 255
      continue
    }
    const x = index % width
    const y = Math.floor(index / width)
    const horizontal = left[index] >= 0 && right[index] >= 0
    const vertical = top[index] >= 0 && bottom[index] >= 0
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0
      let weight = 0
      if (horizontal) {
        const leftX = left[index] % width
        const rightX = right[index] % width
        const amount = rightX === leftX ? 0 : (x - leftX) / (rightX - leftX)
        sum += source[left[index] * 4 + channel] * (1 - amount) + source[right[index] * 4 + channel] * amount
        weight += 1
      }
      if (vertical) {
        const topY = Math.floor(top[index] / width)
        const bottomY = Math.floor(bottom[index] / width)
        const amount = bottomY === topY ? 0 : (y - topY) / (bottomY - topY)
        sum += source[top[index] * 4 + channel] * (1 - amount) + source[bottom[index] * 4 + channel] * amount
        weight += 1
      }
      const fallback = left[index] >= 0 ? left[index] : right[index] >= 0 ? right[index] : top[index] >= 0 ? top[index] : bottom[index]
      output[offset + channel] = weight ? Math.round(sum / weight) : source[Math.max(0, fallback) * 4 + channel]
    }
    output[offset + 3] = 255
  }
  return output
}

const MAX_TEXT_BLOCKS = 40

type PixelBox = { left: number; top: number; right: number; bottom: number }
/** preserve=设计字整框保真；glyph=印刷小字精抠 */
type TextKeepMode = 'preserve' | 'glyph'

function usableTextRegions(regions: TextRegion[]): TextRegion[] {
  const filtered = regions.filter((region) => {
    const area = region.width * region.height
    if (area <= 0 || area > 0.35) return false
    if (region.confidence < 0.18) return false
    return true
  })
  // 合并横向相邻/重叠框（大标题常被 det 拆成多块导致「裁少」）
  const merged = mergeNearbyTextRegions(filtered)
  return merged.slice(0, MAX_TEXT_BLOCKS)
}

/** 合并几乎同一行、水平相接或重叠的文字框 */
function mergeNearbyTextRegions(regions: TextRegion[]): TextRegion[] {
  if (regions.length <= 1) return regions
  const items = regions.map((r) => ({ ...r }))
  items.sort((a, b) => (Math.abs(a.y - b.y) < 0.02 ? a.x - b.x : a.y - b.y))
  const out: TextRegion[] = []
  for (const cur of items) {
    const prev = out[out.length - 1]
    if (!prev) {
      out.push(cur)
      continue
    }
    const sameRow = Math.abs(prev.y + prev.height / 2 - (cur.y + cur.height / 2)) < Math.max(prev.height, cur.height) * 0.55
    const prevRight = prev.x + prev.width
    const gap = cur.x - prevRight
    const closeX = gap < Math.max(prev.width, cur.width) * 0.35 && gap > -Math.min(prev.width, cur.width)
    const overlap =
      Math.max(0, Math.min(prevRight, cur.x + cur.width) - Math.max(prev.x, cur.x)) >
      Math.min(prev.width, cur.width) * 0.15
    if (sameRow && (closeX || overlap)) {
      const left = Math.min(prev.x, cur.x)
      const top = Math.min(prev.y, cur.y)
      const right = Math.max(prev.x + prev.width, cur.x + cur.width)
      const bottom = Math.max(prev.y + prev.height, cur.y + cur.height)
      prev.x = left
      prev.y = top
      prev.width = right - left
      prev.height = bottom - top
      prev.confidence = Math.max(prev.confidence, cur.confidence)
      if (cur.text && prev.text && !prev.text.includes(cur.text)) prev.text = `${prev.text}${cur.text}`
      else if (cur.text && !prev.text) prev.text = cur.text
    } else {
      out.push(cur)
    }
  }
  return out
}

function regionBox(region: TextRegion, width: number, height: number, padScale = 1): PixelBox {
  // 适度外扩：保证 3D 描边/麦穗，但禁止扩到吞身体（padScale 3 已实测翻车）
  const base = Math.max(3, Math.round(Math.min(width, height) * 0.006 * padScale))
  const textH = Math.max(1, region.height * height)
  const textW = Math.max(1, region.width * width)
  const padX = Math.max(base, Math.round(textW * 0.05 * padScale), Math.round(textH * 0.08 * padScale))
  const padY = Math.max(base, Math.round(textH * 0.14 * padScale), Math.round(textW * 0.03 * padScale))
  return {
    left: Math.max(0, Math.floor(region.x * width) - padX),
    top: Math.max(0, Math.floor(region.y * height) - padY),
    right: Math.min(width, Math.ceil((region.x + region.width) * width) + padX),
    bottom: Math.min(height, Math.ceil((region.y + region.height) * height) + padY)
  }
}

/** 文字层禁止带上人体：框与主体重叠时扣掉主体核 */
function clipGlyphAgainstSubject(
  glyph: Uint8Array,
  box: PixelBox,
  subjectMask: Uint8Array,
  width: number
): Uint8Array {
  const boxW = box.right - box.left
  const boxH = box.bottom - box.top
  if (glyph.length !== boxW * boxH) return glyph
  const out = new Uint8Array(glyph)
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const si = (box.top + y) * width + (box.left + x)
      const s = subjectMask[si]
      if (s < 40) continue
      const gi = y * boxW + x
      // 主体实心处彻底清掉，边缘按比例衰减
      if (s >= 140) out[gi] = 0
      else out[gi] = Math.round((out[gi] * (255 - s)) / 255)
    }
  }
  return out
}

/** 是否几乎整框实心（整框保真回退） */
function isNearlySolidGlyph(glyph: Uint8Array): boolean {
  let solid = 0
  for (const v of glyph) if (v >= 200) solid += 1
  return solid / Math.max(1, glyph.length) > 0.82
}

/** 文字框与主体 mask 的重叠比例（主体像素 / 框面积） */
function subjectOverlapRatio(box: PixelBox, subjectMask: Uint8Array, width: number): number {
  const boxW = box.right - box.left
  const boxH = box.bottom - box.top
  if (boxW <= 0 || boxH <= 0) return 0
  let subject = 0
  let total = 0
  for (let y = box.top; y < box.bottom; y += 1) {
    for (let x = box.left; x < box.right; x += 1) {
      total += 1
      if (subjectMask[y * width + x] >= 128) subject += 1
    }
  }
  return total > 0 ? subject / total : 0
}

/**
 * 方案 C 分类：
 * - 大标题/条幅且与主体重叠不高 → preserve（整框原图像素，主体不硬减）
 * - 小印刷字或压在人身上 → glyph（精抠并从主体扣除）
 */
function classifyTextKeepMode(
  region: TextRegion,
  box: PixelBox,
  subjectMask: Uint8Array,
  width: number,
  hasSubject: boolean
): TextKeepMode {
  const overlap = hasSubject ? subjectOverlapRatio(box, subjectMask, width) : 0
  const relH = region.height
  const relW = region.width
  const area = relH * relW
  // 大号设计字 / 主标题
  if (relH >= 0.032 || area >= 0.018) {
    if (overlap < 0.38) return 'preserve'
  }
  // 中等条幅、角标（与人不重叠）
  if ((relH >= 0.016 || relW >= 0.12 || area >= 0.006) && overlap < 0.22) {
    return 'preserve'
  }
  // 压在人身上的字：仍精抠并尽量从主体扣除
  if (overlap >= 0.45) return 'glyph'
  // 很小的印刷字
  return 'glyph'
}

/** 整框保真：近乎不透明 + 极轻边缘羽化，保留 3D 金字高光/投影 */
function preserveRectGlyph(boxW: number, boxH: number): Uint8Array {
  const mask = new Uint8Array(boxW * boxH).fill(255)
  const feather = Math.max(1, Math.min(6, Math.round(Math.min(boxW, boxH) * 0.02)))
  if (feather <= 1) return mask
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const edge = Math.min(x, y, boxW - 1 - x, boxH - 1 - y)
      if (edge >= feather) continue
      const t = edge / feather
      mask[y * boxW + x] = Math.max(200, Math.round(255 * (0.55 + 0.45 * t)))
    }
  }
  return mask
}

/**
 * 大标题金字去底（宁可多留、不可裁少）：
 * 放宽金色/高光保留，再膨胀 2px 保住描边投影；
 * 覆盖异常则返回 null，上层回退整框（整框宁可带底，也不裁字）。
 */
function goldTitleMatte(sourceRgba: Uint8Array, imageWidth: number, box: PixelBox): Uint8Array | null {
  const boxW = box.right - box.left
  const boxH = box.bottom - box.top
  if (boxW < 12 || boxH < 12) return null
  const mask = new Uint8Array(boxW * boxH)
  const ring = Math.max(2, Math.round(Math.min(boxW, boxH) * 0.05))
  let bgR = 0
  let bgG = 0
  let bgB = 0
  let bgN = 0
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      if (x >= ring && y >= ring && x < boxW - ring && y < boxH - ring) continue
      const o = ((box.top + y) * imageWidth + (box.left + x)) * 4
      bgR += sourceRgba[o]
      bgG += sourceRgba[o + 1]
      bgB += sourceRgba[o + 2]
      bgN += 1
    }
  }
  if (bgN < 8) return null
  bgR /= bgN
  bgG /= bgN
  bgB /= bgN
  const bgLum = bgR * 0.2126 + bgG * 0.7152 + bgB * 0.0722
  if (bgLum > 155) return null

  let kept = 0
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const o = ((box.top + y) * imageWidth + (box.left + x)) * 4
      const r = sourceRgba[o]
      const g = sourceRgba[o + 1]
      const b = sourceRgba[o + 2]
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722
      const dist = Math.hypot(r - bgR, g - bgG, b - bgB)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max - min
      // 放宽：浅金、暗金描边、高光都尽量留
      const goldish = r >= 95 && g >= 60 && r - b >= 18 && sat >= 14 && lum >= 55
      const warmBright = lum > bgLum + 18 && r >= g && r - b >= 10
      let alpha = 0
      if (goldish) {
        alpha = Math.min(255, Math.round(160 + dist * 1.2))
      } else if (warmBright && dist > 22) {
        alpha = Math.min(255, Math.round(((dist - 14) / 55) * 255))
      } else if (dist > 40 && lum > bgLum + 12) {
        alpha = Math.min(255, Math.round(((dist - 28) / 70) * 230))
      }
      if (alpha < 20) alpha = 0
      mask[y * boxW + x] = alpha
      if (alpha >= 70) kept += 1
    }
  }
  const cov = kept / (boxW * boxH)
  // 太少=裁少丢字；太多=几乎没去底，整框更稳
  if (cov < 0.06 || cov > 0.78) return null

  // 膨胀 2 次：宁可多一点半透明边，也不要裁掉 3D 投影/麦穗尖
  let grown = morphMask(mask, boxW, boxH, 2, true)
  grown = morphMask(grown, boxW, boxH, 1, true)
  for (let i = 0; i < grown.length; i += 1) {
    if (mask[i] >= 30) grown[i] = Math.max(grown[i], Math.min(255, mask[i] + 20))
    else if (grown[i] < 36) grown[i] = 0
    else grown[i] = Math.min(255, grown[i])
  }
  // 边缘若仍大片接近 0，说明框内字被裁飞，放弃 matte
  let edgeKept = 0
  let edgeTotal = 0
  const band = Math.max(2, Math.round(Math.min(boxW, boxH) * 0.08))
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const onEdge = x < band || y < band || x >= boxW - band || y >= boxH - band
      if (!onEdge) continue
      edgeTotal += 1
      if (grown[y * boxW + x] >= 60) edgeKept += 1
    }
  }
  // 边缘保留过少 → 字贴边被裁，回退整框
  if (edgeTotal > 0 && edgeKept / edgeTotal < 0.04) return null
  return grown
}

function createTextMask(regions: TextRegion[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (const region of regions) {
    const box = regionBox(region, width, height)
    for (let y = box.top; y < box.bottom; y += 1) mask.fill(255, y * width + box.left, y * width + box.right)
  }
  return mask
}

function cropRegion(source: Uint8Array, width: number, box: PixelBox): Uint8ClampedArray {
  const boxWidth = box.right - box.left
  const boxHeight = box.bottom - box.top
  const output = new Uint8ClampedArray(boxWidth * boxHeight * 4)
  for (let y = 0; y < boxHeight; y += 1) {
    const sourceStart = ((box.top + y) * width + box.left) * 4
    output.set(source.subarray(sourceStart, sourceStart + boxWidth * 4), y * boxWidth * 4)
  }
  return output
}

// 可分离 min/max 形态学滤波：takeMax=false 腐蚀（取邻域最小），takeMax=true 膨胀（取邻域最大）
function morphMask(mask: Uint8ClampedArray | Uint8Array, width: number, height: number, radius: number, takeMax: boolean): Uint8Array {
  const pick = takeMax ? Math.max : Math.min
  const horizontal = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = mask[y * width + x]
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sx = x + dx
        if (sx < 0 || sx >= width) continue
        value = pick(value, mask[y * width + sx])
      }
      horizontal[y * width + x] = value
    }
  }
  const output = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = horizontal[y * width + x]
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = y + dy
        if (sy < 0 || sy >= height) continue
        value = pick(value, horizontal[sy * width + x])
      }
      output[y * width + x] = value
    }
  }
  return output
}

// 横竖两轴分别做已知背景插值，逐像素取与实际颜色更接近的估计。
// 贯穿文字块的竖/横装饰线在其延伸方向上会被对应轴命中，从而正确归为背景；字形两轴都对不上、得以保留。
function bestAxisBackgroundEstimate(source: Uint8Array, mask: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const pixelCount = width * height
  const nearest = { left: new Int32Array(pixelCount), right: new Int32Array(pixelCount), top: new Int32Array(pixelCount), bottom: new Int32Array(pixelCount) }
  nearest.left.fill(-1)
  nearest.right.fill(-1)
  nearest.top.fill(-1)
  nearest.bottom.fill(-1)
  for (let y = 0; y < height; y += 1) {
    let known = -1
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (mask[index] < 128) known = index
      nearest.left[index] = known
    }
    known = -1
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x
      if (mask[index] < 128) known = index
      nearest.right[index] = known
    }
  }
  for (let x = 0; x < width; x += 1) {
    let known = -1
    for (let y = 0; y < height; y += 1) {
      const index = y * width + x
      if (mask[index] < 128) known = index
      nearest.top[index] = known
    }
    known = -1
    for (let y = height - 1; y >= 0; y -= 1) {
      const index = y * width + x
      if (mask[index] < 128) known = index
      nearest.bottom[index] = known
    }
  }
  const output = new Uint8ClampedArray(source.length)
  const estimate = [0, 0, 0]
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    if (mask[index] < 128) {
      output.set(source.subarray(offset, offset + 4), offset)
      continue
    }
    const x = index % width
    const y = Math.floor(index / width)
    let bestDistance = Number.POSITIVE_INFINITY
    let found = false
    const consider = (fromIndex: number, toIndex: number, position: number, fromPosition: number, toPosition: number): void => {
      if (fromIndex < 0 || toIndex < 0) return
      const amount = toPosition === fromPosition ? 0 : (position - fromPosition) / (toPosition - fromPosition)
      let distance = 0
      for (let channel = 0; channel < 3; channel += 1) {
        estimate[channel] = source[fromIndex * 4 + channel] * (1 - amount) + source[toIndex * 4 + channel] * amount
        distance += (source[offset + channel] - estimate[channel]) ** 2
      }
      if (distance < bestDistance) {
        bestDistance = distance
        output[offset] = Math.round(estimate[0])
        output[offset + 1] = Math.round(estimate[1])
        output[offset + 2] = Math.round(estimate[2])
        found = true
      }
    }
    consider(nearest.left[index], nearest.right[index], x, nearest.left[index] >= 0 ? nearest.left[index] % width : 0, nearest.right[index] >= 0 ? nearest.right[index] % width : 0)
    consider(nearest.top[index], nearest.bottom[index], y, nearest.top[index] >= 0 ? Math.floor(nearest.top[index] / width) : 0, nearest.bottom[index] >= 0 ? Math.floor(nearest.bottom[index] / width) : 0)
    if (!found) {
      const fallback = nearest.left[index] >= 0 ? nearest.left[index] : nearest.right[index] >= 0 ? nearest.right[index] : nearest.top[index] >= 0 ? nearest.top[index] : Math.max(0, nearest.bottom[index])
      output[offset] = source[fallback * 4]
      output[offset + 1] = source[fallback * 4 + 1]
      output[offset + 2] = source[fallback * 4 + 2]
    }
    output[offset + 3] = 255
  }
  return output
}

// 以块边缘为已知背景做方向插值，按逐像素色距生成字形级 alpha；
// 能同时处理背景渐变和穿过文字块的光束。估计失败时退回整块矩形。
async function applyGlyphMatte(pixels: Uint8ClampedArray, boxWidth: number, boxHeight: number): Promise<boolean> {
  const ring = Math.max(2, Math.round(Math.min(boxWidth, boxHeight) * 0.04))
  if (boxWidth <= ring * 2 + 2 || boxHeight <= ring * 2 + 2) return false
  const interiorMask = new Uint8Array(boxWidth * boxHeight).fill(255)
  for (let y = 0; y < boxHeight; y += 1) {
    if (y < ring || y >= boxHeight - ring) {
      interiorMask.fill(0, y * boxWidth, (y + 1) * boxWidth)
      continue
    }
    interiorMask.fill(0, y * boxWidth, y * boxWidth + ring)
    interiorMask.fill(0, (y + 1) * boxWidth - ring, (y + 1) * boxWidth)
  }
  const computeAlphas = (background: Uint8ClampedArray): Uint8ClampedArray => {
    // 更敏感：3D 金字高光/描边与暖色背景差有时不大，过严会丢笔划
    const rampStart = 18
    const rampEnd = 64
    const output = new Uint8ClampedArray(boxWidth * boxHeight)
    for (let index = 0; index < output.length; index += 1) {
      const offset = index * 4
      const distance = Math.sqrt(
        (pixels[offset] - background[offset]) ** 2 +
          (pixels[offset + 1] - background[offset + 1]) ** 2 +
          (pixels[offset + 2] - background[offset + 2]) ** 2
      )
      output[index] = Math.round(Math.max(0, Math.min(1, (distance - rampStart) / (rampEnd - rampStart))) * 255)
    }
    return output
  }
  const source = new Uint8Array(pixels)
  const firstAlphas = computeAlphas(bestAxisBackgroundEstimate(source, interiorMask, boxWidth, boxHeight))
  // 自举细化：第一遍判定为背景的像素成为新的已知源，重新插值可消除穿过字形的估计误差条带
  const refineMask = new Uint8Array(boxWidth * boxHeight)
  for (let index = 0; index < refineMask.length; index += 1) {
    refineMask[index] = firstAlphas[index] < 64 ? 0 : 255
  }
  const alphas = computeAlphas(bestAxisBackgroundEstimate(source, refineMask, boxWidth, boxHeight))
  // 大文字块里背景自带的细装饰线和光效残留会被误判为字形：
  // 开运算重建门控清除细线（半径随块高缩放），gamma 压制大面积中等透明度的雾状噪声
  if (boxHeight >= 160) {
    const radius = Math.max(2, Math.min(5, Math.round(boxHeight / 130)))
    const eroded = morphMask(alphas, boxWidth, boxHeight, radius, false)
    const survivors = morphMask(eroded, boxWidth, boxHeight, radius + 3, true)
    for (let index = 0; index < alphas.length; index += 1) {
      if (survivors[index] < 32) {
        alphas[index] = 0
        continue
      }
      const gamma = Math.round(255 * Math.pow(alphas[index] / 255, 1.8))
      alphas[index] = gamma < 24 ? 0 : gamma
    }
  }
  let covered = 0
  for (let index = 0; index < alphas.length; index += 1) {
    if (alphas[index] >= 128) covered += 1
  }
  const coverage = covered / alphas.length
  if (coverage > 0.85 || coverage < 0.002) return false
  for (let index = 0; index < alphas.length; index += 1) {
    const offset = index * 4
    pixels[offset + 3] = Math.round((pixels[offset + 3] * alphas[index]) / 255)
  }
  return true
}

function glyphMainColor(pixels: Uint8ClampedArray): { r: number; g: number; b: number } {
  let weight = 0
  let red = 0
  let green = 0
  let blue = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]
    if (alpha < 128) continue
    weight += alpha
    red += pixels[offset] * alpha
    green += pixels[offset + 1] * alpha
    blue += pixels[offset + 2] * alpha
  }
  if (!weight) return { r: 30, g: 30, b: 30 }
  return { r: Math.round(red / weight), g: Math.round(green / weight), b: Math.round(blue / weight) }
}

// 每个文字块一组：可编辑文本图层（默认隐藏）+ 原样式像素图层
async function buildTextBlockGroup(
  source: Uint8Array,
  width: number,
  height: number,
  region: TextRegion,
  glyphMask: Uint8Array | undefined,
  mode: TextKeepMode,
  box: PixelBox
): Promise<Layer> {
  const boxWidth = box.right - box.left
  const boxHeight = box.bottom - box.top
  const pixels = cropRegion(source, width, box)
  if (mode === 'preserve') {
    // 方案 C：设计字整框原图像素，仅极轻羽化，不做阈值抠字
    const keep = glyphMask && glyphMask.length === boxWidth * boxHeight ? glyphMask : preserveRectGlyph(boxWidth, boxHeight)
    for (let index = 0; index < keep.length; index += 1) {
      const offset = index * 4
      pixels[offset + 3] = Math.round((pixels[offset + 3] * keep[index]) / 255)
    }
  } else if (glyphMask && glyphMask.length === boxWidth * boxHeight) {
    for (let index = 0; index < glyphMask.length; index += 1) {
      const offset = index * 4
      pixels[offset + 3] = Math.round((pixels[offset + 3] * glyphMask[index]) / 255)
    }
  } else {
    await applyGlyphMatte(pixels, boxWidth, boxHeight)
  }
  const textHeight = region.height * height
  const trimmedText = region.text.trim() || 'Text'
  const label = trimmedText.length > 12 ? `${trimmedText.slice(0, 12)}…` : trimmedText
  const modeTag = mode === 'preserve' ? 'Preserve frame' : 'Glyph cutout'
  const editableLayer: Layer = {
    name: 'Editable text',
    hidden: true,
    text: {
      text: trimmedText === 'Text' ? '' : trimmedText,
      transform: [1, 0, 0, 1, region.x * width, region.y * height + textHeight * 0.85],
      style: {
        font: { name: 'PingFangSC-Regular' },
        fontSize: Math.max(8, Math.round(textHeight * 0.8)),
        fillColor: glyphMainColor(pixels)
      }
    }
  }
  const pixelLayer: Layer = {
    name: 'Original style',
    top: box.top,
    left: box.left,
    right: box.right,
    bottom: box.bottom,
    imageData: { data: pixels, width: boxWidth, height: boxHeight },
    transparencyProtected: true
  }
  return { name: `Text · ${modeTag} · ${label}`, opened: false, children: [editableLayer, pixelLayer] }
}

function createDecorationMask(source: Uint8Array, textMask: Uint8Array): Uint8Array {
  const mask = new Uint8Array(textMask.length)
  for (let index = 0; index < textMask.length; index += 1) {
    if (textMask[index] >= 128) continue
    const offset = index * 4
    const red = source[offset]
    const green = source[offset + 1]
    const blue = source[offset + 2]
    const maximum = Math.max(red, green, blue)
    const minimum = Math.min(red, green, blue)
    const saturation = maximum - minimum
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
    const brightColor = maximum > 205 && saturation > 38
    const goldAccent = red > 145 && green > 90 && blue < 145 && red - blue > 45
    const lightAccent = luminance > 225 && saturation > 18
    if (brightColor || goldAccent || lightAccent) mask[index] = 230
  }
  return mask
}

function createRepairArea(mask: Uint8Array, width: number, height: number): Uint8Array {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] < 128) continue
    const x = index % width
    const y = Math.floor(index / width)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (maxX < minX || maxY < minY) return mask
  const padding = Math.max(10, Math.round(Math.min(width, height) * 0.035))
  minX = Math.max(0, minX - padding)
  minY = Math.max(0, minY - padding)
  maxX = Math.min(width - 1, maxX + padding)
  maxY = Math.min(height - 1, maxY + padding)
  const output = new Uint8Array(mask.length)
  for (let y = minY; y <= maxY; y += 1) output.fill(255, y * width + minX, y * width + maxX + 1)
  return output
}

/** sharp erode(亮) = 膨胀亮区；用于人体挖洞外扩 */
async function expandBrightMask(mask: Uint8Array, width: number, height: number, radius: number): Promise<Uint8Array> {
  const r = Math.max(1, Math.min(64, Math.round(radius)))
  const binary = Buffer.alloc(mask.length)
  for (let index = 0; index < mask.length; index += 1) binary[index] = mask[index] >= 40 ? 255 : 0
  const { data, info } = await sharp(binary, { raw: { width, height, channels: 1 } })
    .erode(r)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 1 || data.length !== width * height) throw new Error('Mask expansion failed')
  return new Uint8Array(data)
}

/**
 * 主体 alpha 轻量精修（绝不改 RGB）：
 * 1) 小孔闭合  2) 去白边：半透明 + 高亮像素收紧 alpha（白衣/深底经典毛边）
 * 3) 边缘 1px 轻腐蚀再极轻羽化
 * 禁止颜色去污染（会造描边）。
 */
async function refineSubjectAlpha(
  source: Uint8Array,
  alpha: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array> {
  // 闭运算稍强，补裙摆/袖口小洞（单开主体时透出棋盘格）
  const closeR = Math.max(2, Math.min(5, Math.round(Math.min(width, height) * 0.0035)))
  let work = morphMask(alpha, width, height, closeR, true)
  work = morphMask(work, width, height, closeR, false)

  // 去白边：半透明边缘若偏亮，按亮度加大透明度衰减（等价 PS Remove White Matte 的 alpha 侧）
  const cleaned = new Uint8Array(work.length)
  for (let index = 0; index < work.length; index += 1) {
    let a = work[index]
    if (a < 16) {
      cleaned[index] = 0
      continue
    }
    if (a > 248) {
      cleaned[index] = 255
      continue
    }
    const o = index * 4
    const lum = source[o] * 0.2126 + source[o + 1] * 0.7152 + source[o + 2] * 0.0722
    // 越亮 + alpha 越中间 → 越像白毛边，alpha 收得越狠
    if (lum > 165 && a < 230) {
      const bright = Math.min(1, (lum - 165) / 70)
      const mid = 1 - Math.abs(a - 128) / 128
      const cut = 0.35 + bright * 0.55 * (0.4 + mid * 0.6)
      a = Math.round(a * (1 - cut))
    } else if (lum > 140 && a < 100) {
      // 更外侧的淡白雾直接清掉
      a = Math.round(a * 0.35)
    }
    cleaned[index] = a < 14 ? 0 : a
  }

  // 1px 腐蚀：吃掉最外圈毛边（商业人像白衣优先干净轮廓，发丝损失可接受）
  const eroded = morphMask(cleaned, width, height, 1, false)

  try {
    const soft = await blurMask(eroded, width, height, Math.max(0.3, Math.min(width, height) * 0.0007))
    for (let index = 0; index < soft.length; index += 1) {
      if (soft[index] < 16) soft[index] = 0
      else if (soft[index] > 250) soft[index] = 255
    }
    return soft
  } catch {
    return eroded
  }
}

/**
 * 写入主体层前再做一次去白边：半透明亮边 alpha 二次收紧，避免叠在深色干净背景上冒白描边。
 */
function defringeLayerAlpha(source: Uint8Array, mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask)
  for (let index = 0; index < mask.length; index += 1) {
    const a = mask[index]
    if (a <= 0 || a >= 250) continue
    const o = index * 4
    const lum = source[o] * 0.2126 + source[o + 1] * 0.7152 + source[o + 2] * 0.0722
    if (lum < 150) continue
    // 检查 4 邻是否有接近透明（外边缘）
    const x = index % width
    const y = Math.floor(index / width)
    let nearOut = false
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1]
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        nearOut = true
        break
      }
      if (mask[ny * width + nx] < 40) {
        nearOut = true
        break
      }
    }
    if (!nearOut) continue
    const t = Math.min(1, (lum - 150) / 80)
    out[index] = Math.round(a * (1 - 0.55 * t))
    if (out[index] < 12) out[index] = 0
  }
  return out
}

/**
 * 关主体后的「鬼影」评分：在主体核内，修复结果若仍接近原图人物色，说明补洞不干净。
 * 返回 0–1，越高残影越重。
 */
function measureSubjectGhost(
  clean: Uint8ClampedArray,
  source: Uint8Array,
  subjectMask: Uint8Array,
  width: number,
  height: number
): number {
  let samples = 0
  let residual = 0
  // 在主体外侧取背景色参考
  const ring = Math.max(8, Math.round(Math.min(width, height) * 0.02))
  let bgR = 0
  let bgG = 0
  let bgB = 0
  let bgN = 0
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const index = y * width + x
      if (subjectMask[index] >= 24) continue
      // 靠近主体的环带
      let near = false
      for (let dy = -ring; dy <= ring && !near; dy += ring) {
        for (let dx = -ring; dx <= ring; dx += ring) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          if (subjectMask[ny * width + nx] >= 96) near = true
        }
      }
      if (!near) continue
      const o = index * 4
      bgR += clean[o]
      bgG += clean[o + 1]
      bgB += clean[o + 2]
      bgN += 1
    }
  }
  if (bgN < 8) {
    bgR = 40
    bgG = 30
    bgB = 25
  } else {
    bgR /= bgN
    bgG /= bgN
    bgB /= bgN
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = y * width + x
      if (subjectMask[index] < 96) continue
      const o = index * 4
      // 修复后仍接近原图像素 → 人物没抹干净
      const dSrc = Math.hypot(clean[o] - source[o], clean[o + 1] - source[o + 1], clean[o + 2] - source[o + 2])
      // 修复后远离环带背景 → 也像残留结构
      const dBg = Math.hypot(clean[o] - bgR, clean[o + 1] - bgG, clean[o + 2] - bgB)
      const score = Math.max(0, 1 - dSrc / 55) * 0.65 + Math.min(1, dBg / 80) * 0.35
      residual += score
      samples += 1
    }
  }
  return samples > 0 ? Math.min(1, residual / samples) : 0
}

/**
 * 道具层：只抠奖杯。
 * 策略：右下象限 + 高饱和实心金 + 开运算断开金流桥 + 按 fill 打分取 1 块。
 * 上几版失败主因：奖杯与底部金流粘连后 bbox 过宽/fill 过低被滤掉。
 */
async function extractSecondaryPropMask(
  source: Uint8Array,
  subjectMask: Uint8Array,
  textMask: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  const pixelCount = width * height
  const xStart = Math.floor(width * 0.28)
  const yStart = Math.floor(height * 0.5)

  // 主体硬核：不要缩太狠，奖杯在人脚边
  const core = new Uint8Array(pixelCount)
  for (let i = 0; i < pixelCount; i += 1) core[i] = subjectMask[i] >= 120 ? 255 : 0

  // 只在右下找亮金/铬（奖杯杯体），阈值偏高压掉淡金流
  const seed = new Uint8Array(pixelCount)
  for (let y = yStart; y < height; y += 1) {
    for (let x = xStart; x < width; x += 1) {
      const index = y * width + x
      if (core[index] >= 128) continue
      if (textMask[index] >= 100) continue
      const o = index * 4
      const r = source[o]
      const g = source[o + 1]
      const b = source[o + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max - min
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722
      const solidGold = r > 170 && g > 120 && b < 140 && r - b > 50 && sat > 50 && lum > 120
      const brightChrome = lum > 200 && sat < 45 && max > 210 && r > 180
      if (solidGold || brightChrome) seed[index] = 255
    }
  }

  // 先开运算断开细桥，再弱闭填杯体缝
  let closed: Uint8Array
  try {
    const opened = await sharp(Buffer.from(seed), { raw: { width, height, channels: 1 } })
      .dilate(2) // 缩亮=腐蚀
      .erode(2) // 扩亮
      .toColourspace('b-w')
      .raw()
      .toBuffer()
    const step = await sharp(opened, { raw: { width, height, channels: 1 } })
      .erode(2)
      .dilate(1)
      .toColourspace('b-w')
      .raw()
      .toBuffer()
    closed = new Uint8Array(step)
    for (let i = 0; i < pixelCount; i += 1) {
      if (core[i] >= 128 || textMask[i] >= 100) closed[i] = 0
    }
  } catch {
    closed = seed
  }

  const labels = new Int32Array(pixelCount).fill(-1)
  const qx = new Int32Array(pixelCount)
  const qy = new Int32Array(pixelCount)
  let bestId = -1
  let bestScore = -1
  let nextId = 0

  for (let y = yStart; y < height; y += 1) {
    for (let x = xStart; x < width; x += 1) {
      const start = y * width + x
      if (closed[start] < 128 || labels[start] >= 0) continue
      const id = nextId++
      let head = 0
      let tail = 0
      qx[tail] = x
      qy[tail] = y
      tail += 1
      labels[start] = id
      let area = 0
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      while (head < tail) {
        const cx = qx[head]
        const cy = qy[head]
        head += 1
        area += 1
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [nx, ny] of [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ] as const) {
          if (nx < xStart || ny < yStart || nx >= width || ny >= height) continue
          const nidx = ny * width + nx
          if (closed[nidx] < 128 || labels[nidx] >= 0) continue
          labels[nidx] = id
          qx[tail] = nx
          qy[tail] = ny
          tail += 1
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      const fill = area / Math.max(1, bw * bh)
      const rel = area / pixelCount
      if (area < pixelCount * 0.0025 || area > pixelCount * 0.1) continue
      if (bw < 20 || bh < 28) continue
      // 金流横条：很宽很扁
      if (bw > width * 0.5 && bh < bw * 0.55) continue
      if (fill < 0.12) continue
      const cy = (minY + maxY) / 2 / height
      const cx = (minX + maxX) / 2 / width
      if (cy < 0.55) continue
      // 奖杯：fill 高、偏竖、偏右下
      let score = fill * 4 + Math.min(1.5, rel / 0.025) + (cy - 0.55) * 2
      if (cx > 0.4) score += 0.5
      if (bh >= bw * 0.7) score += 0.8
      if (bh / Math.max(1, bw) > 0.85 && bh / Math.max(1, bw) < 1.9) score += 0.5
      if (score > bestScore) {
        bestScore = score
        bestId = id
      }
    }
  }

  if (bestId < 0 || bestScore < 0.9) return null

  const mask = new Uint8Array(pixelCount)
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === bestId) mask[i] = 255
  }

  try {
    // 小外扩包住杯耳，再开一次去掉粘丝
    let grown = await expandBrightMask(mask, width, height, Math.max(2, Math.round(Math.min(width, height) * 0.003)))
    for (let i = 0; i < grown.length; i += 1) {
      if (core[i] >= 128 || textMask[i] >= 100) grown[i] = 0
    }
    grown = morphMask(grown, width, height, 1, false)
    grown = morphMask(grown, width, height, 2, true)
    const soft = await blurMask(grown, width, height, Math.max(0.4, Math.min(width, height) * 0.0015))
    for (let i = 0; i < soft.length; i += 1) {
      soft[i] = soft[i] >= 40 ? Math.min(255, Math.round(soft[i] * 1.1)) : 0
    }
    let on = 0
    for (const v of soft) if (v >= 64) on += 1
    if (on < pixelCount * 0.002 || on > pixelCount * 0.1) return null
    return soft
  } catch {
    return mask
  }
}

/** 干净背景里近黑挖洞补丁：LaMa 有时把文字洞填成死黑，用周围色重填 */
function patchNearBlackHoles(
  clean: Uint8ClampedArray,
  holeHint: Uint8Array,
  width: number,
  height: number
): void {
  const fill = directionalBackgroundFill(new Uint8Array(clean), holeHint, width, height)
  for (let index = 0; index < holeHint.length; index += 1) {
    if (holeHint[index] < 40) continue
    const o = index * 4
    const lum = clean[o] * 0.2126 + clean[o + 1] * 0.7152 + clean[o + 2] * 0.0722
    // 异常死黑/死灰
    if (lum > 28) continue
    clean[o] = fill[o]
    clean[o + 1] = fill[o + 1]
    clean[o + 2] = fill[o + 2]
  }
}

async function blurMask(mask: Uint8Array, width: number, height: number, sigma: number): Promise<Uint8Array> {
  const output = await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } })
    .blur(Math.max(0.3, Math.min(100, sigma)))
    .greyscale()
    .raw()
    .toBuffer()
  return new Uint8Array(output)
}

function makeMaskLayer(mask: Uint8Array, width: number, height: number) {
  return {
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    defaultColor: 0,
    // 文档绝对坐标，避免 PS 按「相对图层」解读导致蒙版整体偏移
    positionRelativeToLayer: false,
    imageData: maskPixelData(mask, width, height)
  }
}

/** 将全图画布裁到 mask 外接矩形，返回裁切像素 + 放置坐标（防止全画布+双重蒙版偏移/叠影） */
function cropLayerToMask(
  sourceRgba: Uint8Array | Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number
): { pixels: Uint8ClampedArray; maskCrop: Uint8Array; box: PixelBox } | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] < 8) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return null
  // 轻微外扩 1px，避免裁切吃边
  minX = Math.max(0, minX - 1)
  minY = Math.max(0, minY - 1)
  maxX = Math.min(width - 1, maxX + 1)
  maxY = Math.min(height - 1, maxY + 1)
  const boxW = maxX - minX + 1
  const boxH = maxY - minY + 1
  const pixels = new Uint8ClampedArray(boxW * boxH * 4)
  const maskCrop = new Uint8Array(boxW * boxH)
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const srcIndex = (minY + y) * width + (minX + x)
      const dstIndex = y * boxW + x
      const so = srcIndex * 4
      const doff = dstIndex * 4
      const a = mask[srcIndex]
      maskCrop[dstIndex] = a
      pixels[doff] = sourceRgba[so]
      pixels[doff + 1] = sourceRgba[so + 1]
      pixels[doff + 2] = sourceRgba[so + 2]
      pixels[doff + 3] = Math.round((sourceRgba[so + 3] * a) / 255)
    }
  }
  return {
    pixels,
    maskCrop,
    box: { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 }
  }
}

function layer(
  name: string,
  pixels: Uint8Array | Uint8ClampedArray,
  mask: Uint8Array | null,
  width: number,
  height: number,
  writeLayerMasks: boolean,
  extra: Partial<Layer> = {}
): Layer {
  // 像素 alpha 已烘焙时不再写 PS 矢量蒙版，避免「双重蒙版」在部分 PS 版本里产生错位/发虚
  return {
    name,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    imageData: rgbaPixelData(pixels, width, height),
    ...extra
  }
}

/** 裁切后的图层：top/left 与 imageData 尺寸严格一致，杜绝偏移 */
function layerCropped(
  name: string,
  cropped: { pixels: Uint8ClampedArray; box: PixelBox },
  extra: Partial<Layer> = {}
): Layer {
  const boxW = cropped.box.right - cropped.box.left
  const boxH = cropped.box.bottom - cropped.box.top
  return {
    name,
    top: cropped.box.top,
    left: cropped.box.left,
    right: cropped.box.right,
    bottom: cropped.box.bottom,
    imageData: { data: cropped.pixels, width: boxW, height: boxH },
    ...extra
  }
}

async function runVision(helperPath: string, normalizedPath: string, maskPath: string, jsonPath: string): Promise<VisionAnalysis> {
  try {
    await execFileAsync(helperPath, [normalizedPath, maskPath, jsonPath], { timeout: 120_000, maxBuffer: 1024 * 1024 })
  } catch (error) {
    const message = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : ''
    throw new Error(message.trim() || 'Mac Vision subject detection failed')
  }
  const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as Partial<VisionAnalysis>
  return {
    instanceCount: Math.max(0, Number(parsed.instanceCount || 0)),
    textRegions: Array.isArray(parsed.textRegions) ? parsed.textRegions : []
  }
}

/** 半自动：用户笔刷修过的 mask 覆盖 AI 结果 */
export type PsdMaskOverrides = {
  subjectMask?: Uint8Array
  /** 显式传入（含全 0）表示跳过自动道具；undefined 表示仍自动提取 */
  propMask?: Uint8Array | null
}

export type PsdDraftResult = {
  draftId: string
  width: number
  height: number
  hasSubject: boolean
  hasProp: boolean
  sourceDataUrl: string
  subjectMaskDataUrl: string
  propMaskDataUrl: string
}

function maskToPngDataUrl(mask: Uint8Array, width: number, height: number): Promise<string> {
  return sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
    .then((buf) => `data:image/png;base64,${buf.toString('base64')}`)
}

/**
 * 半自动第一步：只跑主体/道具识别，产出可笔刷编辑的草稿（不做 LaMa / 不写 PSD）。
 */
export async function preparePsdDraft(input: {
  inputPath: string
  draftDirectory: string
  helperPath: string
  aiModelsDirectory: string
  options: PsdProcessOptions
  onProgress: (progress: number, stage: string) => void
}): Promise<PsdDraftResult> {
  const draftId = randomUUID()
  const draftDir = path.join(input.draftDirectory, draftId)
  await mkdir(draftDir, { recursive: true })
  const normalizedPath = path.join(draftDir, 'source.png')
  const visionMaskPath = path.join(draftDir, 'vision-mask.png')
  const jsonPath = path.join(draftDir, 'analysis.json')

  input.onProgress(8, 'Reading image')
  const normalized = sharp(input.inputPath, { limitInputPixels: 80_000_000 }).rotate().ensureAlpha()
  const metadata = await normalized.metadata()
  const width = Number(metadata.width || 0)
  const height = Number(metadata.height || 0)
  if (!width || !height) throw new Error('Unable to read image dimensions')
  if (width > 8000 || height > 8000) throw new Error('Images over 8000 pixels are not supported')
  await normalized.png().toFile(normalizedPath)

  input.onProgress(18, 'Mac Vision is detecting the subject (fallback pass)')
  const analysis = await runVision(input.helperPath, normalizedPath, visionMaskPath, jsonPath)
  const sourceResult = await sharp(normalizedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const source = new Uint8Array(sourceResult.data)

  let subjectMask: Uint8Array
  let hasSubject: boolean
  try {
    input.onProgress(35, 'AI is detecting the subject (BiRefNet)')
    const alpha = await segmentSubject({
      imagePath: normalizedPath,
      width,
      height,
      modelsDirectory: input.aiModelsDirectory
    })
    let covered = 0
    for (const value of alpha) if (value >= 128) covered += 1
    const coverage = covered / alpha.length
    hasSubject = coverage >= 0.002 && coverage <= 0.985
    subjectMask = hasSubject ? await refineSubjectAlpha(source, alpha, width, height) : alpha
  } catch (error) {
    console.warn('Draft subject segmentation failed; falling back to Vision:', error)
    const threshold = input.options.subjectProtection ? 36 : 72
    const subjectBuffer = await sharp(visionMaskPath)
      .resize(width, height, { fit: 'fill' })
      .greyscale()
      .blur(input.options.subjectProtection ? 0.55 : 0.9)
      .threshold(threshold)
      .raw()
      .toBuffer()
    subjectMask = new Uint8Array(subjectBuffer)
    let subjectPixelCount = 0
    for (const value of subjectMask) if (value >= 128) subjectPixelCount += 1
    hasSubject = analysis.instanceCount > 0 && subjectPixelCount > Math.max(64, subjectMask.length * 0.002)
  }

  // 草稿阶段文字 mask 仅用于道具排除（完整文字仍在导出时重检）
  let textMask = new Uint8Array(width * height)
  try {
    input.onProgress(50, 'AI is detecting text (excluded from prop layer)')
    const det = await detectTextBoxes({
      imagePath: normalizedPath,
      width,
      height,
      modelsDirectory: input.aiModelsDirectory
    })
    const visionRegions: DetectedTextRegion[] = analysis.textRegions.map((item) => ({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      confidence: item.confidence,
      text: item.text
    }))
    const regions = usableTextRegions(mergeTextRegions(det, visionRegions))
    textMask = new Uint8Array(createTextMask(regions, width, height))
  } catch {
    textMask = new Uint8Array(createTextMask([], width, height))
  }

  input.onProgress(70, 'Detecting props such as trophies')
  let propMask: Uint8Array | null = null
  try {
    propMask = await extractSecondaryPropMask(source, subjectMask, textMask, width, height)
  } catch {
    propMask = null
  }
  if (!propMask) propMask = new Uint8Array(width * height)

  // 主体与道具互斥：道具实心从主体扣掉，方便笔刷起点干净
  if (hasSubject) {
    for (let i = 0; i < subjectMask.length; i += 1) {
      if (propMask[i] >= 96) subjectMask[i] = Math.max(0, subjectMask[i] - propMask[i])
    }
  }

  const subjectPath = path.join(draftDir, 'subject-mask.png')
  const propPath = path.join(draftDir, 'prop-mask.png')
  await sharp(Buffer.from(subjectMask), { raw: { width, height, channels: 1 } }).png().toFile(subjectPath)
  await sharp(Buffer.from(propMask), { raw: { width, height, channels: 1 } }).png().toFile(propPath)
  await writeFile(
    path.join(draftDir, 'meta.json'),
    JSON.stringify({
      draftId,
      width,
      height,
      hasSubject,
      sourceName: path.basename(input.inputPath),
      options: input.options
    })
  )

  input.onProgress(100, 'Draft ready; refine the masks')
  let hasProp = false
  for (const v of propMask) {
    if (v >= 64) {
      hasProp = true
      break
    }
  }
  const sourcePng = await readFile(normalizedPath)
  return {
    draftId,
    width,
    height,
    hasSubject,
    hasProp,
    sourceDataUrl: `data:image/png;base64,${sourcePng.toString('base64')}`,
    subjectMaskDataUrl: await maskToPngDataUrl(subjectMask, width, height),
    propMaskDataUrl: await maskToPngDataUrl(propMask, width, height)
  }
}

export async function processImageToPsd(input: {
  inputPath: string
  outputPath: string
  helperPath: string
  aiModelsDirectory: string
  options: PsdProcessOptions
  onProgress: (progress: number, stage: string) => void
  /** 半自动：跳过 AI 主体，改用用户修过的 mask */
  maskOverrides?: PsdMaskOverrides
}): Promise<PsdProcessResult> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'psd-'))
  const normalizedPath = path.join(temporaryDirectory, 'source.png')
  const maskPath = path.join(temporaryDirectory, 'subject-mask.png')
  const jsonPath = path.join(temporaryDirectory, 'analysis.json')

  try {
    input.onProgress(8, 'Reading and correcting image')
    const normalized = sharp(input.inputPath, { limitInputPixels: 80_000_000 }).rotate().ensureAlpha()
    const metadata = await normalized.metadata()
    const width = Number(metadata.width || 0)
    const height = Number(metadata.height || 0)
    if (!width || !height) throw new Error('Unable to read image dimensions')
    if (width > 8000 || height > 8000) throw new Error('Images over 8000 pixels are not supported')
    await normalized.png().toFile(normalizedPath)

    input.onProgress(18, 'Mac Vision is detecting subject and text (fallback pass)')
    const analysis = await runVision(input.helperPath, normalizedPath, maskPath, jsonPath)

    const sourceResult = await sharp(normalizedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const source = new Uint8Array(sourceResult.data)

    // 首选 BiRefNet 软 alpha；半自动时用用户修过的主体 mask
    let subjectMask: Uint8Array
    let hasSubject: boolean
    let aiSegmented = false
    if (input.maskOverrides?.subjectMask && input.maskOverrides.subjectMask.length === width * height) {
      input.onProgress(30, 'Using refined subject mask')
      subjectMask = new Uint8Array(input.maskOverrides.subjectMask)
      let covered = 0
      for (const value of subjectMask) if (value >= 128) covered += 1
      const coverage = covered / subjectMask.length
      hasSubject = coverage >= 0.002 && coverage <= 0.985
      aiSegmented = true
    } else {
      try {
        input.onProgress(30, 'AI is refining subject detection (BiRefNet)')
        const alpha = await segmentSubject({
          imagePath: normalizedPath,
          width,
          height,
          modelsDirectory: input.aiModelsDirectory
        })
        let covered = 0
        for (const value of alpha) if (value >= 128) covered += 1
        const coverage = covered / alpha.length
        hasSubject = coverage >= 0.002 && coverage <= 0.985
        aiSegmented = true
        if (hasSubject) {
          input.onProgress(34, 'Refining subject edges')
          subjectMask = await refineSubjectAlpha(source, alpha, width, height)
        } else {
          subjectMask = alpha
        }
      } catch (error) {
        console.warn('AI subject segmentation failed; falling back to the Vision mask:', error)
        const threshold = input.options.subjectProtection ? 36 : 72
        const subjectBuffer = await sharp(maskPath)
          .resize(width, height, { fit: 'fill' })
          .greyscale()
          .blur(input.options.subjectProtection ? 0.55 : 0.9)
          .threshold(threshold)
          .raw()
          .toBuffer()
        subjectMask = new Uint8Array(subjectBuffer)
        let subjectPixelCount = 0
        for (const value of subjectMask) if (value >= 128) subjectPixelCount += 1
        hasSubject = analysis.instanceCount > 0 && subjectPixelCount > Math.max(64, subjectMask.length * 0.002)
      }
    }

    // PP-OCR det 主检文字 + Vision 补漏/贴 OCR 文案
    let detRegions: DetectedTextRegion[] = []
    try {
      input.onProgress(40, 'AI is detecting text regions (PP-OCR)')
      detRegions = await detectTextBoxes({
        imagePath: normalizedPath,
        width,
        height,
        modelsDirectory: input.aiModelsDirectory
      })
    } catch (error) {
      console.warn('PP-OCR text detection failed; using Vision only:', error)
    }
    const visionRegions: DetectedTextRegion[] = analysis.textRegions.map((item) => ({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      confidence: item.confidence,
      text: item.text
    }))
    const mergedRegions = usableTextRegions(mergeTextRegions(detRegions, visionRegions))
    const textRegions: TextRegion[] = mergedRegions.map((item) => ({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      confidence: item.confidence,
      text: item.text
    }))

    // 方案 C：大标题 → 金字去底优先，失败整框；框不可过大；文字层强制扣人体
    input.onProgress(48, 'Classifying text (gold matte / frame preserve / glyph cutout)')
    type PreparedText = {
      region: TextRegion
      box: PixelBox
      digBox: PixelBox
      mode: TextKeepMode
      glyph: Uint8Array
      digGlyph: Uint8Array
    }
    const preparedTexts: PreparedText[] = []
    for (const region of textRegions) {
      const modeProbeBox = regionBox(region, width, height, 1)
      const mode = classifyTextKeepMode(region, modeProbeBox, subjectMask, width, hasSubject)
      // 显示框：适度外扩（2.0）；挖洞框更紧，避免干净背景留下大黑块
      const box = regionBox(region, width, height, mode === 'preserve' ? 2.0 : 1.35)
      const digBox = regionBox(region, width, height, mode === 'preserve' ? 1.35 : 1.15)
      const boxW = box.right - box.left
      const boxH = box.bottom - box.top
      let glyph: Uint8Array
      if (mode === 'preserve') {
        const gold = goldTitleMatte(source, width, box)
        glyph = gold && gold.length === boxW * boxH ? gold : preserveRectGlyph(boxW, boxH)
      } else {
        try {
          glyph = await refineGlyphMaskInBox({ sourceRgba: source, imageWidth: width, box })
          glyph = morphMask(glyph, boxW, boxH, 1, true)
        } catch {
          glyph = new Uint8Array(boxW * boxH).fill(200)
        }
      }
      // 关键：文字层绝不吞身体（上一版框过大把白西装带进文字层）
      if (hasSubject) {
        glyph = clipGlyphAgainstSubject(glyph, box, subjectMask, width)
      }

      // 挖洞 mask：有字形用字形（略膨胀）；整框实心则用更紧的 digBox 实心，禁止超大矩形挖黑坑
      let digGlyph: Uint8Array
      const digW = digBox.right - digBox.left
      const digH = digBox.bottom - digBox.top
      if (!isNearlySolidGlyph(glyph)) {
        // 把 display glyph 投影到 digBox 坐标系不方便；直接对 display glyph 膨胀作挖洞
        digGlyph = morphMask(glyph, boxW, boxH, 2, true)
        preparedTexts.push({ region, box, digBox: box, mode, glyph, digGlyph })
      } else {
        digGlyph = new Uint8Array(digW * digH).fill(255)
        preparedTexts.push({ region, box, digBox, mode, glyph, digGlyph })
      }
    }

    // 从主体扣除：仅精抠字
    const subtractMask = composeTextMaskFromRegions(
      preparedTexts.filter((item) => item.mode === 'glyph').map((item) => ({ box: item.box, glyph: item.glyph })),
      width,
      height
    )
    // LaMa 挖洞：用 digBox + digGlyph（紧、贴字形），不要超大实心矩形
    const holeTextMask = composeTextMaskFromRegions(
      preparedTexts.map((item) => ({
        box: item.digBox,
        glyph: item.digGlyph
      })),
      width,
      height
    )
    // 兼容旧变量名：装饰/回退路径仍需要一张「文字占用」图
    const textMask = holeTextMask

    input.onProgress(54, 'Separating subject, text, and lighting')
    const mainMask = new Uint8Array(subjectMask.length)
    const repairBaseMask = new Uint8Array(subjectMask.length)
    for (let index = 0; index < subjectMask.length; index += 1) {
      // 主体只减「精抠字」，大标题不硬切，避免 3D 字被啃边
      mainMask[index] = hasSubject ? Math.max(0, subjectMask[index] - subtractMask[index]) : 0
      // LaMa 挖洞：主体 ∪ 全部文字
      repairBaseMask[index] = Math.max(subjectMask[index], holeTextMask[index])
    }
    // 次要物体（奖杯等）；半自动时用用户修过的道具 mask
    input.onProgress(56, 'Detecting and separating props such as trophies')
    let propMask: Uint8Array | null = null
    if (input.maskOverrides && 'propMask' in input.maskOverrides) {
      const override = input.maskOverrides.propMask
      if (override && override.length === width * height) {
        propMask = new Uint8Array(override)
        let on = 0
        for (const v of propMask) if (v >= 64) on += 1
        if (on < width * height * 0.0005) propMask = null
      } else {
        propMask = null
      }
      input.onProgress(56, propMask ? 'Using refined prop mask' : 'No prop mask')
    } else {
      try {
        propMask = await extractSecondaryPropMask(source, mainMask, textMask, width, height)
      } catch (error) {
        console.warn('Secondary prop extraction failed:', error)
        propMask = null
      }
    }
    if (propMask) {
      for (let index = 0; index < mainMask.length; index += 1) {
        // 仅在道具实心处从主体扣除，避免半透明羽化把身体啃出洞
        if (propMask[index] >= 96) {
          mainMask[index] = Math.max(0, mainMask[index] - propMask[index])
        }
        repairBaseMask[index] = Math.max(repairBaseMask[index], propMask[index])
      }
    }

    // 光影装饰：人物软影 + 非主体/文字/道具的金色点缀（金箔碎屑）
    let decorationMask: Uint8Array
    {
      const accent = createDecorationMask(source, textMask)
      const shadowBlur = hasSubject
        ? await blurMask(subjectMask, width, height, Math.max(4, Math.min(width, height) * 0.012))
        : null
      decorationMask = new Uint8Array(subjectMask.length)
      for (let index = 0; index < decorationMask.length; index += 1) {
        let value = 0
        if (shadowBlur) {
          value = Math.round(Math.max(0, shadowBlur[index] - subjectMask[index]) * 0.55)
        }
        // 金箔：排除主体/道具/强文字
        if (subjectMask[index] < 48 && (!propMask || propMask[index] < 48) && textMask[index] < 80) {
          value = Math.max(value, Math.round(accent[index] * 0.85))
        }
        if (propMask && propMask[index] >= 64) value = 0
        if (textMask[index] >= 100) value = 0
        decorationMask[index] = value
      }
    }

    // 背景修复：2 遍 + 有主体默认强清残影 + 死黑洞补丁
    let cleanBackground: Uint8ClampedArray | null = null
    let aiInpainted = false
    const baseExpand = Math.max(14, Math.min(48, Math.round(Math.min(width, height) * 0.03)))
    async function runInpaintWithExpand(
      expandRadius: number,
      progressLabel: string,
      seedThreshold = 28,
      base: Uint8ClampedArray | Uint8Array | null = null
    ): Promise<Uint8ClampedArray> {
      input.onProgress(62, progressLabel)
      const seed = new Uint8Array(repairBaseMask.length)
      for (let index = 0; index < repairBaseMask.length; index += 1) {
        seed[index] = repairBaseMask[index] >= seedThreshold ? 255 : 0
      }
      const expanded = await expandBrightMask(seed, width, height, expandRadius)
      const feathered = await blurMask(expanded, width, height, Math.max(2, expandRadius * 0.35))
      const holeMask = new Uint8Array(feathered.length)
      for (let index = 0; index < feathered.length; index += 1) {
        holeMask[index] = feathered[index] >= 20 ? 255 : 0
      }
      const srcForInpaint = base ? new Uint8Array(base) : source
      return inpaintImage({
        source: srcForInpaint,
        mask: holeMask,
        width,
        height,
        modelsDirectory: input.aiModelsDirectory
      })
    }

    if (aiSegmented) {
      try {
        cleanBackground = await runInpaintWithExpand(baseExpand, 'AI is repairing the background (pass 1)', 28)
        aiInpainted = true
        const pass2Expand = Math.min(56, Math.round(baseExpand * 1.45 + 6))
        input.onProgress(68, 'AI is removing residual artifacts (pass 2)')
        cleanBackground = await runInpaintWithExpand(pass2Expand, 'AI is removing residual artifacts (pass 2)', 24, cleanBackground)

        if (hasSubject) {
          // 默认第三遍：干净背景人影是当前最大槽点
          input.onProgress(72, 'AI is removing strong subject ghosts (pass 3)')
          const pass3 = Math.min(64, Math.round(baseExpand * 1.9 + 10))
          cleanBackground = await runInpaintWithExpand(pass3, 'AI is removing strong subject ghosts (pass 3)', 20, cleanBackground)
          const ghost2 = measureSubjectGhost(cleanBackground, source, subjectMask, width, height)
          // 始终做一轮主体核插值压影（ghost 低也轻压，去轮廓）
          input.onProgress(76, ghost2 > 0.14 ? 'Ghosting remains; finishing with directional fill' : 'Smoothing subject edges with directional fill')
          const core = await expandBrightMask(
            (() => {
              const m = new Uint8Array(subjectMask.length)
              for (let i = 0; i < subjectMask.length; i += 1) m[i] = subjectMask[i] >= 48 ? 255 : 0
              return m
            })(),
            width,
            height,
            Math.max(12, Math.round(baseExpand * 1.05))
          )
          const directionalFill = directionalBackgroundFill(new Uint8Array(cleanBackground), core, width, height)
          const smoothFill = await sharp(Buffer.from(directionalFill), { raw: { width, height, channels: 4 } })
            .blur(Math.max(6, Math.min(40, Math.min(width, height) * 0.016)))
            .raw()
            .toBuffer()
          const mixMask = await blurMask(core, width, height, Math.max(3, Math.min(width, height) * 0.008))
          const mixStrength = ghost2 > 0.2 ? 0.92 : 0.72
          for (let index = 0; index < mixMask.length; index += 1) {
            const wMix = Math.min(255, Math.round(mixMask[index] * mixStrength))
            if (wMix < 6) continue
            const o = index * 4
            const t = wMix / 255
            cleanBackground[o] = Math.round(cleanBackground[o] * (1 - t) + smoothFill[o] * t)
            cleanBackground[o + 1] = Math.round(cleanBackground[o + 1] * (1 - t) + smoothFill[o + 1] * t)
            cleanBackground[o + 2] = Math.round(cleanBackground[o + 2] * (1 - t) + smoothFill[o + 2] * t)
          }
        }
        // 文字挖洞偶发死黑：用周围色补
        patchNearBlackHoles(cleanBackground, holeTextMask, width, height)
      } catch (error) {
        console.warn('AI background repair failed; falling back to directional fill:', error)
        cleanBackground = null
        aiInpainted = false
      }
    }
    if (!cleanBackground) {
      input.onProgress(66, 'Repairing the background around the subject')
      let expandedMask: Uint8Array
      if (hasSubject) {
        expandedMask = createRepairArea(repairBaseMask, width, height)
      } else {
        const expandedBuffer = await sharp(Buffer.from(repairBaseMask), { raw: { width, height, channels: 1 } })
          .erode(Math.max(3, Math.min(13, Math.round(Math.min(width, height) * 0.006))))
          .greyscale()
          .raw()
          .toBuffer()
        expandedMask = new Uint8Array(expandedBuffer)
      }
      const directionalFill = directionalBackgroundFill(source, expandedMask, width, height)
      const smoothFill = await sharp(Buffer.from(directionalFill), { raw: { width, height, channels: 4 } })
        .blur(Math.max(3, Math.min(28, Math.min(width, height) * 0.012)))
        .raw()
        .toBuffer()
      const repairMask = await blurMask(expandedMask, width, height, Math.max(2, Math.min(width, height) * 0.004))
      cleanBackground = blend(source, new Uint8Array(smoothFill), repairMask)
    }

    // 主体层去白边：白衣叠深色干净背景时最容易冒一圈描边
    const finalMainMask = hasSubject ? defringeLayerAlpha(source, mainMask, width, height) : mainMask
    const mainPixels = applyAlpha(source, finalMainMask)
    const decorationPixels = applyAlpha(source, decorationMask)
    const textGroups = await Promise.all(
      preparedTexts.map((item) =>
        buildTextBlockGroup(source, width, height, item.region, item.glyph, item.mode, item.box)
      )
    )
    // 主体/道具改为「裁切到外接矩形 + 烘焙 alpha」，placement 与像素一一对应，避免全画布蒙版偏移
    const mainCropped = hasSubject ? cropLayerToMask(source, finalMainMask, width, height) : null
    const propCropped = propMask ? cropLayerToMask(source, propMask, width, height) : null
    const decoCropped = cropLayerToMask(source, decorationMask, width, height)

    let sequence = 1
    const numbered = (label: string): string => `${String(sequence++).padStart(2, '0')} ${label}`
    // 按面板从上到下的编号顺序构建；ag-psd 的 children 数组是从下到上（背面→正面）排列的，
    // 不透明且无蒙版的「干净背景」若留在数组前部会盖住其余图层，因此写入 PSD 前整体反转
    const panelTopToBottom: Layer[] = []
    if (mainCropped) {
      panelTopToBottom.push(
        layerCropped(numbered('Subject'), mainCropped, { transparencyProtected: true })
      )
    } else if (hasSubject) {
      panelTopToBottom.push(layer(numbered('Subject'), mainPixels, null, width, height, false, { transparencyProtected: true }))
    }
    if (textGroups.length) {
      panelTopToBottom.push({ name: numbered('Text & logo'), opened: false, children: textGroups })
    }
    if (propCropped) {
      panelTopToBottom.push(layerCropped(numbered('Props'), propCropped, { transparencyProtected: true }))
    }
    if (decoCropped) {
      panelTopToBottom.push(
        layerCropped(numbered(hasSubject ? 'Lighting & decor' : 'Highlights & decor'), decoCropped, {
          opacity: hasSubject ? 190 : 210
        })
      )
    } else {
      panelTopToBottom.push(
        layer(numbered(hasSubject ? 'Lighting & decor' : 'Highlights & decor'), decorationPixels, null, width, height, false, {
          opacity: hasSubject ? 190 : 210
        })
      )
    }
    // 干净背景：不透明整幅，作为对齐基准（0,0）
    panelTopToBottom.push(layer(numbered('Clean background'), cleanBackground, null, width, height, false))
    panelTopToBottom.push(layer(numbered('Original backup'), source, null, width, height, false, {
      hidden: true,
      protected: { transparency: true, composite: true, position: true }
    }))
    const layerNames = panelTopToBottom.map((item) => String(item.name || 'Layer'))
    const children: Layer[] = [...panelTopToBottom].reverse()

    input.onProgress(84, 'Writing editable PSD')
    const psd: Psd = {
      width,
      height,
      imageData: rgbaPixelData(source, width, height),
      children
    }
    const encoded = writePsdBuffer(psd, { compress: true, invalidateTextLayers: true })
    await mkdir(path.dirname(input.outputPath), { recursive: true })
    const temporaryOutput = `${input.outputPath}.${randomUUID()}.part`
    await writeFile(temporaryOutput, encoded)
    await rename(temporaryOutput, input.outputPath)
    const outputStat = await stat(input.outputPath)
    input.onProgress(100, 'PSD exported')
    return {
      path: input.outputPath,
      width,
      height,
      size: outputStat.size,
      layerNames,
      textRegionCount: textRegions.length,
      instanceCount: analysis.instanceCount,
      engine: aiSegmented && aiInpainted ? 'ai' : aiSegmented || aiInpainted ? 'mixed' : 'compat'
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
