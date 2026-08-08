import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'

export type PhotopeaOpenPayload = {
  filePath: string
  theme?: 'dark' | 'light' | 'system'
  taskId?: string
}

export type PhotopeaSessionInfo = {
  sessionId: string
  sourcePath: string
  fileName: string
  extension: string
  taskId: string
  theme: 'dark' | 'light'
  bytes: Uint8Array
}

export type PhotopeaSavePayload = {
  sessionId: string
  bytes: ArrayBuffer
  mode: 'overwrite' | 'saveAs'
  format?: 'psd' | 'png'
}

export type PhotopeaSaveResult = {
  path: string
  size: number
  mode: 'overwrite' | 'saveAs'
  format: 'psd' | 'png'
  sessionId: string
  taskId: string
  sourcePath: string
}

type ActiveSession = {
  sessionId: string
  sourcePath: string
  originalPath: string
  fileName: string
  extension: string
  taskId: string
  theme: 'dark' | 'light'
  bytes: Buffer
}

type DesktopSettingsTheme = 'dark' | 'light' | 'system'

const PHOTOPEA_ORIGIN = 'https://www.photopea.com'
const MAX_EDIT_BYTES = 200 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['.psd', '.png', '.jpg', '.jpeg', '.webp', '.gif'])
const mainDirectory = path.dirname(fileURLToPath(import.meta.url))

let photopeaWindow: BrowserWindow | null = null
let activeSession: ActiveSession | null = null
let hostReady = false
let pendingBootstrap: ActiveSession | null = null
let boundMainWindow: BrowserWindow | null = null

function resolveTheme(theme: DesktopSettingsTheme | undefined, systemDark: boolean): 'dark' | 'light' {
  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  return systemDark ? 'dark' : 'light'
}

function safeBaseName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  return base.replace(/[^\w\u4e00-\u9fff.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document'
}

export function getPhotopeaWindow(): BrowserWindow | null {
  return photopeaWindow
}

export function isPhotopeaSender(sender: WebContents): boolean {
  return Boolean(photopeaWindow && !photopeaWindow.isDestroyed() && photopeaWindow.webContents === sender)
}

export function assertPhotopeaSender(event: IpcMainInvokeEvent): void {
  if (!isPhotopeaSender(event.sender)) throw new Error('Unauthorized Photopea call rejected')
}

export async function assertEditableWorkspaceFile(
  filePath: string,
  outputDirectory: string,
  knownFiles?: Set<string>
): Promise<string> {
  const resolved = path.resolve(String(filePath || ''))
  const extension = path.extname(resolved).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('Only PSD, PNG, JPG, WebP, and GIF files can be opened')
  const outputRoot = path.resolve(outputDirectory)
  const underOutput = resolved === outputRoot || resolved.startsWith(outputRoot + path.sep)
  const known = knownFiles?.has(resolved)
  if (!underOutput && !known) throw new Error('Opening files outside the workspace is not allowed')
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error('The file does not exist or cannot be read')
  if (info.size <= 0) throw new Error('The file is empty')
  if (info.size > MAX_EDIT_BYTES) throw new Error('Files over 200 MB cannot be edited in-app')
  return resolved
}

async function uniqueEditedPath(directory: string, sourcePath: string, format: 'psd' | 'png'): Promise<string> {
  const base = `${safeBaseName(sourcePath)}-edited`
  const extension = format === 'png' ? '.png' : '.psd'
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index ? `-${index + 1}` : ''
    const candidate = path.join(directory, `${base}${suffix}${extension}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(directory, `${base}-${Date.now()}${extension}`)
}

function hostHtmlPath(): string {
  return path.join(mainDirectory, '../renderer/photopea-host.html')
}

function hostDevUrl(developmentUrl: string): string {
  const base = developmentUrl.endsWith('/') ? developmentUrl : `${developmentUrl}/`
  return new URL('photopea-host.html', base).toString()
}

function preloadPath(): string {
  return path.join(mainDirectory, '../preload/photopea.mjs')
}

function broadcastToMain(channel: string, payload: Record<string, unknown>): void {
  if (!boundMainWindow || boundMainWindow.isDestroyed()) return
  boundMainWindow.webContents.send(channel, payload)
}

function toSessionInfo(session: ActiveSession): PhotopeaSessionInfo {
  return {
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
    fileName: session.fileName,
    extension: session.extension,
    taskId: session.taskId,
    theme: session.theme,
    bytes: Uint8Array.from(session.bytes)
  }
}

function sendBootstrap(session: ActiveSession): void {
  if (!photopeaWindow || photopeaWindow.isDestroyed() || !hostReady) {
    pendingBootstrap = session
    return
  }
  photopeaWindow.webContents.send('photopea:bootstrap', toSessionInfo(session))
  pendingBootstrap = null
}

function destroyPhotopeaWindow(notify: boolean): void {
  const closedSessionId = activeSession?.sessionId || ''
  hostReady = false
  pendingBootstrap = null
  activeSession = null
  if (photopeaWindow && !photopeaWindow.isDestroyed()) {
    photopeaWindow.removeAllListeners('closed')
    photopeaWindow.destroy()
  }
  photopeaWindow = null
  if (notify) {
    broadcastToMain('desktop:photopea-event', {
      type: 'closed',
      sessionId: closedSessionId
    })
  }
}

async function loadHost(developmentUrl?: string): Promise<void> {
  if (!photopeaWindow || photopeaWindow.isDestroyed()) return
  if (developmentUrl) await photopeaWindow.loadURL(hostDevUrl(developmentUrl))
  else await photopeaWindow.loadFile(hostHtmlPath())
}

export async function openPhotopeaEditor(options: {
  payload: PhotopeaOpenPayload
  outputDirectory: string
  knownFiles?: Set<string>
  mainWindow: BrowserWindow | null
  systemDark: boolean
  developmentUrl?: string
}): Promise<{ sessionId: string; path: string; fileName: string }> {
  boundMainWindow = options.mainWindow
  const sourcePath = await assertEditableWorkspaceFile(
    options.payload.filePath,
    options.outputDirectory,
    options.knownFiles
  )
  const bytes = await readFile(sourcePath)
  const theme = resolveTheme(options.payload.theme, options.systemDark)
  const session: ActiveSession = {
    sessionId: randomUUID(),
    sourcePath,
    originalPath: sourcePath,
    fileName: path.basename(sourcePath),
    extension: path.extname(sourcePath).toLowerCase() || '.psd',
    taskId: String(options.payload.taskId || ''),
    theme,
    bytes
  }
  activeSession = session
  hostReady = false
  pendingBootstrap = session

  if (photopeaWindow && !photopeaWindow.isDestroyed()) {
    photopeaWindow.setTitle(`Photopea · ${session.fileName}`)
    photopeaWindow.focus()
    await loadHost(options.developmentUrl)
    return { sessionId: session.sessionId, path: sourcePath, fileName: session.fileName }
  }

  photopeaWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    title: `Photopea · ${session.fileName}`,
    backgroundColor: theme === 'dark' ? '#1e1e1e' : '#f0f0f0',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false
    }
  })

  photopeaWindow.once('ready-to-show', () => {
    photopeaWindow?.show()
    photopeaWindow?.focus()
  })

  photopeaWindow.on('closed', () => {
    const closedSessionId = activeSession?.sessionId || ''
    photopeaWindow = null
    hostReady = false
    pendingBootstrap = null
    activeSession = null
    broadcastToMain('desktop:photopea-event', {
      type: 'closed',
      sessionId: closedSessionId
    })
  })

  photopeaWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  photopeaWindow.webContents.on('will-navigate', (event, url) => {
    const allowed =
      url.startsWith('file:') ||
      url.startsWith('http://localhost') ||
      url.startsWith('http://127.0.0.1') ||
      url.startsWith(PHOTOPEA_ORIGIN) ||
      Boolean(options.developmentUrl && url.startsWith(options.developmentUrl))
    if (!allowed) event.preventDefault()
  })

  await loadHost(options.developmentUrl)
  return { sessionId: session.sessionId, path: sourcePath, fileName: session.fileName }
}

export function markPhotopeaHostReady(event: IpcMainInvokeEvent): PhotopeaSessionInfo | null {
  assertPhotopeaSender(event)
  hostReady = true
  const session = activeSession || pendingBootstrap
  if (!session) return null
  sendBootstrap(session)
  return toSessionInfo(session)
}

export async function savePhotopeaDocument(options: {
  event: IpcMainInvokeEvent
  payload: PhotopeaSavePayload
  outputDirectory: string
  knownFiles: Set<string>
}): Promise<PhotopeaSaveResult> {
  assertPhotopeaSender(options.event)
  const session = activeSession
  if (!session || session.sessionId !== String(options.payload.sessionId || '')) {
    throw new Error('The edit session expired. Open the file again.')
  }

  const format = options.payload.format === 'png' ? 'png' : 'psd'
  const bytes = Buffer.from(options.payload.bytes || new ArrayBuffer(0))
  if (!bytes.byteLength) throw new Error('The save content is empty')
  if (bytes.byteLength > MAX_EDIT_BYTES) throw new Error('The saved file is over 200 MB')

  const requestedMode = options.payload.mode === 'saveAs' ? 'saveAs' : 'overwrite'
  const sourceExt = path.extname(session.sourcePath).toLowerCase()
  const canOverwrite = requestedMode === 'overwrite' && format === 'psd' && sourceExt === '.psd'

  let destination = session.sourcePath
  let mode: 'overwrite' | 'saveAs' = 'overwrite'
  if (!canOverwrite) {
    destination = await uniqueEditedPath(options.outputDirectory, session.originalPath || session.sourcePath, format)
    mode = 'saveAs'
  }

  const temporary = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes)
  await rename(temporary, destination)

  const resolvedDestination = path.resolve(destination)
  options.knownFiles.add(resolvedDestination)

  session.bytes = bytes
  session.sourcePath = resolvedDestination
  session.fileName = path.basename(resolvedDestination)
  session.extension = path.extname(resolvedDestination).toLowerCase()

  const saveResult: PhotopeaSaveResult = {
    path: resolvedDestination,
    size: bytes.byteLength,
    mode,
    format,
    sessionId: session.sessionId,
    taskId: session.taskId,
    sourcePath: resolvedDestination
  }

  broadcastToMain('desktop:photopea-event', {
    type: 'saved',
    ...saveResult
  })

  if (photopeaWindow && !photopeaWindow.isDestroyed()) {
    photopeaWindow.setTitle(`Photopea · ${session.fileName}`)
  }

  return saveResult
}

export function reportPhotopeaHostError(event: IpcMainInvokeEvent, message: string): boolean {
  assertPhotopeaSender(event)
  broadcastToMain('desktop:photopea-event', {
    type: 'error',
    sessionId: activeSession?.sessionId || '',
    message: String(message || 'Photopea editor error').slice(0, 300)
  })
  return true
}

export function closePhotopeaEditor(event?: IpcMainInvokeEvent): boolean {
  if (event) assertPhotopeaSender(event)
  destroyPhotopeaWindow(Boolean(event))
  return true
}

export function disposePhotopeaEditor(): void {
  destroyPhotopeaWindow(false)
}

export function getActivePhotopeaSession(): ActiveSession | null {
  return activeSession
}
