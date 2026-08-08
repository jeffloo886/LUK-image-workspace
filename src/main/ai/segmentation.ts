import path from 'node:path'
import sharp from 'sharp'
import { AI_MODELS, loadSession, ort } from './models'

// ImageNet 归一化，与 BiRefNet 训练一致
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

// BiRefNet_lite 主体分割：输入任意尺寸图片，返回原尺寸 0-255 软 alpha 蒙版
export async function segmentSubject(input: {
  imagePath: string
  width: number
  height: number
  modelsDirectory: string
}): Promise<Uint8Array> {
  const { inputSize, file } = AI_MODELS.segmentation
  // CoreML 对该模型的编译耗时不可控（实测 10 分钟以上），CPU 推理 1024² 约 7s，直接用 CPU
  const session = await loadSession(path.join(input.modelsDirectory, file), ['cpu'])
  const rgb = await sharp(input.imagePath)
    .resize(inputSize, inputSize, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const plane = inputSize * inputSize
  const chw = new Float32Array(3 * plane)
  for (let channel = 0; channel < 3; channel += 1) {
    for (let index = 0; index < plane; index += 1) {
      chw[channel * plane + index] = (rgb[index * 3 + channel] / 255 - MEAN[channel]) / STD[channel]
    }
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', chw, [1, 3, inputSize, inputSize]) }
  const results = await session.run(feeds)
  const output = results[session.outputNames[session.outputNames.length - 1]]
  const values = output.data as Float32Array
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (let index = 0; index < plane; index += 1) {
    if (values[index] < minimum) minimum = values[index]
    if (values[index] > maximum) maximum = values[index]
  }
  // 导出模型可能带或不带 sigmoid，按输出范围自适应
  const needSigmoid = minimum < -0.01 || maximum > 1.01
  const alpha = Buffer.alloc(plane)
  for (let index = 0; index < plane; index += 1) {
    const value = needSigmoid ? 1 / (1 + Math.exp(-values[index])) : values[index]
    alpha[index] = Math.max(0, Math.min(255, Math.round(value * 255)))
  }
  // resize 会把单通道图升为 sRGB 三通道，必须显式转回 b-w 单通道
  const { data: restored, info } = await sharp(alpha, { raw: { width: inputSize, height: inputSize, channels: 1 } })
    .resize(input.width, input.height, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 1 || restored.length !== input.width * input.height) {
    throw new Error(`分割蒙版通道异常：channels=${info.channels} length=${restored.length}`)
  }
  return new Uint8Array(restored)
}
