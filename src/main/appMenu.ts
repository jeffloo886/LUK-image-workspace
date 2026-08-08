/*
 * English application menu. Previously there was no setApplicationMenu, so Electron's default Help menu
 * 还挂着 electronjs.org 的链接，很掉价。这里补上标准 macOS 菜单与快捷键，并把
 * 「设置 ⌘,」「检查更新」桥回渲染层。
 */
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { UPDATE_RELEASES_PAGE } from './updater/keys'

type MenuActions = {
  openSettings: () => void
  checkForUpdates: () => void
  openManual: () => void
}

export function buildApplicationMenu(getWindow: () => BrowserWindow | null, actions: MenuActions): void {
  const appName = app.getName()

  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { label: 'Check for Updates…', click: () => actions.checkForUpdates() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${appName}` }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' }
      ]
    },
    {
      label: 'Window',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        { role: 'zoom', label: 'Zoom' },
        { type: 'separator' },
        { role: 'front', label: 'Bring All to Front' }
      ]
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        { label: 'User Guide', click: () => actions.openManual() },
        {
          label: 'Release Page',
          click: () => void shell.openExternal(UPDATE_RELEASES_PAGE)
        }
      ]
    }
  ]

  // Add a developer-tools toggle in development builds only.
  if (!app.isPackaged) {
    ;(template[2].submenu as MenuItemConstructorOptions[]).push(
      { type: 'separator' },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'Alt+Cmd+I',
        click: () => getWindow()?.webContents.toggleDevTools()
      },
      { role: 'reload', label: 'Reload' }
    )
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
