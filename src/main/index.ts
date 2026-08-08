import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, Notification, powerMonitor, safeStorage, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import sharp from 'sharp'
import { checkAiModels } from './ai/modelsManifest'
import {
  getModelStoreStatus,
  initAndSeedModels,
  modelsDiskUsage,
  onModelStoreStatus,
  repairModels,
  resolveModelsDir,
  verifyModelsThorough,
  type ModelStoreStatus
} from './ai/modelStore'
import { shutdownAiWorker } from './ai/workerClient'
import { buildApplicationMenu } from './appMenu'
import {
  applyUpdate,
  checkForUpdates as runUpdateCheck,
  downloadUpdate,
  getUpdaterState,
  onUpdaterState,
  reconcilePendingUpdate,
  type UpdaterState
} from './updater/updater'
import { loadWindowState, trackWindowState } from './windowState'
import { cacheLocalCropScene, compositeLocalCrop, featherForCropSize } from './localCrop'
import {
  closePhotopeaEditor,
  disposePhotopeaEditor,
  markPhotopeaHostReady,
  openPhotopeaEditor,
  reportPhotopeaHostError,
  savePhotopeaDocument,
  type PhotopeaOpenPayload,
  type PhotopeaSavePayload
} from './photopea'
import {
  preparePsdDraft,
  processImageToPsd,
  uniquePsdPath,
  type PsdProcessOptions
} from './psd'

type DesktopSettings = {
  outputDirectory: string
  autoDownload: boolean
  theme: 'dark' | 'light' | 'system'
  greetingName: string
  generationProviderId: number
  generationSize: string
  generationQuality: string
  generationResolution: string
  generationCount: number
  siteUrl: string
}

type SelectedImage = {
  id: string
  name: string
  type: string
  size: number
  previewDataUrl: string
}

type ApiRequestPayload = {
  path: string
  method?: 'GET' | 'POST'
  token?: string
  json?: Record<string, unknown>
  file?: {
    name: string
    type: string
    bytes: ArrayBuffer
  }
}

type DesktopSession = {
  token: string
  user: Record<string, unknown>
}

/*
 * 后端地址与租户号：仓库不内置任何特定线上服务地址。
 * 默认为占位符——不配置时应用无法真正调用生成服务（登录/积分/生成/充值）。
 * 运行前可通过环境变量覆盖，或直接修改下面两个常量指向自己的后端。
 */
const API_BASE_URL = process.env.IMAGE_WORKSPACE_API_BASE_URL?.trim() || 'https://api.example.com'
const TENANT_SN = process.env.IMAGE_WORKSPACE_TENANT_SN?.trim() || 'YOUR_TENANT_SN'
const ALLOWED_API_PATHS = new Set([
  '/api/app.image2.service/getConfig',
  '/api/app.image2.generate/providers',
  '/api/app.image2.generate/rewrite',
  '/api/app.image2.auth/login',
  '/api/app.image2.auth/wechatAuthUrl',
  '/api/app.image2.auth/wechatLoginPoll',
  '/api/app.image2.user/stats',
  '/api/app.image2.user/overview',
  // 微信扫码充值：套餐列表 → Native 下单 → 轮询到账
  '/api/app.image2.package/lists',
  '/api/app.image2.order/create',
  '/api/app.image2.order/payStatus',
  '/api/app.image2.upload/image',
  '/api/app.image2.generate/create',
  '/api/app.image2.task/poll',
  '/api/app.image2.task/detail',
  '/api/app.image2.task/history',
  '/api/app.image2.task/delete',
  '/api/app.image2.task/deleteFailed'
])

const APP_NAME = 'AI 图像工作台'
const rendererDirectory = path.dirname(fileURLToPath(import.meta.url))
const selectedFiles = new Map<string, string>()
const generatedPsdFiles = new Set<string>()
const generatedLocalCropFiles = new Set<string>()
const localCropSceneByTask = new Map<number, string>()
let mainWindow: BrowserWindow | null = null
let releaseWindowStateTracker: (() => void) | null = null
let currentThemeSetting: DesktopSettings['theme'] = 'light'

function defaultOutputDirectory(): string {
  return path.join(homedir(), 'Documents', 'AI-Image-Workspace')
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function sessionPath(): string {
  return path.join(app.getPath('userData'), 'session.json')
}

/*
 * 开发期登录旁路：登录门禁会挡住所有界面 QA（动画、间距这类改动根本看不到）。
 * 双重闸门 —— 必须同时是未打包的开发构建且显式设置环境变量，打包后永远不生效。
 * 注意 token 是假的，任何真实接口调用都会失败，这只用于验证界面。
 */
function devFakeSession(): DesktopSession | null {
  if (app.isPackaged || process.env.IMAGE_WORKSPACE_DEV_FAKE_SESSION !== '1') return null
  return {
    token: 'dev-fake-token',
    user: { nickname: '开发预览', isMember: true }
  }
}

async function readSession(): Promise<DesktopSession | null> {
  const fake = devFakeSession()
  if (fake) return fake
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const stored = JSON.parse(await readFile(sessionPath(), 'utf8')) as { version?: number; encrypted?: string }
    if (stored.version !== 1 || !stored.encrypted) return null
    const decoded = safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
    const session = JSON.parse(decoded) as DesktopSession
    if (!String(session.token || '').trim()) return null
    return {
      token: String(session.token),
      user: session.user && typeof session.user === 'object' ? session.user : {}
    }
  } catch {
    return null
  }
}

async function persistSession(value: DesktopSession): Promise<boolean> {
  const token = String(value?.token || '').trim()
  if (!token || !safeStorage.isEncryptionAvailable()) return false
  const payload: DesktopSession = {
    token,
    user: value.user && typeof value.user === 'object' ? value.user : {}
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString('base64')
  const destination = sessionPath()
  const temporary = `${destination}.${randomUUID()}.tmp`
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(temporary, `${JSON.stringify({ version: 1, encrypted })}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  return true
}

async function clearSession(): Promise<boolean> {
  await rm(sessionPath(), { force: true })
  return true
}

const SETTINGS_VERSION = 5
const THEME_SETTINGS_VERSION = 3
const ALLOWED_GENERATION_COUNTS = new Set([1, 3, 5, 7, 10, 15, 20])

function defaultSettings(): DesktopSettings {
  return {
    outputDirectory: defaultOutputDirectory(),
    autoDownload: true,
    theme: 'light',
    greetingName: '',
    generationProviderId: 0,
    generationSize: '1:1',
    generationQuality: 'low',
    generationResolution: '1K',
    generationCount: 1,
    siteUrl: ''
  }
}

function normalizeSiteUrl(value: unknown): string {
  const raw = String(value || '').trim().slice(0, 300)
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function normalizeGreetingName(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 12)
}

async function readSettings(): Promise<DesktopSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<DesktopSettings> & { version?: number }
    const defaults = defaultSettings()
    // v3 起默认浅色；更早版本文件里的 dark 是旧默认值而非用户选择，迁移为浅色
    const migrated = Number(raw.version || 0) >= THEME_SETTINGS_VERSION
      ? raw.theme
      : (raw.theme === 'system' ? 'system' : 'light')
    return {
      outputDirectory: String(raw.outputDirectory || defaults.outputDirectory),
      autoDownload: raw.autoDownload !== false,
      theme: migrated === 'dark' || migrated === 'system' ? migrated : 'light',
      greetingName: normalizeGreetingName(raw.greetingName),
      generationProviderId: Math.max(0, Math.floor(Number(raw.generationProviderId || 0))),
      generationSize: String(raw.generationSize || defaults.generationSize),
      generationQuality: String(raw.generationQuality || defaults.generationQuality),
      generationResolution: String(raw.generationResolution || defaults.generationResolution),
      generationCount: ALLOWED_GENERATION_COUNTS.has(Number(raw.generationCount)) ? Number(raw.generationCount) : defaults.generationCount,
      siteUrl: normalizeSiteUrl(raw.siteUrl)
    }
  } catch {
    return defaultSettings()
  }
}

async function persistSettings(next: DesktopSettings): Promise<DesktopSettings> {
  const normalized: DesktopSettings = {
    outputDirectory: path.resolve(next.outputDirectory || defaultOutputDirectory()),
    autoDownload: next.autoDownload !== false,
    theme: next.theme === 'light' || next.theme === 'system' ? next.theme : 'dark',
    greetingName: normalizeGreetingName(next.greetingName),
    generationProviderId: Math.max(0, Math.floor(Number(next.generationProviderId || 0))),
    generationSize: String(next.generationSize || '1:1').slice(0, 40),
    generationQuality: String(next.generationQuality || 'low').slice(0, 40),
    generationResolution: String(next.generationResolution || '1K').slice(0, 40),
    generationCount: ALLOWED_GENERATION_COUNTS.has(Number(next.generationCount)) ? Number(next.generationCount) : 1,
    siteUrl: normalizeSiteUrl(next.siteUrl)
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  await mkdir(normalized.outputDirectory, { recursive: true })
  await writeFile(settingsPath(), `${JSON.stringify({ ...normalized, version: SETTINGS_VERSION }, null, 2)}\n`, 'utf8')
  return normalized
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('拒绝未授权的桌面调用')
  }
}

function mimeFromExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/jpeg'
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'result'
}

function extensionFor(contentType: string, remoteUrl: string): string {
  const urlExtension = path.extname(new URL(remoteUrl).pathname).toLowerCase()
  if (/^\.(png|jpe?g|webp|gif)$/.test(urlExtension)) return urlExtension === '.jpeg' ? '.jpg' : urlExtension
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('jpeg')) return '.jpg'
  if (contentType.includes('gif')) return '.gif'
  return '.png'
}

async function uniqueDestination(directory: string, baseName: string, extension: string): Promise<string> {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index ? `-${index + 1}` : ''
    const candidate = path.join(directory, `${baseName}${suffix}${extension}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(directory, `${baseName}-${Date.now()}${extension}`)
}

async function selectImages(event: IpcMainInvokeEvent): Promise<SelectedImage[]> {
  return selectWorkflowImages(event, { limit: 4, title: '选择参考图片' })
}

async function selectWorkflowImages(
  event: IpcMainInvokeEvent,
  options: { limit?: number; title?: string } = {}
): Promise<SelectedImage[]> {
  assertTrustedSender(event)
  if (!mainWindow) return []
  const limit = Math.max(1, Math.min(20, Math.floor(Number(options.limit || 4))))
  const result = await dialog.showOpenDialog(mainWindow, {
    title: String(options.title || '选择图片').slice(0, 80),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (result.canceled) return []
  const images: SelectedImage[] = []
  for (const filePath of result.filePaths.slice(0, limit)) {
    const fileStat = await stat(filePath)
    if (fileStat.size > 25 * 1024 * 1024) throw new Error('单张图片不能超过 25 MB')
    const id = randomUUID()
    const type = mimeFromExtension(filePath)
    const bytes = await readFile(filePath)
    selectedFiles.set(id, filePath)
    images.push({
      id,
      name: path.basename(filePath),
      type,
      size: bytes.byteLength,
      previewDataUrl: `data:${type};base64,${bytes.toString('base64')}`
    })
  }
  return images
}

async function selectPsdImage(event: IpcMainInvokeEvent): Promise<SelectedImage | null> {
  assertTrustedSender(event)
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择需要分层的商品图',
    properties: ['openFile'],
    filters: [{ name: '商品图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const filePath = result.filePaths[0]
  const fileStat = await stat(filePath)
  if (fileStat.size > 50 * 1024 * 1024) throw new Error('图片不能超过 50 MB')
  const id = randomUUID()
  const type = mimeFromExtension(filePath)
  const bytes = await readFile(filePath)
  selectedFiles.set(id, filePath)
  return {
    id,
    name: path.basename(filePath),
    type,
    size: bytes.byteLength,
    previewDataUrl: `data:${type};base64,${bytes.toString('base64')}`
  }
}

async function importAuthorizedImage(
  event: IpcMainInvokeEvent,
  payload: { source: string; name?: string }
): Promise<SelectedImage> {
  assertTrustedSender(event)
  const source = String(payload?.source || '').trim()
  if (!source) throw new Error('缺少可导入的图片来源')

  let bytes: Buffer
  let type = 'image/png'
  let name = String(payload?.name || '').trim() || `import-${Date.now()}.png`

  if (source.startsWith('data:image/')) {
    const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([\s\S]+)$/.exec(source)
    if (!match) throw new Error('data URL 无效')
    type = match[1].toLowerCase()
    bytes = Buffer.from(match[2], 'base64')
    if (!name.includes('.')) {
      name = `${path.basename(name, path.extname(name))}.${type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png'}`
    }
  } else if (/^https?:\/\//i.test(source)) {
    const remoteUrl = new URL(source)
    if (!['http:', 'https:'].includes(remoteUrl.protocol)) throw new Error('只允许导入 http(s) 图片')
    const response = await net.fetch(remoteUrl.toString())
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('jpeg')) type = 'image/jpeg'
    else if (contentType.includes('webp')) type = 'image/webp'
    else if (contentType.includes('gif')) type = 'image/gif'
    else type = 'image/png'
    if (!path.extname(name)) {
      const urlExt = path.extname(remoteUrl.pathname).toLowerCase()
      name = `${safeFilePart(path.basename(name, path.extname(name)))}${/^\.(png|jpe?g|webp|gif)$/.test(urlExt) ? (urlExt === '.jpeg' ? '.jpg' : urlExt) : extensionFor(type, remoteUrl.toString())}`
    }
  } else {
    const resolved = path.resolve(source)
    const settings = await readSettings()
    const outputRoot = path.resolve(settings.outputDirectory)
    const underOutput = resolved === outputRoot || resolved.startsWith(`${outputRoot}${path.sep}`)
    const underUserData = resolved.startsWith(`${path.resolve(app.getPath('userData'))}${path.sep}`)
    const knownSelected = [...selectedFiles.values()].some((item) => path.resolve(item) === resolved)
    const knownComposite = generatedLocalCropFiles.has(resolved)
    if (!underOutput && !underUserData && !knownSelected && !knownComposite) {
      throw new Error('拒绝导入未授权本地文件')
    }
    bytes = await readFile(resolved)
    type = mimeFromExtension(resolved)
    if (!String(payload?.name || '').trim()) name = path.basename(resolved)
  }

  if (!bytes.length) throw new Error('图片为空')
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('图片不能超过 50 MB')
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
    // 远端可能返回 octet-stream；按内容交给 sharp 统一转 png
    type = 'image/png'
    bytes = await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().png().toBuffer()
  }

  const id = randomUUID()
  const cacheDirectory = path.join(app.getPath('userData'), 'authorized-imports')
  await mkdir(cacheDirectory, { recursive: true })
  const originalExtension = path.extname(name).toLowerCase()
  const extension = /^\.(png|jpe?g|webp|gif)$/.test(originalExtension)
    ? (originalExtension === '.jpeg' ? '.jpg' : originalExtension)
    : (type === 'image/jpeg' ? '.jpg' : type === 'image/webp' ? '.webp' : type === 'image/gif' ? '.gif' : '.png')
  const fileName = `${id}-${safeFilePart(path.basename(name, path.extname(name)))}${extension}`
  const filePath = path.join(cacheDirectory, fileName)
  await writeFile(filePath, bytes)
  selectedFiles.set(id, filePath)
  const previewType = type === 'image/jpg' ? 'image/jpeg' : type
  return {
    id,
    name: path.basename(name, path.extname(name)) + extension,
    type: previewType,
    size: bytes.byteLength,
    previewDataUrl: `data:${previewType};base64,${bytes.toString('base64')}`
  }
}

async function importPsdImage(
  event: IpcMainInvokeEvent,
  payload: { name: string; type: string; bytes: ArrayBuffer }
): Promise<SelectedImage> {
  assertTrustedSender(event)
  const bytes = Buffer.from(payload.bytes)
  if (!bytes.length || bytes.byteLength > 50 * 1024 * 1024) throw new Error('图片必须小于 50 MB')
  const type = String(payload.type || '').toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('仅支持 PNG、JPG 和 WebP')
  const originalExtension = path.extname(String(payload.name || '')).toLowerCase()
  const extension = /^\.(png|jpe?g|webp)$/.test(originalExtension)
    ? originalExtension
    : (type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg')
  const id = randomUUID()
  const cacheDirectory = path.join(app.getPath('userData'), 'psd-imports')
  await mkdir(cacheDirectory, { recursive: true })
  const fileName = `${id}-${safeFilePart(path.basename(String(payload.name || '商品图'), originalExtension))}${extension}`
  const filePath = path.join(cacheDirectory, fileName)
  await writeFile(filePath, bytes)
  selectedFiles.set(id, filePath)
  return {
    id,
    name: path.basename(String(payload.name || `商品图${extension}`)),
    type,
    size: bytes.byteLength,
    previewDataUrl: `data:${type};base64,${bytes.toString('base64')}`
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const itemPath = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await directorySize(itemPath)
    else if (entry.isFile()) total += (await stat(itemPath)).size
  }
  return total
}

function psdHelperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vision-helper', 'VisionSegmenter')
    : path.join(app.getAppPath(), 'resources', 'vision-helper', 'bin', 'VisionSegmenter')
}

// 模型目录解析已迁到 modelStore（bundle → userData 播种）；这里留个瘦包装保持调用点不变
function aiModelsDirectory(): string {
  return resolveModelsDir()
}

function speechHelperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'speech-helper', 'SpeechRecognizer')
    : path.join(app.getAppPath(), 'resources', 'speech-helper', 'bin', 'SpeechRecognizer')
}

let speechHelper: ChildProcessWithoutNullStreams | null = null

function sendVoiceEvent(payload: Record<string, unknown>): void {
  mainWindow?.webContents.send('desktop:voice-event', payload)
}

function stopSpeechHelper(): void {
  if (!speechHelper) return
  try {
    speechHelper.stdin.write('stop\n')
  } catch {
    speechHelper.kill('SIGTERM')
  }
}

function startSpeechHelper(): boolean {
  if (speechHelper) stopSpeechHelper()
  const helper = spawn(speechHelperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] })
  speechHelper = helper
  let buffered = ''
  helper.stdout.setEncoding('utf8')
  helper.stdout.on('data', (chunk: string) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
      if (!line) continue
      try {
        sendVoiceEvent(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // 忽略无法解析的行
      }
    }
  })
  helper.on('error', (error) => {
    if (speechHelper === helper) speechHelper = null
    sendVoiceEvent({ type: 'error', message: `语音识别组件启动失败：${error.message}` })
  })
  helper.on('exit', (code) => {
    if (speechHelper === helper) speechHelper = null
    sendVoiceEvent({ type: 'end', code: Number(code ?? 0) })
  })
  return true
}

const psdDraftDirs = new Map<string, { dir: string; sourcePath: string; imageId: string }>()

async function decodeMaskPngBase64(dataUrlOrBase64: string, width: number, height: number): Promise<Uint8Array> {
  const raw = String(dataUrlOrBase64 || '')
  const base64 = raw.includes('base64,') ? raw.slice(raw.indexOf('base64,') + 7) : raw
  const buf = Buffer.from(base64, 'base64')
  const { data, info } = await sharp(buf)
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 1 || data.length !== width * height) throw new Error('蒙版解码失败')
  return new Uint8Array(data)
}

async function preparePsdDraftHandler(
  event: IpcMainInvokeEvent,
  payload: { taskId: string; imageId: string; options: PsdProcessOptions }
) {
  assertTrustedSender(event)
  if (!mainWindow) throw new Error('桌面窗口不可用')
  const sourcePath = selectedFiles.get(String(payload.imageId || ''))
  if (!sourcePath) throw new Error('图片授权已失效，请重新选择')
  const draftRoot = path.join(app.getPath('userData'), 'psd-drafts')
  await mkdir(draftRoot, { recursive: true })
  const draft = await preparePsdDraft({
    inputPath: sourcePath,
    draftDirectory: draftRoot,
    helperPath: psdHelperPath(),
    aiModelsDirectory: aiModelsDirectory(),
    options: {
      writeLayerMasks: payload.options?.writeLayerMasks !== false,
      subjectProtection: payload.options?.subjectProtection !== false
    },
    onProgress: (progress, stage) => {
      mainWindow?.webContents.send('desktop:psd-progress', {
        taskId: String(payload.taskId || ''),
        progress,
        stage
      })
    }
  })
  psdDraftDirs.set(draft.draftId, {
    dir: path.join(draftRoot, draft.draftId),
    sourcePath,
    imageId: String(payload.imageId || '')
  })
  return draft
}

async function processPsd(
  event: IpcMainInvokeEvent,
  payload: {
    taskId: string
    imageId: string
    autoExport: boolean
    options: PsdProcessOptions
    draftId?: string
    subjectMaskDataUrl?: string
    propMaskDataUrl?: string
    width?: number
    height?: number
  }
) {
  assertTrustedSender(event)
  if (!mainWindow) throw new Error('桌面窗口不可用')
  const sourcePath = selectedFiles.get(String(payload.imageId || ''))
  if (!sourcePath) throw new Error('图片授权已失效，请重新选择')
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile()) throw new Error('原图片已被移动或删除')
  const settings = await readSettings()
  await mkdir(settings.outputDirectory, { recursive: true })
  let outputPath = await uniquePsdPath(settings.outputDirectory, path.basename(sourcePath))
  if (!payload.autoExport) {
    const chosen = await dialog.showSaveDialog(mainWindow, {
      title: '导出分层 PSD',
      defaultPath: outputPath,
      filters: [{ name: 'Photoshop 文档', extensions: ['psd'] }]
    })
    if (chosen.canceled || !chosen.filePath) throw new Error('已取消导出')
    outputPath = chosen.filePath.toLowerCase().endsWith('.psd') ? chosen.filePath : `${chosen.filePath}.psd`
  }

  let maskOverrides: { subjectMask?: Uint8Array; propMask?: Uint8Array | null } | undefined
  if (payload.subjectMaskDataUrl && payload.width && payload.height) {
    const w = Number(payload.width)
    const h = Number(payload.height)
    const subjectMask = await decodeMaskPngBase64(payload.subjectMaskDataUrl, w, h)
    let propMask: Uint8Array | null = null
    if (payload.propMaskDataUrl) {
      propMask = await decodeMaskPngBase64(payload.propMaskDataUrl, w, h)
    }
    maskOverrides = { subjectMask, propMask }
  }

  const result = await processImageToPsd({
    inputPath: sourcePath,
    outputPath,
    helperPath: psdHelperPath(),
    aiModelsDirectory: aiModelsDirectory(),
    options: {
      writeLayerMasks: payload.options?.writeLayerMasks !== false,
      subjectProtection: payload.options?.subjectProtection !== false
    },
    maskOverrides,
    onProgress: (progress, stage) => {
      mainWindow?.webContents.send('desktop:psd-progress', {
        taskId: String(payload.taskId || ''),
        progress,
        stage
      })
    }
  })
  generatedPsdFiles.add(result.path)
  // 清理草稿目录
  if (payload.draftId && psdDraftDirs.has(payload.draftId)) {
    const entry = psdDraftDirs.get(payload.draftId)
    psdDraftDirs.delete(payload.draftId)
    if (entry) void rm(entry.dir, { recursive: true, force: true })
  }
  return result
}

async function readSelectedImage(event: IpcMainInvokeEvent, id: string): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  assertTrustedSender(event)
  const filePath = selectedFiles.get(String(id || ''))
  if (!filePath) throw new Error('图片授权已失效，请重新选择')
  const bytes = await readFile(filePath)
  // 返回拷贝后的 Uint8Array，避免 Node Buffer 底层 ArrayBuffer 池化污染
  return {
    name: path.basename(filePath),
    type: mimeFromExtension(filePath),
    bytes: Uint8Array.from(bytes)
  }
}

async function cacheLocalCropSceneHandler(
  event: IpcMainInvokeEvent,
  payload: { taskId: number; imageId: string }
): Promise<{ scenePath: string }> {
  assertTrustedSender(event)
  const taskId = Number(payload.taskId || 0)
  const sourcePath = selectedFiles.get(String(payload.imageId || ''))
  if (!taskId || !sourcePath) throw new Error('局部裁切场景图授权已失效')
  const cacheDirectory = path.join(app.getPath('userData'), 'local-crop-scenes')
  const scenePath = await cacheLocalCropScene(sourcePath, cacheDirectory, taskId)
  localCropSceneByTask.set(taskId, scenePath)
  return { scenePath }
}

async function readLocalCropPreview(
  event: IpcMainInvokeEvent,
  filePath: string
): Promise<{ previewDataUrl: string }> {
  assertTrustedSender(event)
  const resolved = path.resolve(String(filePath || ''))
  const settings = await readSettings()
  const outputRoot = path.resolve(settings.outputDirectory)
  const underOutput = resolved.startsWith(`${outputRoot}${path.sep}`) && path.basename(resolved).startsWith('local-crop-')
  if (!generatedLocalCropFiles.has(resolved) && !underOutput) throw new Error('拒绝读取未授权文件')
  const bytes = await readFile(resolved)
  return { previewDataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
}

/** 历史同步后从输出目录找回 local-crop-{taskId}-*.png 拼合结果 */
async function findLocalCropComposite(
  event: IpcMainInvokeEvent,
  taskIdRaw: number
): Promise<{ path: string; width?: number; height?: number } | null> {
  assertTrustedSender(event)
  const taskId = Number(taskIdRaw || 0)
  if (!taskId) return null
  const settings = await readSettings()
  const outputRoot = path.resolve(settings.outputDirectory)
  let entries: string[] = []
  try {
    entries = await readdir(outputRoot)
  } catch {
    return null
  }
  const prefix = `local-crop-${taskId}-`
  const matches = entries.filter((name) => name.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(name))
  if (!matches.length) return null
  let bestPath = ''
  let bestMtime = -1
  for (const name of matches) {
    const full = path.join(outputRoot, name)
    try {
      const info = await stat(full)
      if (!info.isFile()) continue
      const mtime = Number(info.mtimeMs || 0)
      if (mtime >= bestMtime) {
        bestMtime = mtime
        bestPath = full
      }
    } catch {
      // skip unreadable
    }
  }
  if (!bestPath) return null
  const resolved = path.resolve(bestPath)
  generatedLocalCropFiles.add(resolved)
  try {
    const meta = await sharp(resolved, { limitInputPixels: 80_000_000 }).metadata()
    return {
      path: resolved,
      width: Number(meta.width || 0) || undefined,
      height: Number(meta.height || 0) || undefined
    }
  } catch {
    return { path: resolved }
  }
}

async function compositeLocalCropHandler(
  event: IpcMainInvokeEvent,
  payload: {
    taskId: number
    sceneImageId?: string
    scenePath?: string
    patchUrl: string
    cropBox: { x: number; y: number; size: number }
    maskPaths?: Array<{ points: Array<{ x: number; y: number }>; brushSize: number; isEraser: boolean }>
  }
): Promise<{ path: string; previewDataUrl: string; width: number; height: number; size: number }> {
  assertTrustedSender(event)
  const taskId = Number(payload.taskId || 0)
  if (!taskId) throw new Error('任务 ID 无效')
  const scenePath =
    String(payload.scenePath || '') ||
    localCropSceneByTask.get(taskId) ||
    selectedFiles.get(String(payload.sceneImageId || '')) ||
    ''
  if (!scenePath) throw new Error('场景图缓存已失效，无法回贴合成')
  const remoteUrl = new URL(String(payload.patchUrl || ''))
  if (!['http:', 'https:'].includes(remoteUrl.protocol)) throw new Error('只允许合成 http(s) 结果图')
  const response = await net.fetch(remoteUrl.toString())
  if (!response.ok) throw new Error(`拉取生成图失败：HTTP ${response.status}`)
  const patchBytes = Buffer.from(await response.arrayBuffer())
  if (!patchBytes.length) throw new Error('生成图为空')
  const settings = await readSettings()
  // IPC 可能带着 Vue Proxy 序列化后的普通对象；这里再拷一次，避免脏字段进 sharp
  const maskPaths = Array.isArray(payload.maskPaths)
    ? payload.maskPaths.map((item) => ({
        points: Array.isArray(item?.points)
          ? item.points.map((pt) => ({ x: Number(pt?.x || 0), y: Number(pt?.y || 0) }))
          : [],
        brushSize: Number(item?.brushSize || 0),
        isEraser: Boolean(item?.isEraser)
      }))
    : undefined
  const result = await compositeLocalCrop({
    scenePath,
    patchBytes,
    cropBox: {
      x: Number(payload.cropBox?.x || 0),
      y: Number(payload.cropBox?.y || 0),
      size: Number(payload.cropBox?.size || 0)
    },
    outputDirectory: settings.outputDirectory,
    taskId,
    feather: featherForCropSize(Number(payload.cropBox?.size || 0)),
    maskPaths
  })
  generatedLocalCropFiles.add(path.resolve(result.path))
  return result
}

async function downloadResult(
  event: IpcMainInvokeEvent,
  payload: { url: string; taskId: number; index: number }
): Promise<{ path: string; sha256: string; size: number }> {
  assertTrustedSender(event)
  const remoteUrl = new URL(String(payload.url || ''))
  if (!['http:', 'https:'].includes(remoteUrl.protocol)) throw new Error('只允许下载 http(s) 结果')
  const settings = await readSettings()
  await mkdir(settings.outputDirectory, { recursive: true })
  const response = await net.fetch(remoteUrl.toString())
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new Error('下载结果为空')
  const extension = extensionFor(response.headers.get('content-type') || '', remoteUrl.toString())
  const baseName = `task-${safeFilePart(String(payload.taskId || Date.now()))}-${Math.max(1, Number(payload.index || 0) + 1)}`
  const destination = await uniqueDestination(settings.outputDirectory, baseName, extension)
  const temporary = `${destination}.${randomUUID()}.part`
  await writeFile(temporary, bytes)
  await rename(temporary, destination)
  return {
    path: destination,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength
  }
}

const WORKSPACE_WRITE_EXTENSIONS = new Set(['.webm', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4'])

async function writeWorkspaceFile(
  event: IpcMainInvokeEvent,
  payload: { name?: string; bytes: ArrayBuffer; extension?: string }
): Promise<{ path: string; size: number; sha256: string }> {
  assertTrustedSender(event)
  const settings = await readSettings()
  await mkdir(settings.outputDirectory, { recursive: true })
  const rawName = String(payload?.name || 'export').trim() || 'export'
  const requestedExt = String(payload?.extension || path.extname(rawName) || '').toLowerCase()
  const extension = WORKSPACE_WRITE_EXTENSIONS.has(requestedExt)
    ? (requestedExt === '.jpeg' ? '.jpg' : requestedExt)
    : ''
  if (!extension) throw new Error('仅支持写入 webm / mp4 / png / jpg / webp / gif')
  const bytes = Buffer.from(payload.bytes || new ArrayBuffer(0))
  if (!bytes.length) throw new Error('写入内容为空')
  if (bytes.byteLength > 200 * 1024 * 1024) throw new Error('文件不能超过 200 MB')
  const baseName = safeFilePart(path.basename(rawName, path.extname(rawName))) || 'export'
  const destination = await uniqueDestination(settings.outputDirectory, baseName, extension)
  const temporary = `${destination}.${randomUUID()}.part`
  await writeFile(temporary, bytes)
  await rename(temporary, destination)
  return {
    path: destination,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

async function apiRequest(event: IpcMainInvokeEvent, payload: ApiRequestPayload): Promise<{ status: number; body: unknown }> {
  assertTrustedSender(event)
  const requestUrl = new URL(String(payload.path || ''), API_BASE_URL)
  if (requestUrl.origin !== API_BASE_URL || !ALLOWED_API_PATHS.has(requestUrl.pathname)) {
    throw new Error('拒绝未授权的后台接口')
  }
  requestUrl.searchParams.set('tenant_sn', TENANT_SN)
  const method = payload.method === 'POST' ? 'POST' : 'GET'
  const headers = new Headers()
  const token = String(payload.token || '').trim()
  if (token) {
    headers.set('token', token)
    headers.set('Authorization', `Bearer ${token}`)
  }
  let body: string | FormData | undefined
  if (payload.file) {
    if (requestUrl.pathname !== '/api/app.image2.upload/image') throw new Error('文件只允许上传到图片接口')
    const form = new FormData()
    const bytes = Uint8Array.from(new Uint8Array(payload.file.bytes))
    form.append('file', new Blob([bytes], { type: payload.file.type || 'application/octet-stream' }), payload.file.name || 'image.png')
    body = form
  } else if (payload.json) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(payload.json)
  }
  const response = await net.fetch(requestUrl.toString(), {
    method,
    headers,
    body,
    redirect: 'error'
  })
  const text = await response.text()
  let responseBody: unknown = null
  try {
    responseBody = text ? JSON.parse(text) : null
  } catch {
    responseBody = { code: 0, msg: text || `服务请求失败（HTTP ${response.status}）`, data: null }
  }
  return { status: response.status, body: responseBody }
}

function registerIpc(): void {
  ipcMain.handle('desktop:get-info', (event) => {
    assertTrustedSender(event)
    return {
      name: APP_NAME,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      // 渲染层据此在开发预览下跳过「登录过期」自动登出，否则假 token 一被后端拒绝就退回登录页
      devFakeSession: Boolean(devFakeSession())
    }
  })
  ipcMain.handle('desktop:get-settings', async (event) => {
    assertTrustedSender(event)
    const settings = await readSettings()
    await mkdir(settings.outputDirectory, { recursive: true })
    return settings
  })
  ipcMain.handle('desktop:get-session', async (event) => {
    assertTrustedSender(event)
    return readSession()
  })
  ipcMain.handle('desktop:save-session', async (event, value: DesktopSession) => {
    assertTrustedSender(event)
    return persistSession(value)
  })
  ipcMain.handle('desktop:clear-session', async (event) => {
    assertTrustedSender(event)
    return clearSession()
  })
  ipcMain.handle('desktop:save-settings', async (event, value: DesktopSettings) => {
    assertTrustedSender(event)
    const saved = await persistSettings(value)
    currentThemeSetting = saved.theme
    mainWindow?.setBackgroundColor(resolveWindowBackground(saved.theme))
    return saved
  })
  ipcMain.handle('desktop:request-microphone-access', async (event) => {
    assertTrustedSender(event)
    if (process.platform !== 'darwin') return true
    const current = systemPreferences.getMediaAccessStatus('microphone')
    if (current === 'granted') return true
    if (current === 'denied' || current === 'restricted') return false
    return systemPreferences.askForMediaAccess('microphone')
  })
  ipcMain.handle('desktop:choose-output', async (event) => {
    assertTrustedSender(event)
    if (!mainWindow) return null
    const current = await readSettings()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存目录',
      defaultPath: current.outputDirectory,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('desktop:open-output', async (event) => {
    assertTrustedSender(event)
    const settings = await readSettings()
    await mkdir(settings.outputDirectory, { recursive: true })
    const error = await shell.openPath(settings.outputDirectory)
    if (error) throw new Error(error)
    return true
  })
  ipcMain.handle('desktop:select-images', selectImages)
  ipcMain.handle('desktop:select-workflow-images', selectWorkflowImages)
  ipcMain.handle('desktop:select-psd-image', selectPsdImage)
  ipcMain.handle('desktop:import-psd-image', importPsdImage)
  ipcMain.handle('desktop:import-authorized-image', importAuthorizedImage)
  ipcMain.handle('desktop:read-selected-image', readSelectedImage)
  ipcMain.handle('desktop:cache-local-crop-scene', cacheLocalCropSceneHandler)
  ipcMain.handle('desktop:composite-local-crop', compositeLocalCropHandler)
  ipcMain.handle('desktop:read-local-crop-preview', readLocalCropPreview)
  ipcMain.handle('desktop:find-local-crop-composite', findLocalCropComposite)
  ipcMain.handle('desktop:download-result', downloadResult)
  ipcMain.handle('desktop:write-workspace-file', writeWorkspaceFile)
  ipcMain.handle('desktop:api-request', apiRequest)
  ipcMain.handle('desktop:workspace-storage', async (event) => {
    assertTrustedSender(event)
    const settings = await readSettings()
    return directorySize(settings.outputDirectory)
  })
  ipcMain.handle('desktop:process-psd', processPsd)
  ipcMain.handle('desktop:prepare-psd-draft', preparePsdDraftHandler)
  ipcMain.handle('desktop:psd-engine-status', async (event) => {
    assertTrustedSender(event)
    return checkAiModels(aiModelsDirectory())
  })
  ipcMain.handle('desktop:models-status', (event) => {
    assertTrustedSender(event)
    return getModelStoreStatus()
  })
  ipcMain.handle('desktop:models-disk-usage', async (event) => {
    assertTrustedSender(event)
    return modelsDiskUsage()
  })
  ipcMain.handle('desktop:models-verify', async (event) => {
    assertTrustedSender(event)
    return verifyModelsThorough()
  })
  ipcMain.handle('desktop:models-repair', async (event) => {
    assertTrustedSender(event)
    return repairModels()
  })
  ipcMain.handle('desktop:update-state', (event) => {
    assertTrustedSender(event)
    return getUpdaterState()
  })
  ipcMain.handle('desktop:update-check', async (event, manual: boolean) => {
    assertTrustedSender(event)
    return runUpdateCheck(Boolean(manual))
  })
  ipcMain.handle('desktop:update-download', async (event) => {
    assertTrustedSender(event)
    return downloadUpdate()
  })
  ipcMain.handle('desktop:update-apply', async (event) => {
    assertTrustedSender(event)
    return applyUpdate()
  })
  async function resolveAllowedPsdPath(filePath: string): Promise<string> {
    const resolved = path.resolve(String(filePath || ''))
    if (generatedPsdFiles.has(resolved)) return resolved
    // 历史任务恢复后集合会丢：允许「输出目录内已存在的 .psd」
    if (!resolved.toLowerCase().endsWith('.psd')) throw new Error('拒绝打开未授权文件')
    const settings = await readSettings()
    const outDir = path.resolve(settings.outputDirectory)
    const underOutput = resolved === outDir || resolved.startsWith(outDir + path.sep)
    if (!underOutput) throw new Error('拒绝打开未授权文件')
    await stat(resolved)
    generatedPsdFiles.add(resolved)
    return resolved
  }

  ipcMain.handle('desktop:reveal-psd', async (event, filePath: string) => {
    assertTrustedSender(event)
    const resolved = await resolveAllowedPsdPath(filePath)
    shell.showItemInFolder(resolved)
    return true
  })
  ipcMain.handle('desktop:open-psd', async (event, filePath: string) => {
    assertTrustedSender(event)
    const resolved = await resolveAllowedPsdPath(filePath)
    const error = await shell.openPath(resolved)
    if (error) throw new Error(error)
    return true
  })
  ipcMain.handle('desktop:voice-start', (event) => {
    assertTrustedSender(event)
    return startSpeechHelper()
  })
  ipcMain.handle('desktop:voice-stop', (event) => {
    assertTrustedSender(event)
    stopSpeechHelper()
    return true
  })
  /* 任务完成通知：点击横幅把窗口带回前台 */
  ipcMain.handle('desktop:notify', (event, payload: { title?: string; body?: string; silent?: boolean }) => {
    assertTrustedSender(event)
    if (!Notification.isSupported()) return false
    const notification = new Notification({
      title: String(payload?.title || APP_NAME).slice(0, 120),
      body: String(payload?.body || '').slice(0, 300),
      silent: Boolean(payload?.silent)
    })
    notification.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    })
    notification.show()
    return true
  })
  ipcMain.handle('desktop:write-clipboard', (event, text: string) => {
    assertTrustedSender(event)
    clipboard.writeText(String(text || '').slice(0, 10000))
    return true
  })
  ipcMain.handle('desktop:write-clipboard-image', async (event, payload: { path?: string; dataUrl?: string }) => {
    assertTrustedSender(event)
    let image = nativeImage.createEmpty()
    const filePath = String(payload?.path || '').trim()
    const dataUrl = String(payload?.dataUrl || '').trim()
    if (filePath) {
      const resolved = path.resolve(filePath)
      const settings = await readSettings()
      const outputRoot = path.resolve(settings.outputDirectory)
      if (resolved !== outputRoot && !resolved.startsWith(outputRoot + path.sep)) {
        throw new Error('拒绝读取工作目录以外的文件')
      }
      await stat(resolved)
      image = nativeImage.createFromPath(resolved)
    } else if (dataUrl.startsWith('data:image/')) {
      const base64 = dataUrl.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
      image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    } else {
      throw new Error('缺少可复制的图片数据')
    }
    if (image.isEmpty()) throw new Error('图片无效，无法复制到剪贴板')
    clipboard.writeImage(image)
    return true
  })
  ipcMain.handle('desktop:read-clipboard-image', (event) => {
    assertTrustedSender(event)
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const png = image.toPNG()
    const copy = Buffer.from(png)
    return {
      name: `clipboard-${Date.now()}.png`,
      type: 'image/png',
      bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
    }
  })
ipcMain.handle('desktop:open-in-photoshop', async (event, filePath: string) => {
    assertTrustedSender(event)
    const resolved = path.resolve(String(filePath || ''))
    const settings = await readSettings()
    const outputRoot = path.resolve(settings.outputDirectory)
    if (resolved !== outputRoot && !resolved.startsWith(outputRoot + path.sep)) {
      throw new Error('拒绝打开工作目录以外的文件')
    }
    await stat(resolved)
    if (process.platform === 'darwin') {
      const opened = await new Promise<boolean>((resolve) => {
        execFile('open', ['-b', 'com.adobe.Photoshop', resolved], (error) => resolve(!error))
      })
      if (opened) return { fallback: false }
    }
    const error = await shell.openPath(resolved)
    if (error) throw new Error(error)
    return { fallback: true }
  })
  ipcMain.handle('desktop:open-in-photopea', async (event, payload: PhotopeaOpenPayload) => {
    assertTrustedSender(event)
    const settings = await readSettings()
    return openPhotopeaEditor({
      payload: {
        filePath: String(payload?.filePath || ''),
        theme: payload?.theme || settings.theme,
        taskId: String(payload?.taskId || '')
      },
      outputDirectory: settings.outputDirectory,
      knownFiles: generatedPsdFiles,
      mainWindow,
      systemDark: nativeTheme.shouldUseDarkColors,
      developmentUrl: process.env.ELECTRON_RENDERER_URL
    })
  })
  // Photopea 宿主窗口专用 IPC（仅 photopea preload 可调用）
  ipcMain.handle('photopea:host-ready', (event) => markPhotopeaHostReady(event))
  ipcMain.handle('photopea:save', async (event, payload: PhotopeaSavePayload) => {
    const settings = await readSettings()
    return savePhotopeaDocument({
      event,
      payload,
      outputDirectory: settings.outputDirectory,
      knownFiles: generatedPsdFiles
    })
  })
  ipcMain.handle('photopea:close', (event) => closePhotopeaEditor(event))
  ipcMain.handle('photopea:error', (event, message: string) => reportPhotopeaHostError(event, message))
}

// 与 styles.css 的 --bg 完全对应（浅色 :root / 深色 :root[data-theme='dark']）
const WINDOW_BG_LIGHT = '#f5f5f3'
const WINDOW_BG_DARK = '#262624'

function resolveWindowBackground(theme: DesktopSettings['theme']): string {
  const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  return isDark ? WINDOW_BG_DARK : WINDOW_BG_LIGHT
}

function createWindow(theme: DesktopSettings['theme'] = 'light'): void {
  // 双侧栏同时打开时仍为中间工作区保留完整的 680px 操作宽度。
  const minWidth = 1220
  // 首页在双侧栏 + 两行生成参数的最紧凑状态下仍需保留完整操作空间。
  const minHeight = 720
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? minWidth,
    height: saved?.height ?? minHeight,
    x: saved?.x,
    y: saved?.y,
    minWidth,
    minHeight,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    /*
     * 之前用 transparent:true + backgroundColor:'#00000000' 配合渲染层圆角做连续外框，
     * 但 Chromium 在 transparent 窗口里，任何非整数设备像素边界的元素（不止圆角，直边一样）
     * 绘制时的抗锯齿像素会直接和窗口 alpha 混合，而不是和内容自身的不透明色混合——
     * 于是弹层这类绝对定位元素的边缘总会露出一条背后内容的细缝，属于窗口级的合成问题，
     * 光靠内容层 CSS 加不透明背景无法根治。改为跟随主题的实色背景，配合 roundedCorners
     * 依然能拿到原生连续圆角，但窗口不再是真透明，从根上消除这类缝隙。
     */
    transparent: false,
    backgroundColor: resolveWindowBackground(theme),
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(rendererDirectory, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (saved?.maximized) mainWindow.maximize()
  releaseWindowStateTracker?.()
  releaseWindowStateTracker = trackWindowState(mainWindow)
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // 窗口出来后再后台播种模型，不阻塞首屏
    void initAndSeedModels()
  })
  // 播种进度推给渲染层，PSD/修补据此显示「首次准备模型…」而不是直接报错
  onModelStoreStatus((status: ModelStoreStatus) => {
    mainWindow?.webContents.send('desktop:models-status', status)
  })
  onUpdaterState((status: UpdaterState) => {
    mainWindow?.webContents.send('desktop:update-state', status)
  })
  const syncWindowChrome = (): void => {
    const fullscreen = Boolean(mainWindow?.isFullScreen())
    mainWindow?.webContents.send('desktop:window-chrome', { fullscreen })
  }
  mainWindow.on('enter-full-screen', syncWindowChrome)
  mainWindow.on('leave-full-screen', syncWindowChrome)
  mainWindow.webContents.on('did-finish-load', syncWindowChrome)
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone', details)
  })
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload] error', preloadPath, error)
  })
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    webContents === mainWindow?.webContents
      && permission === 'media'
      && (!details.mediaType || details.mediaType === 'audio')
  )
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes || [] : []
    callback(
      webContents === mainWindow?.webContents
        && permission === 'media'
        && mediaTypes.length > 0
        && mediaTypes.every((type) => type === 'audio')
    )
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.on('closed', () => {
    mainWindow = null
    selectedFiles.clear()
    speechHelper?.kill('SIGTERM')
    speechHelper = null
  })
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) void mainWindow.loadURL(developmentUrl)
  else void mainWindow.loadFile(path.join(rendererDirectory, '../renderer/index.html'))
}

registerIpc()

// 单实例锁：双开会争抢 settings.json / session.json 与 ai-worker，也是更新器安全的前提。
// 第二个实例直接退出，把已有窗口带到前台。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  const settings = await persistSettings(await readSettings())
  currentThemeSetting = settings.theme

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: '',
    copyright: 'AI Image Workspace · desktop image generation studio'
  })
  buildApplicationMenu(() => mainWindow, {
    openSettings: () => mainWindow?.webContents.send('desktop:menu', 'settings'),
    checkForUpdates: () => mainWindow?.webContents.send('desktop:menu', 'check-updates'),
    openManual: () => mainWindow?.webContents.send('desktop:menu', 'manual')
  })

  createWindow(currentThemeSetting)
  nativeTheme.on('updated', () => {
    if (currentThemeSetting === 'system') mainWindow?.setBackgroundColor(resolveWindowBackground('system'))
  })
  powerMonitor.on('resume', () => mainWindow?.webContents.send('desktop:system-resumed'))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(currentThemeSetting)
  })

  // 清理上一轮更新残留（含回滚感知），再静默检查一次更新
  void reconcilePendingUpdate()
  setTimeout(() => void runUpdateCheck(false), 8000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  disposePhotopeaEditor()
  shutdownAiWorker()
})
