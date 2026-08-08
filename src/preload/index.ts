import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  getProviderConfig: () => ipcRenderer.invoke('desktop:get-provider-config'),
  saveProviderConfig: (value: unknown) => ipcRenderer.invoke('desktop:save-provider-config', value),
  testProviderConnection: () => ipcRenderer.invoke('desktop:test-provider-connection'),
  saveSettings: (value: unknown) => ipcRenderer.invoke('desktop:save-settings', value),
  requestMicrophoneAccess: () => ipcRenderer.invoke('desktop:request-microphone-access'),
  chooseOutputDirectory: () => ipcRenderer.invoke('desktop:choose-output'),
  openOutputDirectory: () => ipcRenderer.invoke('desktop:open-output'),
  selectImages: () => ipcRenderer.invoke('desktop:select-images'),
  selectWorkflowImages: (options: unknown) => ipcRenderer.invoke('desktop:select-workflow-images', options),
  selectPsdImage: () => ipcRenderer.invoke('desktop:select-psd-image'),
  importPsdImage: (payload: unknown) => ipcRenderer.invoke('desktop:import-psd-image', payload),
  importAuthorizedImage: (payload: unknown) => ipcRenderer.invoke('desktop:import-authorized-image', payload),
  readSelectedImage: (id: string) => ipcRenderer.invoke('desktop:read-selected-image', id),
  cacheLocalCropScene: (payload: unknown) => ipcRenderer.invoke('desktop:cache-local-crop-scene', payload),
  compositeLocalCrop: (payload: unknown) => ipcRenderer.invoke('desktop:composite-local-crop', payload),
  readLocalCropPreview: (filePath: string) => ipcRenderer.invoke('desktop:read-local-crop-preview', filePath),
  readSavedResultPreview: (filePath: string) => ipcRenderer.invoke('desktop:read-saved-result-preview', filePath),
  findLocalCropComposite: (taskId: number) => ipcRenderer.invoke('desktop:find-local-crop-composite', taskId),
  apiRequest: (payload: unknown) => ipcRenderer.invoke('desktop:api-request', payload),
  downloadResult: (payload: { url: string; taskId: number; index: number }) =>
    ipcRenderer.invoke('desktop:download-result', payload),
  writeWorkspaceFile: (payload: { name?: string; bytes: ArrayBuffer; extension?: string }) =>
    ipcRenderer.invoke('desktop:write-workspace-file', payload),
  workspaceStorage: () => ipcRenderer.invoke('desktop:workspace-storage'),
  processPsd: (payload: unknown) => ipcRenderer.invoke('desktop:process-psd', payload),
  preparePsdDraft: (payload: unknown) => ipcRenderer.invoke('desktop:prepare-psd-draft', payload),
  psdEngineStatus: () => ipcRenderer.invoke('desktop:psd-engine-status'),
  modelsStatus: () => ipcRenderer.invoke('desktop:models-status'),
  modelsDiskUsage: () => ipcRenderer.invoke('desktop:models-disk-usage'),
  modelsVerify: () => ipcRenderer.invoke('desktop:models-verify'),
  modelsRepair: () => ipcRenderer.invoke('desktop:models-repair'),
  onModelsStatus: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
    ipcRenderer.on('desktop:models-status', listener)
    return () => ipcRenderer.removeListener('desktop:models-status', listener)
  },
  updateState: () => ipcRenderer.invoke('desktop:update-state'),
  updateCheck: (manual: boolean) => ipcRenderer.invoke('desktop:update-check', manual),
  updateDownload: () => ipcRenderer.invoke('desktop:update-download'),
  updateApply: () => ipcRenderer.invoke('desktop:update-apply'),
  onUpdateState: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
    ipcRenderer.on('desktop:update-state', listener)
    return () => ipcRenderer.removeListener('desktop:update-state', listener)
  },
  revealPsd: (filePath: string) => ipcRenderer.invoke('desktop:reveal-psd', filePath),
  openPsd: (filePath: string) => ipcRenderer.invoke('desktop:open-psd', filePath),
openInPhotoshop: (filePath: string) => ipcRenderer.invoke('desktop:open-in-photoshop', filePath),
  openInPhotopea: (payload: unknown) => ipcRenderer.invoke('desktop:open-in-photopea', payload),
  notify: (payload: unknown) => ipcRenderer.invoke('desktop:notify', payload),
  writeClipboard: (text: string) => ipcRenderer.invoke('desktop:write-clipboard', text),
  writeClipboardImage: (payload: { path?: string; dataUrl?: string }) =>
    ipcRenderer.invoke('desktop:write-clipboard-image', payload),
  readClipboardImage: () => ipcRenderer.invoke('desktop:read-clipboard-image'),
  voiceStart: () => ipcRenderer.invoke('desktop:voice-start'),
  voiceStop: () => ipcRenderer.invoke('desktop:voice-stop'),
  onVoiceEvent: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
    ipcRenderer.on('desktop:voice-event', listener)
    return () => ipcRenderer.removeListener('desktop:voice-event', listener)
  },
  onPsdProgress: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
    ipcRenderer.on('desktop:psd-progress', listener)
    return () => ipcRenderer.removeListener('desktop:psd-progress', listener)
  },
  onMenu: (callback: (action: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on('desktop:menu', listener)
    return () => ipcRenderer.removeListener('desktop:menu', listener)
  },
  onSystemResume: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('desktop:system-resumed', listener)
    return () => ipcRenderer.removeListener('desktop:system-resumed', listener)
  },
onWindowChrome: (callback: (value: { fullscreen: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { fullscreen: boolean }) => callback(value)
    ipcRenderer.on('desktop:window-chrome', listener)
    return () => ipcRenderer.removeListener('desktop:window-chrome', listener)
  },
  onPhotopeaEvent: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
    ipcRenderer.on('desktop:photopea-event', listener)
    return () => ipcRenderer.removeListener('desktop:photopea-event', listener)
  }
})
