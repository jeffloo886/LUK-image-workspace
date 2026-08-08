export type CropBox = { x: number; y: number; size: number }
export type MaskPoint = { x: number; y: number }
export type MaskPath = { points: MaskPoint[]; brushSize: number; isEraser: boolean }

export const GRAY_MASK = '#808080'
export const CROP_MIN_SIZE = 64
export const CROP_INITIAL_SIZE = 256
export const AUTO_CROP_DELAY_MS = 600
export const AUTO_CROP_PADDING = 0.5

export const DEFAULT_LOCAL_CROP_PROMPT =
  'Edit image 1. Replace the gray selection in image 1 with the product from image 2, preserving its shape and details. If images 3 or 4 are provided, use them as product-detail references. Blend the replacement naturally, remove the gray selection box, and keep everything outside the box unchanged.'

// 无论用户自己填了什么提示词，都强制追加这条约束——否则模型收到「删掉/去掉」这类指令时
// 很容易把灰色选区之外的内容也一并改动或删除（局部裁切的卖点就是「框外内容保持不变」）。
export const LOCAL_CROP_PRESERVE_GUARD =
  'Important constraint: only modify the gray marked selection. The composition, background, text, and lighting outside the selection must remain exactly unchanged. Do not edit, redraw, or remove anything outside the selection.'

export function withLocalCropGuard(prompt: string): string {
  const trimmed = prompt.trim() || DEFAULT_LOCAL_CROP_PROMPT
  return `${trimmed}\n\n${LOCAL_CROP_PRESERVE_GUARD}`
}

/** 复用历史任务时去掉强制追加的约束，避免重复叠加 */
export function stripLocalCropGuard(prompt: string): string {
  const raw = String(prompt || '')
  const marker = LOCAL_CROP_PRESERVE_GUARD
  const idx = raw.lastIndexOf(marker)
  if (idx < 0) return raw.trim()
  return raw.slice(0, idx).replace(/\s+$/u, '').trim()
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// MaskPath 数组常来自 Vue ref/props，是响应式 Proxy；浏览器原生 structuredClone 无法克隆
// Proxy（会同步抛 DataCloneError）。这里手动做一次深拷贝，读取时天然拿到原始值。
export function cloneMaskPaths(list: MaskPath[]): MaskPath[] {
  return list.map((path) => ({
    points: path.points.map((point) => ({ x: point.x, y: point.y })),
    brushSize: path.brushSize,
    isEraser: path.isEraser
  }))
}

export function clampCropBox(box: CropBox, imageWidth: number, imageHeight: number): CropBox {
  const maxSize = Math.max(CROP_MIN_SIZE, Math.min(imageWidth, imageHeight))
  const size = clamp(Math.round(box.size), CROP_MIN_SIZE, maxSize)
  return {
    x: clamp(Math.round(box.x), 0, Math.max(0, imageWidth - size)),
    y: clamp(Math.round(box.y), 0, Math.max(0, imageHeight - size)),
    size
  }
}

export function createCenteredCropBox(imageWidth: number, imageHeight: number, preferred = CROP_INITIAL_SIZE): CropBox {
  const size = clamp(preferred, CROP_MIN_SIZE, Math.min(imageWidth, imageHeight))
  return clampCropBox(
    {
      x: Math.round((imageWidth - size) / 2),
      y: Math.round((imageHeight - size) / 2),
      size
    },
    imageWidth,
    imageHeight
  )
}

export function getAutoCropBox(paths: MaskPath[], imageWidth: number, imageHeight: number): CropBox | null {
  const brushPaths = paths.filter((path) => !path.isEraser && path.points.length)
  if (!brushPaths.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const path of brushPaths) {
    const pad = path.brushSize / 2
    for (const point of path.points) {
      minX = Math.min(minX, point.x - pad)
      minY = Math.min(minY, point.y - pad)
      maxX = Math.max(maxX, point.x + pad)
      maxY = Math.max(maxY, point.y + pad)
    }
  }
  if (!Number.isFinite(minX)) return null
  const width = maxX - minX
  const height = maxY - minY
  const padded = Math.max(width, height) * (1 + AUTO_CROP_PADDING)
  const size = clamp(Math.round(padded), CROP_MIN_SIZE, Math.min(imageWidth, imageHeight))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return clampCropBox({ x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), size }, imageWidth, imageHeight)
}

export function drawMaskPathsToCanvas(
  ctx: CanvasRenderingContext2D,
  paths: MaskPath[],
  options: { offsetX?: number; offsetY?: number; scale?: number; alpha?: number; color?: string } = {}
): void {
  const offsetX = options.offsetX ?? 0
  const offsetY = options.offsetY ?? 0
  const scale = options.scale ?? 1
  const alpha = options.alpha ?? 1
  const color = options.color ?? GRAY_MASK
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const path of paths) {
    if (path.points.length < 1) continue
    ctx.globalCompositeOperation = path.isEraser ? 'destination-out' : 'source-over'
    ctx.strokeStyle = path.isEraser ? 'rgba(0,0,0,1)' : color
    ctx.lineWidth = Math.max(1, path.brushSize * scale)
    ctx.beginPath()
    const first = path.points[0]
    ctx.moveTo((first.x - offsetX) * scale, (first.y - offsetY) * scale)
    for (let i = 1; i < path.points.length; i += 1) {
      const point = path.points[i]
      ctx.lineTo((point.x - offsetX) * scale, (point.y - offsetY) * scale)
    }
    if (path.points.length === 1) {
      ctx.lineTo((first.x - offsetX) * scale + 0.01, (first.y - offsetY) * scale)
    }
    ctx.stroke()
  }
  ctx.restore()
}

export async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to load the scene image'))
    image.src = src
  })
}

export async function bakeLocalCropImage(
  sceneSrc: string,
  cropBox: CropBox,
  paths: MaskPath[],
  maskOpacityPercent: number
): Promise<Blob> {
  const image = await loadImageElement(sceneSrc)
  const box = clampCropBox(cropBox, image.naturalWidth, image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = box.size
  canvas.height = box.size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Unable to create the crop canvas')
  ctx.drawImage(image, box.x, box.y, box.size, box.size, 0, 0, box.size, box.size)
  if (paths.length) {
    const mask = document.createElement('canvas')
    mask.width = box.size
    mask.height = box.size
    const maskCtx = mask.getContext('2d')
    if (!maskCtx) throw new Error('Unable to create the selection canvas')
    drawMaskPathsToCanvas(maskCtx, paths, { offsetX: box.x, offsetY: box.y, alpha: 1 })
    ctx.save()
    ctx.globalAlpha = clamp(maskOpacityPercent / 100, 0.05, 1)
    ctx.drawImage(mask, 0, 0)
    ctx.restore()
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('Failed to export the crop'))
      else resolve(blob)
    }, 'image/png')
  })
}

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer()
}

export function featherForCropSize(size: number): number {
  if (size >= 1400) return 80
  if (size >= 900) return 56
  if (size >= 512) return 32
  return 16
}
