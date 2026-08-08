import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('photopeaHost', {
  ready: () => ipcRenderer.invoke('photopea:host-ready'),
  save: (payload: {
    sessionId: string
    bytes: ArrayBuffer
    mode: 'overwrite' | 'saveAs'
    format?: 'psd' | 'png'
  }) => ipcRenderer.invoke('photopea:save', payload),
  close: () => ipcRenderer.invoke('photopea:close'),
  reportError: (message: string) => ipcRenderer.invoke('photopea:error', message),
  onBootstrap: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
    ipcRenderer.on('photopea:bootstrap', listener)
    return () => ipcRenderer.removeListener('photopea:bootstrap', listener)
  }
})
