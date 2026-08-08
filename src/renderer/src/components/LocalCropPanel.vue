<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardPaste,
  HelpCircle,
  LoaderCircle,
  Mic,
  Pencil,
  Plus,
  Square,
  UploadCloud,
  X
} from 'lucide-vue-next'
import ResolutionEnergyCanvas from './ResolutionEnergyCanvas.vue'
import SceneEditorModal from './SceneEditorModal.vue'
import {
  DEFAULT_LOCAL_CROP_PROMPT,
  bakeLocalCropImage,
  blobToArrayBuffer,
  clamp,
  cloneMaskPaths,
  drawMaskPathsToCanvas,
  stripLocalCropGuard,
  withLocalCropGuard,
  type CropBox,
  type MaskPath
} from './localCropShared'

type Option = { label: string; value: string }
type Provider = {
  id: number
  label: string
  model: string
  sizeOptions: Option[]
  qualityOptions: Option[]
  resolutionOptions: Option[]
}

export type LocalCropSubmission = {
  kind: 'crop'
  items: Array<{ prompt: string; sources: DesktopSelectedImage[] }>
  providerId: number
  model: string
  size: string
  quality: string
  resolution: string
  localCrop: {
    sceneImageId: string
    cropBox: CropBox
    hasMask: boolean
    /** 场景图坐标系笔刷路径，回贴时按选区 alpha 合成 */
    maskPaths: MaskPath[]
    productSources?: string[]
  }
}

export type LocalCropDraft = {
  token: number
  prompt?: string
  providerId?: number
  quality?: string
  resolution?: string
  scene?: DesktopSelectedImage | null
  products?: DesktopSelectedImage[]
  cropBox?: CropBox | null
  maskPaths?: MaskPath[]
  maskOpacity?: number
  openEditor?: boolean
}

const props = defineProps<{
  active?: boolean
  providers: Provider[]
  defaultProviderId: number
  defaultSize: string
  defaultQuality: string
  defaultResolution: string
  submitting: boolean
  draft?: LocalCropDraft | null
}>()

const emit = defineEmits<{
  submit: [payload: LocalCropSubmission]
  begin: [payload: { prompt: string }]
  'begin-failed': [message: string]
}>()

const providerId = ref(props.defaultProviderId)
// 局部重绘裁切框固定正方形，出图比例必须锁 1:1，避免竖图 cover 回贴错位
const size = ref('1:1')
const quality = ref(props.defaultQuality)
const resolution = ref(props.defaultResolution)
const cropPrompt = ref(DEFAULT_LOCAL_CROP_PROMPT)
const cropScene = ref<DesktopSelectedImage | null>(null)
const scenePreview = ref('')
const cropProducts = ref<DesktopSelectedImage[]>([])
const maskPaths = ref<MaskPath[]>([])
const cropBox = ref<CropBox | null>(null)
const maskOpacity = ref(50)
const editorOpen = ref(false)
const editorSession = ref(0)
const pickerError = ref('')
const baking = ref(false)
const openPopover = ref('')
const resolutionSlide = ref(0)
const resolutionDragging = ref(false)
const promptRef = ref<HTMLTextAreaElement | null>(null)
const isPromptTyping = ref(false)
const promptTouched = ref(false)
let resolutionSnapRaf = 0
let resolutionCommitting = false
let promptTypeTimer: number | null = null
let promptTypeRun = 0

function autoGrowPrompt(): void {
  const el = promptRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`
}

function stopPromptTypewriter(restore = false): void {
  promptTypeRun += 1
  if (promptTypeTimer) window.clearTimeout(promptTypeTimer)
  promptTypeTimer = null
  isPromptTyping.value = false
  if (restore && !promptTouched.value) cropPrompt.value = DEFAULT_LOCAL_CROP_PROMPT
}

function startPromptTypewriter(): void {
  if (promptTouched.value) return
  stopPromptTypewriter()
  const run = promptTypeRun
  const characters = Array.from(DEFAULT_LOCAL_CROP_PROMPT)
  cropPrompt.value = ''
  isPromptTyping.value = true
  let index = 0

  const typeNext = (): void => {
    if (run !== promptTypeRun || !props.active || promptTouched.value) return
    const character = characters[index]
    if (!character) {
      promptTypeTimer = null
      isPromptTyping.value = false
      cropPrompt.value = DEFAULT_LOCAL_CROP_PROMPT
      return
    }
    cropPrompt.value += character
    index += 1
    const pause = /[，。；：！？,.!?]/.test(character) ? 82 : 18 + ((index * 7) % 11)
    promptTypeTimer = window.setTimeout(typeNext, pause)
  }

  // 等文本框和参数轨道完全落稳后再开始输入，避免两种动效争抢注意力。
  promptTypeTimer = window.setTimeout(typeNext, 620)
}

function onPromptInput(): void {
  promptTouched.value = true
  stopPromptTypewriter()
  autoGrowPrompt()
}

watch(cropPrompt, () => nextTick(autoGrowPrompt))
watch(
  () => props.active,
  (active) => {
    if (active) startPromptTypewriter()
    else stopPromptTypewriter(true)
  },
  { immediate: true }
)

const isVoiceListening = ref(false)
const isVoiceRecognizing = ref(false)
const voiceStatus = ref('')
let voiceStatusTimer: number | null = null
let voiceFinalText = ''
let voiceInterimText = ''
let voiceFailed = false
let nativeVoiceActive = false
let nativeVoiceOff: (() => void) | null = null

const productSlots = computed(() => [0, 1, 2].map((index) => cropProducts.value[index] || null))
const activeProvider = computed(() => props.providers.find((item) => item.id === providerId.value) || props.providers[0])
const canSubmit = computed(() => Boolean(cropScene.value) && !props.submitting && !baking.value)
const selectedProviderLabel = computed(() => activeProvider.value?.label || '线路')
const selectedSizeLabel = computed(() => activeProvider.value?.sizeOptions.find((item) => item.value === size.value)?.label || size.value)
const selectedQualityLabel = computed(() => activeProvider.value?.qualityOptions.find((item) => item.value === quality.value)?.label || quality.value)
const currentResolutionOptions = computed(() => activeProvider.value?.resolutionOptions || [])
const currentQualityOptions = computed(() => activeProvider.value?.qualityOptions || [])

function resolutionMaxIndex(): number {
  return Math.max(0, currentResolutionOptions.value.length - 1)
}

function syncResolutionSlideFromValue(): void {
  if (resolutionDragging.value || resolutionCommitting) return
  const idx = currentResolutionOptions.value.findIndex((item) => item.value === resolution.value)
  resolutionSlide.value = Math.max(0, idx)
}

watch([resolution, currentResolutionOptions], syncResolutionSlideFromValue, { immediate: true, deep: true })

function magnetizeResolution(raw: number): number {
  const max = resolutionMaxIndex()
  const clamped = Math.max(0, Math.min(max, raw))
  let nearest = 0
  let nearestDist = Infinity
  for (let i = 0; i <= max; i += 1) {
    const dist = Math.abs(clamped - i)
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = i
    }
  }
  const radius = 0.16
  if (nearestDist >= radius) return clamped
  const t = 1 - nearestDist / radius
  return clamped + (nearest - clamped) * (t * t * 0.62)
}

function onResolutionSlideInput(event: Event): void {
  resolutionDragging.value = true
  resolutionCommitting = false
  if (resolutionSnapRaf) {
    cancelAnimationFrame(resolutionSnapRaf)
    resolutionSnapRaf = 0
  }
  const raw = Number((event.target as HTMLInputElement).value)
  resolutionSlide.value = magnetizeResolution(Number.isFinite(raw) ? raw : 0)
}

function onResolutionSlideCommit(): void {
  if (resolutionCommitting) return
  const max = resolutionMaxIndex()
  const start = resolutionSlide.value
  const target = Math.round(Math.max(0, Math.min(max, start)))
  const option = currentResolutionOptions.value[target]
  if (!option) {
    resolutionDragging.value = false
    return
  }
  resolutionCommitting = true
  resolutionDragging.value = true
  if (Math.abs(start - target) < 0.002) {
    resolutionSlide.value = target
    resolution.value = option.value
    resolutionDragging.value = false
    resolutionCommitting = false
    return
  }
  const t0 = performance.now()
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / 170)
    const eased = 1 - (1 - p) ** 3
    resolutionSlide.value = start + (target - start) * eased
    if (p < 1) {
      resolutionSnapRaf = requestAnimationFrame(tick)
      return
    }
    resolutionSnapRaf = 0
    resolutionSlide.value = target
    resolution.value = option.value
    resolutionDragging.value = false
    resolutionCommitting = false
  }
  resolutionSnapRaf = requestAnimationFrame(tick)
}

const resolutionLabel = computed(() => {
  const max = resolutionMaxIndex()
  const nearest = Math.round(Math.max(0, Math.min(max, resolutionSlide.value)))
  return currentResolutionOptions.value[nearest]?.label || resolution.value
})
const resolutionProgress = computed(() => {
  const max = resolutionMaxIndex()
  return max > 0 ? (resolutionSlide.value / max) * 100 : 0
})
const resolutionTrackStyle = computed(() => ({ '--resolution-progress': `${resolutionProgress.value}%` }))
const isMaxResolution = computed(() => {
  const max = resolutionMaxIndex()
  return max > 0 && resolutionSlide.value >= max - 0.12
})

watch(() => props.defaultProviderId, (value) => {
  if (!providerId.value) providerId.value = value
})

watch(activeProvider, (provider) => {
  if (!provider) return
  forceSquareSize(provider.sizeOptions)
  preferOption(provider.qualityOptions, quality, [props.defaultQuality, 'high', 'low'])
  preferOption(provider.resolutionOptions, resolution, ['2K', props.defaultResolution, '1K'])
}, { immediate: true })

function preferOption(options: Option[], target: { value: string }, preferred: string[]): void {
  const values = options.map((item) => item.value)
  if (values.includes(target.value)) return
  target.value = preferred.find((item) => values.includes(item)) || options[0]?.value || target.value
}

function isSquareSizeValue(value: string): boolean {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return false
  if (raw === '1:1' || raw === '1x1' || raw === 'square') return true
  const match = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(raw)
  if (!match) return false
  const w = Number(match[1])
  const h = Number(match[2])
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && Math.abs(w - h) < 0.001
}

function forceSquareSize(options: Option[]): void {
  const square = options.find((item) => isSquareSizeValue(item.value))
  if (square) {
    size.value = square.value
    return
  }
  // 线路没有 1:1 时仍提交 1:1，让后端/供应商侧尽量落到方图；UI 也会显示该值
  size.value = '1:1'
}

function togglePopover(name: string): void {
  openPopover.value = openPopover.value === name ? '' : name
}

function pickOption(apply: () => void): void {
  apply()
  openPopover.value = ''
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement | null
  if (openPopover.value && !target?.closest('.pop-wrap')) openPopover.value = ''
}

function openEditor(): void {
  if (!cropScene.value) {
    void chooseScene()
    return
  }
  pickerError.value = ''
  editorSession.value += 1
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
}

function toUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return copy
  }
  return new Uint8Array(bytes)
}

function toBlobPart(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  const view = toUint8(bytes)
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

function applySceneImage(image: DesktopSelectedImage, options: { openEditor?: boolean } = {}): void {
  cropScene.value = image
  scenePreview.value = image.previewDataUrl
  maskPaths.value = []
  cropBox.value = null
  maskOpacity.value = 50
  if (options.openEditor !== false) openEditor()
}

async function rebuildScenePreview(): Promise<void> {
  if (!cropScene.value) {
    scenePreview.value = ''
    return
  }
  if (!cropBox.value || !maskPaths.value.length) {
    scenePreview.value = cropScene.value.previewDataUrl
    return
  }
  try {
    let sceneSrc = cropScene.value.previewDataUrl
    let revoke = false
    if (window.desktop?.readSelectedImage) {
      const selected = await window.desktop.readSelectedImage(cropScene.value.id)
      sceneSrc = URL.createObjectURL(new Blob([toBlobPart(selected.bytes)], { type: selected.type || 'image/png' }))
      revoke = true
    }
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('场景预览加载失败'))
        el.src = sceneSrc
      })
      const maxEdge = 1600
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight, 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        scenePreview.value = cropScene.value.previewDataUrl
        return
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      drawMaskPathsToCanvas(ctx, maskPaths.value, {
        scale,
        alpha: clamp(maskOpacity.value / 100, 0.05, 1)
      })
      scenePreview.value = canvas.toDataURL('image/jpeg', 0.85)
    } finally {
      if (revoke && sceneSrc.startsWith('blob:')) URL.revokeObjectURL(sceneSrc)
    }
  } catch {
    scenePreview.value = cropScene.value.previewDataUrl
  }
}

async function applyDraft(draft: LocalCropDraft): Promise<void> {
  stopPromptTypewriter()
  promptTouched.value = true
  if (typeof draft.providerId === 'number' && draft.providerId > 0) providerId.value = draft.providerId
  if (draft.quality) quality.value = draft.quality
  if (draft.resolution) resolution.value = draft.resolution
  forceSquareSize(activeProvider.value?.sizeOptions || [])
  if (typeof draft.prompt === 'string') {
    cropPrompt.value = stripLocalCropGuard(draft.prompt) || DEFAULT_LOCAL_CROP_PROMPT
  }
  cropProducts.value = Array.isArray(draft.products) ? draft.products.slice(0, 3) : []
  if (draft.scene) {
    cropScene.value = draft.scene
    maskPaths.value = cloneMaskPaths(draft.maskPaths || [])
    cropBox.value = draft.cropBox ? { ...draft.cropBox } : null
    maskOpacity.value = typeof draft.maskOpacity === 'number' ? draft.maskOpacity : 50
    await rebuildScenePreview()
    if (draft.openEditor) {
      editorSession.value += 1
      editorOpen.value = true
    } else {
      editorOpen.value = false
    }
  }
  pickerError.value = ''
  await nextTick(autoGrowPrompt)
}

watch(
  () => props.draft?.token,
  (token) => {
    if (!token || !props.draft) return
    void applyDraft(props.draft)
  }
)

function applyProductImage(slot: number, image: DesktopSelectedImage): void {
  const next: Array<DesktopSelectedImage | null> = [0, 1, 2].map((i) => cropProducts.value[i] || null)
  next[slot] = image
  cropProducts.value = next.filter((item): item is DesktopSelectedImage => Boolean(item))
}

async function importFromClipboard(): Promise<DesktopSelectedImage> {
  if (!window.desktop?.readClipboardImage || !window.desktop?.importPsdImage) {
    throw new Error('当前环境不支持从剪切板粘贴图片')
  }
  const clip = await window.desktop.readClipboardImage()
  if (!clip) throw new Error('剪切板里没有图片，请先复制一张图')
  return window.desktop.importPsdImage(clip)
}

async function chooseScene(): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: '选择场景图' }) || []
    if (!selected[0]) return
    applySceneImage(selected[0])
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : '选择场景图失败'
  }
}

async function pasteScene(): Promise<void> {
  pickerError.value = ''
  try {
    applySceneImage(await importFromClipboard())
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : '粘贴场景图失败'
  }
}

async function chooseProductAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: '选择产品图' }) || []
    if (!selected[0]) return
    applyProductImage(slot, selected[0])
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : '选择产品图失败'
  }
}

async function pasteProductAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    applyProductImage(slot, await importFromClipboard())
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : '粘贴产品图失败'
  }
}

function removeProductAt(slot: number): void {
  cropProducts.value = cropProducts.value.filter((_, index) => index !== slot)
}

function onEditorConfirm(payload: { paths: MaskPath[]; cropBox: CropBox; maskOpacity: number; previewDataUrl: string }): void {
  maskPaths.value = payload.paths
  cropBox.value = payload.cropBox
  maskOpacity.value = payload.maskOpacity
  scenePreview.value = payload.previewDataUrl
  editorOpen.value = false
  pickerError.value = ''
}

function clearVoiceStatusLater(message: string, delay = 2600): void {
  if (voiceStatusTimer) window.clearTimeout(voiceStatusTimer)
  voiceStatusTimer = window.setTimeout(() => {
    if (voiceStatus.value === message) voiceStatus.value = ''
  }, delay)
}

function appendRecognizedText(text: string): void {
  const recognized = text.trim().replace(/\s+/g, ' ')
  if (!recognized) return
  promptTouched.value = true
  stopPromptTypewriter()
  const current = cropPrompt.value.trim()
  const separator = current ? (/[。！？.!?]$/.test(current) ? '' : '，') : ''
  cropPrompt.value = `${current}${separator}${recognized}`.slice(0, 2000)
  void nextTick(() => {
    autoGrowPrompt()
    promptRef.value?.focus()
    promptRef.value?.setSelectionRange(cropPrompt.value.length, cropPrompt.value.length)
  })
}

function handleNativeVoiceEvent(value: { type: string; text?: string; message?: string }): void {
  if (!nativeVoiceActive) return
  if (value.type === 'ready') {
    isVoiceRecognizing.value = false
    isVoiceListening.value = true
    voiceStatus.value = '正在听，你可以开始说话…'
    return
  }
  if (value.type === 'partial') {
    voiceInterimText = String(value.text || '')
    voiceStatus.value = voiceInterimText.trim() ? `识别中：${voiceInterimText.trim()}` : '正在识别…'
    return
  }
  if (value.type === 'final') {
    voiceFinalText = String(value.text || '')
    return
  }
  if (value.type === 'error') {
    voiceFailed = true
    const message = String(value.message || '语音识别失败，请再试一次')
    voiceStatus.value = message
    clearVoiceStatusLater(message, 5200)
    return
  }
  if (value.type === 'end') {
    nativeVoiceActive = false
    isVoiceListening.value = false
    isVoiceRecognizing.value = false
    if (voiceFailed) return
    const recognized = (voiceFinalText || voiceInterimText).trim()
    if (recognized) {
      appendRecognizedText(recognized)
      voiceStatus.value = '已加入提示词'
      clearVoiceStatusLater('已加入提示词')
    } else {
      voiceStatus.value = '没有识别到内容，请再试一次'
      clearVoiceStatusLater('没有识别到内容，请再试一次', 5200)
    }
  }
}

async function toggleVoiceInput(): Promise<void> {
  if (isVoiceListening.value || isVoiceRecognizing.value) {
    isVoiceListening.value = false
    isVoiceRecognizing.value = true
    voiceStatus.value = '正在完成识别…'
    if (nativeVoiceActive) void window.desktop?.voiceStop()
    return
  }
  if (!window.desktop?.voiceStart) {
    voiceStatus.value = '当前环境暂不支持语音输入'
    clearVoiceStatusLater(voiceStatus.value, 4200)
    return
  }
  isVoiceRecognizing.value = true
  voiceStatus.value = '正在请求麦克风权限…'
  try {
    const granted = await window.desktop.requestMicrophoneAccess()
    if (!granted) throw new Error('麦克风未授权')
    voiceFinalText = ''
    voiceInterimText = ''
    voiceFailed = false
    nativeVoiceActive = true
    voiceStatus.value = '正在启动语音识别…'
    await window.desktop.voiceStart()
  } catch (error) {
    nativeVoiceActive = false
    isVoiceListening.value = false
    isVoiceRecognizing.value = false
    voiceStatus.value = error instanceof Error ? error.message : '无法启动语音输入'
    clearVoiceStatusLater(voiceStatus.value, 5200)
  }
}

async function onGenerateClick(): Promise<void> {
  pickerError.value = ''
  if (!cropScene.value) {
    await chooseScene()
    return
  }
  if (!cropBox.value) {
    pickerError.value = '请先在编辑器中设置重绘框'
    openEditor()
    return
  }
  await submit()
}

async function submit(): Promise<void> {
  pickerError.value = ''
  if (!cropScene.value || !cropBox.value) return
  if (!window.desktop?.importPsdImage) return void (pickerError.value = '桌面导入能力不可用')
  const guardedPrompt = withLocalCropGuard(cropPrompt.value)
  emit('begin', { prompt: guardedPrompt })
  baking.value = true
  try {
    let sceneSrc = cropScene.value.previewDataUrl
    if (window.desktop.readSelectedImage) {
      const selected = await window.desktop.readSelectedImage(cropScene.value.id)
      sceneSrc = URL.createObjectURL(new Blob([toBlobPart(selected.bytes)], { type: selected.type || 'image/png' }))
    }
    let blob: Blob
    try {
      blob = await bakeLocalCropImage(sceneSrc, cropBox.value, maskPaths.value, maskOpacity.value)
    } finally {
      if (sceneSrc.startsWith('blob:')) URL.revokeObjectURL(sceneSrc)
    }
    const bytes = await blobToArrayBuffer(blob)
    const baked = await window.desktop.importPsdImage({
      name: `local-crop-${Date.now()}.png`,
      type: 'image/png',
      bytes
    })
    emit('submit', {
      kind: 'crop',
      items: [{
        prompt: guardedPrompt,
        sources: [baked, ...cropProducts.value].slice(0, 4)
      }],
      providerId: activeProvider.value?.id || 0,
      model: activeProvider.value?.model || '',
      size: size.value,
      quality: quality.value,
      resolution: resolution.value,
      localCrop: {
        sceneImageId: cropScene.value.id,
        cropBox: { x: cropBox.value.x, y: cropBox.value.y, size: cropBox.value.size },
        hasMask: maskPaths.value.some((path) => !path.isEraser && path.points.length > 0),
        maskPaths: cloneMaskPaths(maskPaths.value),
        // Only an explicitly remote preview can be reused as metadata; local
        // source ids are intentionally not persisted as remote URLs.
        productSources: cropProducts.value.map((item) => item.previewDataUrl).filter((url) => /^https?:\/\//i.test(url)).slice(0, 3)
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '裁切图准备失败'
    pickerError.value = message
    emit('begin-failed', message)
  } finally {
    baking.value = false
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  if (window.desktop?.onVoiceEvent) {
    nativeVoiceOff = window.desktop.onVoiceEvent(handleNativeVoiceEvent)
  }
  void nextTick(autoGrowPrompt)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  nativeVoiceOff?.()
  if (voiceStatusTimer) window.clearTimeout(voiceStatusTimer)
  if (resolutionSnapRaf) cancelAnimationFrame(resolutionSnapRaf)
  stopPromptTypewriter()
  if (nativeVoiceActive) void window.desktop?.voiceStop()
})
</script>

<template>
  <div class="local-crop-panel">
    <div class="crop-mid">
      <div
        v-if="!cropScene"
        class="scene-hero empty primary-visual-frame"
        role="button"
        tabindex="0"
        @click="chooseScene"
        @keydown.enter.prevent="chooseScene"
        @keydown.space.prevent="chooseScene"
      >
        <div class="scene-energy" aria-hidden="true">
          <ResolutionEnergyCanvas :progress="100" :ultra="true" direction="vertical" />
        </div>
        <div class="scene-empty-copy">
          <UploadCloud :size="22" />
          <strong>上传场景图</strong>
          <span>PNG、JPG 或 WebP</span>
          <button class="paste-action" type="button" @click.stop="pasteScene">
            <ClipboardPaste :size="13" />
            粘贴
          </button>
        </div>
      </div>
      <div v-else class="scene-hero filled primary-visual-frame">
        <img :src="scenePreview || cropScene.previewDataUrl" alt="场景图" />
        <div class="scene-overlay">
          <button type="button" class="edit-chip" @click.stop="openEditor">
            <Pencil :size="13" />
            {{ cropBox ? '编辑重绘框' : '设置重绘框' }}
          </button>
          <button type="button" class="ghost-chip" @click.stop="chooseScene">更换</button>
          <button type="button" class="ghost-chip" @click.stop="pasteScene">
            <ClipboardPaste :size="13" />
            粘贴
          </button>
        </div>
      </div>

      <div class="product-slots">
        <div
          v-for="(image, slot) in productSlots"
          :key="slot"
          class="product-slot"
          role="button"
          tabindex="0"
          @click="chooseProductAt(slot)"
          @keydown.enter.prevent="chooseProductAt(slot)"
          @keydown.space.prevent="chooseProductAt(slot)"
        >
          <template v-if="image">
            <img :src="image.previewDataUrl" :alt="image.name" />
            <span class="remove" @click.stop="removeProductAt(slot)"><X :size="11" /></span>
            <button class="paste-action on-image" type="button" @click.stop="pasteProductAt(slot)">
              <ClipboardPaste :size="11" />
              粘贴
            </button>
          </template>
          <template v-else>
            <Plus :size="16" />
            <span>产品参考</span>
            <button class="paste-action compact" type="button" @click.stop="pasteProductAt(slot)">
              <ClipboardPaste :size="11" />
              粘贴
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- 与快捷生成 composer 共用尺寸、排版与边框特效 -->
    <section class="composer-shell docked primary-composer crop-composer">
      <div class="composer-card mode-composer-surface">
        <div :class="['prompt-area', { typing: isPromptTyping }]" aria-live="polite">
          <textarea
            ref="promptRef"
            v-model="cropPrompt"
            rows="2"
            maxlength="2000"
            placeholder="描述替换要求：产品如何融入场景、光线材质、保留框外内容…"
            @input="onPromptInput"
            @keydown.meta.enter="onGenerateClick"
            @keydown.ctrl.enter="onGenerateClick"
          />
        </div>

        <div :class="['composer-bottom', { 'has-send': canSubmit || submitting || baking }]">
          <div class="crop-composer-actions">
            <button class="icon-round mode-add-control" type="button" :title="cropScene ? '更换场景图' : '添加场景图'" @click="chooseScene">
              <Plus :size="16" />
            </button>
            <button class="icon-round mode-pencil-control" type="button" title="画笔重绘区域" :disabled="!cropScene" @click="openEditor">
              <Pencil :size="16" />
            </button>
          </div>

          <div class="composer-params">
            <div class="pop-wrap mode-provider-control">
              <button :class="['param-btn', { open: openPopover === 'provider' }]" type="button" aria-label="生成线路" @click="togglePopover('provider')">
                {{ selectedProviderLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'provider'" class="menu-pop param-menu scrollable" role="menu">
                  <span class="menu-title">线路</span>
                  <button
                    v-for="provider in providers"
                    :key="provider.id"
                    class="menu-option"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="provider.id === providerId"
                    @click="pickOption(() => { providerId = provider.id })"
                  >
                    <span class="menu-option-label">{{ provider.label }}</span>
                    <span v-if="provider.model" class="menu-option-hint">{{ provider.model }}</span>
                    <Check v-if="provider.id === providerId" :size="14" class="menu-check" />
                  </button>
                </div>
              </Transition>
            </div>

            <div class="pop-wrap mode-size-control">
              <button
                class="param-btn"
                type="button"
                aria-label="画面比例"
                title="局部重绘固定 1:1，与重绘框一致"
                disabled
              >
                {{ selectedSizeLabel || '1:1' }}
                <span class="size-lock-hint">固定</span>
              </button>
            </div>

            <div v-if="currentQualityOptions.length > 1" class="pop-wrap mode-quality-control">
              <button :class="['param-btn', { open: openPopover === 'quality' }]" type="button" aria-label="质量" @click="togglePopover('quality')">
                {{ selectedQualityLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'quality'" class="menu-pop param-menu" role="menu">
                  <span class="menu-title">质量</span>
                  <button
                    v-for="item in currentQualityOptions"
                    :key="item.value"
                    class="menu-option"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="item.value === quality"
                    @click="pickOption(() => { quality = item.value })"
                  >
                    <span class="menu-option-label">{{ item.label }}</span>
                    <Check v-if="item.value === quality" :size="14" class="menu-check" />
                  </button>
                </div>
              </Transition>
            </div>

            <div v-if="currentResolutionOptions.length > 1" class="pop-wrap mode-resolution-control">
              <button
                :class="['param-btn', { open: openPopover === 'resolution', ultra: isMaxResolution }]"
                type="button"
                aria-label="分辨率"
                @click="togglePopover('resolution')"
              >
                {{ resolutionLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'resolution'" class="menu-pop slider-pop">
                  <div class="resolution-heading">
                    <span>分辨率</span>
                    <strong :class="{ ultra: isMaxResolution }">{{ resolutionLabel }}</strong>
                    <button
                      class="resolution-help"
                      type="button"
                      title="更高分辨率会生成更清晰的细节，同时需要更长处理时间"
                      aria-label="分辨率说明"
                    >
                      <HelpCircle :size="14" />
                    </button>
                  </div>
                  <div class="slider-labels"><span>更快</span><span>更清晰</span></div>
                  <div :class="['resolution-track', { ultra: isMaxResolution }]" :style="resolutionTrackStyle">
                    <ResolutionEnergyCanvas :progress="resolutionProgress" :ultra="isMaxResolution" />
                    <input
                      class="res-slider"
                      type="range"
                      min="0"
                      :max="resolutionMaxIndex()"
                      step="0.01"
                      :value="resolutionSlide"
                      :aria-valuetext="resolutionLabel"
                      aria-label="分辨率档位"
                      @input="onResolutionSlideInput"
                      @change="onResolutionSlideCommit"
                      @pointerup="onResolutionSlideCommit"
                      @pointercancel="onResolutionSlideCommit"
                      @keyup.enter="onResolutionSlideCommit"
                    />
                  </div>
                </div>
              </Transition>
            </div>
          </div>

          <div class="composer-trailing mode-trailing-control">
            <button
              :class="['voice-btn', { listening: isVoiceListening, recognizing: isVoiceRecognizing }]"
              type="button"
              :disabled="submitting || baking"
              :aria-label="isVoiceListening ? '停止语音输入' : '语音输入'"
              :title="isVoiceListening ? '停止并识别' : '语音输入提示词'"
              @click="toggleVoiceInput"
            >
              <LoaderCircle v-if="isVoiceRecognizing" :size="15" class="spin" />
              <Square v-else-if="isVoiceListening" :size="11" fill="currentColor" />
              <Mic v-else :size="16" />
              <span v-if="isVoiceListening" class="voice-pulse" aria-hidden="true" />
            </button>

            <div class="send-slot" :class="{ open: canSubmit || submitting || baking }">
              <button
                class="send-btn"
                type="button"
                tabindex="-1"
                :disabled="!canSubmit"
                :aria-hidden="!(canSubmit || submitting || baking)"
                :aria-label="cropBox ? '开始生成' : '设置重绘框并生成'"
                @click="onGenerateClick"
              >
                <LoaderCircle v-if="submitting || baking" :size="16" class="spin" />
                <ArrowUp v-else :size="17" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="composer-tray mode-composer-tray">
        <div class="composer-tray-left">
          <span v-if="pickerError" class="crop-error">{{ pickerError }}</span>
          <span v-else-if="voiceStatus" class="voice-status" role="status" aria-live="polite">{{ voiceStatus }}</span>
          <span v-else>1 local edit request · provider billed separately</span>
        </div>
        <span>⌘ ↵ 生成</span>
      </div>
    </section>

    <SceneEditorModal
      v-if="editorOpen && cropScene"
      :key="editorSession"
      :image-id="cropScene.id"
      :initial-paths="maskPaths"
      :initial-crop-box="cropBox"
      :initial-opacity="maskOpacity"
      @close="closeEditor"
      @confirm="onEditorConfirm"
    />
  </div>
</template>

<style scoped>
.size-lock-hint {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.72;
  font-weight: 500;
}
.local-crop-panel {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  -webkit-app-region: no-drag;
}
/* 场景区顶对齐；垂直空白由场景框本身吃掉，产品参考贴着底部 composer */
.crop-mid {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}
.scene-hero {
  position: relative;
  flex: 1;
  min-height: 180px;
  border-radius: 16px;
  border: 1px solid var(--line-strong);
  background: var(--bg);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.scene-hero.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  background: var(--bg);
  cursor: pointer;
}
.scene-energy {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.scene-empty-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.scene-hero.empty:hover {
  border-color: color-mix(in srgb, var(--text-muted) 35%, var(--line-strong));
}
.scene-hero.empty:hover .scene-empty-copy {
  color: var(--text-soft);
}
.scene-empty-copy strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 550;
}
.scene-empty-copy > span {
  font-size: 12px;
}
.paste-action {
  margin-top: 3px;
  height: 25px;
  padding: 0 7px;
  border-radius: 7px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 450;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}
.paste-action :deep(svg) {
  display: block;
  flex: 0 0 auto;
  transform: translateY(-0.25px);
}
.paste-action:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}
.paste-action.compact {
  margin-top: 0;
  height: 20px;
  padding: 0 4px;
  font-size: 10.5px;
  opacity: 0.72;
}
.product-slot:hover .paste-action.compact,
.paste-action.compact:focus-visible {
  opacity: 1;
}
.paste-action.on-image {
  position: absolute;
  left: auto;
  right: 6px;
  bottom: 6px;
  margin-top: 0;
  height: 26px;
  padding: 0 8px;
  font-size: 10.5px;
  background: rgba(24, 24, 22, 0.58);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.88);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
  backdrop-filter: blur(10px);
  z-index: 1;
}
.paste-action.on-image:hover {
  background: rgba(24, 24, 22, 0.76);
  color: #fff;
}
.scene-hero.filled {
  background: #141413;
  display: grid;
  place-items: center;
}
.scene-hero.filled img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.scene-overlay {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.edit-chip,
.ghost-chip {
  height: 32px;
  padding: 0 11px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.edit-chip {
  background: var(--accent);
  color: #fff;
}
.ghost-chip {
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(24, 24, 22, 0.62);
  color: rgba(255, 255, 255, 0.92);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(10px);
}
.product-slots {
  flex: none;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.product-slot {
  position: relative;
  height: 78px;
  border-radius: 14px;
  border: 1px dashed var(--line-strong);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--text-muted);
  font-size: 11.5px;
  overflow: hidden;
  cursor: pointer;
}
.product-slot:hover {
  border-color: color-mix(in srgb, var(--text-muted) 40%, var(--line-strong));
  color: var(--text-soft);
}
.product-slot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.product-slot .remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 7px;
  background: rgba(20, 20, 20, 0.72);
  color: #fff;
  display: grid;
  place-items: center;
  z-index: 1;
}
.composer-shell.docked {
  flex: none;
  margin-top: 0;
  padding-top: 0;
  padding-bottom: 0;
  background: transparent;
}
.crop-composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.crop-error {
  color: var(--danger);
}
.icon-round:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
