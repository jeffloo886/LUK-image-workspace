/// <reference types="vite/client" />

declare global {
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

  type ModelStoreStatus = {
    phase: 'checking' | 'seeding' | 'ready' | 'repairing' | 'error'
    message?: string
    progress?: number
  }

  type UpdaterState = {
    phase: 'idle' | 'checking' | 'available' | 'downloading' | 'staged' | 'applying' | 'up-to-date' | 'error'
    version?: string
    notes?: string
    progress?: number
    message?: string
    releasePage?: string
  }

  type DesktopSelectedImage = {
    id: string
    name: string
    type: string
    size: number
    previewDataUrl: string
  }

  type DesktopBridge = {
    getInfo: () => Promise<{
      name: string
      version: string
      platform: string
      arch: string
      devFakeSession?: boolean
    }>
    getSettings: () => Promise<DesktopSettings>
    getSession: () => Promise<{ token: string; user: Record<string, unknown> } | null>
    saveSession: (value: { token: string; user: Record<string, unknown> }) => Promise<boolean>
    clearSession: () => Promise<boolean>
    saveSettings: (value: DesktopSettings) => Promise<DesktopSettings>
    requestMicrophoneAccess: () => Promise<boolean>
    chooseOutputDirectory: () => Promise<string | null>
    openOutputDirectory: () => Promise<boolean>
    selectImages: () => Promise<DesktopSelectedImage[]>
    selectWorkflowImages: (options: { limit: number; title: string }) => Promise<DesktopSelectedImage[]>
    selectPsdImage: () => Promise<DesktopSelectedImage | null>
    importPsdImage: (payload: { name: string; type: string; bytes: ArrayBuffer }) => Promise<DesktopSelectedImage>
    importAuthorizedImage: (payload: { source: string; name?: string }) => Promise<DesktopSelectedImage>
    readSelectedImage: (id: string) => Promise<{ name: string; type: string; bytes: ArrayBuffer | Uint8Array }>
    cacheLocalCropScene: (payload: { taskId: number; imageId: string }) => Promise<{ scenePath: string }>
    compositeLocalCrop: (payload: {
      taskId: number
      sceneImageId?: string
      scenePath?: string
      patchUrl: string
      cropBox: { x: number; y: number; size: number }
      maskPaths?: Array<{ points: Array<{ x: number; y: number }>; brushSize: number; isEraser: boolean }>
    }) => Promise<{ path: string; previewDataUrl: string; width: number; height: number; size: number }>
    readLocalCropPreview: (filePath: string) => Promise<{ previewDataUrl: string }>
    findLocalCropComposite: (taskId: number) => Promise<{ path: string; width?: number; height?: number } | null>
    apiRequest: (payload: {
      path: string
      method?: 'GET' | 'POST'
      token?: string
      json?: Record<string, unknown>
      file?: { name: string; type: string; bytes: ArrayBuffer }
    }) => Promise<{ status: number; body: unknown }>
    downloadResult: (payload: { url: string; taskId: number; index: number }) =>
      Promise<{ path: string; sha256: string; size: number }>
    writeWorkspaceFile: (payload: { name?: string; bytes: ArrayBuffer; extension?: string }) =>
      Promise<{ path: string; size: number; sha256: string }>
    workspaceStorage: () => Promise<number>
    preparePsdDraft: (payload: {
      taskId: string
      imageId: string
      options: { writeLayerMasks: boolean; subjectProtection: boolean }
    }) => Promise<{
      draftId: string
      width: number
      height: number
      hasSubject: boolean
      hasProp: boolean
      sourceDataUrl: string
      subjectMaskDataUrl: string
      propMaskDataUrl: string
    }>
    processPsd: (payload: {
      taskId: string
      imageId: string
      autoExport: boolean
      options: { writeLayerMasks: boolean; subjectProtection: boolean }
      draftId?: string
      subjectMaskDataUrl?: string
      propMaskDataUrl?: string
      width?: number
      height?: number
    }) => Promise<{
      path: string
      width: number
      height: number
      size: number
      layerNames: string[]
      textRegionCount: number
      instanceCount: number
      engine: 'ai' | 'mixed' | 'compat'
    }>
    psdEngineStatus: () => Promise<{ ready: boolean; missing: string[] }>
    modelsStatus: () => Promise<ModelStoreStatus>
    modelsDiskUsage: () => Promise<number>
    modelsVerify: () => Promise<{ ok: boolean; corrupt: string[] }>
    modelsRepair: () => Promise<ModelStoreStatus>
    onModelsStatus: (callback: (value: ModelStoreStatus) => void) => () => void
    updateState: () => Promise<UpdaterState>
    updateCheck: (manual: boolean) => Promise<UpdaterState>
    updateDownload: () => Promise<UpdaterState>
    updateApply: () => Promise<UpdaterState>
    onUpdateState: (callback: (value: UpdaterState) => void) => () => void
    revealPsd: (filePath: string) => Promise<boolean>
    openPsd: (filePath: string) => Promise<boolean>
openInPhotoshop: (filePath: string) => Promise<{ fallback: boolean }>
    openInPhotopea: (payload: {
      filePath: string
      theme?: DesktopSettings['theme']
      taskId?: string
    }) => Promise<{ sessionId: string; path: string; fileName: string }>
    notify: (payload: { title?: string; body?: string; silent?: boolean }) => Promise<boolean>
    writeClipboard: (text: string) => Promise<boolean>
    writeClipboardImage: (payload: { path?: string; dataUrl?: string }) => Promise<boolean>
    readClipboardImage: () => Promise<{ name: string; type: string; bytes: ArrayBuffer } | null>
    voiceStart: () => Promise<boolean>
    voiceStop: () => Promise<boolean>
    onVoiceEvent: (callback: (value: { type: string; text?: string; message?: string; code?: number }) => void) => () => void
    onPsdProgress: (callback: (value: { taskId: string; progress: number; stage: string }) => void) => () => void
    onMenu: (callback: (action: string) => void) => () => void
    onSystemResume: (callback: () => void) => () => void
onWindowChrome: (callback: (value: { fullscreen: boolean }) => void) => () => void
    onPhotopeaEvent: (callback: (value: {
      type: 'saved' | 'closed' | 'error'
      sessionId?: string
      path?: string
      size?: number
      mode?: 'overwrite' | 'saveAs'
      format?: 'psd' | 'png'
      taskId?: string
      sourcePath?: string
      message?: string
    }) => void) => () => void
  }

  interface Window {
    desktop?: DesktopBridge
  }
}

export {}
