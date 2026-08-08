/*
 * AI 模型清单 —— 纯数据 + 零重型依赖（只用 node 内建）。
 *
 * 单独成文件的原因：主进程冷启动时要判断模型是否就绪、要做播种/修复，
 * 但这些都不该把 38.8MB 的 onnxruntime dylib 一起 dlopen 进来。
 * onnxruntime 只在 ai-worker（fork 出去的子进程）里通过 models.ts 加载。
 *
 * sha256 / size / 下载源与 scripts/download-models.mjs 保持一致，改一处要同步另一处。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

export const MODEL_MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']

export type ModelSpec = {
  file: string
  size: number
  sha256: string
  inputSize: number
  /** HuggingFace 镜像下的相对路径；与 directUrls 二选一 */
  repoPath?: string
  /** 直链（npm CDN 之类无法拼镜像路径的情况） */
  directUrls?: string[]
}

export const AI_MODELS = {
  segmentation: {
    file: 'birefnet_lite_fp32.onnx',
    size: 224005088,
    sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
    inputSize: 1024,
    repoPath: 'onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx'
  },
  inpaint: {
    file: 'lama_fp32.onnx',
    size: 208044816,
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    inputSize: 512,
    repoPath: 'Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx'
  },
  // PP-OCRv4 中文检测（DBNet），Apache-2.0；来自 paddle-ocr-onnx-models / RapidOCR 再分发
  textDetection: {
    file: 'ch_PP-OCRv4_det_infer.onnx',
    size: 4745517,
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
    inputSize: 960,
    directUrls: [
      'https://cdn.jsdelivr.net/npm/paddle-ocr-onnx-models@0.2.0/models/ch_PP-OCRv4_det_infer.onnx',
      'https://unpkg.com/paddle-ocr-onnx-models@0.2.0/models/ch_PP-OCRv4_det_infer.onnx'
    ]
  }
} as const satisfies Record<string, ModelSpec>

export const AI_MODEL_LIST: ModelSpec[] = Object.values(AI_MODELS)

export const AI_MODELS_TOTAL_BYTES = AI_MODEL_LIST.reduce((sum, model) => sum + model.size, 0)

export type AiModelStatus = {
  ready: boolean
  missing: string[]
}

/** 启动自检：只核对存在性与字节数（全量哈希太慢，放到播种/修复时做）。 */
export async function checkAiModels(directory: string): Promise<AiModelStatus> {
  const missing: string[] = []
  for (const model of AI_MODEL_LIST) {
    try {
      const info = await stat(path.join(directory, model.file))
      if (info.size !== model.size) missing.push(`${model.file}（文件不完整）`)
    } catch {
      missing.push(model.file)
    }
  }
  return { ready: missing.length === 0, missing }
}

/** 流式 sha256，避免把 200MB 文件整个读进内存。 */
export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 拼出某个模型的候选下载地址列表（directUrls 优先，否则镜像 × repoPath）。 */
export function downloadUrlsFor(model: ModelSpec): string[] {
  if (model.directUrls?.length) return [...model.directUrls]
  if (model.repoPath) return MODEL_MIRRORS.map((mirror) => `${mirror}/${model.repoPath}`)
  return []
}
