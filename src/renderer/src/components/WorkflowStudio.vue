<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardPaste,
  HelpCircle,
  ImagePlus,
  LoaderCircle,
  Mic,
  Plus,
  Sparkles,
  Square,
  WandSparkles,
  X
} from 'lucide-vue-next'
import LocalCropPanel, { type LocalCropDraft, type LocalCropSubmission } from './LocalCropPanel.vue'
import ResolutionEnergyCanvas from './ResolutionEnergyCanvas.vue'
import { api } from '../api'

export type WorkflowKind = 'detailV4' | 'replication' | 'batchSku' | 'crop' | 'sellVideo'
type Option = { label: string; value: string }
type Provider = {
  id: number
  label: string
  model: string
  sizeOptions: Option[]
  qualityOptions: Option[]
  resolutionOptions: Option[]
}
type WorkflowItem = { prompt: string; sources: DesktopSelectedImage[] }
export type WorkflowSubmission = {
  kind: WorkflowKind
  items: WorkflowItem[]
  providerId: number
  model: string
  size: string
  quality: string
  resolution: string
  localCrop?: LocalCropSubmission['localCrop']
}

const REF_SLOT_COUNT = 20
const PRODUCT_SLOT_COUNT = 3
const SKU_SLOT_COUNT = 20
const DETAIL_STYLE_SLOT_COUNT = 3

const props = defineProps<{
  kind: WorkflowKind
  active?: boolean
  providers: Provider[]
  defaultProviderId: number
  defaultSize: string
  defaultQuality: string
  defaultResolution: string
  submitting: boolean
  cropDraft?: LocalCropDraft | null
}>()
const emit = defineEmits<{
  submit: [payload: WorkflowSubmission]
  begin: [payload: { prompt: string }]
  'begin-failed': [message: string]
}>()

const providerId = ref(props.defaultProviderId)
const size = ref(props.defaultSize)
const quality = ref(props.defaultQuality)
const resolution = ref(props.defaultResolution)
const productName = ref('')
const sellingPoints = ref('')
const sharedPrompt = ref('Keep the product accurate and make the image ready for commercial use.')
const skuAttributes = ref('')
const detailProduct = ref<DesktopSelectedImage | null>(null)
const detailStyleSlots = ref<Array<DesktopSelectedImage | null>>(Array.from({ length: DETAIL_STYLE_SLOT_COUNT }, () => null))
const detailExtra = ref('')
const optimizingPoints = ref(false)
const replicationRefSlots = ref<Array<DesktopSelectedImage | null>>(Array.from({ length: REF_SLOT_COUNT }, () => null))
const replicationProductSlots = ref<Array<DesktopSelectedImage | null>>(Array.from({ length: PRODUCT_SLOT_COUNT }, () => null))
const skuProductSlots = ref<Array<DesktopSelectedImage | null>>(Array.from({ length: SKU_SLOT_COUNT }, () => null))
const skuTemplate = ref<DesktopSelectedImage | null>(null)
const pickerError = ref('')
const plans = ref<Array<{ title: string; prompt: string; enabled: boolean }>>([])

// —— 与快捷生成 / 局部重绘同一套 composer 状态 ——
const openPopover = ref('')
const resolutionSlide = ref(0)
const resolutionDragging = ref(false)
const promptRef = ref<HTMLTextAreaElement | null>(null)
let resolutionSnapRaf = 0
let resolutionCommitting = false

const isVoiceListening = ref(false)
const isVoiceRecognizing = ref(false)
const voiceStatus = ref('')
let voiceStatusTimer: number | null = null
let voiceFinalText = ''
let voiceInterimText = ''
let voiceFailed = false
let nativeVoiceActive = false
let nativeVoiceOff: (() => void) | null = null

const activeProvider = computed(() => props.providers.find((item) => item.id === providerId.value) || props.providers[0])

const filledReplicationRefs = computed(() =>
  replicationRefSlots.value.filter((item): item is DesktopSelectedImage => Boolean(item))
)
const filledReplicationProducts = computed(() =>
  replicationProductSlots.value.filter((item): item is DesktopSelectedImage => Boolean(item))
)
const filledSkuProducts = computed(() =>
  skuProductSlots.value.filter((item): item is DesktopSelectedImage => Boolean(item))
)
const filledDetailStyles = computed(() =>
  detailStyleSlots.value.filter((item): item is DesktopSelectedImage => Boolean(item))
)
const replicationFilledCount = computed(() => filledReplicationRefs.value.length)
const replicationEmptyCount = computed(() => REF_SLOT_COUNT - replicationFilledCount.value)
const skuFilledCount = computed(() => filledSkuProducts.value.length)
const skuEmptyCount = computed(() => SKU_SLOT_COUNT - skuFilledCount.value)
const detailEnabledCount = computed(() => plans.value.filter((item) => item.enabled && item.prompt.trim()).length)

const selectionCount = computed(() => {
  if (props.kind === 'detailV4') return detailEnabledCount.value
  if (props.kind === 'replication') return replicationFilledCount.value
  if (props.kind === 'batchSku') return skuFilledCount.value
  return 0
})

const selectedProviderLabel = computed(() => activeProvider.value?.label || 'Provider')
const selectedSizeLabel = computed(() => activeProvider.value?.sizeOptions.find((item) => item.value === size.value)?.label || size.value)
const selectedQualityLabel = computed(() => activeProvider.value?.qualityOptions.find((item) => item.value === quality.value)?.label || quality.value)
const currentResolutionOptions = computed(() => activeProvider.value?.resolutionOptions || [])
const currentQualityOptions = computed(() => activeProvider.value?.qualityOptions || [])

const canSubmitReplication = computed(() => replicationFilledCount.value > 0 && !props.submitting)
const canSubmitBatchSku = computed(() => skuFilledCount.value > 0 && Boolean(skuTemplate.value) && !props.submitting)
const canSubmitDetail = computed(() =>
  Boolean(detailProduct.value) && detailEnabledCount.value > 0 && !props.submitting
)

function autoGrowPrompt(): void {
  const el = promptRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`
}
watch([sharedPrompt, detailExtra], () => nextTick(autoGrowPrompt))

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
  if (!provider.sizeOptions.some((item) => item.value === size.value)) size.value = provider.sizeOptions[0]?.value || '1:1'
  if (!provider.qualityOptions.some((item) => item.value === quality.value)) quality.value = provider.qualityOptions[0]?.value || 'low'
  if (!provider.resolutionOptions.some((item) => item.value === resolution.value)) resolution.value = provider.resolutionOptions[0]?.value || '1K'
}, { immediate: true })

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

function clearVoiceStatusLater(message: string, delay = 2600): void {
  if (voiceStatusTimer) window.clearTimeout(voiceStatusTimer)
  voiceStatusTimer = window.setTimeout(() => {
    if (voiceStatus.value === message) voiceStatus.value = ''
  }, delay)
}

function appendRecognizedText(text: string): void {
  const recognized = text.trim().replace(/\s+/g, ' ')
  if (!recognized) return
  const target = props.kind === 'detailV4' ? detailExtra : sharedPrompt
  const current = target.value.trim()
  const separator = current ? (/[。！？.!?]$/.test(current) ? '' : '，') : ''
  target.value = `${current}${separator}${recognized}`.slice(0, 2000)
  void nextTick(() => {
    autoGrowPrompt()
    promptRef.value?.focus()
    promptRef.value?.setSelectionRange(target.value.length, target.value.length)
  })
}

function handleNativeVoiceEvent(value: { type: string; text?: string; message?: string }): void {
  if (!nativeVoiceActive) return
  if (value.type === 'partial') {
    voiceInterimText = String(value.text || '')
    isVoiceRecognizing.value = true
    return
  }
  if (value.type === 'final') {
    voiceFinalText = String(value.text || voiceFinalText)
    voiceInterimText = ''
    isVoiceRecognizing.value = false
    return
  }
  if (value.type === 'error') {
    voiceFailed = true
    isVoiceListening.value = false
    isVoiceRecognizing.value = false
    voiceStatus.value = value.message || 'Voice recognition failed'
    clearVoiceStatusLater(voiceStatus.value)
    return
  }
  if (value.type === 'end') {
    isVoiceListening.value = false
    isVoiceRecognizing.value = false
    nativeVoiceActive = false
    if (!voiceFailed) {
      const text = (voiceFinalText || voiceInterimText).trim()
      if (text) {
        appendRecognizedText(text)
        voiceStatus.value = 'Voice text added'
      } else {
        voiceStatus.value = 'No speech was recognized. Please try again.'
      }
      clearVoiceStatusLater(voiceStatus.value)
    }
    voiceFinalText = ''
    voiceInterimText = ''
    voiceFailed = false
  }
}

async function toggleVoiceInput(): Promise<void> {
  if (props.submitting) return
  if (isVoiceListening.value) {
    if (nativeVoiceActive) {
      isVoiceRecognizing.value = true
      voiceStatus.value = 'Recognizing…'
      try {
        await window.desktop?.voiceStop()
      } catch {
        isVoiceListening.value = false
        isVoiceRecognizing.value = false
        nativeVoiceActive = false
      }
    }
    return
  }
  voiceFailed = false
  voiceFinalText = ''
  voiceInterimText = ''
  try {
    const granted = await window.desktop?.requestMicrophoneAccess()
    if (granted === false) {
      voiceStatus.value = 'Microphone permission is required for voice input'
      clearVoiceStatusLater(voiceStatus.value)
      return
    }
    nativeVoiceOff?.()
    nativeVoiceOff = window.desktop?.onVoiceEvent?.(handleNativeVoiceEvent) || null
    nativeVoiceActive = true
    isVoiceListening.value = true
    voiceStatus.value = 'Listening. You can start speaking…'
    await window.desktop?.voiceStart()
  } catch (error) {
    nativeVoiceActive = false
    isVoiceListening.value = false
    isVoiceRecognizing.value = false
    voiceStatus.value = error instanceof Error ? error.message : 'Unable to start voice input'
    clearVoiceStatusLater(voiceStatus.value)
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  void nextTick(autoGrowPrompt)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  if (resolutionSnapRaf) cancelAnimationFrame(resolutionSnapRaf)
  if (voiceStatusTimer) window.clearTimeout(voiceStatusTimer)
  nativeVoiceOff?.()
  if (nativeVoiceActive) void window.desktop?.voiceStop().catch(() => undefined)
})

async function chooseDetailProduct(): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: 'Choose product hero image' }) || []
    if (!selected[0]) return
    detailProduct.value = selected[0]
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to choose the product hero image'
  }
}

async function pasteDetailProduct(): Promise<void> {
  pickerError.value = ''
  try {
    detailProduct.value = await importFromClipboard()
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to paste the product hero image'
  }
}

function removeDetailProduct(): void {
  detailProduct.value = null
}

async function chooseDetailStyleAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: 'Choose style reference image' }) || []
    if (!selected[0]) return
    const next = detailStyleSlots.value.slice()
    next[slot] = selected[0]
    detailStyleSlots.value = next
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to choose the style reference'
  }
}

async function pasteDetailStyleAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const image = await importFromClipboard()
    const next = detailStyleSlots.value.slice()
    next[slot] = image
    detailStyleSlots.value = next
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to paste the style reference'
  }
}

function removeDetailStyleAt(slot: number): void {
  const next = detailStyleSlots.value.slice()
  next[slot] = null
  detailStyleSlots.value = next
}

function fillRefSlotsFrom(startIndex: number, images: DesktopSelectedImage[]): void {
  const next = replicationRefSlots.value.slice()
  let i = Math.max(0, Math.min(REF_SLOT_COUNT - 1, startIndex))
  for (const image of images) {
    while (i < REF_SLOT_COUNT && next[i] != null) i += 1
    if (i >= REF_SLOT_COUNT) break
    next[i] = image
    i += 1
  }
  replicationRefSlots.value = next
}

async function importFromClipboard(): Promise<DesktopSelectedImage> {
  if (!window.desktop?.readClipboardImage || !window.desktop?.importPsdImage) {
    throw new Error('Pasting images from the clipboard is not supported here')
  }
  const clip = await window.desktop.readClipboardImage()
  if (!clip) throw new Error('No image is in the clipboard. Copy an image first.')
  return window.desktop.importPsdImage(clip)
}

async function chooseRefAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const filled = replicationRefSlots.value[slot]
    if (filled) {
      const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: 'Replace remake reference image' }) || []
      if (!selected[0]) return
      const next = replicationRefSlots.value.slice()
      next[slot] = selected[0]
      replicationRefSlots.value = next
      return
    }
    const remaining = replicationEmptyCount.value
    if (remaining <= 0) {
      pickerError.value = 'The 20 remake reference slots are full'
      return
    }
    const selected = await window.desktop?.selectWorkflowImages({
      limit: remaining,
      title: 'Choose remake reference images (multiple selection allowed)'
    }) || []
    if (!selected.length) return
    fillRefSlotsFrom(slot, selected)
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to choose reference images'
  }
}

async function pasteRefAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const image = await importFromClipboard()
    const next = replicationRefSlots.value.slice()
    next[slot] = image
    replicationRefSlots.value = next
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to paste the reference image'
  }
}

function removeRefAt(slot: number): void {
  const next = replicationRefSlots.value.slice()
  next[slot] = null
  replicationRefSlots.value = next
}

async function chooseProductAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: 'Choose product image' }) || []
    if (!selected[0]) return
    const next = replicationProductSlots.value.slice()
    next[slot] = selected[0]
    replicationProductSlots.value = next
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to choose the product image'
  }
}

async function pasteProductAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const image = await importFromClipboard()
    const next = replicationProductSlots.value.slice()
    next[slot] = image
    replicationProductSlots.value = next
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to paste the product image'
  }
}

function removeProductAt(slot: number): void {
  const next = replicationProductSlots.value.slice()
  next[slot] = null
  replicationProductSlots.value = next
}

/** 底部 +：从第一个空槽开始多选填入参考图 */
async function addRefsFromComposer(): Promise<void> {
  const start = replicationRefSlots.value.findIndex((item) => item == null)
  if (start < 0) {
    pickerError.value = 'The 20 remake reference slots are full'
    return
  }
  await chooseRefAt(start)
}

function fillSkuSlotsFrom(startIndex: number, images: DesktopSelectedImage[]): void {
  const next = skuProductSlots.value.slice()
  let i = Math.max(0, Math.min(SKU_SLOT_COUNT - 1, startIndex))
  for (const image of images) {
    while (i < SKU_SLOT_COUNT && next[i] != null) i += 1
    if (i >= SKU_SLOT_COUNT) break
    next[i] = image
    i += 1
  }
  skuProductSlots.value = next
}

async function chooseSkuAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    if (skuProductSlots.value[slot]) {
      const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: 'Replace SKU product image' }) || []
      if (!selected[0]) return
      const next = skuProductSlots.value.slice()
      next[slot] = selected[0]
      skuProductSlots.value = next
      return
    }
    if (skuEmptyCount.value <= 0) {
      pickerError.value = 'The 20 SKU product slots are full'
      return
    }
    const selected = await window.desktop?.selectWorkflowImages({
      limit: skuEmptyCount.value,
      title: 'Choose SKU product images (multiple selection allowed)'
    }) || []
    if (!selected.length) return
    fillSkuSlotsFrom(slot, selected)
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to choose SKU product images'
  }
}

async function pasteSkuAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const image = await importFromClipboard()
    const next = skuProductSlots.value.slice()
    next[slot] = image
    skuProductSlots.value = next
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to paste the SKU product image'
  }
}

function removeSkuAt(slot: number): void {
  const next = skuProductSlots.value.slice()
  next[slot] = null
  skuProductSlots.value = next
}

async function chooseSkuTemplate(): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: 'Choose shared template image' }) || []
    if (!selected[0]) return
    skuTemplate.value = selected[0]
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to choose the template image'
  }
}

async function pasteSkuTemplate(): Promise<void> {
  pickerError.value = ''
  try {
    skuTemplate.value = await importFromClipboard()
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Failed to paste the template image'
  }
}

function removeSkuTemplate(): void {
  skuTemplate.value = null
}

async function addSkuFromComposer(): Promise<void> {
  const start = skuProductSlots.value.findIndex((item) => item == null)
  if (start < 0) {
    pickerError.value = 'The 20 SKU product slots are full'
    return
  }
  await chooseSkuAt(start)
}

async function optimizeSellingPoints(): Promise<void> {
  pickerError.value = ''
  const raw = [productName.value.trim() && `Product: ${productName.value.trim()}`, sellingPoints.value.trim() || 'Premium feel, core benefits, and credible presentation']
    .filter(Boolean)
    .join('\n')
  if (!raw.trim()) {
    pickerError.value = 'Add a product name or key selling points first'
    return
  }
  if (optimizingPoints.value) return
  optimizingPoints.value = true
  try {
    const seed = [
      'Rewrite the following product information as concise key selling points for an e-commerce detail page.',
      'Use concrete, observable language with 3–6 points or one coherent paragraph. Do not invent medical claims or add headings and numbering. Output only the selling-point copy.',
      '',
      raw
    ].join('\n')
    const res = await api.rewritePrompt(seed)
    const content = String(res?.content || '').trim()
    if (!content) throw new Error('The rewrite returned no content')
    sellingPoints.value = content.slice(0, 400)
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : 'Rewrite failed. Please try again later.'
  } finally {
    optimizingPoints.value = false
  }
}

function buildDetailPlans(): void {
  pickerError.value = ''
  if (!detailProduct.value) {
    pickerError.value = 'Choose a hero product image first'
    return
  }
  const product = productName.value.trim() || 'the product in the hero image'
  const points = sellingPoints.value.trim() || 'premium feel, core benefits, and credible presentation'
  const templates = [
    ['Hero visual', `Design a premium detail-page hero visual for ${product}. Highlight ${points}; center the product and leave a clear area for a headline.`],
    ['Key benefits', `Create a key-benefit scene for ${product} that visualizes ${points} with a clear information hierarchy.`],
    ['Ingredients & technology', `Create a credible ingredients-and-technology visual for ${product} with a realistic commercial photography feel and no invented copy.`],
    ['Usage scene', `Show ${product} in a natural, elevated, credible usage moment and context.`],
    ['Texture detail', `Use macro framing and material highlights to show the texture of ${product}; keep the background clean and emphasize refinement.`],
    ['Evidence', `Create a restrained proof visual for ${product} using comparison, composition, and whitespace without exaggerated promises.`],
    ['How to use', `Design a clear three-step usage visual for ${product}; preserve the product and packaging accurately.`],
    ['Conversion close', `Create a premium detail-page closing visual for ${product}, returning to ${points} and leaving space for purchase information.`]
  ]
  plans.value = templates.map(([title, prompt]) => ({ title, prompt, enabled: true }))
  void nextTick(() => document.querySelector('.detail-panel .plan-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
}

function commonSubmission(items: WorkflowItem[]): WorkflowSubmission {
  return {
    kind: props.kind,
    items,
    providerId: activeProvider.value?.id || 0,
    model: activeProvider.value?.model || '',
    size: size.value,
    quality: quality.value,
    resolution: resolution.value
  }
}

function submitWorkflow(): void {
  pickerError.value = ''
  let items: WorkflowItem[] = []
  if (props.kind === 'detailV4') {
    if (!detailProduct.value || !plans.value.length) return void (pickerError.value = 'Generate and confirm scene plans first')
    const styles = filledDetailStyles.value
    const extra = detailExtra.value.trim()
    items = plans.value.filter((item) => item.enabled && item.prompt.trim()).map((item) => ({
      prompt: [
        item.prompt.trim(),
        extra,
        'The product must match the hero image. Do not replace it with another product.'
      ].filter(Boolean).join('\n'),
      // 主图优先，风格参考随后
      sources: [detailProduct.value!, ...styles].slice(0, 4)
    }))
  }
  if (props.kind === 'replication') {
    const refs = filledReplicationRefs.value
    const products = filledReplicationProducts.value
    if (!refs.length) return void (pickerError.value = 'Choose at least one remake reference image first')
    items = refs.map((image, index) => ({
      prompt: [
        `Recreate the composition, camera, lighting, and overall visual language of reference image ${index + 1}.`,
        products.length ? 'Use the attached product references for the subject; preserve the packaging and shape.' : 'Keep the product subject accurate.',
        sharedPrompt.value.trim()
      ].filter(Boolean).join(' '),
      // 参考图在前（构图母版），商品图随后
      sources: [image, ...products].slice(0, 4)
    }))
  }
  if (props.kind === 'batchSku') {
    if (!skuTemplate.value) return void (pickerError.value = 'Choose a shared template image')
    // 按槽位顺序（不是压缩后的 index），属性第 N 行对应第 N 个槽
    const attributeLines = skuAttributes.value.split(/\r?\n/)
    const paired: WorkflowItem[] = []
    skuProductSlots.value.forEach((image, slot) => {
      if (!image) return
      const attr = String(attributeLines[slot] || '').trim()
      paired.push({
        prompt: [
          'Follow the template layout, composition, background, and lighting exactly; replace only the product subject.',
          `This is SKU ${slot + 1}.`,
          attr ? `SKU attributes: ${attr}.` : '',
          sharedPrompt.value.trim()
        ].filter(Boolean).join(' '),
        // 模板在前强化版式参考，商品图紧随其后用于主体替换
        sources: [skuTemplate.value!, image].slice(0, 4)
      })
    })
    if (!paired.length) return void (pickerError.value = 'Choose at least one SKU product image')
    items = paired
  }
  if (!items.length) return void (pickerError.value = 'There are no tasks to submit')
  emit('submit', commonSubmission(items))
}

function onLocalCropSubmit(payload: LocalCropSubmission): void {
  emit('submit', payload)
}

function onLocalCropBegin(payload: { prompt: string }): void {
  emit('begin', payload)
}

function onLocalCropBeginFailed(message: string): void {
  emit('begin-failed', message)
}
</script>

<template>
  <LocalCropPanel
    v-if="kind === 'crop'"
    :active="active"
    :providers="providers"
    :default-provider-id="defaultProviderId"
    :default-size="defaultSize"
    :default-quality="defaultQuality"
    :default-resolution="defaultResolution"
    :submitting="submitting"
    :draft="cropDraft"
    @begin="onLocalCropBegin"
    @begin-failed="onLocalCropBeginFailed"
    @submit="onLocalCropSubmit"
  />

  <!-- 同构 local-crop-panel：mid(flex1) 吸收高度 → 商品槽贴底 → composer 贴窗底 -->
  <div v-else-if="kind === 'replication'" class="replication-panel">
    <div class="replication-mid replication-layout">
      <!-- 对应 scene-hero：可滚动，吃掉多余高度 -->
      <div class="ref-scroll replication-ref-scroll">
        <div class="slot-block">
          <div class="section-title">
            <strong>Remake references</strong>
            <span>{{ replicationFilledCount }}/20 · Select multiple images; each becomes a local task</span>
          </div>
          <div class="ref-slots replication-ref-slots">
            <div
              v-for="(image, slot) in replicationRefSlots"
              :key="`ref-${slot}`"
              class="image-slot"
              role="button"
              tabindex="0"
              :aria-label="image ? `Replace remake reference ${slot + 1}` : `Add remake reference ${slot + 1}`"
              @click="chooseRefAt(slot)"
              @keydown.enter.prevent="chooseRefAt(slot)"
              @keydown.space.prevent="chooseRefAt(slot)"
            >
              <template v-if="image">
                <img :src="image.previewDataUrl" :alt="image.name" />
                <span class="slot-index">{{ slot + 1 }}</span>
                <span class="remove" role="button" aria-label="Remove" @click.stop="removeRefAt(slot)"><X :size="11" /></span>
                <button class="paste-action on-image" type="button" @click.stop="pasteRefAt(slot)">
                  <ClipboardPaste :size="11" />
                  Paste
                </button>
              </template>
              <template v-else>
                <Plus :size="16" />
                <span class="slot-label">{{ slot + 1 }}</span>
                <button class="paste-action compact" type="button" @click.stop="pasteRefAt(slot)">
                  <ClipboardPaste :size="11" />
                  Paste
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 对应 product-slots：flex:none，贴在 composer 正上方 -->
      <div class="slot-block product-block">
        <div class="section-title">
            <strong>Product references (optional)</strong>
            <span>Up to 3 images, combined with every remake reference</span>
        </div>
        <div class="product-slots">
          <div
            v-for="(image, slot) in replicationProductSlots"
            :key="`product-${slot}`"
            class="image-slot product"
            role="button"
            tabindex="0"
            :aria-label="image ? `Replace product reference ${slot + 1}` : `Add product reference ${slot + 1}`"
            @click="chooseProductAt(slot)"
            @keydown.enter.prevent="chooseProductAt(slot)"
            @keydown.space.prevent="chooseProductAt(slot)"
          >
            <template v-if="image">
              <img :src="image.previewDataUrl" :alt="image.name" />
              <span class="remove" role="button" aria-label="Remove" @click.stop="removeProductAt(slot)"><X :size="11" /></span>
              <button class="paste-action on-image" type="button" @click.stop="pasteProductAt(slot)">
                <ClipboardPaste :size="11" />
                Paste
              </button>
            </template>
            <template v-else>
              <Plus :size="16" />
              <span class="slot-label">Product</span>
              <button class="paste-action compact" type="button" @click.stop="pasteProductAt(slot)">
                <ClipboardPaste :size="11" />
                Paste
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 与局部重绘 / 快捷生成同一套 composer class -->
    <section class="composer-shell docked primary-composer batch-composer">
      <div class="composer-card mode-composer-surface">
        <div class="prompt-area">
          <textarea
            ref="promptRef"
            v-model="sharedPrompt"
            rows="2"
            maxlength="2000"
            placeholder="Shared direction: preserve composition and lighting, replace the product, and remove original text…"
            @keydown.meta.enter="submitWorkflow"
            @keydown.ctrl.enter="submitWorkflow"
          />
        </div>

        <div class="composer-bottom">
          <button class="icon-round" type="button" title="Add remake reference" @click="addRefsFromComposer">
            <Plus :size="16" />
          </button>

          <div class="composer-params">
            <div class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'provider' }]" type="button" aria-label="Generation provider" @click="togglePopover('provider')">
                {{ selectedProviderLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'provider'" class="menu-pop param-menu scrollable" role="menu">
                  <span class="menu-title">Provider</span>
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

            <div class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'size' }]" type="button" aria-label="Aspect ratio" @click="togglePopover('size')">
                {{ selectedSizeLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'size'" class="menu-pop param-menu scrollable" role="menu">
                  <span class="menu-title">Aspect ratio</span>
                  <button
                    v-for="item in activeProvider?.sizeOptions || []"
                    :key="item.value"
                    class="menu-option"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="item.value === size"
                    @click="pickOption(() => { size = item.value })"
                  >
                    <span class="menu-option-label">{{ item.label }}</span>
                    <span class="menu-option-hint">{{ item.value }}</span>
                    <Check v-if="item.value === size" :size="14" class="menu-check" />
                  </button>
                </div>
              </Transition>
            </div>

            <div v-if="currentQualityOptions.length > 1" class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'quality' }]" type="button" aria-label="Quality" @click="togglePopover('quality')">
                {{ selectedQualityLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'quality'" class="menu-pop param-menu" role="menu">
                  <span class="menu-title">Quality</span>
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

            <div v-if="currentResolutionOptions.length > 1" class="pop-wrap">
              <button
                :class="['param-btn', { open: openPopover === 'resolution', ultra: isMaxResolution }]"
                type="button"
                aria-label="Resolution"
                @click="togglePopover('resolution')"
              >
                {{ resolutionLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'resolution'" class="menu-pop slider-pop">
                  <div class="resolution-heading">
                    <span>Resolution</span>
                    <strong :class="{ ultra: isMaxResolution }">{{ resolutionLabel }}</strong>
                    <button
                      class="resolution-help"
                      type="button"
                      title="Higher resolution produces finer detail and may take longer"
                      aria-label="Resolution details"
                    >
                      <HelpCircle :size="14" />
                    </button>
                  </div>
                  <div class="slider-labels"><span>Faster</span><span>Sharper</span></div>
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
                      aria-label="Resolution level"
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

          <button
            :class="['voice-btn', { listening: isVoiceListening, recognizing: isVoiceRecognizing }]"
            type="button"
            :disabled="submitting"
            :aria-label="isVoiceListening ? 'Stop voice input' : 'Voice input'"
            :title="isVoiceListening ? 'Stop and transcribe' : 'Dictate a prompt'"
            @click="toggleVoiceInput"
          >
            <LoaderCircle v-if="isVoiceRecognizing" :size="15" class="spin" />
            <Square v-else-if="isVoiceListening" :size="11" fill="currentColor" />
            <Mic v-else :size="16" />
            <span v-if="isVoiceListening" class="voice-pulse" aria-hidden="true" />
          </button>

          <button
            class="send-btn"
            type="button"
            :disabled="!canSubmitReplication"
            :aria-label="canSubmitReplication ? `Create ${selectionCount} tasks` : 'Add a remake reference first'"
            @click="submitWorkflow"
          >
            <LoaderCircle v-if="submitting" :size="16" class="spin" />
            <ArrowUp v-else :size="17" />
          </button>
        </div>
      </div>

      <div class="composer-tray">
        <div class="composer-tray-left">
          <span v-if="pickerError" class="rep-error">{{ pickerError }}</span>
          <span v-else-if="voiceStatus" class="voice-status" role="status" aria-live="polite">{{ voiceStatus }}</span>
          <span v-else-if="selectionCount > 0">{{ selectionCount }} local requests · provider billed separately</span>
          <span v-else>Add a reference image to queue local tasks</span>
        </div>
        <span>⌘ ↵ Create</span>
      </div>
    </section>
  </div>

  <!-- 批量 SKU：同构批量复刻 / 局部重绘 -->
  <div v-else-if="kind === 'batchSku'" class="replication-panel">
    <div class="replication-mid sku-layout">
      <div class="sku-workspace">
        <div class="slot-block sku-products-block">
          <div class="section-title">
            <strong>SKU product images</strong>
            <span>{{ skuFilledCount }}/20 · Select multiple</span>
          </div>
          <div class="ref-slots sku-ref-slots">
            <div
              v-for="(image, slot) in skuProductSlots"
              :key="`sku-${slot}`"
              class="image-slot"
              role="button"
              tabindex="0"
              :aria-label="image ? `Replace SKU product image ${slot + 1}` : `Add SKU product image ${slot + 1}`"
              @click="chooseSkuAt(slot)"
              @keydown.enter.prevent="chooseSkuAt(slot)"
              @keydown.space.prevent="chooseSkuAt(slot)"
            >
              <template v-if="image">
                <img :src="image.previewDataUrl" :alt="image.name" />
                <span class="slot-index">{{ slot + 1 }}</span>
                <span class="remove" role="button" aria-label="Remove" @click.stop="removeSkuAt(slot)"><X :size="11" /></span>
                <button class="paste-action on-image" type="button" @click.stop="pasteSkuAt(slot)">
                  <ClipboardPaste :size="11" />
                  Paste
                </button>
              </template>
              <template v-else>
                <Plus :size="16" />
                <span class="slot-label">{{ slot + 1 }}</span>
                <button class="paste-action compact" type="button" @click.stop="pasteSkuAt(slot)">
                  <ClipboardPaste :size="11" />
                  Paste
                </button>
              </template>
            </div>
          </div>
        </div>

        <div class="slot-block product-block sku-template-block">
          <div class="section-title">
            <strong>Shared template</strong>
            <span>Layout, background, and lighting reference</span>
          </div>
          <div
            class="image-slot product template-slot"
            role="button"
            tabindex="0"
            :aria-label="skuTemplate ? 'Replace shared template' : 'Choose shared template'"
            @click="chooseSkuTemplate"
            @keydown.enter.prevent="chooseSkuTemplate"
            @keydown.space.prevent="chooseSkuTemplate"
          >
            <template v-if="skuTemplate">
              <img :src="skuTemplate.previewDataUrl" :alt="skuTemplate.name" />
              <span class="remove" role="button" aria-label="Remove" @click.stop="removeSkuTemplate"><X :size="11" /></span>
              <button class="paste-action on-image" type="button" @click.stop="pasteSkuTemplate">
                <ClipboardPaste :size="11" />
                Paste
              </button>
            </template>
            <template v-else>
              <Plus :size="22" />
              <span class="slot-label">Template</span>
              <button class="paste-action compact" type="button" @click.stop="pasteSkuTemplate">
                <ClipboardPaste :size="11" />
                Paste
              </button>
            </template>
          </div>
          <label class="sku-attr-field">
            <span>SKU attributes (one line per product image)</span>
            <textarea
              v-model="skuAttributes"
              rows="3"
              placeholder="50 ml / Repair&#10;100 ml / Rich&#10;Limited gift set / Champagne gold"
            />
          </label>
        </div>
      </div>
    </div>

    <section class="composer-shell docked primary-composer batch-composer">
      <div class="composer-card mode-composer-surface">
        <div class="prompt-area">
          <textarea
            ref="promptRef"
            v-model="sharedPrompt"
            rows="2"
            maxlength="2000"
            placeholder="Shared direction: follow the template layout, replace the product, and preserve lighting and background…"
            @keydown.meta.enter="submitWorkflow"
            @keydown.ctrl.enter="submitWorkflow"
          />
        </div>

        <div class="composer-bottom">
          <button class="icon-round" type="button" title="Add SKU product image" @click="addSkuFromComposer">
            <Plus :size="16" />
          </button>

          <div class="composer-params">
            <div class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'provider' }]" type="button" aria-label="Generation provider" @click="togglePopover('provider')">
                {{ selectedProviderLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'provider'" class="menu-pop param-menu scrollable" role="menu">
                  <span class="menu-title">Provider</span>
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

            <div class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'size' }]" type="button" aria-label="Aspect ratio" @click="togglePopover('size')">
                {{ selectedSizeLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'size'" class="menu-pop param-menu scrollable" role="menu">
                  <span class="menu-title">Aspect ratio</span>
                  <button
                    v-for="item in activeProvider?.sizeOptions || []"
                    :key="item.value"
                    class="menu-option"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="item.value === size"
                    @click="pickOption(() => { size = item.value })"
                  >
                    <span class="menu-option-label">{{ item.label }}</span>
                    <span class="menu-option-hint">{{ item.value }}</span>
                    <Check v-if="item.value === size" :size="14" class="menu-check" />
                  </button>
                </div>
              </Transition>
            </div>

            <div v-if="currentQualityOptions.length > 1" class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'quality' }]" type="button" aria-label="Quality" @click="togglePopover('quality')">
                {{ selectedQualityLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'quality'" class="menu-pop param-menu" role="menu">
                  <span class="menu-title">Quality</span>
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

            <div v-if="currentResolutionOptions.length > 1" class="pop-wrap">
              <button
                :class="['param-btn', { open: openPopover === 'resolution', ultra: isMaxResolution }]"
                type="button"
                aria-label="Resolution"
                @click="togglePopover('resolution')"
              >
                {{ resolutionLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'resolution'" class="menu-pop slider-pop">
                  <div class="resolution-heading">
                    <span>Resolution</span>
                    <strong :class="{ ultra: isMaxResolution }">{{ resolutionLabel }}</strong>
                    <button
                      class="resolution-help"
                      type="button"
                      title="Higher resolution produces finer detail and may take longer"
                      aria-label="Resolution details"
                    >
                      <HelpCircle :size="14" />
                    </button>
                  </div>
                  <div class="slider-labels"><span>Faster</span><span>Sharper</span></div>
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
                      aria-label="Resolution level"
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

          <button
            :class="['voice-btn', { listening: isVoiceListening, recognizing: isVoiceRecognizing }]"
            type="button"
            :disabled="submitting"
            :aria-label="isVoiceListening ? 'Stop voice input' : 'Voice input'"
            :title="isVoiceListening ? 'Stop and transcribe' : 'Dictate a prompt'"
            @click="toggleVoiceInput"
          >
            <LoaderCircle v-if="isVoiceRecognizing" :size="15" class="spin" />
            <Square v-else-if="isVoiceListening" :size="11" fill="currentColor" />
            <Mic v-else :size="16" />
            <span v-if="isVoiceListening" class="voice-pulse" aria-hidden="true" />
          </button>

          <button
            class="send-btn"
            type="button"
            :disabled="!canSubmitBatchSku"
            :aria-label="canSubmitBatchSku ? `Create ${selectionCount} tasks` : 'Choose SKU product images and a template'"
            @click="submitWorkflow"
          >
            <LoaderCircle v-if="submitting" :size="16" class="spin" />
            <ArrowUp v-else :size="17" />
          </button>
        </div>
      </div>

      <div class="composer-tray">
        <div class="composer-tray-left">
          <span v-if="pickerError" class="rep-error">{{ pickerError }}</span>
          <span v-else-if="voiceStatus" class="voice-status" role="status" aria-live="polite">{{ voiceStatus }}</span>
          <span v-else-if="selectionCount > 0 && skuTemplate">{{ selectionCount }} local requests · provider billed separately</span>
          <span v-else-if="selectionCount > 0">{{ selectionCount }} SKU selected · add a template</span>
          <span v-else>Add SKU product images and a template to queue tasks</span>
        </div>
        <span>⌘ ↵ Create</span>
      </div>
    </section>
  </div>

  <!-- 一键详情 4.0：主图+3 风格，不做 20 槽；底部同款 composer -->
  <div v-else-if="kind === 'detailV4'" class="replication-panel detail-panel">
    <div class="replication-mid">
      <div :class="['ref-scroll', 'detail-ref-scroll', { 'has-plans': plans.length > 0 }]">
        <div class="slot-block detail-hero-block">
          <div class="section-title">
            <strong>Product &amp; style</strong>
            <span>Hero 16:9 · Style 1:1 × 3</span>
          </div>
          <div class="detail-asset-row">
            <div
              class="image-slot detail-main"
              role="button"
              tabindex="0"
              :aria-label="detailProduct ? 'Replace hero product image' : 'Choose hero product image'"
              @click="chooseDetailProduct"
              @keydown.enter.prevent="chooseDetailProduct"
              @keydown.space.prevent="chooseDetailProduct"
            >
              <template v-if="detailProduct">
                <img :src="detailProduct.previewDataUrl" :alt="detailProduct.name" />
                <span class="remove" role="button" aria-label="Remove" @click.stop="removeDetailProduct"><X :size="11" /></span>
                <button class="paste-action on-image" type="button" @click.stop="pasteDetailProduct">
                  <ClipboardPaste :size="11" />
                  Paste
                </button>
              </template>
              <template v-else>
                <ImagePlus :size="22" />
                <span class="slot-label">Hero product</span>
                <span class="slot-hint">16:9</span>
                <button class="paste-action compact" type="button" @click.stop="pasteDetailProduct">
                  <ClipboardPaste :size="11" />
                  Paste
                </button>
              </template>
            </div>
            <div class="detail-style-group">
              <div
                v-for="(image, slot) in detailStyleSlots"
                :key="`style-${slot}`"
                class="image-slot detail-style"
                role="button"
                tabindex="0"
                :aria-label="image ? `Replace style reference ${slot + 1}` : `Add style reference ${slot + 1}`"
                @click="chooseDetailStyleAt(slot)"
                @keydown.enter.prevent="chooseDetailStyleAt(slot)"
                @keydown.space.prevent="chooseDetailStyleAt(slot)"
              >
                <template v-if="image">
                  <img :src="image.previewDataUrl" :alt="image.name" />
                  <span class="remove" role="button" aria-label="Remove" @click.stop="removeDetailStyleAt(slot)"><X :size="11" /></span>
                  <button class="paste-action on-image" type="button" @click.stop="pasteDetailStyleAt(slot)">
                    <ClipboardPaste :size="11" />
                    Paste
                  </button>
                </template>
                <template v-else>
                  <Plus :size="16" />
                  <span class="slot-label">Style</span>
                  <button class="paste-action compact" type="button" @click.stop="pasteDetailStyleAt(slot)">
                    <ClipboardPaste :size="11" />
                    Paste
                  </button>
                </template>
              </div>
            </div>
          </div>

          <div class="detail-fields">
            <label class="name-field">
              <span>Product name</span>
              <input v-model="productName" type="text" maxlength="80" placeholder="e.g. Renewal Repair Serum" />
            </label>
            <label class="points-field">
              <div class="field-label-row">
                <span>Key selling points</span>
                <button
                  class="optimize-btn"
                  type="button"
                  :disabled="optimizingPoints"
                  title="Polish selling points locally with the configured provider"
                  @click="optimizeSellingPoints"
                >
                  <LoaderCircle v-if="optimizingPoints" :size="13" class="spin" />
                  <WandSparkles v-else :size="13" />
                  {{ optimizingPoints ? 'Polishing…' : 'Polish copy' }}
                </button>
              </div>
              <textarea
                v-model="sellingPoints"
                rows="5"
                maxlength="400"
                placeholder="Benefits, ingredients, texture, audience, usage scene… be specific for sharper plans"
              />
            </label>
          </div>

          <div class="detail-actions">
            <button class="plan-button" type="button" @click="buildDetailPlans">
              <Sparkles :size="15" />
              Generate 8 scene plans
            </button>
          </div>
          <p v-if="pickerError && !plans.length" class="workflow-error">{{ pickerError }}</p>
        </div>

        <div v-if="plans.length" class="slot-block plan-block">
          <div class="section-title">
            <strong>Scene plans</strong>
            <span>{{ detailEnabledCount }}/{{ plans.length }} enabled · edit copy or disable</span>
          </div>
          <div class="plan-list">
            <article
              v-for="(plan, index) in plans"
              :key="plan.title"
              :class="['plan-item', { disabled: !plan.enabled }]"
            >
              <button type="button" class="plan-check" :aria-label="plan.enabled ? 'Disable plan' : 'Enable plan'" @click="plan.enabled = !plan.enabled">
                <Check v-if="plan.enabled" :size="13" />
              </button>
              <div>
                <strong>{{ index + 1 }}. {{ plan.title }}</strong>
                <textarea v-model="plan.prompt" rows="2" maxlength="2000" />
              </div>
            </article>
          </div>
        </div>
      </div>
    </div>

    <section class="composer-shell docked primary-composer detail-composer batch-composer">
      <div class="composer-card mode-composer-surface">
        <div class="prompt-area">
          <textarea
            ref="promptRef"
            v-model="detailExtra"
            rows="2"
            maxlength="500"
            placeholder="Optional direction appended to every plan"
            @keydown.meta.enter="submitWorkflow"
            @keydown.ctrl.enter="submitWorkflow"
          />
        </div>

        <div class="composer-bottom">
          <button class="icon-round" type="button" title="Regenerate scene plans" :disabled="!detailProduct" @click="buildDetailPlans">
            <Sparkles :size="16" />
          </button>

          <div class="composer-params">
            <div class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'provider' }]" type="button" aria-label="Generation provider" @click="togglePopover('provider')">
                {{ selectedProviderLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'provider'" class="menu-pop param-menu scrollable" role="menu">
                  <span class="menu-title">Provider</span>
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

            <div class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'size' }]" type="button" aria-label="Aspect ratio" @click="togglePopover('size')">
                {{ selectedSizeLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'size'" class="menu-pop param-menu scrollable" role="menu">
                  <span class="menu-title">Aspect ratio</span>
                  <button
                    v-for="item in activeProvider?.sizeOptions || []"
                    :key="item.value"
                    class="menu-option"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="item.value === size"
                    @click="pickOption(() => { size = item.value })"
                  >
                    <span class="menu-option-label">{{ item.label }}</span>
                    <span class="menu-option-hint">{{ item.value }}</span>
                    <Check v-if="item.value === size" :size="14" class="menu-check" />
                  </button>
                </div>
              </Transition>
            </div>

            <div v-if="currentQualityOptions.length > 1" class="pop-wrap">
              <button :class="['param-btn', { open: openPopover === 'quality' }]" type="button" aria-label="Quality" @click="togglePopover('quality')">
                {{ selectedQualityLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'quality'" class="menu-pop param-menu" role="menu">
                  <span class="menu-title">Quality</span>
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

            <div v-if="currentResolutionOptions.length > 1" class="pop-wrap">
              <button
                :class="['param-btn', { open: openPopover === 'resolution', ultra: isMaxResolution }]"
                type="button"
                aria-label="Resolution"
                @click="togglePopover('resolution')"
              >
                {{ resolutionLabel }}
                <ChevronDown :size="12" />
              </button>
              <Transition name="pop">
                <div v-if="openPopover === 'resolution'" class="menu-pop slider-pop">
                  <div class="resolution-heading">
                    <span>Resolution</span>
                    <strong :class="{ ultra: isMaxResolution }">{{ resolutionLabel }}</strong>
                    <button class="resolution-help" type="button" title="Higher resolution produces finer detail and may take longer" aria-label="Resolution details">
                      <HelpCircle :size="14" />
                    </button>
                  </div>
                  <div class="slider-labels"><span>Faster</span><span>Sharper</span></div>
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
                      aria-label="Resolution level"
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

          <button
            :class="['voice-btn', { listening: isVoiceListening, recognizing: isVoiceRecognizing }]"
            type="button"
            :disabled="submitting"
            :aria-label="isVoiceListening ? 'Stop voice input' : 'Voice input'"
            :title="isVoiceListening ? 'Stop and transcribe' : 'Dictate additional direction'"
            @click="toggleVoiceInput"
          >
            <LoaderCircle v-if="isVoiceRecognizing" :size="15" class="spin" />
            <Square v-else-if="isVoiceListening" :size="11" fill="currentColor" />
            <Mic v-else :size="16" />
            <span v-if="isVoiceListening" class="voice-pulse" aria-hidden="true" />
          </button>

          <button
            class="send-btn"
            type="button"
            :disabled="!canSubmitDetail"
            :aria-label="canSubmitDetail ? `Create ${selectionCount} tasks` : 'Generate and enable a scene plan first'"
            @click="submitWorkflow"
          >
            <LoaderCircle v-if="submitting" :size="16" class="spin" />
            <ArrowUp v-else :size="17" />
          </button>
        </div>
      </div>

      <div class="composer-tray">
        <div class="composer-tray-left">
          <span v-if="pickerError" class="rep-error">{{ pickerError }}</span>
          <span v-else-if="voiceStatus" class="voice-status" role="status" aria-live="polite">{{ voiceStatus }}</span>
          <span v-else-if="selectionCount > 0">{{ selectionCount }} local requests · provider billed separately</span>
          <span v-else-if="!detailProduct">Upload a hero product image, then generate scene plans</span>
          <span v-else-if="!plans.length">Generate 8 scene plans to create a batch</span>
          <span v-else>Enable at least one scene plan</span>
        </div>
        <span>⌘ ↵ Create</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 其它工作流沿用旧样式 */
.workflow-studio {
  max-width: 940px;
  width: 100%;
  margin: 0 auto;
  padding: 6px 0 70px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.workflow-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.workflow-head h1 {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 550;
}
.workflow-head p {
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 13px;
}
.workflow-count {
  flex: none;
  padding: 5px 9px;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 11.5px;
}
.workflow-section {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.section-title strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 550;
}
.section-title span {
  color: var(--text-muted);
  font-size: 12px;
}
.asset-row,
.asset-grid {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}
.asset-tile,
.template-tile {
  position: relative;
  width: 82px;
  height: 82px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 11px;
}
.asset-tile.primary {
  width: 100px;
  height: 100px;
}
.asset-tile img,
.template-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.asset-tile.add:hover,
.template-tile:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.remove {
  position: absolute;
  right: 4px;
  top: 4px;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: rgba(20, 20, 20, 0.72);
  color: #fff;
  display: grid;
  place-items: center;
}
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
}
.field-grid label,
.wide-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-grid label span,
.wide-field span {
  font-size: 11.5px;
  color: var(--text-muted);
}
.workflow-studio input,
.workflow-studio textarea,
.workflow-studio select {
  border: 1px solid var(--line);
  background: var(--bg);
  border-radius: 8px;
  outline: none;
  color: var(--text);
}
.workflow-studio input {
  height: 36px;
  padding: 0 10px;
  font-size: 13px;
}
.workflow-studio textarea {
  resize: vertical;
  padding: 9px 10px;
  line-height: 1.55;
  font-size: 12.5px;
}
.plan-button {
  align-self: flex-start;
  height: 34px;
  padding: 0 13px;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
}
.plan-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.plan-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 9px;
  background: var(--bg);
}
.plan-item.disabled {
  opacity: 0.48;
}
.plan-check {
  width: 18px;
  height: 18px;
  flex: none;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: var(--surface);
}
.plan-item:not(.disabled) .plan-check {
  background: var(--text);
  color: var(--surface);
}
.plan-item > div {
  flex: 1;
  min-width: 0;
}
.plan-item strong {
  font-size: 11.5px;
  font-weight: 550;
}
.plan-item textarea {
  width: 100%;
  margin-top: 6px;
  background: transparent;
}
.split-assets {
  display: grid;
  grid-template-columns: 1fr 180px;
  gap: 20px;
}
.split-assets > div {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.template-tile {
  width: 100%;
  height: 150px;
}
.workflow-error {
  color: var(--danger);
  font-size: 12px;
}
.workflow-footer {
  position: sticky;
  bottom: 12px;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  box-shadow: var(--shadow-pop);
  backdrop-filter: blur(14px);
}
.workflow-settings {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.workflow-settings select {
  height: 31px;
  max-width: 135px;
  padding: 0 8px;
  font-size: 11.5px;
}
.submit-workflow {
  height: 34px;
  flex: none;
  padding: 0 13px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
}
.submit-workflow:disabled {
  opacity: 0.42;
  cursor: default;
}

/* ===== 批量复刻：同构 local-crop-panel ===== */
.replication-panel {
  /*
   * 批量三页（复刻 / SKU / 整套详情）共用同一套间距，翻页时块间距不该忽大忽小。
   * 任何页面要调间距都改这里，不要再往具体块上加 margin。
   */
  --batch-gap-block: 12px;
  --batch-gap-inner: 8px;
  --batch-gap-slot: 8px;
  --batch-radius-slot: 12px;
  --batch-radius-card: 16px;

  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--batch-gap-block);
  overflow: hidden;
  -webkit-app-region: no-drag;
}
/* 对应 .crop-mid */
.replication-mid {
  flex: 1;
  min-height: 0;
  width: min(680px, 100%);
  max-width: 680px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--batch-gap-block);
  overflow: hidden;
  box-sizing: border-box;
}
/* 对应 .scene-hero：吃掉多余高度，内部可滚 */
.ref-scroll {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.replication-ref-scroll {
  flex: none;
  overflow: hidden;
}
/*
 * 原本这里用 grid 空行（1fr）分摊剩余高度，块间距会随窗口高度浮动，
 * 和另外两页对不上。改成和 .sku-layout 一样的顶对齐 flex，间距只由 gap 决定。
 */
.replication-layout {
  justify-content: flex-start;
}
.ref-slots.replication-ref-slots {
  grid-template-columns: repeat(10, minmax(0, 1fr));
}
.ref-slots.replication-ref-slots .image-slot {
  min-height: 0;
}
.slot-block {
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--batch-gap-inner);
  flex: none;
  box-sizing: border-box;
}
.product-block {
  flex: none;
}
.sku-layout {
  justify-content: flex-start;
}
.sku-workspace {
  width: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(244px, 0.78fr) minmax(0, 1.22fr);
  align-items: stretch;
  gap: var(--batch-gap-block);
}
.sku-products-block,
.sku-template-block {
  min-width: 0;
}
.sku-template-block {
  height: 100%;
}
.ref-slots.sku-ref-slots {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.ref-slots.sku-ref-slots .image-slot {
  min-height: 0;
}
.sku-template-block .image-slot.template-slot {
  width: 100%;
  max-width: none;
  height: 176px;
  aspect-ratio: auto;
  border-radius: var(--batch-radius-card);
}
.sku-attr-field {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--batch-gap-inner);
}
.sku-attr-field > span {
  font-size: 11.5px;
  color: var(--text-muted);
}
.sku-attr-field textarea {
  flex: 1;
  width: 100%;
  min-height: 64px;
  max-height: none;
  resize: none;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  padding: 9px 10px;
  font-size: 12.5px;
  line-height: 1.5;
  outline: none;
}
.sku-attr-field textarea:focus {
  border-color: rgba(217, 119, 87, 0.55);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 高窗口只放大间距变量，三页同步长开，不再各页写各页的放大比例。 */
@media (min-height: 900px) {
  .replication-panel {
    --batch-gap-block: clamp(18px, 2vh, 26px);
    --batch-gap-inner: clamp(10px, 1.2vh, 14px);
    height: auto;
  }
  .replication-mid {
    flex: none;
  }
  .detail-ref-scroll:not(.has-plans) {
    flex: none;
  }
  .detail-ref-scroll.has-plans {
    max-height: 430px;
  }
}

/* ===== 一键详情：对齐快捷生成的圆角/表面/输入语言 ===== */
.detail-asset-row {
  --detail-slot-h: 88px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--batch-gap-block);
  flex-wrap: nowrap;
}
.image-slot.detail-main {
  flex: 1 1 auto;
  width: auto;
  min-width: 200px;
  max-width: none;
  height: var(--detail-slot-h);
  aspect-ratio: 16 / 9;
  border-radius: var(--batch-radius-card);
  border: 1px dashed var(--line-strong);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}
.detail-style-group {
  display: flex;
  align-items: center;
  gap: var(--batch-gap-inner);
  flex: none;
}
.image-slot.detail-style {
  width: var(--detail-slot-h);
  height: var(--detail-slot-h);
  aspect-ratio: 1;
  border-radius: var(--batch-radius-card);
  flex: none;
  border: 1px dashed var(--line-strong);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}
.detail-panel .image-slot .slot-hint {
  font-size: 10.5px;
  color: var(--text-muted);
  opacity: 0.85;
}
.detail-fields {
  display: flex;
  flex-direction: column;
  gap: var(--batch-gap-inner);
}
.detail-fields label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.detail-fields .field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--batch-gap-inner);
}
.detail-fields label span,
.detail-fields .field-label-row > span {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
}
.detail-fields .name-field input {
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text);
  font-size: 14px;
  outline: none;
  box-shadow: var(--shadow-card);
}
.detail-fields .points-field textarea {
  width: 100%;
  min-height: 84px;
  max-height: 140px;
  resize: vertical;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  font-size: 14.5px;
  line-height: 1.6;
  outline: none;
  box-shadow: var(--shadow-card);
}
.detail-fields .name-field input:focus,
.detail-fields .points-field textarea:focus {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-card);
}
.optimize-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid var(--line-strong);
  background: var(--bg-raised);
  color: var(--text-soft);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.optimize-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line-strong));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-raised));
}
.optimize-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--batch-gap-inner);
}
/* 三个批量工具直接复用局部重绘的 primary-composer，不再维护近似副本。 */
.detail-panel .plan-button {
  align-self: flex-start;
  height: 36px;
  padding: 0 16px;
  border-radius: 12px;
  background: var(--text);
  color: var(--bg);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 500;
}
.detail-panel .plan-button:hover {
  opacity: 0.92;
}
.detail-panel .plan-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--batch-gap-inner);
}
.detail-panel .plan-item {
  display: flex;
  align-items: flex-start;
  gap: var(--batch-gap-inner);
  border: 1px solid var(--line);
  border-radius: var(--batch-radius-card);
  padding: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
}
.detail-panel .plan-item.disabled {
  opacity: 0.48;
}
.detail-panel .plan-check {
  width: 20px;
  height: 20px;
  flex: none;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--bg);
  margin-top: 1px;
}
.detail-panel .plan-item:not(.disabled) .plan-check {
  background: var(--text);
  color: var(--surface);
  border-color: var(--text);
}
.detail-panel .plan-item > div {
  flex: 1;
  min-width: 0;
}
.detail-panel .plan-item strong {
  font-size: 12px;
  font-weight: 550;
}
.detail-panel .plan-item textarea {
  width: 100%;
  margin-top: 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.detail-panel .plan-item textarea:focus {
  border-color: rgba(217, 119, 87, 0.55);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.detail-ref-scroll {
  overflow: hidden;
}
.detail-ref-scroll.has-plans {
  overflow: auto;
}
/* 窄窗口：间距整体收一档，三页共用同一个断点 */
@media (max-width: 780px) {
  .replication-panel {
    --batch-gap-block: 10px;
    --batch-gap-inner: 6px;
    --batch-gap-slot: 6px;
  }
  .sku-workspace {
    grid-template-columns: minmax(220px, 0.86fr) minmax(0, 1.14fr);
  }
  .sku-template-block .image-slot.template-slot {
    height: 156px;
  }
  .detail-panel .plan-list {
    grid-template-columns: 1fr;
  }
  .detail-asset-row {
    flex-wrap: wrap;
  }
  .image-slot.detail-main {
    max-width: none;
    width: 100%;
    height: auto;
    min-height: 96px;
  }
  .detail-style-group {
    width: 100%;
    justify-content: flex-start;
  }
  .detail-style-group .image-slot.detail-style {
    width: 88px;
    height: 88px;
  }
}
.ref-slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: var(--batch-gap-slot);
}
/* 与局部重绘 .product-slots 一致 */
.product-slots {
  flex: none;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--batch-gap-slot);
}
.image-slot {
  position: relative;
  aspect-ratio: 1;
  min-height: 72px;
  border-radius: var(--batch-radius-slot);
  border: 1px dashed var(--line-strong);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--text-muted);
  font-size: 11.5px;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
}
.image-slot.product {
  aspect-ratio: auto;
  height: 78px;
  border-radius: var(--batch-radius-slot);
}
.image-slot:hover {
  border-color: color-mix(in srgb, var(--text-muted) 40%, var(--line-strong));
  color: var(--text-soft);
}
.image-slot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.image-slot .slot-label {
  font-size: 11.5px;
  line-height: 1.2;
}
.image-slot .slot-index {
  position: absolute;
  left: 6px;
  top: 6px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 6px;
  background: rgba(20, 20, 20, 0.72);
  color: #fff;
  font-size: 10px;
  display: grid;
  place-items: center;
  z-index: 1;
}
.image-slot .remove {
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
  transition: background 0.16s ease, color 0.16s ease, opacity 0.16s ease;
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
.image-slot:hover .paste-action.compact,
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

/* 与 LocalCropPanel 中 .composer-shell.docked 一字不差 */
.composer-shell.docked {
  flex: none;
  width: min(680px, 100%);
  max-width: 680px;
  margin-top: 0;
  padding-top: 0;
  padding-bottom: 0;
  background: transparent;
}
.rep-error {
  color: var(--danger);
}
/* 防止 scoped 其它规则误伤 prompt；与全局 .prompt-area textarea 一致 */
.replication-panel .prompt-area textarea {
  width: 100%;
  min-height: 56px;
  max-height: 220px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--text);
  padding: 2px 4px;
  box-shadow: none;
}
.replication-panel .prompt-area textarea:focus {
  border: none;
  box-shadow: none;
}
.replication-panel .prompt-area textarea::placeholder {
  color: var(--text-muted);
}
.batch-composer .prompt-area textarea {
  height: 112px !important;
  min-height: 112px !important;
  max-height: 112px !important;
  overflow-y: auto;
  resize: none;
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 780px) {
  .field-grid,
  .plan-list,
  .split-assets {
    grid-template-columns: 1fr;
  }
}
</style>
