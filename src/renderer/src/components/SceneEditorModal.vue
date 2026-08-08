<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, Crop, Eraser, LoaderCircle, Paintbrush, Trash2, X } from 'lucide-vue-next'
import {
  AUTO_CROP_DELAY_MS,
  CROP_MIN_SIZE,
  type CropBox,
  type MaskPath,
  clamp,
  clampCropBox,
  cloneMaskPaths,
  createCenteredCropBox,
  drawMaskPathsToCanvas,
  getAutoCropBox
} from './localCropShared'

type EditorTool = 'brush' | 'eraser' | 'crop'
type HandleId = 'nw' | 'ne' | 'sw' | 'se' | 'move'

const props = defineProps<{
  imageId: string
  initialPaths?: MaskPath[]
  initialCropBox?: CropBox | null
  initialOpacity?: number
}>()

const emit = defineEmits<{
  close: []
  confirm: [payload: { paths: MaskPath[]; cropBox: CropBox; maskOpacity: number; previewDataUrl: string }]
}>()

const tool = ref<EditorTool>('brush')
const brushSize = ref(25)
const eraserSize = ref(40)
const cropSizeSlider = ref(256)
const maskOpacity = ref(props.initialOpacity ?? 50)
const zoom = ref(100)
const paths = ref<MaskPath[]>(cloneMaskPaths(props.initialPaths || []))
const redoStack = ref<MaskPath[][]>([])
const cropBox = ref<CropBox | null>(props.initialCropBox ? { ...props.initialCropBox } : null)
const imageSize = ref({ width: 0, height: 0 })
const stageSize = ref({ width: 800, height: 560 })
const status = ref<'loading' | 'ready' | 'error'>('loading')
const statusText = ref('Loading scene image…')
const displaySrc = ref('')
const drawing = ref(false)
const currentPath = ref<MaskPath | null>(null)
const draggingHandle = ref<HandleId | null>(null)
const dragOrigin = ref({ x: 0, y: 0, box: null as CropBox | null })

const stageRef = ref<HTMLElement | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)
const maskCanvasRef = ref<HTMLCanvasElement | null>(null)
const autoCropTimer = ref<number | null>(null)
let objectUrl = ''
let resizeObserver: ResizeObserver | null = null

const ZOOM_MIN = 20
const ZOOM_MAX = 400

/* 笔刷光标：跟随指针的圆环，直径等于笔刷落到屏幕上的真实大小 */
const cursorPos = ref({ x: 0, y: 0 })
const cursorInside = ref(false)
let paintSizeInitialized = false

const activeSize = computed({
  get() {
    if (tool.value === 'brush') return brushSize.value
    if (tool.value === 'eraser') return eraserSize.value
    return cropSizeSlider.value
  },
  set(value: number) {
    if (tool.value === 'brush') brushSize.value = value
    else if (tool.value === 'eraser') eraserSize.value = value
    else cropSizeSlider.value = value
  }
})

const isPaintTool = computed(() => tool.value === 'brush' || tool.value === 'eraser')

/*
 * 笔刷大小存的是「图像像素」（落笔时 lineWidth = brushSize * displayScale）。
 * 4000×6000 这种大图缩放到画布上只有 0.1 左右，固定 200 上限换算到屏幕不足 20px，
 * 根本没法用。上限改成跟着图像尺寸走，小图仍保持原来的 200。
 */
const paintSizeMax = computed(() => {
  const minDim = Math.min(imageSize.value.width || 512, imageSize.value.height || 512)
  return Math.max(200, Math.round(minDim / 3))
})

/* PS 的笔刷档位序列，[ / ] 沿着它跳，和 Photoshop 的手感一致 */
const PS_BRUSH_STEPS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20,
  25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100,
  125, 150, 175, 200, 250, 300, 350, 400, 450, 500,
  600, 700, 800, 900, 1000, 1200, 1400, 1600, 1800, 2000, 2500, 3000
]

const sizeSliderMin = computed(() => (tool.value === 'crop' ? CROP_MIN_SIZE : tool.value === 'brush' ? 10 : 20))
const sizeSliderMax = computed(() =>
  tool.value === 'crop'
    ? Math.max(CROP_MIN_SIZE, Math.min(imageSize.value.width || 512, imageSize.value.height || 512))
    : paintSizeMax.value
)
const sizeSliderStep = computed(() => (tool.value === 'crop' ? 16 : 1))

/*
 * 滑块可以停在任意整数，所以不能按索引找档位：
 * 向上取「严格大于当前值」的第一档，向下取「严格小于当前值」的最后一档。
 * 上限随图像尺寸浮动，档位被 clamp 掉时直接落到边界。
 */
function stepPaintSize(delta: 1 | -1): void {
  const min = sizeSliderMin.value
  const max = sizeSliderMax.value
  const current = activeSize.value
  const next =
    delta > 0
      ? PS_BRUSH_STEPS.find((size) => size > current && size <= max)
      : [...PS_BRUSH_STEPS].reverse().find((size) => size < current && size >= min)
  activeSize.value = next ?? (delta > 0 ? max : min)
}

const displayScale = computed(() => {
  if (!imageSize.value.width) return 1
  const pad = 40
  const availW = Math.max(200, stageSize.value.width - pad)
  const availH = Math.max(200, stageSize.value.height - pad)
  const fit = Math.min(availW / imageSize.value.width, availH / imageSize.value.height, 1)
  return Math.max(0.08, fit * (zoom.value / 100))
})

const frameStyle = computed(() => {
  if (!imageSize.value.width) return { width: '320px', height: '240px' }
  return {
    width: `${Math.round(imageSize.value.width * displayScale.value)}px`,
    height: `${Math.round(imageSize.value.height * displayScale.value)}px`
  }
})

/* 圆环直径 = 笔刷在屏幕上的真实落笔宽度，和 drawMaskPathsToCanvas 的 lineWidth 口径一致 */
const brushCursorSize = computed(() => Math.max(4, activeSize.value * displayScale.value))

const brushCursorStyle = computed(() => ({
  width: `${brushCursorSize.value}px`,
  height: `${brushCursorSize.value}px`,
  transform: `translate(${cursorPos.value.x}px, ${cursorPos.value.y}px) translate(-50%, -50%)`
}))

const showBrushCursor = computed(
  () => isPaintTool.value && cursorInside.value && status.value === 'ready' && Boolean(displaySrc.value)
)

function selectCropTool(): void {
  tool.value = 'crop'
  if (!cropBox.value) placeCenteredCrop()
}

function revokeObjectUrl(): void {
  if (!objectUrl) return
  URL.revokeObjectURL(objectUrl)
  objectUrl = ''
}

function coerceBytes(bytes: ArrayBuffer | Uint8Array | { type?: string; data?: number[] }): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  if (bytes && typeof bytes === 'object' && Array.isArray((bytes as { data?: number[] }).data)) {
    return Uint8Array.from((bytes as { data: number[] }).data)
  }
  throw new Error('Invalid scene image data')
}

function toBlobPart(bytes: ArrayBuffer | Uint8Array | { type?: string; data?: number[] }): ArrayBuffer {
  const view = coerceBytes(bytes)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

async function loadSceneFromId(): Promise<void> {
  status.value = 'loading'
  statusText.value = 'Loading scene image…'
  displaySrc.value = ''
  revokeObjectUrl()
  try {
    if (!props.imageId) throw new Error('No scene image was selected')
    if (!window.desktop?.readSelectedImage) throw new Error('Desktop image access is unavailable')
    const selected = await window.desktop.readSelectedImage(props.imageId)
    const buffer = toBlobPart(selected.bytes)
    if (!buffer.byteLength) throw new Error('The scene image is empty')
    objectUrl = URL.createObjectURL(new Blob([buffer], { type: selected.type || 'image/jpeg' }))
    displaySrc.value = objectUrl
  } catch (error) {
    status.value = 'error'
    statusText.value = error instanceof Error ? error.message : 'Failed to load the scene image'
  }
}

function measureStage(): void {
  const stage = stageRef.value
  if (!stage) return
  const rect = stage.getBoundingClientRect()
  stageSize.value = {
    width: Math.max(200, Math.floor(rect.width)),
    height: Math.max(200, Math.floor(rect.height))
  }
}

function paintMask(): void {
  const canvas = maskCanvasRef.value
  if (!canvas || !imageSize.value.width) return
  const cssW = Math.max(1, Math.round(imageSize.value.width * displayScale.value))
  const cssH = Math.max(1, Math.round(imageSize.value.height * displayScale.value))
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const pixelW = Math.max(1, Math.round(cssW * dpr))
  const pixelH = Math.max(1, Math.round(cssH * dpr))
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  drawMaskPathsToCanvas(ctx, paths.value, {
    scale: displayScale.value,
    alpha: clamp(maskOpacity.value / 100, 0.05, 1)
  })
  if (!cropBox.value) return
  const box = cropBox.value
  const x = box.x * displayScale.value
  const y = box.y * displayScale.value
  const size = box.size * displayScale.value
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  ctx.beginPath()
  ctx.rect(0, 0, cssW, cssH)
  ctx.rect(x, y, size, size)
  ctx.fill('evenodd')
  ctx.strokeStyle = '#ef4444'
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, size, size)
  const hs = 10
  ctx.fillStyle = '#fff'
  for (const [hx, hy] of [[x, y], [x + size, y], [x, y + size], [x + size, y + size]]) {
    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs)
    ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs)
  }
  ctx.restore()
}

function onImageLoad(): void {
  const image = imageRef.value
  if (!image?.naturalWidth) {
    status.value = 'error'
    statusText.value = 'The scene image dimensions are invalid'
    return
  }
  imageSize.value = { width: image.naturalWidth, height: image.naturalHeight }
  /*
   * 默认 25/40 是按小图定的，放到 4000×6000 上落到屏幕不足 4px，看不见也没法用。
   * 首次拿到真实尺寸时按图像短边给一个可用的初始值（只做一次，不覆盖用户的调整）。
   */
  if (!paintSizeInitialized) {
    paintSizeInitialized = true
    const minDim = Math.min(image.naturalWidth, image.naturalHeight)
    brushSize.value = clamp(Math.round(minDim * 0.035), 10, paintSizeMax.value)
    eraserSize.value = clamp(Math.round(minDim * 0.05), 20, paintSizeMax.value)
  }
  if (props.initialCropBox) {
    cropBox.value = clampCropBox(props.initialCropBox, image.naturalWidth, image.naturalHeight)
    cropSizeSlider.value = cropBox.value.size
  }
  status.value = 'ready'
  statusText.value = ''
  void nextTick(() => {
    measureStage()
    paintMask()
  })
}

function onImageError(): void {
  status.value = 'error'
  statusText.value = 'Failed to display the scene image. Please choose it again.'
}

function syncImageIfAlreadyLoaded(): void {
  const image = imageRef.value
  if (image?.complete && image.naturalWidth > 0) onImageLoad()
}

function pushHistory(): void {
  redoStack.value = []
}

function undo(): void {
  if (!paths.value.length) return
  redoStack.value.push(cloneMaskPaths(paths.value))
  paths.value = paths.value.slice(0, -1)
  paintMask()
}

function redo(): void {
  const previous = redoStack.value.pop()
  if (!previous) return
  paths.value = previous
  paintMask()
}

function clearEdit(): void {
  paths.value = []
  redoStack.value = []
  cropBox.value = null
  paintMask()
}

function scheduleAutoCrop(): void {
  if (cropBox.value) return
  if (autoCropTimer.value !== null) window.clearTimeout(autoCropTimer.value)
  autoCropTimer.value = window.setTimeout(() => {
    autoCropTimer.value = null
    if (cropBox.value) return
    const box = getAutoCropBox(paths.value, imageSize.value.width, imageSize.value.height)
    if (box) {
      cropBox.value = box
      cropSizeSlider.value = box.size
      paintMask()
    }
  }, AUTO_CROP_DELAY_MS)
}

function clientToImage(event: PointerEvent): { x: number; y: number } {
  const frame = event.currentTarget as HTMLElement | null
  if (!frame || !imageSize.value.width) return { x: 0, y: 0 }
  const rect = frame.getBoundingClientRect()
  return {
    x: clamp(((event.clientX - rect.left) / Math.max(1, rect.width)) * imageSize.value.width, 0, imageSize.value.width),
    y: clamp(((event.clientY - rect.top) / Math.max(1, rect.height)) * imageSize.value.height, 0, imageSize.value.height)
  }
}

function hitHandle(point: { x: number; y: number }): HandleId | null {
  if (!cropBox.value) return null
  const box = cropBox.value
  const handles: Array<[HandleId, number, number]> = [
    ['nw', box.x, box.y],
    ['ne', box.x + box.size, box.y],
    ['sw', box.x, box.y + box.size],
    ['se', box.x + box.size, box.y + box.size]
  ]
  const threshold = Math.max(12, 14 / displayScale.value)
  for (const [id, hx, hy] of handles) {
    if (Math.hypot(point.x - hx, point.y - hy) <= threshold) return id
  }
  if (point.x >= box.x && point.y >= box.y && point.x <= box.x + box.size && point.y <= box.y + box.size) return 'move'
  return null
}

function onPointerDown(event: PointerEvent): void {
  if (status.value !== 'ready' || !imageSize.value.width) return
  const point = clientToImage(event)
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)

  if (tool.value === 'crop') {
    const handle = hitHandle(point)
    if (handle && cropBox.value) {
      draggingHandle.value = handle
      dragOrigin.value = { x: point.x, y: point.y, box: { ...cropBox.value } }
      return
    }
    const size = clamp(cropSizeSlider.value, CROP_MIN_SIZE, Math.min(imageSize.value.width, imageSize.value.height))
    cropBox.value = clampCropBox(
      { x: Math.round(point.x - size / 2), y: Math.round(point.y - size / 2), size },
      imageSize.value.width,
      imageSize.value.height
    )
    draggingHandle.value = 'move'
    dragOrigin.value = { x: point.x, y: point.y, box: { ...cropBox.value } }
    paintMask()
    return
  }

  pushHistory()
  drawing.value = true
  currentPath.value = {
    points: [point],
    brushSize: tool.value === 'brush' ? brushSize.value : eraserSize.value,
    isEraser: tool.value === 'eraser'
  }
  paths.value = [...paths.value, currentPath.value]
  paintMask()
}

function trackCursor(event: PointerEvent): void {
  const frame = event.currentTarget as HTMLElement | null
  if (!frame) return
  const rect = frame.getBoundingClientRect()
  cursorPos.value = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  cursorInside.value = true
}

function onPointerLeave(): void {
  cursorInside.value = false
}

function onPointerMove(event: PointerEvent): void {
  trackCursor(event)
  const point = clientToImage(event)
  if (draggingHandle.value && dragOrigin.value.box) {
    const origin = dragOrigin.value.box
    const dx = point.x - dragOrigin.value.x
    const dy = point.y - dragOrigin.value.y
    if (draggingHandle.value === 'move') {
      cropBox.value = clampCropBox(
        { x: origin.x + dx, y: origin.y + dy, size: origin.size },
        imageSize.value.width,
        imageSize.value.height
      )
    } else {
      let x = origin.x
      let y = origin.y
      let size = origin.size
      if (draggingHandle.value === 'se') size = Math.max(CROP_MIN_SIZE, origin.size + Math.max(dx, dy))
      else if (draggingHandle.value === 'nw') {
        size = Math.max(CROP_MIN_SIZE, origin.size - Math.min(dx, dy))
        x = origin.x + origin.size - size
        y = origin.y + origin.size - size
      } else if (draggingHandle.value === 'ne') {
        size = Math.max(CROP_MIN_SIZE, origin.size + Math.max(dx, -dy))
        y = origin.y + origin.size - size
      } else if (draggingHandle.value === 'sw') {
        size = Math.max(CROP_MIN_SIZE, origin.size + Math.max(-dx, dy))
        x = origin.x + origin.size - size
      }
      cropBox.value = clampCropBox({ x, y, size }, imageSize.value.width, imageSize.value.height)
      cropSizeSlider.value = cropBox.value.size
    }
    paintMask()
    return
  }

  if (!drawing.value || !currentPath.value) return
  const last = currentPath.value.points[currentPath.value.points.length - 1]
  if (Math.hypot(point.x - last.x, point.y - last.y) < 1.2) return
  currentPath.value.points.push(point)
  paintMask()
}

function onPointerUp(): void {
  if (drawing.value && currentPath.value && !currentPath.value.isEraser) scheduleAutoCrop()
  drawing.value = false
  currentPath.value = null
  draggingHandle.value = null
}

/*
 * 触控板双指捏合：Chromium 会把捏合手势映射成 ctrlKey=true 的 wheel 事件。
 * 不带 ctrl 的双指滚动保持浏览器默认行为，正好用来平移（stage 是 overflow:auto）。
 */
function onStageWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  if (status.value !== 'ready') return
  const next = clamp(zoom.value * Math.exp(-event.deltaY * 0.01), ZOOM_MIN, ZOOM_MAX)
  zoom.value = Math.round(next)
}

function placeCenteredCrop(): void {
  if (!imageSize.value.width) return
  cropBox.value = createCenteredCropBox(imageSize.value.width, imageSize.value.height, cropSizeSlider.value)
  cropSizeSlider.value = cropBox.value.size
  tool.value = 'crop'
  paintMask()
}

function confirm(): void {
  if (!cropBox.value) {
    statusText.value = 'Set a crop box first'
    tool.value = 'crop'
    return
  }
  const image = imageRef.value
  if (!image || status.value !== 'ready') {
    statusText.value = 'The scene image has not finished loading'
    return
  }
  const maxEdge = 1600
  const scale = Math.min(1, maxEdge / Math.max(imageSize.value.width, imageSize.value.height))
  const preview = document.createElement('canvas')
  preview.width = Math.max(1, Math.round(imageSize.value.width * scale))
  preview.height = Math.max(1, Math.round(imageSize.value.height * scale))
  const ctx = preview.getContext('2d')
  if (!ctx) return
  ctx.drawImage(image, 0, 0, preview.width, preview.height)
  drawMaskPathsToCanvas(ctx, paths.value, { scale, alpha: clamp(maskOpacity.value / 100, 0.05, 1) })
  emit('confirm', {
    paths: cloneMaskPaths(paths.value),
    cropBox: clampCropBox(cropBox.value, imageSize.value.width, imageSize.value.height),
    maskOpacity: maskOpacity.value,
    previewDataUrl: preview.toDataURL('image/jpeg', 0.85)
  })
}

function onKeydown(event: KeyboardEvent): void {
  // 输入框优先：⌘Z 也要留给原生文本撤销，否则在提示词里撤销会跳去撤销蒙版
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    (event.target instanceof HTMLElement && event.target.isContentEditable)
  if (typing) return

  const meta = event.metaKey || event.ctrlKey
  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  // 带修饰键的组合留给系统/应用快捷键，别被工具切换抢走
  if (meta || event.altKey) return

  if (isPaintTool.value && (event.key === '[' || event.key === ']')) {
    event.preventDefault()
    stepPaintSize(event.key === ']' ? 1 : -1)
    return
  }
  if (event.key.toLowerCase() === 'b') tool.value = 'brush'
  if (event.key.toLowerCase() === 'e') tool.value = 'eraser'
  if (event.key.toLowerCase() === 'c') {
    tool.value = 'crop'
    if (!cropBox.value) placeCenteredCrop()
  }
}

watch([paths, maskOpacity, cropBox, zoom, displayScale], () => {
  if (status.value === 'ready') paintMask()
}, { deep: true })

watch(cropSizeSlider, (size) => {
  if (tool.value !== 'crop' || !cropBox.value || !imageSize.value.width) return
  const cx = cropBox.value.x + cropBox.value.size / 2
  const cy = cropBox.value.y + cropBox.value.size / 2
  cropBox.value = clampCropBox(
    { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), size },
    imageSize.value.width,
    imageSize.value.height
  )
})

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  resizeObserver = new ResizeObserver(() => {
    measureStage()
    if (status.value === 'ready') paintMask()
  })
  if (stageRef.value) resizeObserver.observe(stageRef.value)
  // 必须 passive:false，否则 preventDefault 无效、捏合会被浏览器当成页面缩放
  stageRef.value?.addEventListener('wheel', onStageWheel, { passive: false })
  measureStage()
  void loadSceneFromId().then(() => nextTick(() => {
    syncImageIfAlreadyLoaded()
    requestAnimationFrame(() => syncImageIfAlreadyLoaded())
  }))
})

watch(stageRef, (el, prev) => {
  if (prev) {
    resizeObserver?.unobserve(prev)
    prev.removeEventListener('wheel', onStageWheel)
  }
  if (el) {
    resizeObserver?.observe(el)
    el.addEventListener('wheel', onStageWheel, { passive: false })
    measureStage()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (autoCropTimer.value !== null) window.clearTimeout(autoCropTimer.value)
  stageRef.value?.removeEventListener('wheel', onStageWheel)
  resizeObserver?.disconnect()
  revokeObjectUrl()
})
</script>

<template>
  <Teleport to="body">
    <div class="scene-editor-overlay" @mousedown.self="emit('close')">
      <div class="scene-editor-dialog" role="dialog" aria-label="Edit scene image" @mousedown.stop>
        <header class="scene-editor-toolbar">
          <div class="tool-group">
            <button :class="{ active: tool === 'brush' }" type="button" @click="tool = 'brush'"><Paintbrush :size="15" />Brush</button>
            <button :class="{ active: tool === 'eraser' }" type="button" @click="tool = 'eraser'"><Eraser :size="15" />Eraser</button>
            <button :class="{ active: tool === 'crop' }" type="button" @click="selectCropTool"><Crop :size="15" />Crop box</button>
          </div>
          <label class="slider-field">
            <span>Size</span>
            <input v-model.number="activeSize" type="range" :min="sizeSliderMin" :max="sizeSliderMax" :step="sizeSliderStep" />
            <em>{{ Math.round(activeSize) }}px</em>
          </label>
          <label class="slider-field">
            <span>Opacity</span>
            <input v-model.number="maskOpacity" type="range" min="10" max="100" step="1" />
            <em>{{ maskOpacity }}%</em>
          </label>
          <label class="slider-field">
            <span>Zoom</span>
            <input v-model.number="zoom" type="range" :min="ZOOM_MIN" :max="ZOOM_MAX" step="5" />
            <em>{{ zoom }}%</em>
          </label>
          <div class="toolbar-actions">
            <button type="button" class="ghost" @click="clearEdit"><Trash2 :size="14" />Clear edits</button>
            <button type="button" class="primary" :disabled="status !== 'ready'" @click="confirm"><Check :size="14" />Confirm</button>
            <button type="button" class="icon-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
          </div>
        </header>

        <div ref="stageRef" class="scene-editor-stage">
          <div v-if="status === 'loading'" class="stage-status">
            <LoaderCircle :size="22" class="spin" />{{ statusText }}
          </div>
          <div v-else-if="status === 'error'" class="stage-status error">{{ statusText }}</div>
          <div
            v-show="displaySrc"
            class="scene-frame"
            :class="{ blocked: status !== 'ready', painting: showBrushCursor }"
            :style="frameStyle"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @pointerenter="trackCursor"
            @pointerleave="onPointerLeave"
          >
            <img
              v-if="displaySrc"
              ref="imageRef"
              class="scene-image"
              :src="displaySrc"
              alt="Scene image"
              draggable="false"
              @load="onImageLoad"
              @error="onImageError"
            />
            <canvas ref="maskCanvasRef" class="mask-canvas" />
            <div
              v-show="showBrushCursor"
              class="brush-cursor"
              :class="{ eraser: tool === 'eraser' }"
              :style="brushCursorStyle"
            />
          </div>
        </div>

        <p class="scene-editor-hint">
          LUK Image Workspace · Scene editor
          <template v-if="status === 'ready'"> · {{ imageSize.width }}×{{ imageSize.height }}</template>
          · B brush · E eraser · C crop box · [ ] brush size · ⌘Z undo · pinch to zoom
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scene-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(20, 19, 17, 0.55);
}
.scene-editor-dialog {
  width: min(1120px, 100%);
  height: min(780px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  background: var(--surface, #30302e);
  border: 1px solid var(--line, #3e3d3a);
  border-radius: 16px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  color: var(--text, #f5f4ee);
}
.scene-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line, #3e3d3a);
  background: color-mix(in srgb, var(--surface, #30302e) 92%, var(--bg, #262624));
}
.tool-group {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--bg-raised, #3a3a37);
}
.tool-group button {
  height: 32px;
  padding: 0 11px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-soft, #c9c7bf);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.tool-group button.active {
  background: var(--accent, #d97757);
  color: #fff;
}
.slider-field {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-muted, #9b9a93);
  font-size: 12px;
}
.slider-field input[type='range'] {
  width: 88px;
  accent-color: var(--accent, #d97757);
}
.slider-field em {
  min-width: 42px;
  font-style: normal;
  color: var(--text-soft, #c9c7bf);
  font-variant-numeric: tabular-nums;
}
.toolbar-actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.toolbar-actions .ghost,
.toolbar-actions .primary,
.icon-close {
  border: 0;
  cursor: pointer;
}
.toolbar-actions .ghost,
.toolbar-actions .primary {
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.toolbar-actions .ghost {
  border: 1px solid var(--line-strong, #4b4a46);
  color: var(--text-soft, #c9c7bf);
  background: transparent;
}
.toolbar-actions .primary {
  background: var(--accent, #d97757);
  color: #fff;
}
.toolbar-actions .primary:disabled {
  opacity: 0.45;
}
.icon-close {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-muted, #9b9a93);
  background: transparent;
}
.scene-editor-stage {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: auto;
  background: #1a1917;
  padding: 20px;
  position: relative;
}
.stage-status {
  position: absolute;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #9b9a93;
  font-size: 13px;
  pointer-events: none;
}
.stage-status.error {
  color: #d98a76;
  max-width: 80%;
  text-align: center;
  pointer-events: auto;
}
.scene-frame {
  position: relative;
  touch-action: none;
  user-select: none;
  cursor: crosshair;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  border-radius: 4px;
  overflow: hidden;
  background: #111;
}
.scene-frame.blocked {
  cursor: wait;
}
.scene-image,
.mask-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.scene-image {
  object-fit: fill;
  pointer-events: none;
}
.mask-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
/* 圆环用双色描边，深色/浅色画面上都看得清；中心点用来对准落笔位置 */
.brush-cursor {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 3;
  border-radius: 50%;
  pointer-events: none;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.95);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.55),
    inset 0 0 0 1px rgba(0, 0, 0, 0.35);
}
.brush-cursor.eraser {
  border-style: dashed;
}
.brush-cursor::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 2px;
  margin: -1px 0 0 -1px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
}
/* 圆环本身就是光标，隐藏系统准星避免两个指示重叠 */
.scene-frame.painting {
  cursor: none;
}
.scene-editor-hint {
  padding: 10px 16px 12px;
  color: var(--text-muted, #9b9a93);
  font-size: 11.5px;
  border-top: 1px solid var(--line, #3e3d3a);
}
</style>
