/*
 * 模型存放与首启播种。
 *
 * 安装包自带 417MB 模型（装完即用），但更新包不含模型。若把模型一直留在
 * .app 里，每次自建更新的整包替换都要重下 417MB。所以首启时把模型「播种」到
 * userData（与 session.json/settings.json 同处），之后解析优先走那里，
 * 更新只替换程序壳、模型原地不动。
 *
 * 关键原则：bundle 始终当只读。绝不 rename 出 bundle（非管理员写不了 /Applications、
 * 外置盘跨卷失败、中断留半残 bundle），只做「拷贝 + 校验」。删除 bundle 副本是
 * best-effort，且只在下次启动 init 时做——绝不在播种后立刻删，避免删掉某个正在
 * 被推理任务读取的路径。
 */
import { app } from 'electron'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  AI_MODELS_TOTAL_BYTES,
  AI_MODEL_LIST,
  checkAiModels,
  downloadUrlsFor,
  sha256OfFile,
  type ModelSpec
} from './modelsManifest'

export type ModelStorePhase = 'checking' | 'seeding' | 'ready' | 'repairing' | 'error'
export type ModelStoreStatus = {
  phase: ModelStorePhase
  message?: string
  /** 0–100，仅 seeding/repairing 阶段有意义 */
  progress?: number
}
type StatusListener = (status: ModelStoreStatus) => void

function bundleModelsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ai-models')
    : path.join(app.getAppPath(), 'resources', 'ai-models')
}

function userModelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}

// 解析结果缓存。初始指向 bundle（永远有效的兜底），init/播种成功后切到 userData。
let activeModelsDir = bundleModelsDir()
let currentStatus: ModelStoreStatus = { phase: 'checking' }
const listeners = new Set<StatusListener>()

export function resolveModelsDir(): string {
  return activeModelsDir
}

export function getModelStoreStatus(): ModelStoreStatus {
  return currentStatus
}

export function onModelStoreStatus(listener: StatusListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(status: ModelStoreStatus): void {
  currentStatus = status
  for (const listener of listeners) {
    try {
      listener(status)
    } catch {
      // 监听器抛错不能影响播种主流程
    }
  }
}

/** 逐文件：拷贝到 .part → fsync → 校验大小与 sha256 → 原子改名。全程可重入。 */
async function seedOneModel(model: ModelSpec, fromDir: string, toDir: string): Promise<void> {
  const source = path.join(fromDir, model.file)
  const target = path.join(toDir, model.file)
  const partial = `${target}.part`

  await copyFile(source, partial)
  // copyFile 不落盘，rename 前 fsync，避免断电后留下看似完整实则未落盘的文件
  const handle = await open(partial, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }

  const info = await stat(partial)
  if (info.size !== model.size) {
    await rm(partial, { force: true })
    throw new Error(`${model.file} 大小不符（${info.size} ≠ ${model.size}）`)
  }
  if ((await sha256OfFile(partial)) !== model.sha256) {
    await rm(partial, { force: true })
    throw new Error(`${model.file} 校验失败`)
  }
  await rename(partial, target)
}

/** 剩余空间够不够放下全部模型（留 10% 余量）。 */
async function hasRoomFor(dir: string, bytes: number): Promise<boolean> {
  try {
    const fsInfo = await statfs(dir)
    return fsInfo.bavail * fsInfo.bsize >= bytes * 1.1
  } catch {
    return true // statfs 拿不到就别拦着，后续按文件校验兜底
  }
}

/**
 * 启动时调用：确定模型目录并在需要时后台播种。
 * 返回 Promise 但不必 await——UI 通过状态回调感知进度。
 */
export async function initAndSeedModels(): Promise<void> {
  const userDir = userModelsDir()

  // 1. userData 已就绪 —— 直接用它，并顺手把 bundle 里的冗余副本删掉（此刻无任务在跑，安全）
  if ((await checkAiModels(userDir)).ready) {
    activeModelsDir = userDir
    emit({ phase: 'ready' })
    void tryReclaimBundleCopy()
    return
  }

  // 2. userData 未就绪，从 bundle 播种
  const bundleDir = bundleModelsDir()
  if (!(await checkAiModels(bundleDir)).ready) {
    // bundle 也没有（例如更新包剥离了模型且从未播种）—— 停在 bundle 路径，交给「修复模型」
    activeModelsDir = bundleDir
    emit({ phase: 'error', message: '模型缺失，可在设置里重新校验/修复' })
    return
  }

  emit({ phase: 'seeding', progress: 0, message: '首次准备模型…' })
  try {
    await mkdir(userDir, { recursive: true })
    if (!(await hasRoomFor(userDir, AI_MODELS_TOTAL_BYTES))) {
      // 空间不足：留在 bundle，功能照常，只是没省下空间
      activeModelsDir = bundleDir
      emit({ phase: 'ready', message: '磁盘空间不足，模型暂留安装包内' })
      return
    }

    let done = 0
    for (const model of AI_MODEL_LIST) {
      // 单个文件可能上一轮已播种过，跳过省时间
      const existing = path.join(userDir, model.file)
      const alreadyOk = await stat(existing)
        .then((s) => s.size === model.size)
        .catch(() => false)
      if (!alreadyOk) await seedOneModel(model, bundleDir, userDir)
      done += 1
      emit({ phase: 'seeding', progress: Math.round((done / AI_MODEL_LIST.length) * 100) })
    }

    await writeFile(path.join(userDir, 'manifest.json'), JSON.stringify({ version: 1, seededAt: Date.now() }))
    activeModelsDir = userDir
    emit({ phase: 'ready' })
    // 注意：本次不删 bundle 副本，可能已有任务捕获了它的路径；留给下次启动的 init 清理
  } catch (error) {
    // 播种失败不致命：回落 bundle，功能不受影响
    activeModelsDir = bundleDir
    emit({ phase: 'ready', message: (error as Error).message })
  }
}

/** best-effort 删 bundle 内模型副本；非管理员/只读卷会 EACCES/EROFS，吞掉即可。 */
async function tryReclaimBundleCopy(): Promise<void> {
  // 开发态下 "bundle" 是源码树的 resources/ai-models，绝不能删
  if (!app.isPackaged) return
  const bundleDir = bundleModelsDir()
  if (bundleDir === userModelsDir()) return
  for (const model of AI_MODEL_LIST) {
    await rm(path.join(bundleDir, model.file), { force: true }).catch(() => undefined)
  }
}

/**
 * 修复模型：从镜像重新下载缺失/损坏的文件到 userData。
 * 用于「播种失败 + 更新包不含模型」这种否则无法自救的死局。
 */
export async function repairModels(): Promise<ModelStoreStatus> {
  const userDir = userModelsDir()
  await mkdir(userDir, { recursive: true })
  emit({ phase: 'repairing', progress: 0, message: '正在下载模型…' })

  let done = 0
  for (const model of AI_MODEL_LIST) {
    const target = path.join(userDir, model.file)
    const ok = await stat(target)
      .then((s) => s.size === model.size)
      .catch(() => false)
    if (!ok) {
      try {
        await downloadOneModel(model, userDir)
      } catch (error) {
        const status: ModelStoreStatus = { phase: 'error', message: `${model.file} 下载失败：${(error as Error).message}` }
        emit(status)
        return status
      }
    }
    done += 1
    emit({ phase: 'repairing', progress: Math.round((done / AI_MODEL_LIST.length) * 100) })
  }

  activeModelsDir = userDir
  const status: ModelStoreStatus = { phase: 'ready' }
  emit(status)
  return status
}

async function downloadOneModel(model: ModelSpec, toDir: string): Promise<void> {
  const target = path.join(toDir, model.file)
  const partial = `${target}.part`
  let lastError: unknown = null
  for (const url of downloadUrlsFor(model)) {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(partial))
      if ((await sha256OfFile(partial)) !== model.sha256) throw new Error('sha256 不匹配')
      await rename(partial, target)
      return
    } catch (error) {
      lastError = error
      await rm(partial, { force: true }).catch(() => undefined)
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : '全部镜像失败')
}

/** 设置页展示用：userData 里实际占用的模型字节数。 */
export async function modelsDiskUsage(): Promise<number> {
  const userDir = userModelsDir()
  let total = 0
  for (const model of AI_MODEL_LIST) {
    total += await stat(path.join(userDir, model.file))
      .then((s) => s.size)
      .catch(() => 0)
  }
  return total
}

export async function currentModelStatus(): Promise<{ ready: boolean; missing: string[] }> {
  return checkAiModels(activeModelsDir)
}

// 设置页「重新校验」：逐文件核对 sha256（比启动自检的仅比大小更严格）
export async function verifyModelsThorough(): Promise<{ ok: boolean; corrupt: string[] }> {
  const corrupt: string[] = []
  for (const model of AI_MODEL_LIST) {
    const target = path.join(activeModelsDir, model.file)
    const sizeOk = await stat(target)
      .then((s) => s.size === model.size)
      .catch(() => false)
    if (!sizeOk || (await sha256OfFile(target).catch(() => '')) !== model.sha256) {
      corrupt.push(model.file)
    }
  }
  return { ok: corrupt.length === 0, corrupt }
}
