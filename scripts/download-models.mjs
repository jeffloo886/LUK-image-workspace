// 开发期一次性拉取图片转 PSD 所需的 AI 模型到 resources/ai-models/。
// 构建安装包前须先执行：npm run download:models
// 模型不进 git，经 electron-builder extraResources 打进安装包。
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']

const MODELS = [
  {
    // fp32 版：onnxruntime-node 尚不支持 float16 输入张量，fp16 版喂不进去
    file: 'birefnet_lite_fp32.onnx',
    repoPath: 'onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx',
    sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
    size: 224005088
  },
  {
    file: 'lama_fp32.onnx',
    repoPath: 'Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    size: 208044816
  },
  {
    // 文字检测：优先 npm 包镜像；HF 备用
    file: 'ch_PP-OCRv4_det_infer.onnx',
    // 通过 npm tarball 内路径不可直接 URL；使用 jsDelivr npm 包内文件
    directUrls: [
      'https://cdn.jsdelivr.net/npm/paddle-ocr-onnx-models@0.2.0/models/ch_PP-OCRv4_det_infer.onnx',
      'https://unpkg.com/paddle-ocr-onnx-models@0.2.0/models/ch_PP-OCRv4_det_infer.onnx'
    ],
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
    size: 4745517
  }
]

const targetDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'ai-models')

async function sha256Of(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function alreadyDone(model) {
  const filePath = path.join(targetDirectory, model.file)
  try {
    const info = await stat(filePath)
    if (info.size !== model.size) return false
    return (await sha256Of(filePath)) === model.sha256
  } catch {
    return false
  }
}

async function downloadOne(model) {
  const filePath = path.join(targetDirectory, model.file)
  if (await alreadyDone(model)) {
    console.log(`✓ ${model.file} 已存在且校验通过，跳过`)
    return
  }
  let lastError = null
  const urls = Array.isArray(model.directUrls)
    ? [...model.directUrls]
    : MIRRORS.map((mirror) => `${mirror}/${model.repoPath}`)
  for (const url of urls) {
    const partPath = `${filePath}.part`
    try {
      console.log(`↓ ${model.file} ← ${url}`)
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partPath))
      const digest = await sha256Of(partPath)
      if (digest !== model.sha256) throw new Error(`sha256 不匹配：${digest}`)
      await rename(partPath, filePath)
      console.log(`✓ ${model.file} 下载完成（${(model.size / 1024 / 1024).toFixed(1)}MB）`)
      return
    } catch (error) {
      lastError = error
      await rm(partPath, { force: true })
      console.warn(`  失败：${error.message}`)
    }
  }
  throw new Error(`${model.file} 所有镜像下载失败：${lastError?.message}`)
}

await mkdir(targetDirectory, { recursive: true })
for (const model of MODELS) await downloadOne(model)
console.log('全部模型就绪：', targetDirectory)
