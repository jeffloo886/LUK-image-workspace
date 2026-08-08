import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'

type PendingEntry = { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }

let child: ChildProcess | null = null
let nextId = 1
const pending = new Map<number, PendingEntry>()
// 质量优先：多遍 LaMa + 边缘精修可能超过 3 分钟
const REQUEST_TIMEOUT_MS = 600_000

function workerScriptPath(): string {
  return path.join(app.getAppPath(), 'out', 'main', 'ai-worker.js')
}

function rejectAllPending(error: Error): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout)
    entry.reject(error)
  }
  pending.clear()
}

function ensureWorker(): ChildProcess {
  if (child) return child
  // ELECTRON_RUN_AS_NODE 让打包的 Electron 二进制（process.execPath，fork 默认使用）
  // 以纯 Node 模式跑子进程脚本，不初始化 Chromium，从而绕开与 onnxruntime 原生分配器的冲突
  const proc = fork(workerScriptPath(), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
    serialization: 'advanced'
  })
  proc.stdout?.on('data', (chunk) => process.stdout.write(`[ai-worker] ${chunk}`))
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[ai-worker] ${chunk}`))
  proc.on('message', (message: any) => {
    if (message?.ready) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timeout)
    if (message.ok) entry.resolve(message)
    else entry.reject(new Error(message.error || 'AI 推理子进程返回错误'))
  })
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null
    rejectAllPending(new Error(`AI 推理子进程异常退出（code=${code}, signal=${signal}）`))
  })
  proc.on('error', (error) => {
    if (child === proc) child = null
    rejectAllPending(error)
  })
  child = proc
  return proc
}

function call<T>(request: Record<string, unknown>): Promise<T> {
  const proc = ensureWorker()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('AI 推理子进程超时'))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timeout })
    proc.send({ id, ...request })
  })
}

export async function segmentSubjectRemote(input: {
  imagePath: string
  width: number
  height: number
  modelsDirectory: string
}): Promise<Uint8Array> {
  const response = await call<{ alpha: Uint8Array }>({ kind: 'segment', ...input })
  return response.alpha instanceof Uint8Array ? response.alpha : new Uint8Array(response.alpha)
}

export async function inpaintImageRemote(input: {
  source: Uint8Array
  mask: Uint8Array
  width: number
  height: number
  modelsDirectory: string
}): Promise<Uint8ClampedArray> {
  const response = await call<{ result: Uint8Array }>({ kind: 'inpaint', ...input })
  return new Uint8ClampedArray(response.result)
}

export async function detectTextBoxesRemote(input: {
  imagePath: string
  width: number
  height: number
  modelsDirectory: string
}): Promise<Array<{ x: number; y: number; width: number; height: number; confidence: number; text: string }>> {
  const response = await call<{ regions: Array<{ x: number; y: number; width: number; height: number; confidence: number; text: string }> }>({
    kind: 'text-detect',
    ...input
  })
  return Array.isArray(response.regions) ? response.regions : []
}

export function shutdownAiWorker(): void {
  child?.kill()
  child = null
}
