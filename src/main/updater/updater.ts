/*
 * 自建更新器（无 Apple Developer ID，绕开 Squirrel.Mac）。
 *
 * 流程：latest.json → 版本比较 → 下载 zip（进度 + sha256 + Ed25519 验签）→
 * ditto 解压到暂存 → 校验 Info.plist → 前置检查 → detached 替换脚本 → 退出重启。
 *
 * 安全前提直说：没有代码签名可依赖，Ed25519 验签是唯一锚点，防的是「篡改的更新包」，
 * 防不了「已在本机的恶意软件改 App」。这是不买证书的既定代价。
 */
import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { createVerify, verify as edVerify } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  EXPECTED_BUNDLE_ID,
  UPDATE_KEY_IS_PLACEHOLDER,
  UPDATE_MANIFEST_URL,
  UPDATE_PUBLIC_KEY_PEM,
  UPDATE_RELEASES_PAGE
} from './keys'
import { sha256OfFile } from '../ai/modelsManifest'

const execFileAsync = promisify(execFile)

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'staged'
  | 'applying'
  | 'up-to-date'
  | 'error'

export type UpdaterState = {
  phase: UpdaterPhase
  /** 远端版本（available 起有意义） */
  version?: string
  notes?: string
  /** 下载进度 0–100 */
  progress?: number
  message?: string
  /** 无法自动更新时给用户的手动下载地址 */
  releasePage?: string
}

type LatestManifest = {
  version: string
  notes?: string
  url: string
  sha256: string
  size: number
  signature: string
}

let state: UpdaterState = { phase: 'idle' }
let stagedAppPath: string | null = null
let stagedManifest: LatestManifest | null = null
let inFlight = false
const listeners = new Set<(s: UpdaterState) => void>()

function setState(next: UpdaterState): void {
  state = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch {
      // 忽略监听器异常
    }
  }
}

export function getUpdaterState(): UpdaterState {
  return state
}

export function onUpdaterState(listener: (s: UpdaterState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 严格 semver 比较：a>b → 1，a<b → -1，相等 → 0。只认 x.y.z，忽略预发布标签。 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

/** .app bundle 路径（app.getPath('exe') = .../Contents/MacOS/xxx，上溯三级即 .app）。 */
function bundlePath(): string {
  return path.resolve(app.getPath('exe'), '..', '..', '..')
}

function updaterWorkDir(): string {
  return path.join(app.getPath('userData'), 'updater')
}

function verifySignature(manifest: LatestManifest): boolean {
  if (UPDATE_KEY_IS_PLACEHOLDER) return false
  const message = Buffer.from(`${manifest.version}\n${manifest.sha256}\n${manifest.size}`, 'utf8')
  try {
    const signature = Buffer.from(manifest.signature, 'base64')
    // Ed25519：algorithm 传 null，key 用 PEM
    return edVerify(null, message, UPDATE_PUBLIC_KEY_PEM, signature)
  } catch {
    // 兜底：某些 Node 版本对 Ed25519 走 createVerify 路径
    try {
      const verifier = createVerify('sha512')
      verifier.update(message)
      verifier.end()
      return verifier.verify(UPDATE_PUBLIC_KEY_PEM, Buffer.from(manifest.signature, 'base64'))
    } catch {
      return false
    }
  }
}

export async function checkForUpdates(manual: boolean): Promise<UpdaterState> {
  if (inFlight) return state
  // 占位公钥时自动检查静默跳过；手动检查明确告知
  if (UPDATE_KEY_IS_PLACEHOLDER) {
    const result: UpdaterState = manual
      ? { phase: 'error', message: '更新签名公钥尚未配置，暂无法检查更新', releasePage: UPDATE_RELEASES_PAGE }
      : { phase: 'idle' }
    if (manual) setState(result)
    return result
  }

  setState({ phase: 'checking' })
  try {
    const response = await fetch(UPDATE_MANIFEST_URL, { redirect: 'follow', cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const manifest = (await response.json()) as LatestManifest
    if (!manifest?.version || !manifest.url || !manifest.sha256 || !manifest.signature) {
      throw new Error('更新信息格式异常')
    }

    if (!verifySignature(manifest)) {
      setState({ phase: 'error', message: '更新签名校验失败，已拒绝', releasePage: UPDATE_RELEASES_PAGE })
      return state
    }

    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      const result: UpdaterState = { phase: 'up-to-date', version: app.getVersion() }
      if (manual) setState(result)
      else setState({ phase: 'idle' })
      return result
    }

    stagedManifest = manifest
    setState({ phase: 'available', version: manifest.version, notes: manifest.notes, releasePage: UPDATE_RELEASES_PAGE })
    return state
  } catch (error) {
    const result: UpdaterState = {
      phase: 'error',
      message: `检查更新失败：${(error as Error).message}`,
      releasePage: UPDATE_RELEASES_PAGE
    }
    // 自动检查失败保持静默（不打扰用户），手动检查才落地为错误态
    if (manual) setState(result)
    else setState({ phase: 'idle' })
    return result
  }
}

export async function downloadUpdate(): Promise<UpdaterState> {
  if (inFlight || !stagedManifest) return state
  const manifest = stagedManifest
  inFlight = true
  const workDir = updaterWorkDir()

  try {
    await mkdir(workDir, { recursive: true })
    const zipPath = path.join(workDir, `update-${manifest.version}.zip`)
    const partPath = `${zipPath}.part`
    await rm(partPath, { force: true })

    setState({ phase: 'downloading', version: manifest.version, progress: 0 })
    const response = await fetch(manifest.url, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`)

    const total = Number(response.headers.get('content-length') || manifest.size)
    let received = 0
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      const progress = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0
      setState({ phase: 'downloading', version: manifest.version, progress })
      BrowserWindow.getAllWindows()[0]?.setProgressBar(progress / 100)
    })
    await pipeline(source, createWriteStream(partPath))
    BrowserWindow.getAllWindows()[0]?.setProgressBar(-1)

    // 完整性：大小 + sha256（签名已在 check 阶段验过，此处再核对内容一致）
    const info = await stat(partPath)
    if (info.size !== manifest.size) throw new Error('下载大小不符')
    if ((await sha256OfFile(partPath)) !== manifest.sha256) throw new Error('下载校验失败')
    await rename(partPath, zipPath)

    // 解压：必须 ditto，adm-zip/yauzl 会毁掉 framework 的 Versions/Current 符号链接
    const stagingRoot = await mkdtemp(path.join(workDir, 'staging-'))
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, stagingRoot])
    const stagedApp = await findAppBundle(stagingRoot)
    if (!stagedApp) throw new Error('更新包内未找到 .app')

    // 校验暂存包身份，防止装错东西
    const bundleId = await plistValue(stagedApp, 'CFBundleIdentifier')
    if (bundleId !== EXPECTED_BUNDLE_ID) throw new Error('更新包身份不符，已拒绝')
    const bundleVersion = await plistValue(stagedApp, 'CFBundleShortVersionString')
    if (bundleVersion !== manifest.version) throw new Error('更新包版本与预期不符')

    stagedAppPath = stagedApp
    await rm(zipPath, { force: true })
    setState({ phase: 'staged', version: manifest.version })
    return state
  } catch (error) {
    BrowserWindow.getAllWindows()[0]?.setProgressBar(-1)
    setState({ phase: 'error', message: (error as Error).message, releasePage: UPDATE_RELEASES_PAGE })
    return state
  } finally {
    inFlight = false
  }
}

async function findAppBundle(dir: string): Promise<string | null> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir, { withFileTypes: true })
  const direct = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (direct) return path.join(dir, direct.name)
  return null
}

async function plistValue(appBundle: string, key: string): Promise<string> {
  const plist = path.join(appBundle, 'Contents', 'Info.plist')
  const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Print:${key}`, plist])
  return stdout.trim()
}

type PreflightResult = { ok: true; bundle: string } | { ok: false; message: string; releasePage?: boolean }

async function preflight(): Promise<PreflightResult> {
  if (!app.isPackaged) return { ok: false, message: '开发模式不支持自更新' }

  const bundle = bundlePath()
  const realBundle = await realpath(bundle).catch(() => bundle)

  // App Translocation：被隔离时从只读随机路径运行，替换必然失败
  if (realBundle.includes('/AppTranslocation/') || realBundle.includes('/private/var/folders/')) {
    return { ok: false, message: '应用正在从只读的临时位置运行，请拖到「应用程序」后重新打开', releasePage: true }
  }

  // 只允许在 /Applications 或 ~/Applications 下更新
  const home = app.getPath('home')
  const inApplications =
    realBundle.startsWith('/Applications/') || realBundle.startsWith(path.join(home, 'Applications') + path.sep)
  if (!inApplications) {
    return { ok: false, message: '请先把应用放进「应用程序」文件夹再更新', releasePage: true }
  }

  // 写权限探针：真建一个临时目录（fs.access 在 ACL 下会说谎）
  const probe = path.join(path.dirname(realBundle), `.workspace-write-probe-${process.pid}`)
  try {
    await mkdir(probe)
    await rm(probe, { recursive: true, force: true })
  } catch {
    return { ok: false, message: '没有「应用程序」文件夹的写入权限，请用管理员账号，或手动下载安装', releasePage: true }
  }

  return { ok: true, bundle: realBundle }
}

export async function applyUpdate(): Promise<UpdaterState> {
  if (!stagedAppPath) {
    setState({ phase: 'error', message: '没有可应用的更新' })
    return state
  }
  const check = await preflight()
  if (!check.ok) {
    setState({ phase: 'error', message: check.message, releasePage: check.releasePage ? UPDATE_RELEASES_PAGE : undefined })
    return state
  }

  setState({ phase: 'applying', version: stagedManifest?.version })

  const workDir = updaterWorkDir()
  const scriptPath = path.join(workDir, 'swap.sh')
  // 路径全部经环境变量传入，绝不拼进脚本文本（产品名非 ASCII、可能含引号）
  const script = `#!/bin/bash
set -euo pipefail

BACKUP="\${APP_PATH}.old-$$"
cleanup_fail() {
  # 回滚：新包没到位就把旧包搬回来
  if [ ! -d "\${APP_PATH}" ] && [ -d "\${BACKUP}" ]; then
    mv "\${BACKUP}" "\${APP_PATH}" || true
  fi
  echo "swap-failed" > "\${MARKER}" || true
  open "\${APP_PATH}" || true
  exit 1
}
trap cleanup_fail ERR

# 等旧进程退出（最多 30s）
for _ in $(seq 1 60); do
  if ! kill -0 "\${APP_PID}" 2>/dev/null; then break; fi
  sleep 0.5
done

mv "\${APP_PATH}" "\${BACKUP}"
/usr/bin/ditto "\${STAGED_APP}" "\${APP_PATH}"
rm -rf "\${BACKUP}"
/usr/bin/xattr -dr com.apple.quarantine "\${APP_PATH}" || true
rm -f "\${MARKER}" || true
open "\${APP_PATH}"
`

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    await chmod(workDir, 0o700)
    await writeFile(scriptPath, script, { mode: 0o700 })
    await writeFile(path.join(workDir, 'pending-update.json'), JSON.stringify({ version: stagedManifest?.version, at: Date.now() }))

    const { spawn } = await import('node:child_process')
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        APP_PATH: check.bundle,
        STAGED_APP: stagedAppPath,
        APP_PID: String(process.pid),
        MARKER: path.join(workDir, 'swap-status')
      }
    })
    child.unref()

    // 交棒给脚本后退出（不能 app.relaunch —— 它会重执行正被替换的路径）
    setTimeout(() => app.quit(), 300)
    return state
  } catch (error) {
    setState({ phase: 'error', message: `应用更新失败：${(error as Error).message}` })
    return state
  }
}

/** 启动时清理上一轮更新的残留，并感知回滚。 */
export async function reconcilePendingUpdate(): Promise<void> {
  const workDir = updaterWorkDir()
  const marker = path.join(workDir, 'swap-status')
  try {
    const status = await readFile(marker, 'utf8').catch(() => '')
    if (status.includes('swap-failed')) {
      setState({ phase: 'error', message: '上次更新未完成，已回滚到当前版本' })
    }
    await rm(marker, { force: true })
    await rm(path.join(workDir, 'pending-update.json'), { force: true })
    // 清掉暂存目录，避免 userData 堆积
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(workDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('staging-')) {
        await rm(path.join(workDir, entry.name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  } catch {
    // 清理失败无所谓
  }
}
