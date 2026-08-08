/*
 * 工作台五个创作页共用的一套切换动效。
 *
 * 之前单图组（560ms FLIP + 高度形变）和批量组（110ms 淡出 + 220ms 淡入）各写各的，
 * 跨组切换干脆没动画，用户看到的是几个割裂的页面。这里把动作原语收拢成一处，
 * 三条切换路径都从同一套 token 取值，观感才对得上。
 */

/** 组内切换：composer 位移/形变的时长 */
export const DURATION_MOVE = 560
/** 组内切换结束后的清理时刻，比 DURATION_MOVE 略长，留出最后一帧 */
export const CLEANUP_MOVE = 620
/** 跨组切换：幅度刻意小于组内，保持层级感 */
export const DURATION_CROSS = 340

export const EASING_ENTER = 'cubic-bezier(0.22, 1, 0.36, 1)'

const STAGGER_STEP = 14
const STAGGER_MAX = 56

export type MotionDirection = 'forward' | 'backward'

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 一批动画的生命周期管理：取消旧的、按序号丢弃过期的。
 * 快速连点导航时，只有最后一次切换的动画应该活着。
 */
export class MotionBatch {
  private animations: Animation[] = []
  private serial = 0

  /** 开一次新的切换，返回该次的序号；调用方用 isStale() 判断是否已被后来的切换取代 */
  begin(): number {
    this.cancel()
    return ++this.serial
  }

  isStale(token: number): boolean {
    return token !== this.serial
  }

  add(animation: Animation | null | undefined): void {
    if (animation) this.animations.push(animation)
  }

  cancel(): void {
    this.animations.forEach((animation) => animation.cancel())
    this.animations = []
  }
}

/**
 * FLIP 的 Last-Invert-Play：元素已经落到新位置了，把它拉回旧位置再放开。
 * fromRect 必须在 DOM 交换「之前」量好。
 */
export function flipMove(
  el: HTMLElement,
  fromRect: DOMRect,
  options: { duration?: number; easing?: string } = {}
): Animation | null {
  const liveRect = el.getBoundingClientRect()
  const deltaY = fromRect.top - liveRect.top
  const deltaX = fromRect.left - liveRect.left
  if (Math.abs(deltaY) < 1 && Math.abs(deltaX) < 1) return null
  return el.animate(
    [
      { transform: `translate3d(${deltaX.toFixed(2)}px, ${deltaY.toFixed(2)}px, 0)`, opacity: 1 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 }
    ],
    {
      duration: options.duration ?? DURATION_MOVE,
      easing: options.easing ?? EASING_ENTER,
      fill: 'both'
    }
  )
}

/** 高度形变。差值太小就别动，否则是徒增一帧抖动。 */
export function morphHeight(
  el: HTMLElement,
  fromHeight: number,
  options: { duration?: number; easing?: string } = {}
): Animation | null {
  const toHeight = el.getBoundingClientRect().height
  if (Math.abs(fromHeight - toHeight) <= 1) return null
  return el.animate(
    [{ height: `${fromHeight.toFixed(2)}px` }, { height: `${toHeight.toFixed(2)}px` }],
    {
      duration: options.duration ?? DURATION_MOVE,
      easing: options.easing ?? EASING_ENTER,
      fill: 'both'
    }
  )
}

/** 控件错峰入场，方向决定横向偏移的正负 */
export function staggerIn(
  nodes: ArrayLike<HTMLElement> | null | undefined,
  direction: MotionDirection
): Animation[] {
  if (!nodes) return []
  const offset = direction === 'forward' ? 4 : -4
  return Array.from(nodes).map((node, index) =>
    node.animate(
      [
        { opacity: 0.55, transform: `translate3d(${offset}px, 0, 0)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' }
      ],
      {
        duration: 180,
        delay: Math.min(index * STAGGER_STEP, STAGGER_MAX),
        easing: EASING_ENTER,
        fill: 'both'
      }
    )
  )
}

/** 跨组：新内容轻微下沉淡入 */
export function crossFadeIn(el: HTMLElement): Animation {
  return el.animate(
    [
      { opacity: 0, transform: 'translate3d(0, 6px, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ],
    { duration: DURATION_CROSS, easing: EASING_ENTER, fill: 'both' }
  )
}
