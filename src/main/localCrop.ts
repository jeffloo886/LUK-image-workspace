import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

export type LocalCropBox = { x: number; y: number; size: number }
export type LocalCropMaskPoint = { x: number; y: number }
export type LocalCropMaskPath = { points: LocalCropMaskPoint[]; brushSize: number; isEraser: boolean }

export type CompositeLocalCropInput = {
  scenePath: string
  patchPath?: string
  patchBytes?: Buffer
  cropBox: LocalCropBox
  outputDirectory: string
  taskId: number
  feather?: number
  /** 场景图坐标系下的画笔路径；有笔刷时只回贴选区，避免整框硬盖 */
  maskPaths?: LocalCropMaskPath[]
}

export type CompositeLocalCropResult = {
  path: string
  previewDataUrl: string
  width: number
  height: number
  size: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function featherForCropSize(size: number): number {
  if (size >= 1400) return 80
  if (size >= 900) return 56
  if (size >= 512) return 32
  return 16
}

function buildFeatherAlpha(size: number, feather: number): Float32Array {
  const soft = Math.max(0, Math.min(Math.floor(size / 2) - 1, Math.round(feather)))
  const alpha = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
      const value = soft <= 0 ? 1 : clamp(edge / soft, 0, 1)
      // smoothstep，减轻硬边
      const t = value * value * (3 - 2 * value)
      alpha[y * size + x] = t
    }
  }
  return alpha
}

function stampDisk(alpha: Float32Array, size: number, cx: number, cy: number, radius: number, erase: boolean): void {
  const r = Math.max(0.5, radius)
  const r2 = r * r
  const minX = Math.max(0, Math.floor(cx - r - 1))
  const maxX = Math.min(size - 1, Math.ceil(cx + r + 1))
  const minY = Math.max(0, Math.floor(cy - r - 1))
  const maxY = Math.min(size - 1, Math.ceil(cy + r + 1))
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d2 = dx * dx + dy * dy
      if (d2 > r2) continue
      // 边缘 1px 软化，避免锯齿圆点
      const d = Math.sqrt(d2)
      const coverage = d >= r - 1 ? clamp(r - d, 0, 1) : 1
      const idx = y * size + x
      if (erase) alpha[idx] = Math.max(0, alpha[idx] - coverage)
      else alpha[idx] = Math.max(alpha[idx], coverage)
    }
  }
}

function stampSegment(
  alpha: Float32Array,
  size: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  erase: boolean
): void {
  const dist = Math.hypot(x1 - x0, y1 - y0)
  const step = Math.max(1, radius * 0.35)
  const count = Math.max(1, Math.ceil(dist / step))
  for (let i = 0; i <= count; i += 1) {
    const t = i / count
    stampDisk(alpha, size, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, erase)
  }
}

/** 把场景坐标系下的笔刷路径栅格化为裁切框内 0~1 alpha */
export function rasterizeMaskAlpha(
  size: number,
  cropBox: LocalCropBox,
  paths: LocalCropMaskPath[] | undefined
): Float32Array | null {
  const list = Array.isArray(paths) ? paths : []
  const hasBrush = list.some((pathItem) => !pathItem.isEraser && Array.isArray(pathItem.points) && pathItem.points.length > 0)
  if (!hasBrush) return null

  const alpha = new Float32Array(size * size)
  const ox = cropBox.x
  const oy = cropBox.y
  for (const pathItem of list) {
    const pts = Array.isArray(pathItem.points) ? pathItem.points : []
    if (!pts.length) continue
    const radius = Math.max(0.5, Number(pathItem.brushSize || 0) / 2)
    const erase = Boolean(pathItem.isEraser)
    let prevX = pts[0].x - ox
    let prevY = pts[0].y - oy
    stampDisk(alpha, size, prevX, prevY, radius, erase)
    for (let i = 1; i < pts.length; i += 1) {
      const x = pts[i].x - ox
      const y = pts[i].y - oy
      stampSegment(alpha, size, prevX, prevY, x, y, radius, erase)
      prevX = x
      prevY = y
    }
  }
  return alpha
}

function featherMaskAlpha(mask: Float32Array, size: number, radius: number): Float32Array {
  const soft = Math.max(0, Math.round(radius))
  if (soft <= 0) return mask
  // 两次盒式模糊近似高斯，让笔刷边缘更自然
  const tmp = new Float32Array(size * size)
  const out = new Float32Array(size * size)
  const r = soft
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0
      let count = 0
      for (let dx = -r; dx <= r; dx += 1) {
        const xx = x + dx
        if (xx < 0 || xx >= size) continue
        sum += mask[y * size + xx]
        count += 1
      }
      tmp[y * size + x] = count ? sum / count : 0
    }
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = -r; dy <= r; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= size) continue
        sum += tmp[yy * size + x]
        count += 1
      }
      out[y * size + x] = count ? sum / count : 0
    }
  }
  return out
}

async function loadPatchRgba(patchSource: ReturnType<typeof sharp>, size: number): Promise<Buffer> {
  const meta = await patchSource.metadata()
  const width = meta.width || 0
  const height = meta.height || 0
  const aspect = width > 0 && height > 0 ? width / height : 1
  // 接近正方形：直接拉伸到框，避免 cover 吃掉边缘内容
  // 明显非方（历史错误出图）：cover 居中裁，尽量保住主体
  const fit = Math.abs(aspect - 1) <= 0.08 ? 'fill' : 'cover'
  const resized = await patchSource
    .rotate()
    .resize(size, size, { fit, position: 'centre' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return Buffer.from(resized.data)
}

export async function compositeLocalCrop(input: CompositeLocalCropInput): Promise<CompositeLocalCropResult> {
  const scene = sharp(input.scenePath, { limitInputPixels: 80_000_000 }).rotate().ensureAlpha()
  const meta = await scene.metadata()
  const width = meta.width || 0
  const height = meta.height || 0
  if (!width || !height) throw new Error('Scene image dimensions are invalid')

  const size = clamp(Math.round(input.cropBox.size), 16, Math.min(width, height))
  const left = clamp(Math.round(input.cropBox.x), 0, Math.max(0, width - size))
  const top = clamp(Math.round(input.cropBox.y), 0, Math.max(0, height - size))
  const cropBox: LocalCropBox = { x: left, y: top, size }
  const edgeFeather = input.feather ?? featherForCropSize(size)

  const patchSource = input.patchBytes
    ? sharp(input.patchBytes, { limitInputPixels: 80_000_000 })
    : sharp(String(input.patchPath || ''), { limitInputPixels: 80_000_000 })
  const rgba = await loadPatchRgba(patchSource, size)

  const edgeAlpha = buildFeatherAlpha(size, edgeFeather)
  const brushAlpha = rasterizeMaskAlpha(size, cropBox, input.maskPaths)
  // 有画笔：按选区回贴，并给笔刷边缘再软化一点；无画笔：整框 + 边缘羽化
  const brushSoft = brushAlpha ? featherMaskAlpha(brushAlpha, size, Math.max(2, Math.round(edgeFeather / 6))) : null

  for (let i = 0; i < size * size; i += 1) {
    const base = i * 4
    const keep = brushSoft ? brushSoft[i] * edgeAlpha[i] : edgeAlpha[i]
    rgba[base + 3] = Math.round(clamp(rgba[base + 3] * keep, 0, 255))
  }

  const patchPng = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer()
  const composed = await scene
    .composite([{ input: patchPng, left, top }])
    .png()
    .toBuffer({ resolveWithObject: true })

  await mkdir(input.outputDirectory, { recursive: true })
  const filePath = path.join(input.outputDirectory, `local-crop-${input.taskId}-${Date.now()}.png`)
  await writeFile(filePath, composed.data)
  return {
    path: filePath,
    previewDataUrl: `data:image/png;base64,${composed.data.toString('base64')}`,
    width: composed.info.width,
    height: composed.info.height,
    size: composed.data.byteLength
  }
}

export async function cacheLocalCropScene(scenePath: string, cacheDirectory: string, taskId: number): Promise<string> {
  await mkdir(cacheDirectory, { recursive: true })
  const ext = path.extname(scenePath) || '.png'
  const out = path.join(cacheDirectory, `scene-${taskId}${ext}`)
  await copyFile(scenePath, out)
  return out
}
