/*
 * 记住窗口大小与位置。之前每次都以 1220×720 最小尺寸开在屏幕中央，是最被用户
 * 感知的「廉价感」来源。恢复时对着当前所有显示器做可见性校验，避免窗口开在
 * 已拔掉的外接屏上变成看不见。
 */
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type WindowState = Rectangle & { maximized?: boolean }

const MIN_WIDTH = 1220
const MIN_HEIGHT = 720

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

export function loadWindowState(): WindowState | null {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState
    if (
      typeof raw.width !== 'number' ||
      typeof raw.height !== 'number' ||
      typeof raw.x !== 'number' ||
      typeof raw.y !== 'number'
    ) {
      return null
    }
    // 尺寸下限兜底
    raw.width = Math.max(raw.width, MIN_WIDTH)
    raw.height = Math.max(raw.height, MIN_HEIGHT)
    // 可见性校验：窗口中心必须落在某块显示器的工作区内，否则丢弃位置
    const center = { x: raw.x + raw.width / 2, y: raw.y + raw.height / 2 }
    const onScreen = screen.getAllDisplays().some((display) => {
      const { x, y, width, height } = display.workArea
      return center.x >= x && center.x <= x + width && center.y >= y && center.y <= y + height
    })
    return onScreen ? raw : { ...raw, x: undefined as never, y: undefined as never }
  } catch {
    return null
  }
}

/** 防抖持久化窗口几何；返回解绑函数。 */
export function trackWindowState(win: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null

  const persist = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
      const bounds = win.getBounds()
      try {
        writeFileSync(
          stateFile(),
          JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
          { mode: 0o600 }
        )
      } catch {
        // 写盘失败不影响使用
      }
    }, 500)
  }

  win.on('resize', persist)
  win.on('move', persist)
  return () => {
    if (timer) clearTimeout(timer)
    win.removeListener('resize', persist)
    win.removeListener('move', persist)
  }
}
