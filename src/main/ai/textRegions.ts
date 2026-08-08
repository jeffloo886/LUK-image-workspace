/*
 * 文字区域的纯几何/像素处理 —— 不依赖 onnxruntime。
 * 从 textDetect.ts 拆出来，好让主进程的 psd.ts 用这些工具时不会顺带把
 * 38.8MB 的 ort dylib 在冷启动就 dlopen 进来（只有 fork 出去的 ai-worker 需要 ort）。
 */
import sharp from 'sharp'

/** 归一化文字框（相对 0–1 坐标，与 Vision JSON 一致） */
export type DetectedTextRegion = {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  text: string
  /** 可选四点多边形（相对坐标），用于更贴合文字 */
  polygon?: Array<{ x: number; y: number }>
}

/** merge 后保留的候选上限 */
export const MAX_CANDIDATES = 80

export async function refineGlyphMaskInBox(input: {
  sourceRgba: Uint8Array
  imageWidth: number
  box: { left: number; top: number; right: number; bottom: number }
}): Promise<Uint8Array> {
  const { left, top, right, bottom } = input.box
  const boxW = Math.max(1, right - left)
  const boxH = Math.max(1, bottom - top)
  const crop = Buffer.alloc(boxW * boxH * 3)
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const src = ((top + y) * input.imageWidth + (left + x)) * 4
      const dst = (y * boxW + x) * 3
      crop[dst] = input.sourceRgba[src]
      crop[dst + 1] = input.sourceRgba[src + 1]
      crop[dst + 2] = input.sourceRgba[src + 2]
    }
  }

  // 灰度 + 轻微模糊稳定阈值
  const grayBuf = await sharp(crop, { raw: { width: boxW, height: boxH, channels: 3 } })
    .greyscale()
    .blur(0.6)
    .raw()
    .toBuffer()

  // Otsu 阈值
  const hist = new Float64Array(256)
  for (let index = 0; index < grayBuf.length; index += 1) hist[grayBuf[index]] += 1
  const total = grayBuf.length
  let sum = 0
  for (let i = 0; i < 256; i += 1) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 128
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }

  // 判断文字更可能偏暗还是偏亮：比较阈值两侧到中心的平均对比
  let dark = 0
  let light = 0
  let darkN = 0
  let lightN = 0
  for (let index = 0; index < grayBuf.length; index += 1) {
    const v = grayBuf[index]
    if (v <= threshold) {
      dark += v
      darkN += 1
    } else {
      light += v
      lightN += 1
    }
  }
  const darkMean = darkN ? dark / darkN : 0
  const lightMean = lightN ? light / lightN : 255
  // 前景取面积较小的一侧（文字通常不占满框）
  const preferDark = darkN > 0 && darkN <= lightN

  const mask = new Uint8Array(boxW * boxH)
  const edge = Math.max(1, Math.round(Math.min(boxW, boxH) * 0.04))
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const index = y * boxW + x
      // 边缘一圈视为背景，减轻框外溢
      if (x < edge || y < edge || x >= boxW - edge || y >= boxH - edge) {
        mask[index] = 0
        continue
      }
      const v = grayBuf[index]
      const isFg = preferDark ? v <= threshold - 4 : v >= threshold + 4
      if (!isFg) {
        mask[index] = 0
        continue
      }
      // 软边：距阈值越远越实
      const dist = preferDark ? threshold - v : v - threshold
      const alpha = Math.max(0, Math.min(255, Math.round((dist / 48) * 255)))
      mask[index] = alpha < 28 ? 0 : Math.max(alpha, 90)
    }
  }

  // 小面积则回退实心（避免全空）
  let covered = 0
  for (const value of mask) if (value >= 64) covered += 1
  const coverage = covered / mask.length
  if (coverage < 0.004 || coverage > 0.92) {
    mask.fill(220)
    for (let y = 0; y < boxH; y += 1) {
      for (let x = 0; x < boxW; x += 1) {
        if (x < edge || y < edge || x >= boxW - edge || y >= boxH - edge) mask[y * boxW + x] = 0
      }
    }
  }
  return mask
}

/** 将多个 ROI glyph mask 拼成全图文字 soft mask */
export function composeTextMaskFromRegions(
  regions: Array<{ box: { left: number; top: number; right: number; bottom: number }; glyph: Uint8Array }>,
  width: number,
  height: number
): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (const region of regions) {
    const { left, top, right, bottom } = region.box
    const boxW = right - left
    const boxH = bottom - top
    if (boxW <= 0 || boxH <= 0) continue
    for (let y = 0; y < boxH; y += 1) {
      for (let x = 0; x < boxW; x += 1) {
        const gx = left + x
        const gy = top + y
        if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue
        const value = region.glyph[y * boxW + x]
        const index = gy * width + gx
        if (value > mask[index]) mask[index] = value
      }
    }
  }
  return mask
}

/**
 * 合并 PP-OCR det 与 Vision 框：det 为主，Vision 补漏并带上 OCR 字符串。
 */
export function mergeTextRegions(
  detRegions: DetectedTextRegion[],
  visionRegions: DetectedTextRegion[]
): DetectedTextRegion[] {
  const merged: DetectedTextRegion[] = detRegions.map((item) => ({ ...item }))

  const iou = (a: DetectedTextRegion, b: DetectedTextRegion): number => {
    const ax0 = a.x
    const ay0 = a.y
    const ax1 = a.x + a.width
    const ay1 = a.y + a.height
    const bx0 = b.x
    const by0 = b.y
    const bx1 = b.x + b.width
    const by1 = b.y + b.height
    const ix0 = Math.max(ax0, bx0)
    const iy0 = Math.max(ay0, by0)
    const ix1 = Math.min(ax1, bx1)
    const iy1 = Math.min(ay1, by1)
    const iw = Math.max(0, ix1 - ix0)
    const ih = Math.max(0, iy1 - iy0)
    const inter = iw * ih
    const union = a.width * a.height + b.width * b.height - inter
    return union > 0 ? inter / union : 0
  }

  // 给 det 框贴上最近 Vision OCR 文本
  for (const det of merged) {
    let best: DetectedTextRegion | null = null
    let bestScore = 0
    for (const vision of visionRegions) {
      const score = iou(det, vision)
      if (score > bestScore) {
        bestScore = score
        best = vision
      }
    }
    if (best && bestScore >= 0.15 && best.text.trim()) {
      det.text = best.text.trim()
      det.confidence = Math.max(det.confidence, best.confidence)
    }
  }

  // Vision 独有框（det 漏检）补入
  for (const vision of visionRegions) {
    if (!vision.text.trim()) continue
    let hit = false
    for (const det of merged) {
      if (iou(det, vision) >= 0.2) {
        hit = true
        break
      }
    }
    if (!hit) merged.push({ ...vision })
  }

  merged.sort((a, b) => (Math.abs(a.y - b.y) < 0.02 ? a.x - b.x : a.y - b.y))
  return merged.slice(0, MAX_CANDIDATES)
}
