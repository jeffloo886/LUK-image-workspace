<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Eraser, LoaderCircle, Paintbrush, X, Check, RotateCcw, Undo2 } from 'lucide-vue-next'

export type PsdMaskDraft = {
  draftId: string
  width: number
  height: number
  hasSubject: boolean
  hasProp: boolean
  sourceDataUrl: string
  subjectMaskDataUrl: string
  propMaskDataUrl: string
}

const props = defineProps<{
  draft: PsdMaskDraft
  exporting?: boolean
}>()

const emit = defineEmits<{
  cancel: []
  export: [payload: { subjectMaskDataUrl: string; propMaskDataUrl: string }]
}>()

type LayerKey = 'subject' | 'prop'
type ToolMode = 'paint' | 'erase'
type Snapshot = { subject: Uint8Array; prop: Uint8Array }

const layer = ref<LayerKey>('subject')
const tool = ref<ToolMode>('paint')
const brushSize = ref(28)
const overlayOpacity = ref(0.3)

const stageRef = ref<HTMLDivElement | null>(null)
const viewCanvas = ref<HTMLCanvasElement | null>(null)
const sourceImg = ref<HTMLImageElement | null>(null)

let subjectMask: Uint8Array = new Uint8Array(0)
let propMask: Uint8Array = new Uint8Array(0)
const imgW = ref(0)
const imgH = ref(0)

const ready = ref(false)
const painting = ref(false)
const lastPt = ref<{ x: number; y: number } | null>(null)
const scale = ref(1)

// 笔刷预览（屏幕坐标，相对 stage）
const cursorVisible = ref(false)
const cursorX = ref(0)
const cursorY = ref(0)

// 撤销栈：最多 40 步
const undoStack: Snapshot[] = []
const canUndo = ref(false)
const MAX_UNDO = 40
let strokeSnapshotTaken = false

const layerLabel = computed(() => (layer.value === 'subject' ? 'Subject' : 'Prop'))
const hint = computed(() =>
  layer.value === 'subject'
    ? 'Paint missing edges (hem or hair); erase mistakes. Keep the trophy out of the subject layer.'
    : 'Paint in the trophy; erase gold streaks or fragments.'
)
const brushPreviewPx = computed(() => Math.max(6, brushSize.value * scale.value))

function cloneMask(m: Uint8Array): Uint8Array {
  return new Uint8Array(m)
}

function pushUndo(): void {
  undoStack.push({
    subject: cloneMask(subjectMask),
    prop: cloneMask(propMask)
  })
  if (undoStack.length > MAX_UNDO) undoStack.shift()
  canUndo.value = undoStack.length > 0
}

function undo(): void {
  if (!undoStack.length || props.exporting) return
  const snap = undoStack.pop()!
  subjectMask = snap.subject
  propMask = snap.prop
  canUndo.value = undoStack.length > 0
  paint()
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load the image'))
    img.src = url
  })
}

async function maskFromDataUrl(url: string, w: number, h: number): Promise<Uint8Array> {
  const img = await loadImage(url)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8Array(new ArrayBuffer(w * h))
  for (let i = 0; i < w * h; i += 1) out[i] = data[i * 4]
  return out
}

function layout(): void {
  const stage = stageRef.value
  const canvas = viewCanvas.value
  if (!stage || !canvas || !imgW.value || !imgH.value) return
  const pad = 20
  const availW = Math.max(100, stage.clientWidth - pad * 2)
  const availH = Math.max(100, stage.clientHeight - pad * 2)
  const s = Math.min(availW / imgW.value, availH / imgH.value, 1.25)
  scale.value = s
  const dw = Math.round(imgW.value * s)
  const dh = Math.round(imgH.value * s)
  canvas.width = dw
  canvas.height = dh
  canvas.style.width = `${dw}px`
  canvas.style.height = `${dh}px`
  paint()
}

function paint(): void {
  const canvas = viewCanvas.value
  const img = sourceImg.value
  if (!canvas || !img || !ready.value) return
  const ctx = canvas.getContext('2d')!
  const dw = canvas.width
  const dh = canvas.height
  ctx.clearRect(0, 0, dw, dh)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(img, 0, 0, dw, dh)

  const mask = layer.value === 'subject' ? subjectMask : propMask
  const w = imgW.value
  const h = imgH.value
  const overlay = ctx.createImageData(w, h)
  // 贴合品牌暖调：主体青绿、道具琥珀，边缘更实
  const color =
    layer.value === 'subject'
      ? { r: 80, g: 170, b: 120 }
      : { r: 220, g: 150, b: 70 }
  const fillA = Math.round(overlayOpacity.value * 150)
  const edgeA = Math.min(255, Math.round(150 + overlayOpacity.value * 90))
  for (let i = 0; i < mask.length; i += 1) {
    const m = mask[i]
    if (m < 12) continue
    const x = i % w
    const y = Math.floor(i / w)
    let isEdge = false
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) isEdge = true
    else {
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1]
      ] as const) {
        if (mask[(y + dy) * w + (x + dx)] < 40) {
          isEdge = true
          break
        }
      }
    }
    const o = i * 4
    overlay.data[o] = color.r
    overlay.data[o + 1] = color.g
    overlay.data[o + 2] = color.b
    overlay.data[o + 3] = isEdge ? Math.round((m / 255) * edgeA) : Math.round((m / 255) * fillA)
  }
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  tmp.getContext('2d')!.putImageData(overlay, 0, 0)
  ctx.drawImage(tmp, 0, 0, dw, dh)
}

function canvasToImage(cx: number, cy: number): { x: number; y: number } | null {
  const canvas = viewCanvas.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const lx = cx - rect.left
  const ly = cy - rect.top
  if (lx < 0 || ly < 0 || lx > rect.width || ly > rect.height) return null
  const x = Math.floor((lx / rect.width) * imgW.value)
  const y = Math.floor((ly / rect.height) * imgH.value)
  return {
    x: Math.max(0, Math.min(imgW.value - 1, x)),
    y: Math.max(0, Math.min(imgH.value - 1, y))
  }
}

function updateCursor(e: PointerEvent): void {
  const stage = stageRef.value
  if (!stage) return
  const rect = stage.getBoundingClientRect()
  cursorX.value = e.clientX - rect.left
  cursorY.value = e.clientY - rect.top
  // 仅在画布区域内显示笔刷环
  const canvas = viewCanvas.value
  if (!canvas) {
    cursorVisible.value = false
    return
  }
  const cr = canvas.getBoundingClientRect()
  cursorVisible.value =
    e.clientX >= cr.left && e.clientX <= cr.right && e.clientY >= cr.top && e.clientY <= cr.bottom
}

function stamp(x: number, y: number): void {
  const mask = layer.value === 'subject' ? subjectMask : propMask
  const w = imgW.value
  const h = imgH.value
  const r = Math.max(2, Math.round(brushSize.value / 2 / Math.max(0.001, scale.value)))
  const add = tool.value === 'paint'
  const r2 = r * r
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > r2) continue
      const px = x + dx
      const py = y + dy
      if (px < 0 || py < 0 || px >= w || py >= h) continue
      const i = py * w + px
      const d = Math.sqrt(dx * dx + dy * dy)
      const edge = d > r * 0.65 ? Math.round(255 * (1 - (d - r * 0.65) / (r * 0.35))) : 255
      if (add) mask[i] = Math.max(mask[i], edge)
      else mask[i] = Math.min(mask[i], 255 - edge)
    }
  }
  if (layer.value === 'subject' && tool.value === 'paint') {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r2) continue
        const px = x + dx
        const py = y + dy
        if (px < 0 || py < 0 || px >= w || py >= h) continue
        const i = py * w + px
        if (subjectMask[i] >= 128) propMask[i] = 0
      }
    }
  }
  if (layer.value === 'prop' && tool.value === 'paint') {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r2) continue
        const px = x + dx
        const py = y + dy
        if (px < 0 || py < 0 || px >= w || py >= h) continue
        const i = py * w + px
        if (propMask[i] >= 128) subjectMask[i] = Math.min(subjectMask[i], 40)
      }
    }
  }
}

function lineStamp(x0: number, y0: number, x1: number, y1: number): void {
  const dist = Math.hypot(x1 - x0, y1 - y0)
  const steps = Math.max(1, Math.ceil(dist / Math.max(2, brushSize.value * 0.25)))
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    stamp(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))
  }
}

function onPointerDown(e: PointerEvent): void {
  if (props.exporting) return
  updateCursor(e)
  const pt = canvasToImage(e.clientX, e.clientY)
  if (!pt) return
  if (!strokeSnapshotTaken) {
    pushUndo()
    strokeSnapshotTaken = true
  }
  painting.value = true
  lastPt.value = pt
  stamp(pt.x, pt.y)
  paint()
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  updateCursor(e)
  if (!painting.value) return
  const pt = canvasToImage(e.clientX, e.clientY)
  if (!pt) return
  if (lastPt.value) lineStamp(lastPt.value.x, lastPt.value.y, pt.x, pt.y)
  else stamp(pt.x, pt.y)
  lastPt.value = pt
  paint()
}

function onPointerUp(): void {
  painting.value = false
  lastPt.value = null
  strokeSnapshotTaken = false
}

function onStageLeave(): void {
  cursorVisible.value = false
  onPointerUp()
}

function maskToDataUrl(mask: Uint8Array, w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let i = 0; i < mask.length; i += 1) {
    const v = mask[i]
    const o = i * 4
    img.data[o] = v
    img.data[o + 1] = v
    img.data[o + 2] = v
    img.data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

function confirmExport(): void {
  emit('export', {
    subjectMaskDataUrl: maskToDataUrl(subjectMask, imgW.value, imgH.value),
    propMaskDataUrl: maskToDataUrl(propMask, imgW.value, imgH.value)
  })
}

async function resetMasks(): Promise<void> {
  pushUndo()
  subjectMask = await maskFromDataUrl(props.draft.subjectMaskDataUrl, imgW.value, imgH.value)
  propMask = await maskFromDataUrl(props.draft.propMaskDataUrl, imgW.value, imgH.value)
  paint()
}

watch(layer, () => paint())
watch(overlayOpacity, () => paint())

let resizeObs: ResizeObserver | null = null

function onKey(e: KeyboardEvent): void {
  const meta = e.metaKey || e.ctrlKey
  if (meta && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    e.preventDefault()
    undo()
    return
  }
  if (e.key === 'b' || e.key === 'B') tool.value = 'paint'
  if (e.key === 'e' || e.key === 'E') tool.value = 'erase'
  if (e.key === '1') layer.value = 'subject'
  if (e.key === '2') layer.value = 'prop'
  if (e.key === '[') brushSize.value = Math.max(4, brushSize.value - 4)
  if (e.key === ']') brushSize.value = Math.min(120, brushSize.value + 4)
}

onMounted(async () => {
  imgW.value = props.draft.width
  imgH.value = props.draft.height
  sourceImg.value = await loadImage(props.draft.sourceDataUrl)
  subjectMask = await maskFromDataUrl(props.draft.subjectMaskDataUrl, imgW.value, imgH.value)
  propMask = await maskFromDataUrl(props.draft.propMaskDataUrl, imgW.value, imgH.value)
  ready.value = true
  await nextTick()
  layout()
  if (stageRef.value) {
    resizeObs = new ResizeObserver(() => layout())
    resizeObs.observe(stageRef.value)
  }
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="psd-mask-editor">
    <header class="psd-mask-bar">
      <div class="psd-mask-title">
        <strong>Refine masks</strong>
        <span>AI draft · paint to refine · ⌘Z undo</span>
      </div>
      <div class="psd-mask-actions">
        <button type="button" class="ghost-btn" :disabled="exporting || !canUndo" title="⌘Z" @click="undo">
          <Undo2 :size="14" /> Undo
        </button>
        <button type="button" class="ghost-btn" :disabled="exporting" @click="emit('cancel')">
          <X :size="14" /> Cancel
        </button>
        <button type="button" class="ghost-btn" :disabled="exporting" @click="resetMasks">
          <RotateCcw :size="14" /> Reset AI
        </button>
        <button type="button" class="primary-btn" :disabled="exporting || !ready" @click="confirmExport">
          <LoaderCircle v-if="exporting" :size="14" class="spin" />
          <Check v-else :size="14" />
          {{ exporting ? 'Exporting…' : 'Export PSD' }}
        </button>
      </div>
    </header>

    <div class="psd-mask-tools">
      <div class="tool-group">
        <span class="tool-label">Layers</span>
        <button type="button" :class="{ active: layer === 'subject' }" @click="layer = 'subject'">1 Subject</button>
        <button type="button" :class="{ active: layer === 'prop' }" @click="layer = 'prop'">2 Prop</button>
      </div>
      <div class="tool-group">
        <span class="tool-label">Tools</span>
        <button type="button" :class="{ active: tool === 'paint' }" @click="tool = 'paint'">
          <Paintbrush :size="14" /> Paint B
        </button>
        <button type="button" :class="{ active: tool === 'erase' }" @click="tool = 'erase'">
          <Eraser :size="14" /> Erase E
        </button>
      </div>
      <label class="tool-slider">
        Brush {{ brushSize }}
        <input v-model.number="brushSize" type="range" min="4" max="120" step="2" />
        <!-- 旁路静态预览环，改滑条时立刻看到大小 -->
        <span
          class="brush-size-chip"
          :class="[tool, layer]"
          :style="{ width: `${Math.max(10, brushSize * 0.55)}px`, height: `${Math.max(10, brushSize * 0.55)}px` }"
          :title="`Brush ${brushSize}px`"
        />
      </label>
      <label class="tool-slider">
        Mask opacity
        <input v-model.number="overlayOpacity" type="range" min="0.12" max="0.65" step="0.02" />
      </label>
    </div>

    <div class="psd-mask-hint">
      <span class="hint-tag" :class="layer">{{ layerLabel }}</span>
      <span class="hint-tag tool">{{ tool === 'paint' ? 'Paint' : 'Erase' }}</span>
      <span class="hint-text">{{ hint }} · The ring on the canvas shows the actual brush size.</span>
    </div>

    <div
      ref="stageRef"
      class="psd-mask-stage"
      @pointermove="updateCursor"
      @pointerleave="onStageLeave"
    >
      <canvas
        ref="viewCanvas"
        class="psd-mask-canvas"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
      <!-- 跟随鼠标的笔刷预览环 -->
      <div
        v-show="cursorVisible && ready && !exporting"
        class="brush-cursor"
        :class="[tool, layer]"
        :style="{
          width: `${brushPreviewPx}px`,
          height: `${brushPreviewPx}px`,
          left: `${cursorX}px`,
          top: `${cursorY}px`
        }"
      />
      <div v-if="!ready" class="psd-mask-loading">Loading masks…</div>
    </div>
  </div>
</template>

<style scoped>
.psd-mask-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--text);
  background: var(--surface);
  border-radius: var(--radius);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.psd-mask-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--line);
}
.psd-mask-title {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.psd-mask-title strong {
  font-size: 16px;
  font-weight: 650;
  color: var(--text);
}
.psd-mask-title span {
  font-size: 12.5px;
  color: var(--text-soft);
  line-height: 1.35;
}
.psd-mask-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.psd-mask-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 12px 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.tool-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tool-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-soft);
  margin-right: 4px;
}
.tool-group button {
  appearance: none;
  border: 1px solid var(--line-strong);
  background: var(--bg-raised);
  color: var(--text);
  border-radius: var(--radius-small);
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 550;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.tool-group button:hover {
  background: var(--surface-hover);
  border-color: var(--accent);
}
.tool-group button.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.tool-slider {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--text-soft);
}
.tool-slider input[type='range'] {
  width: 110px;
  accent-color: var(--accent);
}
.brush-size-chip {
  display: inline-block;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: var(--accent-soft);
  flex-shrink: 0;
  box-sizing: border-box;
}
.brush-size-chip.erase {
  border-style: dashed;
  background: transparent;
}
.psd-mask-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 18px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--line);
}
.hint-tag {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}
.hint-tag.subject {
  background: color-mix(in srgb, #5aaf7a 22%, var(--surface));
  color: #2d6a45;
  border: 1px solid color-mix(in srgb, #5aaf7a 40%, var(--line));
}
.hint-tag.prop {
  background: color-mix(in srgb, #d97757 18%, var(--surface));
  color: #9a4e32;
  border: 1px solid color-mix(in srgb, #d97757 35%, var(--line));
}
.hint-tag.tool {
  background: var(--accent-soft);
  color: var(--accent-hover);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
}
:root[data-theme='dark'] .hint-tag.subject {
  color: #a8e0bc;
}
:root[data-theme='dark'] .hint-tag.prop {
  color: #f0c4b0;
}
.hint-text {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-soft);
  font-weight: 500;
}
.psd-mask-stage {
  position: relative;
  flex: 1;
  min-height: 360px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 棋盘格：浅色/深色主题都能看清白衣与黑衣 */
  background-color: var(--bg-raised);
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--text) 6%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--text) 6%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--text) 6%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--text) 6%, transparent) 75%);
  background-size: 18px 18px;
  background-position: 0 0, 0 9px, 9px -9px, -9px 0;
  overflow: hidden;
  cursor: none;
}
.psd-mask-canvas {
  touch-action: none;
  /* 隐藏系统光标，改用自定义笔刷环 */
  cursor: none;
  border-radius: var(--radius-small);
  box-shadow: var(--shadow-pop);
  outline: 1px solid var(--line-strong);
}
.brush-cursor {
  position: absolute;
  pointer-events: none;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  border: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  z-index: 5;
  mix-blend-mode: normal;
}
.brush-cursor.subject {
  border-color: #4a9d68;
  background: color-mix(in srgb, #4a9d68 20%, transparent);
}
.brush-cursor.prop {
  border-color: #d97757;
  background: color-mix(in srgb, #d97757 18%, transparent);
}
.brush-cursor.erase {
  border-style: dashed;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-color: var(--text-soft);
}
.psd-mask-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.primary-btn {
  appearance: none;
  border: none;
  background: var(--accent);
  color: #fff;
  border-radius: var(--radius-small);
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 650;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.primary-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}
.primary-btn:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.ghost-btn {
  appearance: none;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text);
  border-radius: var(--radius-small);
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 550;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.ghost-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--accent);
  color: var(--accent);
}
.ghost-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
