<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 0–100，滑块位置 */
    progress: number
    ultra: boolean
    /** horizontal：分辨率轨右→左；vertical：场景空态上→下 */
    direction?: 'horizontal' | 'vertical'
  }>(),
  { direction: 'horizontal' }
)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const hostRef = ref<HTMLElement | null>(null)

type Cell = {
  phase: number
  speed: number
  shade: number
  sparkle: boolean
  jitter: number
}

const CELL = 3
const GAP = 1
const STRIDE = CELL + GAP
/**
 * 动画从「倒数第二档」之后才开始（1K→2K 无动画；2K→4K 渐入）。
 * 三档时 progress=50 是 2K，>50 才有闪烁。
 */
const ANIM_START = 0.5

let cells: Cell[] = []
let cols = 0
let rows = 0
let raf = 0
let resizeObserver: ResizeObserver | null = null
let reducedMotion = false

function readTheme(): {
  accent: [number, number, number]
  soft: [number, number, number]
  deep: [number, number, number]
  highlight: [number, number, number]
  silk: [number, number, number]
  blush: [number, number, number]
  dark: boolean
} {
  const styles = getComputedStyle(document.documentElement)
  const dark = document.documentElement.dataset.theme === 'dark'
  const accent = hexToRgb(styles.getPropertyValue('--ultra').trim() || '#d97757')
  if (dark) {
    return {
      accent,
      soft: hexToRgb(styles.getPropertyValue('--ultra-soft').trim() || '#a86049'),
      deep: mix(accent, [120, 55, 35], 0.2),
      highlight: [255, 244, 236],
      silk: [255, 244, 236],
      blush: [232, 150, 122],
      dark
    }
  }
  // 浅色「值钱感」：底色带要够深；像素用亮桃/玫瑰金做纹理
  return {
    accent: mix(accent, [190, 85, 55], 0.22),
    soft: [245, 175, 150],
    deep: [210, 105, 75],
    highlight: [255, 255, 255],
    silk: [255, 232, 222],
    blush: [248, 180, 155],
    dark
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const raw = hex.replace('#', '').trim()
  if (raw.length === 3) {
    return [parseInt(raw[0] + raw[0], 16), parseInt(raw[1] + raw[1], 16), parseInt(raw[2] + raw[2], 16)]
  }
  if (raw.length >= 6) {
    return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)]
  }
  return [217, 119, 87]
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k)
  ]
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * 2K→4K：前段跟手（刚过 2K 就有可见动态），末端沉稳。
 * 不用 smootherstep 起步（导数为 0，会拖很久才「活」）。
 */
function animStrength(progress01: number): number {
  const u = clamp01((progress01 - ANIM_START) / Math.max(1e-6, 1 - ANIM_START))
  return 1 - Math.pow(1 - u, 1.55)
}

function rebuildGrid(width: number, height: number): void {
  cols = Math.max(1, Math.floor((width + GAP) / STRIDE))
  rows = Math.max(1, Math.floor((height + GAP) / STRIDE))
  cells = Array.from({ length: cols * rows }, () => ({
    phase: Math.random() * Math.PI * 2,
    speed: 0.85 + Math.random() * 2.4,
    shade: Math.random(),
    sparkle: Math.random() < 0.32,
    jitter: Math.random()
  }))
}

function fillWashStops(
  wash: CanvasGradient,
  theme: ReturnType<typeof readTheme>,
  washT: number,
  vertical: boolean
): void {
  if (theme.dark) {
    const a1 = 0.06 * washT
    const a2 = 0.16 * washT
    const a3 = 0.32 * washT
    const a4 = 0.55 * washT
    const a5 = 0.78 * washT
    if (vertical) {
      // 场景空态只保留一层暖色环境光，像素波本身承担视觉重心。
      wash.addColorStop(0, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${0.34 * washT})`)
      wash.addColorStop(0.24, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${0.2 * washT})`)
      wash.addColorStop(0.54, `rgba(${theme.soft[0]},${theme.soft[1]},${theme.soft[2]},${0.08 * washT})`)
      wash.addColorStop(1, 'rgba(0,0,0,0)')
    } else {
      wash.addColorStop(0, 'rgba(0,0,0,0)')
      wash.addColorStop(0.1, `rgba(${theme.soft[0]},${theme.soft[1]},${theme.soft[2]},${a1})`)
      wash.addColorStop(0.28, `rgba(${theme.soft[0]},${theme.soft[1]},${theme.soft[2]},${a2})`)
      wash.addColorStop(0.5, `rgba(${theme.soft[0]},${theme.soft[1]},${theme.soft[2]},${a3})`)
      wash.addColorStop(0.76, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${a4})`)
      wash.addColorStop(1, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${a5})`)
    }
    return
  }

  if (vertical) {
    wash.addColorStop(0, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${0.38 * washT})`)
    wash.addColorStop(0.26, `rgba(${theme.deep[0]},${theme.deep[1]},${theme.deep[2]},${0.22 * washT})`)
    wash.addColorStop(0.58, `rgba(${theme.soft[0]},${theme.soft[1]},${theme.soft[2]},${0.08 * washT})`)
    wash.addColorStop(1, 'rgba(0,0,0,0)')
    return
  }

  const pale = mix(theme.silk, [232, 230, 226], 0.45)
  wash.addColorStop(0, `rgba(${pale[0]},${pale[1]},${pale[2]},${0.0})`)
  wash.addColorStop(0.12, `rgba(${theme.silk[0]},${theme.silk[1]},${theme.silk[2]},${0.28 * washT})`)
  wash.addColorStop(0.3, `rgba(${theme.blush[0]},${theme.blush[1]},${theme.blush[2]},${0.58 * washT})`)
  wash.addColorStop(0.52, `rgba(${theme.soft[0]},${theme.soft[1]},${theme.soft[2]},${0.82 * washT})`)
  wash.addColorStop(0.74, `rgba(${theme.deep[0]},${theme.deep[1]},${theme.deep[2]},${0.94 * washT})`)
  wash.addColorStop(0.9, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${0.98 * washT})`)
  wash.addColorStop(1, `rgba(${theme.accent[0]},${theme.accent[1]},${theme.accent[2]},${1.0 * washT})`)
}

function paint(timeMs: number): void {
  const canvas = canvasRef.value
  const host = hostRef.value
  if (!canvas || !host) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cssW = Math.max(1, host.clientWidth)
  const cssH = Math.max(1, host.clientHeight)
  const pixelW = Math.round(cssW * dpr)
  const pixelH = Math.round(cssH * dpr)
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
    rebuildGrid(cssW, cssH)
  }

  const progress = clamp01(props.progress / 100)
  const strength = animStrength(progress)
  const vertical = props.direction === 'vertical'

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  if (strength < 0.004) return

  const theme = readTheme()
  const mosaicT = clamp01(strength * 1.05)
  const washT = clamp01(strength)
  const flowT = clamp01(0.35 + strength * 0.65)
  const sparkT = smootherstep(0.05, 1, strength)
  const t = timeMs / 1000

  if (vertical) {
    paintVerticalField(ctx, cssW, cssH, theme, washT, mosaicT, t)
    return
  }

  const axisLen = cssW
  const span = theme.dark
    ? (0.22 + 0.7 * smootherstep(0, 1, Math.max(mosaicT, washT))) * axisLen
    : (0.35 + 0.6 * smootherstep(0, 1, washT)) * axisLen
  if (span < 1) return

  const origin = cssW - span

  const wash = ctx.createLinearGradient(origin, 0, cssW, 0)
  fillWashStops(wash, theme, washT, false)
  ctx.fillStyle = wash
  ctx.fillRect(origin, 0, span, cssH)

  const gridH = rows * STRIDE - GAP
  const offsetY = Math.max(0, Math.floor((cssH - gridH) / 2))

  const flowSpeed = reducedMotion ? 0 : 14 + flowT * flowT * 70
  const flowPos = t * flowSpeed
  const driftSpeed = 0.18 + flowT * flowT * 0.9
  const drift = reducedMotion ? 0.92 : ((t * driftSpeed) % 1.45)
  const waveK = (0.16 + flowT * 0.1) * (axisLen / Math.max(span, 36))

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = col * STRIDE
      if (x + CELL < origin - 0.5) continue
      if (x > cssW + 0.5) continue
      const y = offsetY + row * STRIDE
      const cell = cells[row * cols + col]
      if (!cell) continue

      const along = x + CELL * 0.5
      const nx = span <= CELL ? 1 : clamp01((along - origin) / span)
      const tail = theme.dark
        ? Math.pow(smootherstep(0.0, 0.42, nx + (cell.jitter - 0.5) * 0.05), 1.15)
        : Math.pow(smootherstep(0.06, 0.55, nx + (cell.jitter - 0.5) * 0.04), 1.1)
      if (tail < 0.012) continue

      const densProfile = Math.pow(smootherstep(theme.dark ? 0.0 : 0.08, 0.92, nx), theme.dark ? 1.02 : 0.95)
      const densLive = densProfile * (theme.dark ? 0.5 + 0.5 * mosaicT : 0.62 + 0.38 * mosaicT) * (0.9 + cell.jitter * 0.14)
      const keep = densLive * (0.5 + 0.5 * tail)
      if (cell.shade > keep) continue

      const colorRamp = smootherstep(0.04, 0.85, nx)
      let color: [number, number, number]
      if (theme.dark) {
        color = mix(theme.soft, theme.accent, Math.pow(colorRamp, 0.65))
      } else {
        const local = mix(
          mix(theme.silk, theme.blush, clamp01(colorRamp * 1.1)),
          mix(theme.soft, theme.accent, colorRamp),
          smootherstep(0.25, 1, colorRamp)
        )
        if (cell.shade > 0.78) {
          color = mix(local, theme.highlight, 0.55 + cell.jitter * 0.25)
        } else if (cell.shade > 0.45) {
          color = mix(local, theme.highlight, 0.12 + cell.shade * 0.2)
        } else {
          color = mix(local, theme.deep, 0.18 + (1 - cell.shade) * 0.22)
        }
      }
      let lum = theme.dark ? 0.38 + cell.shade * 0.5 : 0.5 + cell.shade * 0.35

      if (!reducedMotion) {
        const fromEdge = (1 - nx) * span
        const cross = row

        const f1 = Math.sin(t * cell.speed * 1.15 + cell.phase)
        const f2 = Math.sin(t * (cell.speed * 1.7 + 0.4) + cell.phase * 2.1)
        const f3 = Math.sin(t * (cell.speed * 0.55 + 0.85) + cell.phase * 0.7 + cross * 1.05)
        const chaos = f1 * 0.42 + f2 * 0.36 + f3 * 0.22
        lum += chaos * (theme.dark ? 0.2 + flowT * 0.18 : 0.14 + flowT * 0.14)

        const dir = Math.sin((fromEdge - flowPos) * waveK + cell.phase * 0.5 + cross * 0.16)
        const dirBoost = Math.pow(Math.max(0, dir), 1.25)
        const edgeBias = 0.55 + nx * 0.75
        lum += dirBoost * (0.34 + flowT * 0.5) * edgeBias * (0.65 + cell.shade * 0.4)

        const center = 1.1 - drift
        const softPush = Math.exp(-(nx - center) * (nx - center) * 3.6)
        lum += softPush * (0.14 + flowT * 0.28) * densProfile

        const band = Math.pow(
          Math.max(0, Math.sin((fromEdge - flowPos * 1.2) * waveK * 0.55 + cell.jitter * 2)),
          2.1
        )
        lum += band * (0.12 + flowT * 0.2) * edgeBias

        if (cell.sparkle || (!theme.dark && cell.jitter > 0.7)) {
          const burst = Math.sin((fromEdge - flowPos * 0.95) * 0.12 + t * cell.speed * 2.3 + cell.phase * 3)
          const flash =
            Math.pow(Math.max(0, burst), theme.dark ? 7 + cell.shade * 4 : 6 + cell.shade * 3.5)
            * (0.4 + 0.6 * sparkT)
            * densProfile
          if (flash > 0.025) {
            lum += flash * (theme.dark ? 1.35 : 1.2) * edgeBias
            color = mix(color, theme.highlight, Math.min(1, flash * (theme.dark ? 1.45 : 1.5) * edgeBias))
          }
        }
      } else if (cell.sparkle && cell.shade > 0.7) {
        lum += 0.16 * mosaicT
      }

      lum = Math.max(0.2, Math.min(1.55, lum))
      if (lum > 1) color = mix(color, theme.highlight, Math.min(1, (lum - 1) * (theme.dark ? 1.3 : 1.45)))

      const body = theme.dark ? 0.28 + colorRamp * 0.82 : 0.18 + colorRamp * 0.55 + cell.shade * 0.18
      const mosaicGain = theme.dark ? 1 : 0.78
      const alpha = Math.min(
        1,
        body * Math.min(1, lum) * (0.72 + 0.28 * mosaicT) * Math.sqrt(tail) * mosaicGain
      )
      if (alpha < 0.03) continue
      ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`
      ctx.fillRect(x, y, CELL, CELL)
    }
  }
}

/**
 * 场景空态：两道横向像素干涉波。
 * 它不是下落粒子，也不做随机爆闪；动画只沿水平方向缓慢巡游，中心主动留静区。
 */
function paintVerticalField(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  theme: ReturnType<typeof readTheme>,
  washT: number,
  mosaicT: number,
  t: number
): void {
  const span = (theme.dark ? 0.8 : 0.84) * cssH
  if (span < 1) return

  const wash = ctx.createLinearGradient(0, 0, 0, span)
  fillWashStops(wash, theme, washT, true)
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, cssW, span)

  const gridW = cols * STRIDE - GAP
  const gridH = rows * STRIDE - GAP
  const offsetX = Math.max(0, Math.floor((cssW - gridW) / 2))
  const offsetY = Math.max(0, Math.floor((cssH - gridH) / 2))
  const phase = reducedMotion ? 0.9 : t * 0.42
  const scanX = reducedMotion ? 0.5 : ((t * 0.075) % 1.36) - 0.18

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = cells[row * cols + col]
      if (!cell) continue
      const x = offsetX + col * STRIDE
      const y = offsetY + row * STRIDE
      const nx = (x + CELL * 0.5) / Math.max(cssW, 1)
      const ny = (y + CELL * 0.5) / Math.max(cssH, 1)
      if (ny > 0.82) continue

      const waveA = 0.17
        + Math.sin(nx * Math.PI * 4.1 - phase) * 0.055
        + Math.sin(nx * Math.PI * 10.4 + phase * 0.58) * 0.018
      const waveB = 0.42
        + Math.sin(nx * Math.PI * 3.15 + phase * 0.72 + 1.4) * 0.07
        + Math.sin(nx * Math.PI * 7.2 - phase * 0.45) * 0.022
      const distanceA = ny - waveA
      const distanceB = ny - waveB
      const ribbonA = Math.exp(-(distanceA * distanceA) / 0.0032)
      const ribbonB = Math.exp(-(distanceB * distanceB) / 0.0058)
      const canopy = Math.pow(1 - smoothstep(0.02, 0.76, ny), 1.35)
      const scan = Math.exp(-((nx - scanX) * (nx - scanX)) / 0.012)
      const centerQuiet = 1 - 0.7 * Math.exp(
        -(((nx - 0.5) * (nx - 0.5)) / 0.055 + ((ny - 0.5) * (ny - 0.5)) / 0.07)
      )
      const field = (
        0.035 * canopy
        + ribbonA * 0.58
        + ribbonB * 0.3
        + scan * (ribbonA * 0.22 + ribbonB * 0.13)
      ) * centerQuiet * mosaicT
      if (cell.shade > field * (0.82 + cell.jitter * 0.38)) continue

      const slowPulse = reducedMotion
        ? 0.7
        : 0.62 + Math.sin(t * 0.72 + cell.phase + nx * 2.8) * 0.08
      const energy = clamp01(ribbonA * 0.86 + ribbonB * 0.48 + scan * 0.22)
      let color = mix(theme.soft, theme.accent, 0.3 + energy * 0.62)
      if (energy > 0.72 && cell.sparkle) {
        color = mix(color, theme.highlight, (energy - 0.72) * 1.5)
      }
      const alpha = Math.min(
        theme.dark ? 0.88 : 0.7,
        (0.12 + energy * 0.76) * slowPulse * centerQuiet * washT
      )
      if (alpha < 0.035) continue
      ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`
      ctx.fillRect(x, y, CELL, CELL)
    }
  }
}

function tick(now: number): void {
  paint(now)
  raf = requestAnimationFrame(tick)
}

function start(): void {
  cancelAnimationFrame(raf)
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  raf = requestAnimationFrame(tick)
}

function stop(): void {
  cancelAnimationFrame(raf)
  raf = 0
}

onMounted(() => {
  start()
  resizeObserver = new ResizeObserver(() => {
    const host = hostRef.value
    if (!host) return
    rebuildGrid(host.clientWidth, host.clientHeight)
    paint(performance.now())
  })
  if (hostRef.value) resizeObserver.observe(hostRef.value)
})

watch(
  () => [props.progress, props.ultra, props.direction],
  () => paint(performance.now())
)

onBeforeUnmount(() => {
  stop()
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="hostRef" class="resolution-energy" aria-hidden="true">
    <canvas ref="canvasRef" class="resolution-energy-canvas" />
  </div>
</template>

<style scoped>
.resolution-energy {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}
.resolution-energy-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
