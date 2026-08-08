import path from 'node:path'
import sharp from 'sharp'
import { AI_MODELS, loadSession, ort } from './models'
// 纯几何/像素处理已拆到 textRegions.ts（不依赖 ort），主进程 psd.ts 直接用那边
import { MAX_CANDIDATES, type DetectedTextRegion } from './textRegions'

export type { DetectedTextRegion }

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
const LIMIT_SIDE = 960
const BOX_THRESH = 0.55
const BITMAP_THRESH = 0.3
const MIN_SIZE = 3
// det 框略放大即可；过大 unclip + 大 pad 会把身体吞进文字层
const UNCLIP_RATIO = 1.85

function resizeLimit(width: number, height: number, limit: number): { rw: number; rh: number; ratio: number } {
  const longSide = Math.max(width, height)
  const ratio = longSide > limit ? limit / longSide : 1
  let rw = Math.round(width * ratio)
  let rh = Math.round(height * ratio)
  rw = Math.max(32, Math.round(rw / 32) * 32)
  rh = Math.max(32, Math.round(rh / 32) * 32)
  return { rw, rh, ratio: rw / width }
}

/** 简易连通域：返回每个连通块的 bbox（在 det 特征图坐标系） */
function connectedComponents(
  bitmap: Uint8Array,
  scores: Float32Array,
  width: number,
  height: number
): Array<{ left: number; top: number; right: number; bottom: number; area: number; scoreSum: number }> {
  const labels = new Int32Array(width * height)
  labels.fill(-1)
  const boxes: Array<{ left: number; top: number; right: number; bottom: number; area: number; scoreSum: number }> = []
  const qx = new Int32Array(width * height)
  const qy = new Int32Array(width * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (!bitmap[start] || labels[start] >= 0) continue
      const id = boxes.length
      let head = 0
      let tail = 0
      qx[tail] = x
      qy[tail] = y
      tail += 1
      labels[start] = id
      let left = x
      let right = x
      let top = y
      let bottom = y
      let area = 0
      let scoreSum = 0
      while (head < tail) {
        const cx = qx[head]
        const cy = qy[head]
        head += 1
        const idx = cy * width + cx
        area += 1
        scoreSum += scores[idx]
        if (cx < left) left = cx
        if (cx > right) right = cx
        if (cy < top) top = cy
        if (cy > bottom) bottom = cy
        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ]
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const nidx = ny * width + nx
          if (!bitmap[nidx] || labels[nidx] >= 0) continue
          labels[nidx] = id
          qx[tail] = nx
          qy[tail] = ny
          tail += 1
        }
      }
      if (right - left + 1 >= MIN_SIZE && bottom - top + 1 >= MIN_SIZE) {
        boxes.push({ left, top, right: right + 1, bottom: bottom + 1, area, scoreSum })
      }
    }
  }
  return boxes
}

function expandBox(
  left: number,
  top: number,
  right: number,
  bottom: number,
  width: number,
  height: number,
  ratio: number
): { left: number; top: number; right: number; bottom: number } {
  const bw = right - left
  const bh = bottom - top
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const halfW = (bw * ratio) / 2
  const halfH = (bh * ratio) / 2
  return {
    left: Math.max(0, Math.floor(cx - halfW)),
    top: Math.max(0, Math.floor(cy - halfH)),
    right: Math.min(width, Math.ceil(cx + halfW)),
    bottom: Math.min(height, Math.ceil(cy + halfH))
  }
}

/**
 * PP-OCRv4 det（DBNet）本地推理：返回相对坐标文字框。
 * 协议 Apache-2.0；中文电商海报检测强于系统 Vision 框。
 */
export async function detectTextBoxes(input: {
  imagePath: string
  width: number
  height: number
  modelsDirectory: string
}): Promise<DetectedTextRegion[]> {
  const { file } = AI_MODELS.textDetection
  const session = await loadSession(path.join(input.modelsDirectory, file), ['cpu'])
  const { rw, rh } = resizeLimit(input.width, input.height, LIMIT_SIDE)
  const rgb = await sharp(input.imagePath)
    .resize(rw, rh, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()

  const plane = rw * rh
  // PaddleOCR det 训练为 BGR + ImageNet 归一化
  const chw = new Float32Array(3 * plane)
  for (let index = 0; index < plane; index += 1) {
    const r = rgb[index * 3] / 255
    const g = rgb[index * 3 + 1] / 255
    const b = rgb[index * 3 + 2] / 255
    chw[0 * plane + index] = (b - MEAN[0]) / STD[0]
    chw[1 * plane + index] = (g - MEAN[1]) / STD[1]
    chw[2 * plane + index] = (r - MEAN[2]) / STD[2]
  }

  const feeds = {
    [session.inputNames[0]]: new ort.Tensor('float32', chw, [1, 3, rh, rw])
  }
  const results = await session.run(feeds)
  const output = results[session.outputNames[0]]
  const dims = output.dims as number[]
  const mapH = Number(dims[dims.length - 2] || rh)
  const mapW = Number(dims[dims.length - 1] || rw)
  const values = output.data as Float32Array
  if (values.length < mapH * mapW) throw new Error('文字检测输出尺寸异常')

  const bitmap = new Uint8Array(mapW * mapH)
  for (let index = 0; index < mapW * mapH; index += 1) {
    bitmap[index] = values[index] > BITMAP_THRESH ? 1 : 0
  }

  const components = connectedComponents(bitmap, values, mapW, mapH)
  components.sort((a, b) => b.area - a.area)

  const scaleX = input.width / mapW
  const scaleY = input.height / mapH
  const regions: DetectedTextRegion[] = []

  for (const box of components.slice(0, MAX_CANDIDATES)) {
    const confidence = box.scoreSum / Math.max(1, box.area)
    if (confidence < BOX_THRESH * 0.45) continue
    const expanded = expandBox(box.left, box.top, box.right, box.bottom, mapW, mapH, UNCLIP_RATIO)
    const left = expanded.left * scaleX
    const top = expanded.top * scaleY
    const right = expanded.right * scaleX
    const bottom = expanded.bottom * scaleY
    const width = Math.max(1, right - left)
    const height = Math.max(1, bottom - top)
    // 过滤过大背景块与过小噪声
    if (width * height > input.width * input.height * 0.35) continue
    if (width < 6 || height < 6) continue
    regions.push({
      x: left / input.width,
      y: top / input.height,
      width: width / input.width,
      height: height / input.height,
      confidence: Math.min(1, confidence),
      text: ''
    })
  }

  // 按阅读顺序排序：上→下，左→右
  regions.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
  return regions
}
