/*
 * 中文应用菜单。此前完全没有 setApplicationMenu，Electron 默认菜单的「帮助」里
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
        { role: 'about', label: `关于 ${appName}` },
        { label: '检查更新…', click: () => actions.checkForUpdates() },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}` }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'togglefullscreen', label: '进入全屏' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' }
      ]
    },
    {
      label: '窗口',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' }
      ]
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '功能说明', click: () => actions.openManual() },
        {
          label: '发布主页',
          click: () => void shell.openExternal(UPDATE_RELEASES_PAGE)
        }
      ]
    }
  ]

  // 开发期加一个「切换开发者工具」，正式包不出现
  if (!app.isPackaged) {
    ;(template[2].submenu as MenuItemConstructorOptions[]).push(
      { type: 'separator' },
      {
        label: '切换开发者工具',
        accelerator: 'Alt+Cmd+I',
        click: () => getWindow()?.webContents.toggleDevTools()
      },
      { role: 'reload', label: '重新载入' }
    )
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
