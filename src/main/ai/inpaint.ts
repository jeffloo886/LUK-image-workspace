import path from 'node:path'
import sharp from 'sharp'
import { AI_MODELS, loadSession, ort } from './models'

type Box = { left: number; top: number; right: number; bottom: number }

// 在 1/4 分辨率上找修复区域的连通块外接框，避免全图逐像素 BFS 的开销
function repairBoxes(mask: Uint8Array, width: number, height: number): Box[] {
  const scale = 4
  const smallWidth = Math.max(1, Math.floor(width / scale))
  const smallHeight = Math.max(1, Math.floor(height / scale))
  const small = new Uint8Array(smallWidth * smallHeight)
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(smallHeight - 1, Math.floor(y / scale))
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] >= 128) small[sy * smallWidth + Math.min(smallWidth - 1, Math.floor(x / scale))] = 1
    }
  }
  const labels = new Int32Array(smallWidth * smallHeight).fill(-1)
  const boxes: Box[] = []
  const queue = new Int32Array(smallWidth * smallHeight)
  for (let start = 0; start < small.length; start += 1) {
    if (!small[start] || labels[start] >= 0) continue
    const label = boxes.length
    let head = 0
    let tail = 0
    queue[tail++] = start
    labels[start] = label
    const box = { left: smallWidth, top: smallHeight, right: 0, bottom: 0 }
    while (head < tail) {
      const index = queue[head++]
      const x = index % smallWidth
      const y = Math.floor(index / smallWidth)
      box.left = Math.min(box.left, x)
      box.top = Math.min(box.top, y)
      box.right = Math.max(box.right, x + 1)
      box.bottom = Math.max(box.bottom, y + 1)
      const neighbors = [index - 1, index + 1, index - smallWidth, index + smallWidth]
      for (const next of neighbors) {
        if (next < 0 || next >= small.length) continue
        if (Math.abs((next % smallWidth) - x) > 1) continue
        if (small[next] && labels[next] < 0) {
          labels[next] = label
          queue[tail++] = next
        }
      }
    }
    boxes.push({ left: box.left * scale, top: box.top * scale, right: Math.min(width, box.right * scale), bottom: Math.min(height, box.bottom * scale) })
  }
  return mergeBoxes(boxes)
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function mergeBoxes(boxes: Box[]): Box[] {
  const merged = [...boxes]
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (overlaps(merged[i], merged[j])) {
          merged[i] = {
            left: Math.min(merged[i].left, merged[j].left),
            top: Math.min(merged[i].top, merged[j].top),
            right: Math.max(merged[i].right, merged[j].right),
            bottom: Math.max(merged[i].bottom, merged[j].bottom)
          }
          merged.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
  }
  return merged
}

function expandBox(box: Box, width: number, height: number): Box {
  const boxWidth = box.right - box.left
  const boxHeight = box.bottom - box.top
  // 质量优先：更大上下文，让 LaMa 有足够周围背景可参考
  const margin = Math.max(72, Math.min(640, Math.round(Math.max(boxWidth, boxHeight) * 0.48)))
  return {
    left: Math.max(0, box.left - margin),
    top: Math.max(0, box.top - margin),
    right: Math.min(width, box.right + margin),
    bottom: Math.min(height, box.bottom + margin)
  }
}

function cropChannel(data: Uint8Array, width: number, box: Box, channels: number): Buffer {
  const boxWidth = box.right - box.left
  const boxHeight = box.bottom - box.top
  const output = Buffer.alloc(boxWidth * boxHeight * channels)
  for (let y = 0; y < boxHeight; y += 1) {
    const sourceStart = ((box.top + y) * width + box.left) * channels
    output.set(data.subarray(sourceStart, sourceStart + boxWidth * channels), y * boxWidth * channels)
  }
  return output
}

// LaMa 修复：source 为 RGBA，mask 中 >=128 的像素视为待修补洞口；返回修复后的 RGBA（alpha 置 255）
export async function inpaintImage(input: {
  source: Uint8Array
  mask: Uint8Array
  width: number
  height: number
  modelsDirectory: string
}): Promise<Uint8ClampedArray> {
  const { inputSize, file } = AI_MODELS.inpaint
  const { source, mask, width, height } = input
  const output = new Uint8ClampedArray(source)
  for (let index = 0; index < width * height; index += 1) output[index * 4 + 3] = 255

  const boxes = repairBoxes(mask, width, height).map((box) => expandBox(box, width, height))
  if (!boxes.length) return output
  // 实测 CPU（512² 约 2.7s/块）显著快于 CoreML（图被拆成 585 个分区，仅建会话就 23s）
  const session = await loadSession(path.join(input.modelsDirectory, file), ['cpu'])

  for (const box of mergeBoxes(boxes)) {
    const boxWidth = box.right - box.left
    const boxHeight = box.bottom - box.top
    if (boxWidth < 8 || boxHeight < 8) continue
    const cropRgba = cropChannel(new Uint8Array(output.buffer, output.byteOffset, output.byteLength), width, box, 4)
    const cropMask = cropChannel(mask, width, box, 1)
    const resizedImage = await sharp(cropRgba, { raw: { width: boxWidth, height: boxHeight, channels: 4 } })
      .resize(inputSize, inputSize, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer()
    // 蒙版先膨胀再缩放，确保缩放后洞口完整覆盖原修复区域。
    // 注意：sharp/libvips 的 erode 才是扩张亮区（dilate 是收缩亮区），语义与直觉相反
    // 质量优先：多扩几像素，避免洞缘残留人物轮廓
    const resizedMask = await sharp(cropMask, { raw: { width: boxWidth, height: boxHeight, channels: 1 } })
      .erode(Math.max(3, Math.round(Math.max(boxWidth, boxHeight) / inputSize) + 4))
      .resize(inputSize, inputSize, { fit: 'fill' })
      .toColourspace('b-w')
      .raw()
      .toBuffer()
    const plane = inputSize * inputSize
    if (resizedImage.length !== plane * 3 || resizedMask.length !== plane) {
      throw new Error(`Inpaint input channel mismatch: image=${resizedImage.length} mask=${resizedMask.length}`)
    }
    const imageTensor = new Float32Array(3 * plane)
    for (let channel = 0; channel < 3; channel += 1) {
      for (let index = 0; index < plane; index += 1) {
        imageTensor[channel * plane + index] = resizedImage[index * 3 + channel] / 255
      }
    }
    const maskTensor = new Float32Array(plane)
    for (let index = 0; index < plane; index += 1) maskTensor[index] = resizedMask[index] > 64 ? 1 : 0
    const results = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', imageTensor, [1, 3, inputSize, inputSize]),
      [session.inputNames[1]]: new ort.Tensor('float32', maskTensor, [1, 1, inputSize, inputSize])
    })
    const inpainted = results[session.outputNames[0]].data as Float32Array
    // Carve 导出的 LaMa 输出即 0-255；兜底兼容 0-1 版本导出
    let maximum = 0
    for (let index = 0; index < inpainted.length; index += 1) if (inpainted[index] > maximum) maximum = inpainted[index]
    const scale = maximum <= 1.5 ? 255 : 1
    const smallRgb = Buffer.alloc(plane * 3)
    for (let channel = 0; channel < 3; channel += 1) {
      for (let index = 0; index < plane; index += 1) {
        smallRgb[index * 3 + channel] = Math.max(0, Math.min(255, Math.round(inpainted[channel * plane + index] * scale)))
      }
    }
    const restored = await sharp(smallRgb, { raw: { width: inputSize, height: inputSize, channels: 3 } })
      .resize(boxWidth, boxHeight, { fit: 'fill' })
      .raw()
      .toBuffer()
    // 洞口边缘羽化稍宽，减少贴回硬边/鬼影环
    const feather = await sharp(cropMask, { raw: { width: boxWidth, height: boxHeight, channels: 1 } })
      .blur(3.5)
      .toColourspace('b-w')
      .raw()
      .toBuffer()
    if (restored.length !== boxWidth * boxHeight * 3 || feather.length !== boxWidth * boxHeight) {
      throw new Error(`Inpaint output channel mismatch: restored=${restored.length} feather=${feather.length}`)
    }
    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const local = y * boxWidth + x
        const amount = Math.max(feather[local], cropMask[local]) / 255
        if (!amount) continue
        const globalOffset = ((box.top + y) * width + box.left + x) * 4
        for (let channel = 0; channel < 3; channel += 1) {
          const value = restored[local * 3 + channel]
          output[globalOffset + channel] = Math.round(output[globalOffset + channel] * (1 - amount) + value * amount)
        }
      }
    }
  }
  return output
}
