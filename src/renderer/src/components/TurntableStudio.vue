<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Clapperboard,
  Download,
  ImagePlus,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  X
} from 'lucide-vue-next'
import type { WorkflowSubmission } from './WorkflowStudio.vue'
import { TURNTABLE_ANGLES, buildTurntablePrompt, parseTurntableAngle, turntableAngleTitle } from '../turntableAngles'
import { exportTurntableWebm } from '../turntableExport'

type Option = { label: string; value: string; credits?: number | null }
type Provider = {
  id: number
  label: string
  model: string
  sizeOptions: Option[]
  qualityOptions: Option[]
  resolutionOptions: Option[]
  priceMatrix?: Record<string, Record<string, Record<string, number>>>
  referenceImageCredits?: number
}

type TurntableTaskSnapshot = {
  id: number
  prompt: string
  status: string
  createdAt: number
  resultImages: string[]
  savedFiles: Array<{ url: string; path: string }>
  toolScene?: string
}

const EXTRA_SLOT_COUNT = 2

const props = defineProps<{
  providers: Provider[]
  defaultProviderId: number
  defaultSize: string
  defaultQuality: string
  defaultResolution: string
  submitting: boolean
  tasks: TurntableTaskSnapshot[]
}>()

const emit = defineEmits<{
  submit: [payload: WorkflowSubmission]
  begin: [payload: { prompt: string }]
}>()

/**
 * C 端对外通常只有「通用线路」；布里塔是上游主机，不会出现在 name 里。
 * 测试期：优先选名里带布里塔/bulita 的；否则用默认/第一条可用线路。
 */
function isPreferredCheapProvider(item: Provider): boolean {
  return /布里塔|bulita|brita/i.test(String(item.label || ''))
}

const turntableProviders = computed(() => {
  const all = props.providers.filter((item) => Number(item.id) > 0 || String(item.label || '').trim())
  const preferred = all.filter(isPreferredCheapProvider)
  return preferred.length ? preferred : all
})

const providerId = ref(0)
const size = ref(props.defaultSize)
const quality = ref(props.defaultQuality)
const resolution = ref(props.defaultResolution)
const extraNotes = ref('')
const product = ref<DesktopSelectedImage | null>(null)
const extraSlots = ref<Array<DesktopSelectedImage | null>>(Array.from({ length: EXTRA_SLOT_COUNT }, () => null))
const pickerError = ref('')
const batchStartedAt = ref(0)
const previewIndex = ref(0)
const autoSpin = ref(false)
const exporting = ref(false)
const exportMessage = ref('')
const isDragging = ref(false)
const frameDataUrls = ref<Record<number, string>>({})
let spinTimer: number | null = null
const loadingFrameKeys = new Set<string>()
let dragOriginX = 0
let dragOriginIndex = 0
let draggingPreview = false
const DRAG_PX_PER_FRAME = 28

const activeProvider = computed(() =>
  turntableProviders.value.find((item) => item.id === providerId.value) || turntableProviders.value[0] || null
)
const filledExtras = computed(() => extraSlots.value.filter((item): item is DesktopSelectedImage => Boolean(item)))
const refCount = computed(() => Math.min(4, 1 + filledExtras.value.length))
const providerMissing = computed(() => turntableProviders.value.length === 0)
const providerLockedLabel = computed(() => activeProvider.value?.label || '未配置线路')

const unitCost = computed(() => {
  const provider = activeProvider.value
  if (!provider) return 0
  const matrixCost = Number(provider.priceMatrix?.[size.value]?.[resolution.value]?.[quality.value])
  const base = Number.isFinite(matrixCost) && matrixCost > 0
    ? matrixCost
    : Number(
        provider.resolutionOptions.find((item) => item.value === resolution.value)?.credits
        ?? provider.qualityOptions.find((item) => item.value === quality.value)?.credits
        ?? provider.sizeOptions.find((item) => item.value === size.value)?.credits
        ?? 49
      )
  const refs = refCount.value * Number(provider.referenceImageCredits || 0)
  return Math.max(0, base) + refs
})
const totalCost = computed(() => unitCost.value * TURNTABLE_ANGLES.length)
const canSubmit = computed(() => Boolean(product.value) && Boolean(activeProvider.value) && !props.submitting && !providerMissing.value)

function syncTurntableProvider(): void {
  const list = turntableProviders.value
  if (!list.length) {
    providerId.value = 0
    return
  }
  if (!list.some((item) => item.id === providerId.value)) {
    const preferred = list.find(isPreferredCheapProvider)
    const fallback = list.find((item) => item.id === props.defaultProviderId) || list[0]
    providerId.value = (preferred || fallback).id
  }
  const provider = list.find((item) => item.id === providerId.value) || list[0]
  if (!provider.sizeOptions.some((item) => item.value === size.value)) {
    size.value = provider.sizeOptions[0]?.value || size.value
  }
  if (!provider.qualityOptions.some((item) => item.value === quality.value)) {
    quality.value = provider.qualityOptions[0]?.value || quality.value
  }
  if (!provider.resolutionOptions.some((item) => item.value === resolution.value)) {
    resolution.value = provider.resolutionOptions[0]?.value || resolution.value
  }
}

watch(turntableProviders, () => syncTurntableProvider(), { immediate: true, deep: true })
watch(() => props.defaultProviderId, () => syncTurntableProvider())
watch(() => props.defaultSize, (value) => {
  if (!value) return
  size.value = value
  syncTurntableProvider()
})
watch(() => props.defaultQuality, (value) => {
  if (!value) return
  quality.value = value
  syncTurntableProvider()
})
watch(() => props.defaultResolution, (value) => {
  if (!value) return
  resolution.value = value
  syncTurntableProvider()
})

type AngleSlot = {
  angle: number
  status: 'empty' | 'queued' | 'running' | 'success' | 'failed'
  preview: string
  taskId?: number
  error?: string
}

const angleSlots = computed<AngleSlot[]>(() => {
  const since = batchStartedAt.value
  const candidates = props.tasks
    .filter((task) => task.toolScene === 'sellVideo' && (!since || task.createdAt >= since - 15_000))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)

  return TURNTABLE_ANGLES.map((angle) => {
    const task = [...candidates].reverse().find((item) => parseTurntableAngle(item.prompt) === angle)
    if (!task) {
      return {
        angle,
        status: since ? 'queued' : 'empty',
        preview: frameDataUrls.value[angle] || ''
      }
    }
    const preview = frameDataUrls.value[angle]
      || task.resultImages[0]
      || ''
    const status = task.status === 'success' || task.resultImages.length
      ? 'success'
      : task.status === 'failed'
        ? 'failed'
        : task.status === 'queued'
          ? 'queued'
          : 'running'
    return {
      angle,
      status,
      preview,
      taskId: task.id,
      error: status === 'failed' ? '生成失败' : undefined
    }
  })
})

const readyFrames = computed(() => angleSlots.value.filter((slot) => slot.status === 'success' && slot.preview))
const readyCount = computed(() => readyFrames.value.length)
const currentPreview = computed(() => angleSlots.value[previewIndex.value]?.preview || product.value?.previewDataUrl || '')
const canExport = computed(() => readyCount.value >= 2 && !exporting.value)

watch(angleSlots, (slots) => {
  for (const slot of slots) {
    if (slot.status !== 'success') continue
    void ensureFrameDataUrl(slot.angle)
  }
}, { deep: true })

watch([autoSpin, readyCount], () => {
  stopSpin()
  if (autoSpin.value && readyCount.value >= 2) startSpin()
})

onBeforeUnmount(() => stopSpin())

function startSpin(): void {
  stopSpin()
  spinTimer = window.setInterval(() => {
    if (!readyCount.value) return
    let next = previewIndex.value
    for (let step = 0; step < TURNTABLE_ANGLES.length; step += 1) {
      next = (next + 1) % TURNTABLE_ANGLES.length
      if (angleSlots.value[next]?.status === 'success') {
        previewIndex.value = next
        return
      }
    }
  }, 140)
}

function stopSpin(): void {
  if (spinTimer != null) {
    window.clearInterval(spinTimer)
    spinTimer = null
  }
}

async function ensureFrameDataUrl(angle: number): Promise<string> {
  if (frameDataUrls.value[angle]) return frameDataUrls.value[angle]
  const key = String(angle)
  if (loadingFrameKeys.has(key)) return ''
  const task = props.tasks
    .filter((item) => item.toolScene === 'sellVideo' && parseTurntableAngle(item.prompt) === angle)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!task) return ''
  loadingFrameKeys.add(key)
  try {
    const saved = task.savedFiles.find((file) => file.path)
    if (saved?.path && window.desktop?.importAuthorizedImage) {
      const imported = await window.desktop.importAuthorizedImage({ source: saved.path, name: `turntable-${angle}.png` })
      frameDataUrls.value = { ...frameDataUrls.value, [angle]: imported.previewDataUrl }
      return imported.previewDataUrl
    }
    const remote = task.resultImages[0]
    if (remote && window.desktop?.importAuthorizedImage) {
      const imported = await window.desktop.importAuthorizedImage({ source: remote, name: `turntable-${angle}.png` })
      frameDataUrls.value = { ...frameDataUrls.value, [angle]: imported.previewDataUrl }
      return imported.previewDataUrl
    }
    if (remote) {
      frameDataUrls.value = { ...frameDataUrls.value, [angle]: remote }
      return remote
    }
  } catch {
    // 预览失败不阻断；导出时再报错
  } finally {
    loadingFrameKeys.delete(key)
  }
  return frameDataUrls.value[angle] || ''
}

async function chooseProduct(): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: '选择商品主图' }) || []
    if (selected[0]) product.value = selected[0]
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : '选择图片失败'
  }
}

async function chooseExtraAt(slot: number): Promise<void> {
  pickerError.value = ''
  try {
    const selected = await window.desktop?.selectWorkflowImages({ limit: 1, title: '选择辅助参考图' }) || []
    if (!selected[0]) return
    const next = extraSlots.value.slice()
    next[slot] = selected[0]
    extraSlots.value = next
  } catch (error) {
    pickerError.value = error instanceof Error ? error.message : '选择图片失败'
  }
}

function clearProduct(): void {
  product.value = null
}

function clearExtraAt(slot: number): void {
  const next = extraSlots.value.slice()
  next[slot] = null
  extraSlots.value = next
}

function submitTurntable(): void {
  pickerError.value = ''
  exportMessage.value = ''
  syncTurntableProvider()
  if (providerMissing.value || !activeProvider.value) {
    pickerError.value = '当前没有可用生图线路，请先在后台开启'
    return
  }
  if (!product.value) {
    pickerError.value = '请先选择商品主图'
    return
  }
  const extras = filledExtras.value
  const sourcesBase = [product.value, ...extras].slice(0, 4)
  const items = TURNTABLE_ANGLES.map((angle) => ({
    prompt: buildTurntablePrompt(angle, extraNotes.value),
    sources: sourcesBase
  }))
  batchStartedAt.value = Date.now()
  previewIndex.value = 0
  frameDataUrls.value = {}
  emit('begin', { prompt: '一键带货转台生成中…' })
  emit('submit', {
    kind: 'sellVideo',
    items,
    providerId: activeProvider.value.id,
    model: activeProvider.value.model || '',
    size: size.value,
    quality: quality.value,
    resolution: resolution.value
  })
}

function selectAngle(index: number): void {
  previewIndex.value = index
  autoSpin.value = false
}

function onPreviewPointerDown(event: PointerEvent): void {
  if (readyCount.value < 2) return
  if (event.button !== 0) return
  draggingPreview = true
  isDragging.value = true
  autoSpin.value = false
  dragOriginX = event.clientX
  dragOriginIndex = previewIndex.value
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
}

function onPreviewPointerMove(event: PointerEvent): void {
  if (!draggingPreview || readyCount.value < 2) return
  const delta = event.clientX - dragOriginX
  const step = Math.trunc(delta / DRAG_PX_PER_FRAME)
  const next = ((dragOriginIndex - step) % TURNTABLE_ANGLES.length + TURNTABLE_ANGLES.length) % TURNTABLE_ANGLES.length
  if (angleSlots.value[next]?.status === 'success') {
    previewIndex.value = next
  } else {
    // 跳过未成功帧，找最近可用
    for (let offset = 0; offset < TURNTABLE_ANGLES.length; offset += 1) {
      const cand = ((next + offset) % TURNTABLE_ANGLES.length + TURNTABLE_ANGLES.length) % TURNTABLE_ANGLES.length
      if (angleSlots.value[cand]?.status === 'success') {
        previewIndex.value = cand
        break
      }
    }
  }
}

function onPreviewPointerUp(event: PointerEvent): void {
  if (!draggingPreview) return
  draggingPreview = false
  isDragging.value = false
  ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)
}

function resetSession(): void {
  batchStartedAt.value = 0
  frameDataUrls.value = {}
  previewIndex.value = 0
  exportMessage.value = ''
  autoSpin.value = false
  isDragging.value = false
}

async function exportVideo(): Promise<void> {
  exportMessage.value = ''
  exporting.value = true
  autoSpin.value = false
  try {
    const urls: string[] = []
    for (const angle of TURNTABLE_ANGLES) {
      const dataUrl = await ensureFrameDataUrl(angle)
      if (dataUrl) urls.push(dataUrl)
    }
    if (urls.length < 2) throw new Error('可用视角不足，请等待生成完成')
    const blob = await exportTurntableWebm({ frameDataUrls: urls, frameMs: 120, loops: 3 })
    const bytes = await blob.arrayBuffer()
    if (!window.desktop?.writeWorkspaceFile) throw new Error('当前环境无法写入工作区')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const saved = await window.desktop.writeWorkspaceFile({
      name: `turntable-${stamp}`,
      extension: '.webm',
      bytes
    })
    exportMessage.value = `已保存 ${saved.path}`
    void window.desktop.notify?.({ title: '转台视频已导出', body: saved.path })
  } catch (error) {
    exportMessage.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="turntable-panel">
    <div class="turntable-mid">
      <section class="hero-preview">
        <div
          class="preview-stage"
          :class="{ dragging: isDragging, ready: readyCount >= 2 }"
          @pointerdown="onPreviewPointerDown"
          @pointermove="onPreviewPointerMove"
          @pointerup="onPreviewPointerUp"
          @pointercancel="onPreviewPointerUp"
        >
          <img v-if="currentPreview" :src="currentPreview" alt="转台预览" draggable="false" />
          <div v-else class="preview-empty">
            <RotateCcw :size="28" />
            <p>上传商品主图并生成后，在这里左右拖动切换视角</p>
          </div>
          <div v-if="readyCount >= 2" class="preview-hint">← 按住左右拖动旋转 →</div>
          <div v-if="readyCount" class="preview-meta">
            {{ angleSlots[previewIndex]?.angle }}° · {{ readyCount }}/{{ TURNTABLE_ANGLES.length }}
          </div>
        </div>
        <div class="preview-actions">
          <button type="button" class="ghost-btn primary-action" :disabled="readyCount < 2" @click="autoSpin = !autoSpin">
            <component :is="autoSpin ? Pause : Play" :size="14" />
            {{ autoSpin ? '停止自动转' : '自动慢转' }}
          </button>
          <button
            v-if="batchStartedAt"
            type="button"
            class="ghost-btn"
            @click="resetSession"
          >
            <RotateCcw :size="14" />
            重置会话
          </button>
          <button type="button" class="ghost-btn quiet" :disabled="!canExport" @click="exportVideo">
            <LoaderCircle v-if="exporting" :size="14" class="spin" />
            <Download v-else :size="14" />
            {{ exporting ? '导出中…' : '可选：导出短视频' }}
          </button>
        </div>
        <p class="drag-tip">主交互是上面大图：按住拖动即可转；下面 8 张也能点选。短视频只是可选导出。</p>
        <p v-if="exportMessage" class="export-msg">{{ exportMessage }}</p>
      </section>

      <section class="angle-grid">
        <div class="section-title">
          <strong>8 个环绕视角</strong>
          <span>每帧强制不同相机方位；点选或大图拖动预览</span>
        </div>
        <div class="angles">
          <button
            v-for="(slot, index) in angleSlots"
            :key="slot.angle"
            type="button"
            class="angle-card"
            :class="[slot.status, { active: previewIndex === index }]"
            @click="selectAngle(index)"
          >
            <img v-if="slot.preview" :src="slot.preview" :alt="`${slot.angle}度`" />
            <span v-else class="angle-placeholder">{{ slot.angle }}°</span>
            <span class="angle-badge">{{ turntableAngleTitle(slot.angle) }}</span>
            <span v-if="slot.status === 'running' || slot.status === 'queued'" class="angle-state">生成中</span>
            <span v-else-if="slot.status === 'failed'" class="angle-state fail">失败</span>
          </button>
        </div>
      </section>

      <section class="source-block">
        <div class="section-title">
          <strong>商品主图</strong>
          <span>必填 · 建议白底单主体</span>
        </div>
        <div class="source-row">
          <div
            class="image-slot primary"
            role="button"
            tabindex="0"
            @click="chooseProduct"
            @keydown.enter.prevent="chooseProduct"
          >
            <template v-if="product">
              <img :src="product.previewDataUrl" :alt="product.name" />
              <span class="remove" @click.stop="clearProduct"><X :size="11" /></span>
            </template>
            <template v-else>
              <ImagePlus :size="18" />
              <span>主图</span>
            </template>
          </div>
          <div
            v-for="(image, slot) in extraSlots"
            :key="`extra-${slot}`"
            class="image-slot"
            role="button"
            tabindex="0"
            @click="chooseExtraAt(slot)"
            @keydown.enter.prevent="chooseExtraAt(slot)"
          >
            <template v-if="image">
              <img :src="image.previewDataUrl" :alt="image.name" />
              <span class="remove" @click.stop="clearExtraAt(slot)"><X :size="11" /></span>
            </template>
            <template v-else>
              <Plus :size="16" />
              <span>辅助 {{ slot + 1 }}</span>
            </template>
          </div>
        </div>
      </section>
    </div>

    <section class="composer-shell docked">
      <div class="composer-card">
        <textarea
          v-model="extraNotes"
          class="notes"
          rows="2"
          placeholder="可选补充要求，例如：保留瓶身银色泵头，背景纯白…"
        />
        <div class="composer-row">
          <label>
            线路
            <select v-model.number="providerId" disabled>
              <option v-for="item in turntableProviders" :key="item.id" :value="item.id">{{ item.label }}</option>
              <option v-if="providerMissing" :value="0">未配置线路</option>
            </select>
          </label>
          <label>
            比例
            <select v-model="size">
              <option v-for="item in activeProvider?.sizeOptions || []" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label>
            质量
            <select v-model="quality">
              <option v-for="item in activeProvider?.qualityOptions || []" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label>
            分辨率
            <select v-model="resolution">
              <option v-for="item in activeProvider?.resolutionOptions || []" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <button class="submit-btn" type="button" :disabled="!canSubmit" @click="submitTurntable">
            <LoaderCircle v-if="submitting" :size="16" class="spin" />
            <Clapperboard v-else :size="16" />
            {{ submitting ? '提交中…' : `生成 8 视角 · ${totalCost} 积分` }}
          </button>
        </div>
        <p v-if="providerMissing" class="error">当前没有可用生图线路，请先在后台开启。</p>
        <p v-if="pickerError" class="error">{{ pickerError }}</p>
        <p class="hint">测试期锁定线路「{{ providerLockedLabel }}」（C 端展示名；布里塔是上游）。单视角约 {{ unitCost }} 积分。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.turntable-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.turntable-mid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 22px 12px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.hero-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.preview-stage {
  position: relative;
  aspect-ratio: 1;
  max-height: min(42vh, 420px);
  margin: 0 auto;
  width: min(100%, 420px);
  border-radius: 22px;
  overflow: hidden;
  background: color-mix(in srgb, var(--bg-raised) 80%, #fff);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-card);
  cursor: default;
  touch-action: none;
  user-select: none;
}
.preview-stage.ready {
  cursor: grab;
}
.preview-stage.dragging {
  cursor: grabbing;
}
.preview-stage img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #f4f4f5;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}
.preview-hint {
  position: absolute;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}
.drag-tip {
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}
.ghost-btn.quiet {
  opacity: 0.72;
}
.ghost-btn.primary-action {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
}
.preview-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  padding: 24px;
  text-align: center;
}
.preview-meta {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
}
.preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.ghost-btn {
  height: 32px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text-soft);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  cursor: pointer;
}
.ghost-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.export-msg {
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}
.section-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.section-title strong {
  font-size: 14px;
}
.section-title span {
  font-size: 12px;
  color: var(--text-muted);
}
.angles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.angle-card {
  position: relative;
  aspect-ratio: 1;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: var(--surface);
  overflow: hidden;
  padding: 0;
  cursor: pointer;
}
.angle-card.active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.angle-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.angle-placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 13px;
}
.angle-badge {
  position: absolute;
  left: 6px;
  top: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.angle-state {
  position: absolute;
  right: 6px;
  bottom: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.85);
  color: #fff;
}
.angle-state.fail {
  background: rgba(185, 28, 28, 0.9);
}
.source-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.image-slot {
  width: 92px;
  height: 92px;
  border-radius: 16px;
  border: 1px dashed var(--line-strong);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: 11px;
  position: relative;
  overflow: hidden;
  cursor: pointer;
}
.image-slot.primary {
  width: 112px;
  height: 112px;
}
.image-slot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.image-slot .remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: grid;
  place-items: center;
}
.composer-shell {
  flex: none;
  padding: 0 18px 16px;
}
.composer-card {
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.notes {
  width: 100%;
  resize: vertical;
  min-height: 54px;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 10px 12px;
  background: var(--bg-raised);
  color: var(--text);
  font-size: 13.5px;
  outline: none;
}
.composer-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;
}
.composer-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.composer-row select {
  height: 34px;
  min-width: 96px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--text);
  padding: 0 8px;
}
.submit-btn {
  margin-left: auto;
  height: 38px;
  padding: 0 16px;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  font-size: 13.5px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  color: #b91c1c;
  font-size: 12px;
}
.hint {
  font-size: 11.5px;
  color: var(--text-muted);
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@media (max-width: 900px) {
  .angles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
