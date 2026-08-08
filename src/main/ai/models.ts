import ort from 'onnxruntime-node'

// 清单与自检移到 modelsManifest.ts（零重型依赖），这里只保留会拖入 onnxruntime 的部分。
// worker 里的 segmentation/inpaint/textDetect 仍从本文件取 AI_MODELS，故在此转出。
export { AI_MODELS, checkAiModels, type AiModelStatus } from './modelsManifest'

const sessionCache = new Map<string, Promise<ort.InferenceSession>>()

export function loadSession(modelPath: string, executionProviders: string[]): Promise<ort.InferenceSession> {
  const cached = sessionCache.get(modelPath)
  if (cached) return cached
  const pending = (async () => {
    let lastError: unknown = null
    for (const provider of executionProviders) {
      try {
        return await ort.InferenceSession.create(modelPath, {
          executionProviders: [provider],
          graphOptimizationLevel: 'all',
          // 关闭内存池分配器：在 Electron 主进程里与 Chromium 的 malloc 分配器共存时，
          // BFCArena 的大块对齐扩容曾实测触发 EXC_BREAKPOINT 硬崩溃；改用简单分配器规避
          enableCpuMemArena: false,
          intraOpNumThreads: 1,
          interOpNumThreads: 1
        })
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Unable to create the ONNX inference session')
  })()
  pending.catch(() => sessionCache.delete(modelPath))
  sessionCache.set(modelPath, pending)
  return pending
}

export { ort }
