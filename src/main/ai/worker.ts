// 独立子进程入口：通过 ELECTRON_RUN_AS_NODE 以纯 Node 模式运行（见 workerClient.ts），
// 彻底脱离 Electron/Chromium 主进程的内存分配器，避免 onnxruntime 原生大块对齐分配与
// Chromium malloc 分配器冲突导致的 EXC_BREAKPOINT 硬崩溃（该崩溃曾在主进程内实测复现）。
import { inpaintImage } from './inpaint'
import { segmentSubject } from './segmentation'
import { detectTextBoxes } from './textDetect'

type SegmentRequest = { id: number; kind: 'segment'; imagePath: string; width: number; height: number; modelsDirectory: string }
type InpaintRequest = {
  id: number
  kind: 'inpaint'
  source: Uint8Array
  mask: Uint8Array
  width: number
  height: number
  modelsDirectory: string
}
type TextDetectRequest = {
  id: number
  kind: 'text-detect'
  imagePath: string
  width: number
  height: number
  modelsDirectory: string
}
type Request = SegmentRequest | InpaintRequest | TextDetectRequest

process.on('message', async (request: Request) => {
  try {
    if (request.kind === 'segment') {
      const alpha = await segmentSubject(request)
      process.send?.({ id: request.id, ok: true, alpha })
    } else if (request.kind === 'text-detect') {
      const regions = await detectTextBoxes(request)
      process.send?.({ id: request.id, ok: true, regions })
    } else {
      const result = await inpaintImage(request)
      process.send?.({ id: request.id, ok: true, result: Uint8Array.from(result) })
    }
  } catch (error) {
    process.send?.({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

process.send?.({ ready: true })
