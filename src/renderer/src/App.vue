<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Component } from 'vue'
import {
  CLEANUP_MOVE,
  DURATION_CROSS,
  MotionBatch,
  crossFadeIn,
  flipMove,
  morphHeight,
  prefersReducedMotion,
  staggerIn,
  type MotionDirection
} from './viewMotion'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  ClipboardCopy,
  Clock3,
  Copy,
  Download,
  FolderOpen,
  Globe,
  HelpCircle,
  History,
  Image as ImageIcon,
  ImagePlus,
  Images,
  LayoutTemplate,
  Layers3,
  LoaderCircle,
  LogIn,
  LogOut,
  Mic,
  MoreHorizontal,
  Package,
  PanelLeft,
  PanelRight,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Settings,
  Square,
  Sparkles,
  Trash2,
  UploadCloud,
  Wallet,
  WandSparkles,
  Wrench,
  X
} from 'lucide-vue-next'
import { absoluteAssetUrl, api, ApiError, getStoredUser, getToken, setDevKeepSession, setStoredUser, setToken, type UsageOverview, type UserInfo } from './api'
import { toDataURL as qrCodeToDataURL } from 'qrcode'
import WorkflowStudio, { type WorkflowSubmission } from './components/WorkflowStudio.vue'
import TurntableStudio from './components/TurntableStudio.vue'
import ResolutionEnergyCanvas from './components/ResolutionEnergyCanvas.vue'
import PsdMaskEditor, { type PsdMaskDraft } from './components/PsdMaskEditor.vue'
import {
  DEFAULT_LOCAL_CROP_PROMPT,
  LOCAL_CROP_PRESERVE_GUARD,
  stripLocalCropGuard
} from './components/localCropShared'

type CreateMode = 'text' | 'image'
type NavMode = 'creation' | 'tools'
type BatchWorkflowView = 'replication' | 'batchSku' | 'detailV4'
type NavigationGroupId = 'imageEditing' | 'batchFeatures' | 'creationTools'
type NavigationTarget = ActiveView | 'folder'
type NavigationLeaf = { id: NavigationTarget; label: string; icon: Component }
type NavigationGroup = { id: NavigationGroupId; label: string; icon: Component; children: NavigationLeaf[] }
type NavigationEntry = NavigationLeaf | NavigationGroup
type TaskStatus = 'queued' | 'running' | 'success' | 'failed'
type TaskFilter = 'all' | 'running' | 'attention' | 'completed'
type ActiveView =
  | 'quick'
  | 'detail'
  | 'detailV4'
  | 'customBatch'
  | 'replication'
  | 'batchSku'
  | 'crop'
  | 'psd'
  | 'sellVideo'
  | 'inspiration'
  | 'promptAssistant'
  | 'assets'
  | 'history'
type PsdTaskStatus = 'processing' | 'success' | 'failed' | 'interrupted'

type SpeechRecognitionResultEventLike = Event & {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0: { transcript: string }
  }>
}

type SpeechRecognitionErrorEventLike = Event & { error: string }

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
}

type ReferenceImage = {
  key: string
  name: string
  preview: string
  nativeId?: string
  file?: File
  remoteUrl?: string
  uploading?: boolean
  error?: string
}

type ProviderOption = {
  id: number
  label: string
  model: string
  isDefault: boolean
  sizeOptions: ParameterOption[]
  qualityOptions: ParameterOption[]
  resolutionOptions: ParameterOption[]
  priceMatrix: PriceMatrix
  referenceImageCredits: number
}

type ParameterOption = {
  label: string
  value: string
  credits: number | null
}

type PriceMatrix = Record<string, Record<string, Record<string, number>>>

type SavedFile = {
  url: string
  path: string
  sha256: string
}

type LocalCropMaskPoint = { x: number; y: number }
type LocalCropMaskPath = { points: LocalCropMaskPoint[]; brushSize: number; isEraser: boolean }
type LocalCropMeta = {
  sceneImageId: string
  cropBox: { x: number; y: number; size: number }
  hasMask: boolean
  maskPaths?: LocalCropMaskPath[]
  /** 上传后的产品参考图远端 URL（不含场景裁切图） */
  productSources?: string[]
  scenePath?: string
  compositePath?: string
  /** 拼合后整图尺寸，历史瀑布流按此比例展示，避免被 1:1 裁切比例压扁 */
  compositeWidth?: number
  compositeHeight?: number
}

type LocalCropDraftState = {
  token: number
  prompt?: string
  providerId?: number
  quality?: string
  resolution?: string
  scene?: DesktopSelectedImage | null
  products?: DesktopSelectedImage[]
  cropBox?: { x: number; y: number; size: number } | null
  maskPaths?: LocalCropMaskPath[]
  maskOpacity?: number
  openEditor?: boolean
}

type LocalTask = {
  id: number
  prompt: string
  size?: string
  status: TaskStatus
  progress: number
  createdAt: number
  resultImages: string[]
  savedFiles: SavedFile[]
  sourceImages?: string[]
  quality?: string
  resolution?: string
  providerId?: number
  error?: string
  downloadError?: string
  /** 服务端 tool_scene / task_meta.scene，如 crop */
  toolScene?: string
  localCropMeta?: LocalCropMeta
}

type PsdTask = {
  id: string
  image: DesktopSelectedImage
  status: PsdTaskStatus
  progress: number
  stage: string
  createdAt: number
  result?: {
    path: string
    width: number
    height: number
    size: number
    layerNames: string[]
    textRegionCount: number
    instanceCount: number
  }
  error?: string
}

const TASKS_KEY = 'yfq_desktop_tasks_v1'
const PSD_TASKS_KEY = 'yfq_desktop_psd_tasks_v1'
const HIDDEN_TASKS_KEY = 'yfq_desktop_hidden_task_ids_v1'
const hiddenTaskIds = ref<Set<number>>(loadHiddenTaskIdsFromStorage())

function loadHiddenTaskIdsFromStorage(): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_TASKS_KEY) || '[]') as number[]
    return new Set((Array.isArray(raw) ? raw : []).map(Number).filter((id) => id > 0))
  } catch {
    return new Set()
  }
}

function persistHiddenTaskIds(): void {
  localStorage.setItem(HIDDEN_TASKS_KEY, JSON.stringify(Array.from(hiddenTaskIds.value).slice(-800)))
}

function hideTaskIds(ids: number[]): void {
  const next = new Set(hiddenTaskIds.value)
  ids.forEach((id) => {
    if (id > 0) next.add(id)
  })
  hiddenTaskIds.value = next
  persistHiddenTaskIds()
}

function isTaskHidden(id: number): boolean {
  return hiddenTaskIds.value.has(id)
}

function purgeHiddenTasksFromList(list: LocalTask[]): LocalTask[] {
  if (!hiddenTaskIds.value.size) return list
  return list.filter((task) => !isTaskHidden(task.id))
}

const MAX_REFERENCES = 4
const POLL_DELAY = 5000
const MAX_POLLS = 240
const HISTORY_PAGE_SIZE = 50
const HISTORY_MAX_PAGES = 100

const plannedViews = [
  { id: 'detailV4' as const, label: '整套详情', icon: LayoutTemplate, description: '先生成 8 组可编辑场景方案，确认后再批量生成详情图。' },
  { id: 'replication' as const, label: '批量复刻', icon: Copy, description: '基于参考图批量复刻构图、风格和商品呈现。' },
  { id: 'batchSku' as const, label: '批量 SKU', icon: Package, description: '同一模板快速适配多规格、多颜色和多 SKU 商品。' },
  { id: 'crop' as const, label: '局部重绘', icon: WandSparkles, description: '编辑场景图标记灰色选区，局部重绘后回贴原图，框外内容保持不变。' },
  { id: 'sellVideo' as const, label: '一键带货视频', icon: Clapperboard, description: '一张商品主图生成 8 个环绕视角，可在 App 内旋转预览并导出短视频。' },
  { id: 'promptAssistant' as const, label: '提示词助手', icon: WandSparkles, description: '拆解需求、优化提示词并沉淀常用模板。' }
]

const navigation: Record<NavMode, NavigationEntry[]> = {
  creation: [
    {
      id: 'imageEditing',
      label: '单图创作',
      icon: ImageIcon,
      children: [
        { id: 'quick', label: '图片生成', icon: ImagePlus },
        { id: 'crop', label: '局部重绘', icon: ScanLine }
      ]
    },
    {
      id: 'batchFeatures',
      label: '批量创作',
      icon: Layers3,
      children: [
        { id: 'replication', label: '批量复刻', icon: Copy },
        { id: 'batchSku', label: '批量 SKU', icon: Boxes },
        { id: 'detailV4', label: '整套详情', icon: LayoutTemplate }
      ]
    },
    {
      id: 'creationTools',
      label: '工具',
      icon: Wrench,
      children: [
        { id: 'psd', label: '图片转 PSD', icon: Layers3 },
        { id: 'folder', label: '保存目录', icon: FolderOpen }
      ]
    }
  ],
  tools: [
    { id: 'sellVideo', label: '一键带货视频', icon: Clapperboard },
    { id: 'promptAssistant', label: '提示词助手', icon: WandSparkles },
    { id: 'history', label: '历史记录', icon: History }
  ]
}

const expandedNavGroups = reactive<Record<NavigationGroupId, boolean>>({
  imageEditing: true,
  batchFeatures: true,
  creationTools: true
})

function isNavigationGroup(item: NavigationEntry): item is NavigationGroup {
  return 'children' in item
}

function navigationGroupActive(item: NavigationGroup): boolean {
  return item.children.some((child) => child.id !== 'folder' && child.id === activeView.value)
}

function toggleNavigationGroup(id: NavigationGroupId): void {
  expandedNavGroups[id] = !expandedNavGroups[id]
}

// 真实值由 desktop:get-info 在 loadDesktopState() 里覆盖，这里只是首帧占位
const appInfo = reactive({ name: 'AI 图像工作台', version: '', arch: '' })
const activeView = ref<ActiveView>('quick')
const navMode = ref<NavMode>('creation')
const primaryModeTransition = ref<'quick' | 'crop' | null>(null)
const primaryModeStageRef = ref<HTMLElement | null>(null)
let primaryModeTransitionTimer: number | null = null
let primaryModeTransitionFrame: number | null = null
const batchTransition = ref<MotionDirection | null>(null)
let batchTransitionTimer: number | null = null
const primaryMotion = new MotionBatch()
const batchMotion = new MotionBatch()
const crossMotion = new MotionBatch()
const viewHistory = ref<ActiveView[]>([])
let navigatingBack = false
const settings = reactive<DesktopSettings>({
  outputDirectory: '~/Documents/AI-Image-Workspace',
  autoDownload: true,
  theme: 'light',
  greetingName: '',
  generationProviderId: 0,
  generationSize: '1:1',
  generationQuality: 'low',
  generationResolution: '1K',
  generationCount: 1,
  siteUrl: ''
})
const user = ref<UserInfo | null>(getStoredUser())
const brandName = ref('AI 图像工作台')
const createMode = ref<CreateMode>('text')
const prompt = ref('')
const references = ref<ReferenceImage[]>([])
const providers = ref<ProviderOption[]>([])
const selectedProviderId = ref(0)
const selectedSize = ref('1:1')
const quality = ref('low')
const resolution = ref('1K')
const count = ref(1)
const fallbackUnitCost = ref(49)
const loginAgreementRequired = ref(false)
const tasks = ref<LocalTask[]>([])
const historySyncing = ref(false)
const historySyncError = ref('')
const historyVisibleCount = ref(120)
const submitting = ref(false)
const workflowSubmitting = ref(false)
const cropDraft = ref<LocalCropDraftState | null>(null)
const cropReuseBusy = ref(false)
const settingsOpen = ref(false)
const manualOpen = ref(false)
const loginOpen = ref(false)
// 启动时会话尚未恢复完成，此时既不显示工作台也不显示登录页，避免闪屏
const sessionRestoring = ref(true)

type RechargePackage = { id: number; name: string; price: string; credits: number; draw_count: number }
const rechargeOpen = ref(false)
const rechargePackages = ref<RechargePackage[]>([])
const rechargeLoading = ref(false)
const rechargeError = ref('')
const rechargeCreating = ref(false)
const rechargeQrDataUrl = ref('')
const rechargeActivePackage = ref<RechargePackage | null>(null)
const rechargePaid = ref(false)
let rechargePollTimer: number | null = null
const loginSubmitting = ref(false)
const loginError = ref('')
const loginMode = ref<'password' | 'wechat'>('password')
const wechatLoginAvailable = ref(false)
const wechatQrDataUrl = ref('')
const wechatQrState = ref('')
const wechatQrLoading = ref(false)
const wechatLoginError = ref('')
const wechatQrExpired = ref(false)
const pendingSubmit = ref(false)
/** 点击生成后立刻占位的临时任务（负数 id），提交成功后替换为真实任务 */
const preparingTaskId = ref<number | null>(null)
const globalMessage = ref('')
const globalError = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const pollTimers = new Map<number, number>()
const activePolls = new Set<number>()
let wechatPollTimer: number | null = null
const WECHAT_POLL_DELAY = 2500
const WECHAT_POLL_MAX = 220
const activeDownloads = new Set<string>()
const selectedPsdImage = ref<DesktopSelectedImage | null>(null)
const psdTasks = ref<PsdTask[]>([])
const psdEngine = ref<{ ready: boolean; missing: string[] } | null>(null)
const psdTaskFilter = ref<TaskFilter>('all')
const psdStorageBytes = ref(0)
const modelStatus = ref<ModelStoreStatus>({ phase: 'checking' })
const modelDiskBytes = ref(0)
const modelBusy = ref(false)
const updateState = ref<UpdaterState>({ phase: 'idle' })
const updateModalOpen = ref(false)
// semiAutoMask 默认关闭：默认走全自动分层，需要手工修蒙版时用户自己打开
const psdSettings = reactive({ autoExport: true, writeLayerMasks: true, subjectProtection: true, semiAutoMask: false })
/** 点击开始分层后展开右侧状态栏；有历史任务时也会显示 */
const psdRailOpen = ref(false)
/** 提交生图后自动拉出的右侧历史记录栏；可手动收起和打开 */
const HISTORY_RAIL_WIDTH_KEY = 'yfq_history_rail_width_v2'
const HISTORY_RAIL_MIN_WIDTH = 280
const HISTORY_RAIL_MAX_WIDTH = 460
const HISTORY_RAIL_DEFAULT_WIDTH = 385
// 每次启动只显示中间工作区；右栏只在用户手动打开或提交任务后出现。
const historyRailOpen = ref(false)
const storedHistoryRailWidthRaw = localStorage.getItem(HISTORY_RAIL_WIDTH_KEY)
const storedHistoryRailWidth = storedHistoryRailWidthRaw === null ? Number.NaN : Number(storedHistoryRailWidthRaw)
const historyRailWidth = ref(Number.isFinite(storedHistoryRailWidth)
  ? Math.max(HISTORY_RAIL_MIN_WIDTH, Math.min(HISTORY_RAIL_MAX_WIDTH, storedHistoryRailWidth))
  : HISTORY_RAIL_DEFAULT_WIDTH)
const historyRailResizing = ref(false)
const historyRailStyle = computed(() => ({ '--history-rail-width': `${historyRailWidth.value}px` }))
let historyRailResizeStartX = 0
let historyRailResizeStartWidth = HISTORY_RAIL_DEFAULT_WIDTH

function setHistoryRail(open: boolean): void {
  if (open) {
    // 打开时强制回到合法宽度，避免历史宽度被压成 0 后“开了但看不见”
    const width = clampHistoryRailWidth(historyRailWidth.value || HISTORY_RAIL_DEFAULT_WIDTH)
    historyRailWidth.value = Math.max(HISTORY_RAIL_MIN_WIDTH, width)
    historyRailOpen.value = true
    void nextTick(() => {
      historyRailWidth.value = clampHistoryRailWidth(historyRailWidth.value)
    })
    return
  }
  historyRailOpen.value = false
}

function toggleHistoryRail(): void {
  setHistoryRail(!historyRailOpen.value)
}

function clampHistoryRailWidth(width: number): number {
  const leftRailWidth = sidebarCollapsed.value ? 0 : 238
  const minimumWorkspaceWidth = 680
  const viewportLimit = Math.max(HISTORY_RAIL_MIN_WIDTH, window.innerWidth - leftRailWidth - minimumWorkspaceWidth)
  return Math.round(Math.max(HISTORY_RAIL_MIN_WIDTH, Math.min(HISTORY_RAIL_MAX_WIDTH, viewportLimit, width)))
}

function syncHistoryRailToViewport(): void {
  if (!historyRailOpen.value) return
  const nextWidth = clampHistoryRailWidth(historyRailWidth.value)
  if (nextWidth === historyRailWidth.value) return
  historyRailWidth.value = nextWidth
  localStorage.setItem(HISTORY_RAIL_WIDTH_KEY, String(nextWidth))
}

function onHistoryRailPointerMove(event: PointerEvent): void {
  if (!historyRailResizing.value) return
  historyRailWidth.value = clampHistoryRailWidth(historyRailResizeStartWidth + historyRailResizeStartX - event.clientX)
}

function finishHistoryRailResize(): void {
  if (!historyRailResizing.value) return
  historyRailResizing.value = false
  document.documentElement.classList.remove('history-rail-resizing')
  window.removeEventListener('pointermove', onHistoryRailPointerMove)
  window.removeEventListener('pointerup', finishHistoryRailResize)
  window.removeEventListener('pointercancel', finishHistoryRailResize)
  localStorage.setItem(HISTORY_RAIL_WIDTH_KEY, String(historyRailWidth.value))
}

function startHistoryRailResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  historyRailResizeStartX = event.clientX
  historyRailResizeStartWidth = historyRailWidth.value
  historyRailResizing.value = true
  document.documentElement.classList.add('history-rail-resizing')
  window.addEventListener('pointermove', onHistoryRailPointerMove)
  window.addEventListener('pointerup', finishHistoryRailResize)
  window.addEventListener('pointercancel', finishHistoryRailResize)
}

function nudgeHistoryRailWidth(delta: number): void {
  historyRailWidth.value = clampHistoryRailWidth(historyRailWidth.value + delta)
  localStorage.setItem(HISTORY_RAIL_WIDTH_KEY, String(historyRailWidth.value))
}
const psdMaskEditor = ref<{
  open: boolean
  taskId: string
  draft: PsdMaskDraft | null
  exporting: boolean
}>({ open: false, taskId: '', draft: null, exporting: false })
const openPopover = ref('')
const usage = ref<UsageOverview | null>(null)
const usageRange = ref<'all' | '30d' | '7d'>('all')
const usageTab = ref<'overview' | 'images'>('overview')
const usageSelectedDate = ref('')
const usedCredits = ref(0)
const previewImage = ref<{ src: string; name: string; task?: LocalTask } | null>(null)
const promptCopied = ref(false)
const imageCopied = ref(false)
const openingInPhotoshop = ref(false)
const openingInPhotopea = ref(false)
const copyingImage = ref(false)
const convertingPreviewPsd = ref(false)
const taskDetail = ref<LocalTask | null>(null)
const deletingTaskIds = ref<Set<number>>(new Set())
const clearingFailed = ref(false)
const promptRef = ref<HTMLTextAreaElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const isOnline = ref(navigator.onLine)
const isVoiceListening = ref(false)
const isVoiceRecognizing = ref(false)
const voiceStatus = ref('')
const generationSettingsReady = ref(false)
const SIDEBAR_KEY = 'image_workspace_sidebar_collapsed'
/** 接近 Electron minWidth(960) 时自动收起侧栏 */
const SIDEBAR_AUTO_COLLAPSE_MAX = 1000
// 每次启动只显示中间工作区；用户仍可在本次使用中手动展开左栏。
const sidebarCollapsed = ref(true)
const sidebarPreview = ref(false)
const sidebarPreviewClosing = ref(false)
let sidebarAutoCollapsed = false
const featureGuides = [
  {
    title: '整套详情',
    icon: LayoutTemplate,
    summary: '先规划，再成套生成商品详情页，适合需要统一视觉和完整卖点表达的商品。',
    steps: ['上传 1 张商品主图，可补充最多 3 张风格参考图', '填写商品名、核心卖点与禁用内容', '先生成 8 组场景方案，删改或关闭不需要的方案', '确认方案后批量生成详情图并下载']
  },
  {
    title: '批量复刻',
    icon: Copy,
    summary: '把一批参考图的构图与风格，快速迁移到你的商品素材上。',
    steps: ['一次上传最多 20 张参考图', '需要替换商品时，再上传最多 3 张商品图', '填写整批共用的复刻要求', '系统按每张参考图独立生成，完成后可逐张检查']
  },
  {
    title: '批量 SKU',
    icon: Boxes,
    summary: '用同一套模板批量适配不同颜色、规格或款式，减少重复做图。',
    steps: ['上传 1 张版式模板', '上传最多 20 张 SKU 商品图', '按行填写每个 SKU 的颜色、规格或卖点', '提交后每个 SKU 独立出图，便于单独下载和重试']
  },
  {
    title: '局部重绘',
    icon: ScanLine,
    summary: '编辑场景图画出灰色选区并设置重绘范围，把产品自然替换进原图，框外内容保持不变。',
    steps: ['上传场景图并点击「编辑场景图」', '用画笔标记替换区域，再设置重绘框', '可选上传最多 3 张产品参考图', '确认提示词与线路后开始生成，完成后自动回贴原图']
  },
  {
    title: '一键带货转台',
    icon: Clapperboard,
    summary: '一张商品主图生成 8 个环绕视角，可旋转预览并导出 WebM 短视频。',
    steps: ['上传 1 张白底商品主图，可选 2 张辅助参考', '核对线路与预计积分（约单次价 × 8）', '提交后等待 8 个视角出图', '在预览区旋转查看，需要时导出 WebM']
  }
]
const activePlaceholder = computed(() => {
  if (activeView.value === 'sellVideo') return null
  return plannedViews.find((item) => item.id === activeView.value) || null
})
const activeWorkflowKind = computed(() => {
  if (activeView.value === 'detailV4' || activeView.value === 'replication' || activeView.value === 'batchSku' || activeView.value === 'crop') {
    return activeView.value
  }
  return null
})
const visibleNavigation = computed(() => navigation[navMode.value])
const allNavigationLeaves = computed(() => Object.values(navigation).flatMap((entries) => entries.flatMap((item) => (
  isNavigationGroup(item) ? item.children : [item]
))))
const activeViewTitle = computed(() => {
  const all = [...allNavigationLeaves.value, ...plannedViews]
  return all.find((item) => item.id === activeView.value)?.label || 'AI 图像工作台'
})

async function clearFailedTasks(): Promise<void> {
  openPopover.value = ''
  if (clearingFailed.value) return
  const failedTasks = tasks.value.filter((task) => task.status === 'failed')
  if (!failedTasks.length) {
    showMessage('没有失败任务需要清理')
    return
  }
  clearingFailed.value = true
  try {
    if (getToken()) {
      try {
        await api.deleteFailedTasks()
      } catch (error) {
        // 服务端清理失败时仍做本地隐藏，避免「删了又回来」
        showError(error, '服务端清理失败，已先在本机隐藏')
      }
    }
    hideTaskIds(failedTasks.map((task) => task.id))
    tasks.value = tasks.value.filter((task) => task.status !== 'failed')
    persistTasks()
    if (taskDetail.value?.status === 'failed') taskDetail.value = null
    showMessage(`已清理 ${failedTasks.length} 条失败任务`)
  } finally {
    clearingFailed.value = false
  }
}

function openSiteUrl(): void {
  openPopover.value = ''
  const url = settings.siteUrl.trim()
  if (!url) {
    settingsOpen.value = true
    showMessage('先在设置里填写网站地址')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function openTaskDetail(task: LocalTask): void {
  taskDetail.value = task
  if (task.status === 'queued' || task.status === 'running') {
    void pollTask(task.id, 0)
  }
}

function closeTaskDetail(): void {
  taskDetail.value = null
}

function taskStatusLabel(task: LocalTask): string {
  if (task.status === 'success') return '已完成'
  if (task.status === 'failed') return '失败'
  if (task.status === 'queued') return '排队中'
  return '生成中'
}

function taskProviderLabel(task: LocalTask): string {
  const provider = providers.value.find((item) => item.id === task.providerId)
  return provider?.label || (task.providerId ? `线路 #${task.providerId}` : '默认线路')
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp)
}

const liveTaskDetail = computed(() => {
  if (!taskDetail.value) return null
  return tasks.value.find((task) => task.id === taskDetail.value!.id) || taskDetail.value
})

function setNavMode(mode: NavMode): void {
  navMode.value = mode
  if (mode === 'creation') activeView.value = 'quick'
  if (mode === 'tools') activeView.value = 'psd'
}

function activateNavigation(id: ActiveView | 'folder'): void {
  if (id === 'folder') {
    void openOutputDirectory()
    return
  }
  if ((id === 'quick' || id === 'crop') && (activeView.value === 'quick' || activeView.value === 'crop')) {
    switchPrimaryMode(id)
    return
  }
  const batchViews: BatchWorkflowView[] = ['replication', 'batchSku', 'detailV4']
  if (batchViews.includes(id as BatchWorkflowView) && batchViews.includes(activeView.value as BatchWorkflowView)) {
    switchBatchMode(id as BatchWorkflowView)
    return
  }
  // 单图组 ↔ 批量组：跨组也要有过渡，五个创作页之间不该有硬切的缝
  const creationSet: ActiveView[] = ['quick', 'crop', ...batchViews]
  if (creationSet.includes(id) && creationSet.includes(activeView.value)) {
    switchCreationView(id)
    return
  }
  activeView.value = id
  if (id === 'history') void syncTaskHistory()
}

/*
 * 当前视图里那个「底部输入框」——五个创作页共有，跨组切换时它是视觉锚点。
 * 单图组两个 pane 始终都在 DOM 里，必须挑 .active 的那个，否则量到的是隐藏框的位置。
 */
function findComposer(root: ParentNode): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>('.primary-mode-pane.active .primary-composer') ||
    root.querySelector<HTMLElement>('.batch-composer') ||
    root.querySelector<HTMLElement>('.primary-composer')
  )
}

function switchCreationView(view: ActiveView): void {
  if (activeView.value === view) return
  const outgoingView = document.querySelector<HTMLElement>('.view')
  const token = crossMotion.begin()

  if (!outgoingView || prefersReducedMotion()) {
    navMode.value = 'creation'
    activeView.value = view
    return
  }

  // 旧视图会在下一帧被 v-if 卸掉，来不及播离场；跨组的连续感全靠输入框的位移接上
  const outgoingComposerRect = findComposer(outgoingView)?.getBoundingClientRect()

  navMode.value = 'creation'
  activeView.value = view

  void nextTick(() => {
    window.requestAnimationFrame(() => {
      if (crossMotion.isStale(token)) return
      const incomingView = document.querySelector<HTMLElement>('.view')
      if (!incomingView) return

      // 先量输入框：父级一旦挂上位移动画，子元素的 rect 就带偏移了
      const incomingComposer = findComposer(incomingView)
      if (incomingComposer && outgoingComposerRect) {
        crossMotion.add(flipMove(incomingComposer, outgoingComposerRect, { duration: DURATION_CROSS }))
        crossMotion.add(
          morphHeight(incomingComposer, outgoingComposerRect.height, { duration: DURATION_CROSS })
        )
      }
      crossMotion.add(crossFadeIn(incomingView))
    })
  })
}

function switchPrimaryMode(view: 'quick' | 'crop'): void {
  if (activeView.value === view) return
  if (primaryModeTransitionTimer !== null) window.clearTimeout(primaryModeTransitionTimer)
  if (primaryModeTransitionFrame !== null) window.cancelAnimationFrame(primaryModeTransitionFrame)
  primaryMotion.begin()
  if (prefersReducedMotion()) {
    // WAAPI 不受 CSS 的 prefers-reduced-motion 约束，得在 JS 这层早退
    navMode.value = 'creation'
    activeView.value = view
    return
  }
  const stage = primaryModeStageRef.value
  const quickComposer = stage?.querySelector<HTMLElement>('.quick-mode-pane > .primary-composer')
  const cropComposer = stage?.querySelector<HTMLElement>('.crop-mode-pane .primary-composer')
  const outgoingComposer = activeView.value === 'quick' ? quickComposer : cropComposer
  const incomingComposer = view === 'quick' ? quickComposer : cropComposer
  const outgoingRect = outgoingComposer?.getBoundingClientRect()
  const incomingRect = incomingComposer?.getBoundingClientRect()
  const outgoingSurfaceRect = outgoingComposer?.querySelector<HTMLElement>('.mode-composer-surface')?.getBoundingClientRect()
  const incomingSurfaceRect = incomingComposer?.querySelector<HTMLElement>('.mode-composer-surface')?.getBoundingClientRect()

  primaryModeTransition.value = view
  navMode.value = 'creation'
  activeView.value = view

  // 目标 composer 从旧框的真实位置和真实高度出发。这样 textarea 自动增高后，
  // 切换仍是一只框在移动和变形，不会因两套固定 transform 互相覆盖而闪烁。
  void nextTick(() => {
    primaryModeTransitionFrame = window.requestAnimationFrame(() => {
      primaryModeTransitionFrame = null
      const liveIncoming = view === 'quick'
        ? stage?.querySelector<HTMLElement>('.quick-mode-pane > .primary-composer')
        : stage?.querySelector<HTMLElement>('.crop-mode-pane .primary-composer')
      const liveSurface = liveIncoming?.querySelector<HTMLElement>('.mode-composer-surface')
      if (!liveIncoming || !outgoingRect || !incomingRect) return

      primaryMotion.add(flipMove(liveIncoming, outgoingRect))
      if (liveSurface && outgoingSurfaceRect && incomingSurfaceRect) {
        primaryMotion.add(morphHeight(liveSurface, outgoingSurfaceRect.height))
      }
    })
  })
  primaryModeTransitionTimer = window.setTimeout(() => {
    primaryMotion.cancel()
    primaryModeTransition.value = null
    primaryModeTransitionTimer = null
  }, CLEANUP_MOVE)
}

function switchBatchMode(view: BatchWorkflowView): void {
  if (activeView.value === view) return
  const batchOrder: BatchWorkflowView[] = ['replication', 'batchSku', 'detailV4']
  const current = activeView.value as BatchWorkflowView
  const direction: MotionDirection =
    batchOrder.indexOf(view) > batchOrder.indexOf(current) ? 'forward' : 'backward'
  const stage = document.querySelector<HTMLElement>('.workflow-view.workflow-replication')
  const outgoingWorkspace = stage?.querySelector<HTMLElement>('.replication-mid')
  const token = batchMotion.begin()

  if (!stage || !outgoingWorkspace || prefersReducedMotion()) {
    navMode.value = 'creation'
    activeView.value = view
    return
  }

  /*
   * 和单图组同一套动作：面板从旧位置移过来、高度形变成新高度，
   * 让三页看起来是同一块面板在长高变矮，而不是两块内容闪替。
   */
  const outgoingRect = outgoingWorkspace.getBoundingClientRect()
  const outgoingComposerRect = stage
    .querySelector<HTMLElement>('.batch-composer')
    ?.getBoundingClientRect()

  batchTransition.value = direction
  navMode.value = 'creation'
  activeView.value = view

  void nextTick(() => {
    window.requestAnimationFrame(() => {
      if (batchMotion.isStale(token)) return
      const incomingWorkspace = stage.querySelector<HTMLElement>('.replication-mid')
      const incomingComposer = stage.querySelector<HTMLElement>('.batch-composer')
      if (incomingWorkspace) {
        batchMotion.add(flipMove(incomingWorkspace, outgoingRect))
        batchMotion.add(morphHeight(incomingWorkspace, outgoingRect.height))
      }
      if (incomingComposer && outgoingComposerRect) {
        batchMotion.add(flipMove(incomingComposer, outgoingComposerRect))
        batchMotion.add(morphHeight(incomingComposer, outgoingComposerRect.height))
      }
      staggerIn(
        incomingComposer?.querySelectorAll<HTMLElement>(
          '.prompt-area, .composer-bottom > .icon-round, .composer-params > *, .composer-bottom > .submit-workflow'
        ),
        direction
      ).forEach((animation) => batchMotion.add(animation))
    })
  })

  if (batchTransitionTimer !== null) window.clearTimeout(batchTransitionTimer)
  batchTransitionTimer = window.setTimeout(() => {
    batchMotion.cancel()
    batchTransition.value = null
    batchTransitionTimer = null
  }, CLEANUP_MOVE)
}

const canNavigateBack = computed(() => viewHistory.value.length > 0)

function navModeForView(view: ActiveView): NavMode {
  if (view === 'psd' || view === 'sellVideo' || view === 'promptAssistant' || view === 'history') return 'tools'
  return 'creation'
}

function navigateBack(): void {
  const previous = viewHistory.value.pop()
  if (!previous) return
  navigatingBack = true
  navMode.value = navModeForView(previous)
  activeView.value = previous
  if (previous === 'history') void syncTaskHistory()
}

function toggleSidebar(): void {
  cancelSidebarDock()
  clearSidebarPreviewTimers()
  sidebarPreview.value = false
  sidebarPreviewClosing.value = false
  sidebarAutoCollapsed = false

  if (!sidebarCollapsed.value) {
    sidebarCollapsed.value = true
    localStorage.setItem(SIDEBAR_KEY, '1')
    return
  }

  // fixed 预览先退出为 0 宽 flex 项，再开始 0→232 的布局动画。
  localStorage.setItem(SIDEBAR_KEY, '0')
  sidebarDockRaf = requestAnimationFrame(() => {
    sidebarDockRaf = null
    sidebarDockCommitRaf = requestAnimationFrame(() => {
      sidebarDockCommitRaf = null
      sidebarCollapsed.value = false
    })
  })
}

function syncSidebarToViewport(): void {
  const narrow = window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_MAX
  if (narrow) {
    if (!sidebarCollapsed.value) {
      sidebarAutoCollapsed = true
      cancelSidebarDock()
      clearSidebarPreviewTimers()
      sidebarCollapsed.value = true
      sidebarPreview.value = false
      sidebarPreviewClosing.value = false
    }
    return
  }
  if (sidebarAutoCollapsed) {
    sidebarAutoCollapsed = false
    sidebarCollapsed.value = localStorage.getItem(SIDEBAR_KEY) === '1'
  }
}

function openSidebarPreview(): void {
  if (!sidebarCollapsed.value) return
  clearSidebarPreviewTimers()
  sidebarPreviewClosing.value = false
  sidebarPreview.value = true
}

function closeSidebarPreview(): void {
  if (!sidebarCollapsed.value || (!sidebarPreview.value && !sidebarPreviewClosing.value)) return
  clearSidebarPreviewTimers()
  sidebarPreview.value = false
  sidebarPreviewClosing.value = true
  sidebarPreviewExitTimer = window.setTimeout(() => {
    sidebarPreviewExitTimer = null
    sidebarPreviewClosing.value = false
  }, 240)
}

function scheduleSidebarPreviewClose(): void {
  if (!sidebarCollapsed.value) return
  if (sidebarPreviewTimer !== null) window.clearTimeout(sidebarPreviewTimer)
  sidebarPreviewTimer = window.setTimeout(() => {
    sidebarPreviewTimer = null
    if (openPopover.value !== 'account') closeSidebarPreview()
  }, 180)
}

function autoGrowPrompt(): void {
  const el = promptRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`
}

watch(prompt, () => nextTick(autoGrowPrompt))
let removePsdProgressListener: (() => void) | null = null
let removeSystemResumeListener: (() => void) | null = null
let removeModelsStatusListener: (() => void) | null = null
let removeMenuListener: (() => void) | null = null
let removeUpdateStateListener: (() => void) | null = null
let removeWindowChromeListener: (() => void) | null = null
let removePhotopeaEventListener: (() => void) | null = null
const windowFullscreen = ref(false)
let removeVoiceEventListener: (() => void) | null = null
let speechRecognition: SpeechRecognitionLike | null = null
let voiceFinalText = ''
let voiceInterimText = ''
let voiceFailed = false
let generationSettingsTimer: number | null = null
let sidebarPreviewTimer: number | null = null
let sidebarPreviewExitTimer: number | null = null
let sidebarDockRaf: number | null = null
let sidebarDockCommitRaf: number | null = null

function clearSidebarPreviewTimers(): void {
  if (sidebarPreviewTimer !== null) window.clearTimeout(sidebarPreviewTimer)
  if (sidebarPreviewExitTimer !== null) window.clearTimeout(sidebarPreviewExitTimer)
  sidebarPreviewTimer = null
  sidebarPreviewExitTimer = null
}

function cancelSidebarDock(): void {
  if (sidebarDockRaf !== null) cancelAnimationFrame(sidebarDockRaf)
  if (sidebarDockCommitRaf !== null) cancelAnimationFrame(sidebarDockCommitRaf)
  sidebarDockRaf = null
  sidebarDockCommitRaf = null
}

const loginForm = reactive({ account: '', password: '', agreement: true })

const isLoggedIn = computed(() => Boolean(user.value) && Boolean(getToken()))
const runningCount = computed(() => tasks.value.filter((task) => task.status === 'queued' || task.status === 'running').length)
/** 右侧历史栏：与历史记录页共用同一批最近任务 */
const railTasks = computed(() => {
  const list = tasks.value.slice()
  list.sort((a, b) => {
    const rank = (task: LocalTask) => {
      if (task.status === 'queued' || task.status === 'running') return 0
      if (task.status === 'failed') return 1
      return 2
    }
    const diff = rank(a) - rank(b)
    if (diff) return diff
    return (b.createdAt - a.createdAt) || (b.id - a.id)
  })
  return list.slice(0, 60)
})
const historyTasks = computed(() => tasks.value.slice(0, historyVisibleCount.value))

// ===== 作品瀑布流：按图片比例分列，最短列优先 =====

type WaterfallCell = {
  key: string
  task: LocalTask
  kind: 'image' | 'card'
  src?: string
  index?: number
  ratio: number
}

const WATERFALL_GAP = 12
const WATERFALL_TARGET_COLUMN = 210
const historyGridRef = ref<HTMLElement | null>(null)
const usageCardRef = ref<HTMLElement | null>(null)
const historyGridWidth = ref(0)
const usageCardWidth = ref(0)
const gridResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
  for (const entry of entries) {
    if (entry.target === historyGridRef.value) historyGridWidth.value = entry.contentRect.width
    if (entry.target === usageCardRef.value) usageCardWidth.value = entry.contentRect.width
  }
})

for (const gridRef of [historyGridRef, usageCardRef]) {
  watch(gridRef, (el, previous) => {
    if (previous) gridResizeObserver?.unobserve(previous)
    if (el) gridResizeObserver?.observe(el)
  })
}

function ratioFromSize(size?: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(String(size || '').trim())
  if (!match) return 1
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return 1
  return Math.min(3, Math.max(0.4, width / height))
}

// 局部裁切任务的 resultImages 理想态是 [拼合预览 data:, ...裁切小图]（见 maybeCompositeLocalCrop）。
// 拼合图才是作品；persist 会剥掉 data:，恢复前若误用 slice(0,1) 会把远端裁切小图当成作品。
function galleryImages(task: LocalTask): string[] {
  if (!isLocalCropTask(task)) return task.resultImages
  const first = task.resultImages[0]
  if (first && (first.startsWith('data:') || first.startsWith('blob:'))) return [first]
  const preview = task.resultImages.find((url) => url.startsWith('data:') || url.startsWith('blob:'))
  if (preview) return [preview]
  // 已有本地拼合文件但预览尚未挂上：先占位，绝不用远端裁切小图冒充整图作品
  if (task.localCropMeta?.compositePath || task.savedFiles.some((file) => String(file.url || '').startsWith('local-crop-composite://'))) {
    return []
  }
  // 历史同步后丢了拼合元数据时，同样不要把 1:1 补丁图当作品
  return []
}

function buildWaterfallColumns(
  list: LocalTask[],
  containerWidth: number,
  options: { gap?: number; targetColumn?: number; maxColumns?: number; fallbackColumns?: number } = {}
): WaterfallCell[][] {
  const gap = options.gap ?? WATERFALL_GAP
  const targetColumn = options.targetColumn ?? WATERFALL_TARGET_COLUMN
  const maxColumns = options.maxColumns ?? 6
  const fallbackColumns = options.fallbackColumns ?? 4
  const columnCount = containerWidth > 0
    ? Math.max(1, Math.min(maxColumns, Math.floor((containerWidth + gap) / (targetColumn + gap))))
    : fallbackColumns
  const columnWidth = containerWidth > 0
    ? (containerWidth - gap * (columnCount - 1)) / columnCount
    : targetColumn
  const columns: WaterfallCell[][] = Array.from({ length: columnCount }, () => [])
  const heights = new Array<number>(columnCount).fill(0)
  const place = (cell: WaterfallCell, estimatedHeight: number): void => {
    let target = 0
    for (let i = 1; i < columnCount; i += 1) {
      if (heights[i] < heights[target] - 0.5) target = i
    }
    columns[target].push(cell)
    heights[target] += estimatedHeight + gap
  }
  for (const task of list) {
    if (task.status === 'success' && task.resultImages.length) {
      const images = galleryImages(task)
      if (images.length) {
        const cw = Number(task.localCropMeta?.compositeWidth || 0)
        const ch = Number(task.localCropMeta?.compositeHeight || 0)
        const ratio = (isLocalCropTask(task) && cw > 0 && ch > 0)
          ? Math.min(3, Math.max(0.4, cw / ch))
          : ratioFromSize(task.size)
        images.forEach((src, index) => {
          place({ key: `${task.id}-${index}`, task, kind: 'image', src, index, ratio }, columnWidth / ratio)
        })
      } else {
        // 局部裁切拼合预览尚未挂上：先占位，避免误展示裁切小图
        place({ key: `card-${task.id}`, task, kind: 'card', ratio: 1 }, 118)
      }
    } else {
      place({ key: `card-${task.id}`, task, kind: 'card', ratio: 1 }, 118)
    }
  }
  return columns
}

const historyColumns = computed(() => buildWaterfallColumns(historyTasks.value, historyGridWidth.value))
const railColumns = computed(() => buildWaterfallColumns(railTasks.value, historyRailWidth.value - 18, {
  gap: 8,
  targetColumn: 110,
  maxColumns: 3,
  fallbackColumns: 3
}))
/** 开屏励志问候池：化用而不露出处，每次打开随机取一条；附淡色英文副句 */
const GREETING_POOL: Array<{ zh: string; en: string }> = [
  { zh: '愿你今天的力量，配得上今天的路', en: "May today's strength match today's road." },
  { zh: '清晨的光，会越照越明', en: 'The morning light shines ever brighter.' },
  { zh: '含泪播种的，必欢喜收割', en: 'Those who sow in tears will reap in joy.' },
  { zh: '不为明天忧虑，先把今天做好', en: 'Never mind tomorrow — make today count.' },
  { zh: '愿你手上的工，稳稳立住', en: 'May the work of your hands stand firm.' },
  { zh: '疲乏的人，必再得力量', en: 'The weary will renew their strength.' },
  { zh: '起初虽然微小，终必大大兴旺', en: 'Small beginnings grow into great endings.' },
  { zh: '哭过的夜晚，会迎来欢呼的早晨', en: 'Joy comes with the morning.' },
  { zh: '脚前有灯，路上有光', en: 'A lamp for your feet, a light for your path.' },
  { zh: '万事都在互相效力，成全更好的安排', en: 'All things are working together for good.' },
  { zh: '在小事上尽心，会被托付更大的事', en: 'Faithful in little, trusted with much.' },
  { zh: '殷勤的手，必不至缺乏', en: 'Diligent hands will never be in want.' },
  { zh: '每个早晨，都是新的开始', en: 'Every morning is a fresh start.' },
  { zh: '心里定了方向，脚步自会被引导', en: 'Set your heart, and your steps will be guided.' },
  { zh: '沉住气，力量藏在安稳里', en: 'In quietness lies your strength.' }
]
const greetingPhrase = GREETING_POOL[Math.floor(Math.random() * GREETING_POOL.length)]
const greeting = computed(() => {
  const name = settings.greetingName.trim()
  return name ? `${name}，${greetingPhrase.zh}` : greetingPhrase.zh
})
const greetingEnglish = computed(() => greetingPhrase.en)

/** 首页「为你推荐」功能池：每次打开随机抽几条，hover 时输入框预览示例文案，点进对应工作流 */
const HERO_IDEA_POOL: Array<{
  id: ActiveView
  label: string
  hint: string
  icon: typeof Sparkles
  tag: string
  preview: string
}> = [
  { id: 'crop', label: '局部重绘', hint: '框选区域，只改局部、其余原样保留', icon: ScanLine, tag: '工作流', preview: '框选场景图里要替换的区域，把新产品自然融入原图，框外内容保持不变。' },
  { id: 'psd', label: '图片转 PSD', hint: '智能分层，导出可编辑 PSD', icon: Layers3, tag: '工作流', preview: '把这张商品主图智能分层，导出可以继续编辑的 PSD 文件。' },
  { id: 'replication', label: '批量复刻', hint: '参考一张图，批量复刻构图与风格', icon: Copy, tag: '工作流', preview: '参考这批图的构图、光线和风格，把我的商品批量复刻成同款画面。' },
  { id: 'batchSku', label: '批量 SKU', hint: '同一模板适配多色号、多规格', icon: Boxes, tag: '工作流', preview: '用同一套版式模板，批量适配不同色号、规格的 SKU 商品图。' },
  { id: 'detailV4', label: '整套详情', hint: '先出场景方案，再批量生成详情图', icon: LayoutTemplate, tag: '批量', preview: '先生成 8 组可编辑的场景方案，确认后一键产出整套商品详情图。' },
  { id: 'sellVideo', label: '一键带货视频', hint: '8 视角环绕预览并导出短视频', icon: Clapperboard, tag: '工具', preview: '用商品主图生成环绕视角，拖动预览并导出 WebM。' },
  { id: 'promptAssistant', label: '提示词助手', hint: '拆解需求，写出更好用的提示词', icon: Sparkles, tag: '工具', preview: '把模糊的想法拆解成一条更好用的生图提示词。' },
  { id: 'history', label: '历史记录', hint: '同步网页、小程序与 Mac 全部出图', icon: History, tag: '记录', preview: '同步查看当前账户在网页、小程序和 Mac 生成的全部图片。' }
]

const heroIdeas = ref<typeof HERO_IDEA_POOL>([])
/** hover 推荐项时在输入框浮现的示例文案；移出即清空 */
const hoveredIdeaPreview = ref('')

const promptPlaceholder = computed(() => {
  if (hoveredIdeaPreview.value) return hoveredIdeaPreview.value
  return createMode.value === 'text'
    ? '描述想要的画面：产品、场景、构图、光线…（可直接粘贴参考图）'
    : '描述需要保留和修改的内容，不填则按参考图生成…'
})

function shuffleHeroIdeas(count = 4): void {
  const pool = HERO_IDEA_POOL.slice()
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  heroIdeas.value = pool.slice(0, Math.min(count, pool.length))
}

function openHeroIdea(id: ActiveView): void {
  hoveredIdeaPreview.value = ''
  const creationViews: ActiveView[] = ['quick', 'crop', 'replication', 'batchSku', 'detailV4']
  navMode.value = creationViews.includes(id) ? 'creation' : 'tools'
  activateNavigation(id)
}
const activeProvider = computed(() => providers.value.find((item) => item.id === selectedProviderId.value) || providers.value[0])
const currentSizeOptions = computed(() => activeProvider.value?.sizeOptions || [])
const currentQualityOptions = computed(() => activeProvider.value?.qualityOptions || [])
const currentResolutionOptions = computed(() => activeProvider.value?.resolutionOptions || [])
const unitCost = computed(() => {
  const provider = activeProvider.value
  const matrixCost = Number(provider?.priceMatrix?.[selectedSize.value]?.[resolution.value]?.[quality.value])
  const base = Number.isFinite(matrixCost) && matrixCost > 0
    ? matrixCost
    : Number(
        currentResolutionOptions.value.find((item) => item.value === resolution.value)?.credits
        ?? currentQualityOptions.value.find((item) => item.value === quality.value)?.credits
        ?? currentSizeOptions.value.find((item) => item.value === selectedSize.value)?.credits
        ?? fallbackUnitCost.value
      )
  const referencesCost = createMode.value === 'image'
    ? references.value.length * Number(provider?.referenceImageCredits || 0)
    : 0
  return Math.max(0, base || fallbackUnitCost.value) + referencesCost
})
const totalCost = computed(() => unitCost.value * count.value)
const canSubmit = computed(() => {
  if (submitting.value) return false
  if (createMode.value === 'text') return Boolean(prompt.value.trim())
  return references.value.length > 0
})
const showPsdTaskTabs = computed(() => psdTasks.value.length > 5)
const accountInitial = computed(() => (user.value?.nickname || '用').trim().slice(0, 1).toUpperCase())
const membershipLabel = computed(() => (user.value?.isMember ? 'Annual Member' : 'Free'))
const selectedSizeLabel = computed(() => currentSizeOptions.value.find((item) => item.value === selectedSize.value)?.label || selectedSize.value)
const selectedProviderLabel = computed(() => activeProvider.value?.label || '线路')
const selectedQualityLabel = computed(() => currentQualityOptions.value.find((item) => item.value === quality.value)?.label || quality.value)
const resolutionSlide = ref(0)
const resolutionDragging = ref(false)
let resolutionSnapRaf = 0
let resolutionCommitting = false

function resolutionMaxIndex(): number {
  return Math.max(0, currentResolutionOptions.value.length - 1)
}

function syncResolutionSlideFromValue(): void {
  if (resolutionDragging.value || resolutionCommitting) return
  const idx = currentResolutionOptions.value.findIndex((item) => item.value === resolution.value)
  resolutionSlide.value = Math.max(0, idx)
}

watch([resolution, currentResolutionOptions], syncResolutionSlideFromValue, { immediate: true, deep: true })

/** 靠近 1K / 2K / 4K 时轻微吸住，拖动仍连续 */
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
  const pull = t * t * 0.62
  return clamped + (nearest - clamped) * pull
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
  // 松手后短缓动吸到档位
  const t0 = performance.now()
  const dur = 170
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / dur)
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

const resolutionIndex = computed({
  get: () => Math.max(0, currentResolutionOptions.value.findIndex((item) => item.value === resolution.value)),
  set: (index: number) => {
    const option = currentResolutionOptions.value[index]
    if (option) resolution.value = option.value
  }
})

function togglePopover(name: string): void {
  openPopover.value = openPopover.value === name ? '' : name
}

function pickOption(name: 'account' | 'provider' | 'size' | 'quality' | 'count', apply: () => void): void {
  apply()
  openPopover.value = ''
  if (name === 'provider') syncProviderSelections()
}

function onDocumentMousedown(event: MouseEvent): void {
  const target = event.target as Element | null
  if (sidebarCollapsed.value && sidebarPreview.value && !target?.closest('.sidebar') && !target?.closest('.panel-toggle.floating')) {
    closeSidebarPreview()
  }
  if (openPopover.value && !target?.closest('.pop-wrap')) openPopover.value = ''
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (previewImage.value) previewImage.value = null
  else if (taskDetail.value) taskDetail.value = null
  else if (openPopover.value) openPopover.value = ''
  else if (sidebarPreview.value) closeSidebarPreview()
}

// ===== 生图数据总览（右栏开屏统计卡） =====

const usageDaily = computed(() => usage.value?.daily || [])
const usageRangeSummary = computed(() => usage.value?.ranges?.[usageRange.value] || null)
const usageFiltered = computed(() => {
  if (usageRange.value === 'all') return usageDaily.value
  const days = usageRange.value === '30d' ? 30 : 7
  const since = dateKey(new Date(Date.now() - (days - 1) * 86400000))
  return usageDaily.value.filter((row) => row.date >= since)
})
const usageTotals = computed(() => {
  if (usageRangeSummary.value) {
    return {
      tasks: Number(usageRangeSummary.value.tasks || 0),
      images: Number(usageRangeSummary.value.images || 0),
      activeDays: Number(usageRangeSummary.value.active_days || 0),
      credits: Number(usageRangeSummary.value.credits || 0)
    }
  }
  let tasksSum = 0
  let imagesSum = 0
  for (const row of usageFiltered.value) {
    tasksSum += row.tasks
    imagesSum += row.images
  }
  return { tasks: tasksSum, images: imagesSum, activeDays: usageFiltered.value.filter((row) => row.tasks > 0).length, credits: usedCredits.value }
})
const usageStreaks = computed(() => {
  if (usageRangeSummary.value) {
    return {
      current: Number(usageRangeSummary.value.current_streak || 0),
      longest: Number(usageRangeSummary.value.longest_streak || 0)
    }
  }
  const active = new Set(usageFiltered.value.filter((row) => row.tasks > 0).map((row) => row.date))
  let longest = 0
  let run = 0
  const fallbackDays = usageRange.value === 'all' ? 365 : usageRange.value === '30d' ? 30 : 7
  for (let i = usageFiltered.value.length ? fallbackDays - 1 : -1; i >= 0; i -= 1) {
    const key = dateKey(new Date(Date.now() - i * 86400000))
    run = active.has(key) ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  let current = 0
  for (let i = active.has(dateKey(new Date())) ? 0 : 1; ; i += 1) {
    if (!active.has(dateKey(new Date(Date.now() - i * 86400000)))) break
    current += 1
  }
  return { current, longest }
})
const usagePeakHour = computed(() => {
  const rangePeak = usageRangeSummary.value?.peak_hour
  const histogram = usageRangeSummary.value?.hour_histogram || usage.value?.hour_histogram || []
  const max = Math.max(0, ...histogram)
  if (!max) return '—'
  const hour = rangePeak === null || rangePeak === undefined ? histogram.indexOf(max) : Number(rangePeak)
  const period = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour === 12 ? '中午' : hour < 18 ? '下午' : '晚上'
  const display = hour === 0 ? 12 : hour <= 12 ? hour : hour - 12
  return `${period} ${display} 点`
})
const usageTopRatio = computed(() => {
  if (usageRangeSummary.value?.top_ratio) return usageRangeSummary.value.top_ratio
  const counts = new Map<string, number>()
  for (const task of tasks.value) {
    const taskDate = dateKey(new Date(task.createdAt))
    if (!usageFiltered.value.some((row) => row.date === taskDate)) continue
    if (task.size) counts.set(task.size, (counts.get(task.size) || 0) + 1)
  }
  let top = ''
  let best = 0
  counts.forEach((count, size) => {
    if (count > best) {
      best = count
      top = size
    }
  })
  return top || selectedSize.value
})
const HEATMAP_DAYS = 140
const usageHeatmap = computed(() => {
  const byDate = new Map(usageFiltered.value.map((row) => [row.date, row.images]))
  const max = Math.max(1, ...usageFiltered.value.map((row) => row.images))
  const cells: Array<{ key: string; level: number; count: number }> = []
  const rangeDays = usageRange.value === 'all' ? HEATMAP_DAYS : usageRange.value === '30d' ? 30 : 7
  // 按卡片实际宽度收缩周数，保证热力图始终完整可见、不出现横向滚动条
  const fitWeeks = usageCardWidth.value > 0 ? Math.max(1, Math.floor((usageCardWidth.value + 3) / 13)) : 20
  const days = Math.min(rangeDays, fitWeeks * 7)
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dateKey(new Date(Date.now() - i * 86400000))
    const count = byDate.get(key) || 0
    cells.push({ key, count, level: count ? Math.max(1, Math.ceil((count / max) * 4)) : 0 })
  }
  return cells
})
const usageSelectedCell = computed(() => usageHeatmap.value.find((cell) => cell.key === usageSelectedDate.value) || null)
const usageChartRows = computed(() => {
  const byDate = new Map(usageDaily.value.map((row) => [row.date, row]))
  const days = usageRange.value === 'all' ? 70 : usageRange.value === '30d' ? 30 : 7
  const rows = []
  for (let index = 0; index < days; index += 1) {
    const date = dateKey(new Date(Date.now() - (days - 1 - index) * 86400000))
    const row = byDate.get(date)
    const resolutions = row?.resolutions
    rows.push({
      date,
      label: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`,
      showLabel: index === 0 || index === days - 1 || index % Math.max(1, Math.floor(days / 7)) === 0,
      total: Number(row?.images || 0),
      k1: Number(resolutions?.['1K'] || 0),
      k2: Number(resolutions?.['2K'] || 0),
      k4: Number(resolutions?.['4K'] || 0)
    })
  }
  return rows
})
const usageChartMax = computed(() => Math.max(1, ...usageChartRows.value.map((row) => row.total)))
const usageResolutionBreakdown = computed(() => {
  // 「历史」分档（旧版无分辨率字段的流水）不再展示，由系统自动归档隐藏。
  const keys = ['1K', '2K', '4K'] as const
  const range = usageRangeSummary.value?.resolution_breakdown
  const fallback = Object.fromEntries(keys.map((key) => [key, 0])) as Record<(typeof keys)[number], number>
  for (const row of usageFiltered.value) {
    for (const key of keys) fallback[key] += Number(row.resolutions?.[key] || 0)
  }
  const values = keys.map((key) => ({ key, images: Number(range?.[key]?.images ?? fallback[key]) }))
  const total = Math.max(1, values.reduce((sum, item) => sum + item.images, 0))
  return values.map((item) => ({ ...item, percent: item.images ? (item.images / total) * 100 : 0 }))
})
const usageSelectedChartDay = computed(() => usageChartRows.value.find((row) => row.date === usageSelectedDate.value) || null)
const usageFootnote = computed(() => {
  const images = usageTotals.value.images
  if (!images) return '还没有生成记录，从下面的对话框开始吧。'
  return `已生成 ${images.toLocaleString()} 张图，相当于 ${Math.ceil(images / 9)} 组朋友圈九宫格。`
})

function dateKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

async function loadOverview(): Promise<void> {
  if (!getToken()) {
    usage.value = null
    return
  }
  try {
    usage.value = await api.userOverview()
  } catch {
    usage.value = null
  }
}

function helpPlaceholder(): void {
  openPopover.value = ''
  manualOpen.value = true
}
watch(showPsdTaskTabs, (visible) => {
  if (!visible) psdTaskFilter.value = 'all'
})
const psdRunningCount = computed(() => psdTasks.value.filter((task) => task.status === 'processing').length)
const psdAttentionCount = computed(() => psdTasks.value.filter((task) => task.status === 'failed' && !isPsdInterruptedTask(task)).length)
const psdInterruptedCount = computed(() => psdTasks.value.filter((task) => isPsdInterruptedTask(task)).length)
const psdCompletedCount = computed(() => psdTasks.value.filter((task) => task.status === 'success').length)
const visiblePsdTasks = computed(() => {
  if (psdTaskFilter.value === 'running') return psdTasks.value.filter((task) => task.status === 'processing')
  if (psdTaskFilter.value === 'attention') return psdTasks.value.filter((task) => task.status === 'failed' && !isPsdInterruptedTask(task))
  if (psdTaskFilter.value === 'completed') return psdTasks.value.filter((task) => task.status === 'success')
  return psdTasks.value
})
function showMessage(message: string): void {
  globalMessage.value = message
  globalError.value = ''
  window.setTimeout(() => {
    if (globalMessage.value === message) globalMessage.value = ''
  }, 3200)
}

function cleanErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : ''
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim()
  return cleaned || fallback
}

function showError(error: unknown, fallback = '操作失败，请稍后重试'): void {
  const message = cleanErrorMessage(error, fallback)
  globalError.value = message
  globalMessage.value = ''
  window.setTimeout(() => {
    if (globalError.value === message) globalError.value = ''
  }, 5200)
}

function appendRecognizedText(text: string): void {
  const recognized = text.trim().replace(/\s+/g, ' ')
  if (!recognized) return
  const current = prompt.value.trimEnd()
  const separator = current && !/[，。！？；：,.!?;:\n]$/.test(current) ? '，' : ''
  prompt.value = `${current}${separator}${recognized}`.slice(0, 2000)
  nextTick(() => {
    autoGrowPrompt()
    promptRef.value?.focus()
    promptRef.value?.setSelectionRange(prompt.value.length, prompt.value.length)
  })
}

function clearVoiceStatusLater(expected: string, delay = 3600): void {
  window.setTimeout(() => {
    if (voiceStatus.value === expected) voiceStatus.value = ''
  }, delay)
}

function speechErrorMessage(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return '麦克风未授权，请在系统设置中允许访问'
  if (code === 'audio-capture') return '没有检测到可用麦克风'
  if (code === 'no-speech') return '没有听到语音，请靠近麦克风再试一次'
  if (code === 'network') return '语音识别服务暂时不可用，请检查网络后重试'
  if (code === 'aborted') return '已停止语音输入'
  return '语音识别失败，请再试一次'
}

// ===== 本地语音识别（macOS 原生 SFSpeechRecognizer helper，优先于浏览器识别） =====

let nativeVoiceActive = false

function handleNativeVoiceEvent(value: { type: string; text?: string; message?: string; code?: number }): void {
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

async function startNativeVoice(): Promise<void> {
  isVoiceRecognizing.value = true
  voiceStatus.value = '正在请求麦克风权限…'
  try {
    const granted = await window.desktop!.requestMicrophoneAccess()
    if (!granted) throw new Error('麦克风未授权，请在系统设置中允许访问')
    voiceFinalText = ''
    voiceInterimText = ''
    voiceFailed = false
    nativeVoiceActive = true
    voiceStatus.value = '正在启动语音识别…'
    await window.desktop!.voiceStart()
  } catch (error) {
    nativeVoiceActive = false
    isVoiceListening.value = false
    isVoiceRecognizing.value = false
    const message = cleanErrorMessage(error, '无法启动语音输入')
    voiceStatus.value = message
    clearVoiceStatusLater(message, 5200)
  }
}

async function toggleVoiceInput(): Promise<void> {
  if (isVoiceListening.value || isVoiceRecognizing.value) {
    isVoiceListening.value = false
    isVoiceRecognizing.value = true
    voiceStatus.value = '正在完成识别…'
    if (nativeVoiceActive) void window.desktop?.voiceStop()
    else speechRecognition?.stop()
    return
  }

  if (window.desktop?.voiceStart) {
    await startNativeVoice()
    return
  }

  const SpeechRecognitionConstructor = (window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }).SpeechRecognition || (window as unknown as {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }).webkitSpeechRecognition

  if (!SpeechRecognitionConstructor) {
    const message = '当前系统暂不支持语音识别，请使用 macOS 自带听写输入'
    voiceStatus.value = message
    clearVoiceStatusLater(message, 5200)
    return
  }

  isVoiceRecognizing.value = true
  voiceStatus.value = '正在请求麦克风权限…'
  try {
    const granted = window.desktop ? await window.desktop.requestMicrophoneAccess() : true
    if (!granted) throw new Error('麦克风未授权，请在系统设置中允许访问')

    speechRecognition?.abort()
    voiceFinalText = ''
    voiceInterimText = ''
    voiceFailed = false
    const recognition = new SpeechRecognitionConstructor()
    speechRecognition = recognition
    recognition.lang = 'zh-CN'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onstart = () => {
      isVoiceRecognizing.value = false
      isVoiceListening.value = true
      voiceStatus.value = '正在听，你可以开始说话…'
    }
    recognition.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = String(result?.[0]?.transcript || '')
        if (result?.isFinal) voiceFinalText += transcript
        else interim += transcript
      }
      voiceInterimText = interim
      const preview = (interim || voiceFinalText).trim()
      voiceStatus.value = preview ? `识别中：${preview}` : '正在识别…'
    }
    recognition.onerror = (event) => {
      voiceFailed = true
      const message = speechErrorMessage(event.error)
      isVoiceListening.value = false
      isVoiceRecognizing.value = false
      voiceStatus.value = message
      clearVoiceStatusLater(message, 5200)
    }
    recognition.onend = () => {
      const recognized = (voiceFinalText || voiceInterimText).trim()
      isVoiceListening.value = false
      isVoiceRecognizing.value = false
      speechRecognition = null
      if (voiceFailed) return
      if (recognized) {
        appendRecognizedText(recognized)
        voiceStatus.value = '已加入提示词'
        clearVoiceStatusLater('已加入提示词')
      } else {
        voiceStatus.value = '没有识别到内容，请再试一次'
        clearVoiceStatusLater('没有识别到内容，请再试一次', 5200)
      }
    }
    recognition.start()
  } catch (error) {
    isVoiceListening.value = false
    isVoiceRecognizing.value = false
    speechRecognition = null
    const message = cleanErrorMessage(error, '无法启动语音输入')
    voiceStatus.value = message
    clearVoiceStatusLater(message, 5200)
  }
}

function formatBytes(value: number): string {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const amount = value / (1024 ** index)
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

async function refreshPsdStorage(): Promise<void> {
  if (!window.desktop) return
  try {
    psdStorageBytes.value = await window.desktop.workspaceStorage()
  } catch {
    psdStorageBytes.value = 0
  }
  try {
    psdEngine.value = await window.desktop.psdEngineStatus()
  } catch {
    psdEngine.value = null
  }
  try {
    modelDiskBytes.value = await window.desktop.modelsDiskUsage()
  } catch {
    modelDiskBytes.value = 0
  }
}

const modelStatusLabel = computed(() => {
  switch (modelStatus.value.phase) {
    case 'seeding':
      return `首次准备模型… ${modelStatus.value.progress ?? 0}%`
    case 'repairing':
      return `修复中… ${modelStatus.value.progress ?? 0}%`
    case 'error':
      return modelStatus.value.message || '模型缺失'
    case 'checking':
      return '检查中…'
    default:
      return modelDiskBytes.value > 0 ? `模型缓存 ${formatBytes(modelDiskBytes.value)}` : '模型未缓存'
  }
})

async function repairModels(): Promise<void> {
  if (!window.desktop || modelBusy.value) return
  modelBusy.value = true
  try {
    const result = await window.desktop.modelsRepair()
    if (result.phase === 'ready') showMessage('模型已就绪')
    else showError(null, result.message || '模型修复失败')
    await refreshPsdStorage()
  } catch (error) {
    showError(error, '模型修复失败')
  } finally {
    modelBusy.value = false
  }
}

async function verifyModels(): Promise<void> {
  if (!window.desktop || modelBusy.value) return
  modelBusy.value = true
  try {
    const result = await window.desktop.modelsVerify()
    if (result.ok) showMessage('模型校验通过')
    else showError(null, `发现损坏文件：${result.corrupt.join('、')}，可点击修复`)
  } catch (error) {
    showError(error, '模型校验失败')
  } finally {
    modelBusy.value = false
  }
}

const updateAvailable = computed(() => ['available', 'downloading', 'staged'].includes(updateState.value.phase))

async function checkForUpdates(manual: boolean): Promise<void> {
  if (!window.desktop?.updateCheck) return
  try {
    const result = await window.desktop.updateCheck(manual)
    if (manual) {
      if (result.phase === 'up-to-date') showMessage('已是最新版本')
      else if (result.phase === 'available') updateModalOpen.value = true
      else if (result.phase === 'error') showError(null, result.message || '检查更新失败')
    }
  } catch (error) {
    if (manual) showError(error, '检查更新失败')
  }
}

async function downloadUpdate(): Promise<void> {
  if (!window.desktop?.updateDownload) return
  updateModalOpen.value = true
  await window.desktop.updateDownload()
}

async function applyUpdate(): Promise<void> {
  if (!window.desktop?.updateApply) return
  // PSD/修补任务运行时拒绝，避免中途被杀导致产物损坏
  if (psdTasks.value.some((task) => task.status === 'processing')) {
    showError(null, '有分层任务正在进行，请等它完成后再更新')
    return
  }
  await window.desktop.updateApply()
}

function openUpdateReleasePage(): void {
  const url = updateState.value.releasePage
  // 主进程 setWindowOpenHandler 会把 http(s) 路由到 shell.openExternal
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

async function pickPsdImage(): Promise<void> {
  if (!window.desktop) return showError(new Error('图片转 PSD 需要在 Mac App 中使用'))
  try {
    const selected = await window.desktop.selectPsdImage()
    if (selected) selectedPsdImage.value = selected
  } catch (error) {
    showError(error, '选择商品图失败')
  }
}

async function onPsdDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  if (!window.desktop) return showError(new Error('图片转 PSD 需要在 Mac App 中使用'))
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    return showError(new Error('仅支持 PNG、JPG 和 WebP'))
  }
  try {
    selectedPsdImage.value = await window.desktop.importPsdImage({
      name: file.name,
      type: file.type,
      bytes: await file.arrayBuffer()
    })
  } catch (error) {
    showError(error, '导入商品图失败')
  }
}

async function runPsdTask(task: PsdTask): Promise<void> {
  if (!window.desktop) return
  task.status = 'processing'
  task.progress = 2
  task.stage = '准备本地分层'
  task.error = ''
  try {
    // 半自动：先 AI 出主体/道具草稿 → 笔刷修 mask → 再导出
    if (psdSettings.semiAutoMask && window.desktop.preparePsdDraft) {
      task.stage = 'AI 识别主体与道具'
      const draft = await window.desktop.preparePsdDraft({
        taskId: task.id,
        imageId: task.image.id,
        options: {
          writeLayerMasks: psdSettings.writeLayerMasks,
          subjectProtection: psdSettings.subjectProtection
        }
      })
      task.progress = 100
      task.stage = '请修蒙版后导出'
      psdMaskEditor.value = {
        open: true,
        taskId: task.id,
        draft,
        exporting: false
      }
      showMessage('AI 初稿已出：涂一下主体/奖杯再导出')
      return
    }

    task.result = await window.desktop.processPsd({
      taskId: task.id,
      imageId: task.image.id,
      autoExport: psdSettings.autoExport,
      options: {
        writeLayerMasks: psdSettings.writeLayerMasks,
        subjectProtection: psdSettings.subjectProtection
      }
    })
    task.status = 'success'
    task.progress = 100
    const degraded = task.result.instanceCount === 0
    task.stage = degraded
      ? `未检测到主体，已按文字与背景分层（${task.result.layerNames.length} 个图层）`
      : `已导出 ${task.result.layerNames.length} 个图层`
    selectedPsdImage.value = null
    await refreshPsdStorage()
    showMessage(degraded ? '未检测到主体，已按文字与背景导出 PSD' : '分层 PSD 已导出')
    notifySystem('PSD 已导出', task.stage)
  } catch (error) {
    task.status = 'failed'
    task.error = cleanErrorMessage(error, 'PSD 分层失败')
    task.stage = '处理失败，可重新分层'
    showError(error, 'PSD 分层失败')
    notifySystem('PSD 分层失败', task.error)
  }
}

function cancelPsdMaskEditor(): void {
  const taskId = psdMaskEditor.value.taskId
  const task = psdTasks.value.find((item) => item.id === taskId)
  if (task && task.status === 'processing') {
    task.status = 'failed'
    task.error = '已取消修蒙版'
    task.stage = '已取消，可重新分层'
  }
  psdMaskEditor.value = { open: false, taskId: '', draft: null, exporting: false }
}

async function exportPsdFromMaskEditor(payload: {
  subjectMaskDataUrl: string
  propMaskDataUrl: string
}): Promise<void> {
  if (!window.desktop || !psdMaskEditor.value.draft) return
  const task = psdTasks.value.find((item) => item.id === psdMaskEditor.value.taskId)
  if (!task) return
  const draft = psdMaskEditor.value.draft
  psdMaskEditor.value.exporting = true
  task.status = 'processing'
  task.progress = 5
  task.stage = '正在按修过的蒙版导出 PSD'
  task.error = ''
  try {
    task.result = await window.desktop.processPsd({
      taskId: task.id,
      imageId: task.image.id,
      autoExport: psdSettings.autoExport,
      draftId: draft.draftId,
      subjectMaskDataUrl: payload.subjectMaskDataUrl,
      propMaskDataUrl: payload.propMaskDataUrl,
      width: draft.width,
      height: draft.height,
      options: {
        writeLayerMasks: psdSettings.writeLayerMasks,
        subjectProtection: psdSettings.subjectProtection
      }
    })
    task.status = 'success'
    task.progress = 100
    const degraded = task.result.instanceCount === 0
    task.stage = degraded
      ? `未检测到主体，已按文字与背景分层（${task.result.layerNames.length} 个图层）`
      : `已导出 ${task.result.layerNames.length} 个图层（半自动修蒙版）`
    selectedPsdImage.value = null
    psdMaskEditor.value = { open: false, taskId: '', draft: null, exporting: false }
    await refreshPsdStorage()
    showMessage('分层 PSD 已导出')
  } catch (error) {
    task.status = 'failed'
    task.error = cleanErrorMessage(error, 'PSD 导出失败')
    task.stage = '导出失败，可返回修改蒙版'
    psdMaskEditor.value.exporting = false
    showError(error, 'PSD 导出失败')
  }
}

function startPsdTask(image: DesktopSelectedImage): void {
  const task: PsdTask = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    image,
    status: 'processing',
    progress: 1,
    stage: '任务已创建',
    createdAt: Date.now()
  }
  psdTasks.value.unshift(task)
  psdRailOpen.value = true
  void runPsdTask(task)
}

function createPsdTask(): void {
  if (!selectedPsdImage.value) return showError(new Error('请先选择一张商品图'))
  startPsdTask(selectedPsdImage.value)
}

function retryPsdTask(task: PsdTask): void {
  void runPsdTask(task)
}

async function revealPsd(task: PsdTask): Promise<void> {
  if (!task.result || !window.desktop) return
  try {
    await window.desktop.revealPsd(task.result.path)
  } catch (error) {
    showError(error, '无法定位 PSD')
  }
}

async function openPsd(task: PsdTask): Promise<void> {
  if (!task.result || !window.desktop) return
  try {
    // 优先在 Photoshop 打开；无 PS 时 API 会 fallback 系统默认应用
    if (window.desktop.openInPhotoshop) {
      const result = await window.desktop.openInPhotoshop(task.result.path)
      if (result?.fallback) showMessage('未检测到 Photoshop，已用系统默认应用打开')
      return
    }
    await window.desktop.openPsd(task.result.path)
  } catch (error) {
    showError(error, '在 Photoshop 打开失败')
  }
}

async function openFileInPhotopea(filePath: string, taskId = ''): Promise<void> {
  if (!window.desktop?.openInPhotopea) throw new Error('当前版本不支持 Photopea 编辑')
  const pathValue = String(filePath || '').trim()
  if (!pathValue) throw new Error('缺少可编辑文件')
  await window.desktop.openInPhotopea({
    filePath: pathValue,
    theme: settings.theme,
    taskId: String(taskId || '')
  })
}

async function openPsdInPhotopea(task: PsdTask): Promise<void> {
  if (!task.result || openingInPhotopea.value) return
  openingInPhotopea.value = true
  try {
    await openFileInPhotopea(task.result.path, task.id)
    showMessage('已在 Photopea 打开，可直接编辑图层')
  } catch (error) {
    showError(error, '在 Photopea 打开失败')
  } finally {
    openingInPhotopea.value = false
  }
}

async function openPreviewInPhotopea(): Promise<void> {
  const preview = previewImage.value
  const task = preview?.task
  if (!preview || !task || openingInPhotopea.value) return
  openingInPhotopea.value = true
  try {
    const filePath = await ensurePreviewLocalPath({ src: preview.src, task })
    if (!filePath) throw new Error('无法准备本地图片，请先下载或使用「一键转 PSD」')
    await openFileInPhotopea(filePath, String(task.id))
    showMessage('已在 Photopea 打开')
  } catch (error) {
    showError(error, '在 Photopea 打开失败')
  } finally {
    openingInPhotopea.value = false
  }
}

function handlePhotopeaEvent(event: {
  type: 'saved' | 'closed' | 'error'
  path?: string
  mode?: 'overwrite' | 'saveAs'
  taskId?: string
  message?: string
}): void {
  if (event.type === 'saved') {
    const savedPath = String(event.path || '')
    const taskId = String(event.taskId || '')
    if (taskId && savedPath) {
      const task = psdTasks.value.find((item) => item.id === taskId)
      if (task?.result) {
        task.result.path = savedPath
        task.result.size = Number(task.result.size || 0)
        task.stage = event.mode === 'saveAs' ? '已在 Photopea 另存' : '已在 Photopea 保存'
      }
    }
    void refreshPsdStorage()
    showMessage(event.mode === 'saveAs' ? 'Photopea 已另存到工作区' : 'Photopea 已保存到工作区')
    return
  }
  if (event.type === 'error' && event.message) {
    showError(new Error(event.message), 'Photopea 编辑出错')
  }
}

function togglePsdRail(): void {
  psdRailOpen.value = !psdRailOpen.value
}

function normalizeList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  if (!value || typeof value !== 'object') return []
  const row = value as Record<string, unknown>
  for (const key of ['lists', 'list', 'data', 'providers']) {
    if (Array.isArray(row[key])) return normalizeList(row[key])
  }
  return []
}

function normalizeResultImages(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === 'string' ? item : String((item as Record<string, unknown>)?.url || (item as Record<string, unknown>)?.image || ''))
      .map(absoluteAssetUrl)
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      return normalizeResultImages(JSON.parse(trimmed))
    } catch {
      return [absoluteAssetUrl(trimmed)].filter(Boolean)
    }
  }
  return []
}

function extractUploadUrl(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  return String(row.url || row.uri || row.path || '').trim()
}

function persistTasks(): void {
  const payload = tasks.value
    .filter((task) => Number(task.id) > 0)
    .slice(0, 100)
    .map((task) => ({
      ...task,
      resultImages: task.resultImages.filter((url) => !String(url || '').startsWith('data:'))
    }))
  localStorage.setItem(TASKS_KEY, JSON.stringify(payload))
}

function persistPsdTasks(): void {
  try {
    // 预览图 base64 很大，只给最近若干条留缩略图，避免撑爆 localStorage
    // 注意：进行中任务原样写入；不要在持久化时改成 failed（会把成功记录冲掉）
    const KEEP_PREVIEW = 12
    const payload = psdTasks.value.slice(0, 80).map((task, index) => {
      const preview = String(task.image?.previewDataUrl || '')
      const keepPreview = index < KEEP_PREVIEW && preview.length > 0 && preview.length < 400_000
      return {
        id: task.id,
        status: task.status,
        progress: task.progress,
        stage: task.stage,
        createdAt: task.createdAt,
        error: task.error || '',
        image: {
          id: task.image?.id || '',
          name: task.image?.name || '商品图',
          type: task.image?.type || 'image/png',
          size: Number(task.image?.size || 0),
          previewDataUrl: keepPreview ? preview : ''
        },
        result: task.result
          ? {
              path: task.result.path,
              width: task.result.width,
              height: task.result.height,
              size: task.result.size,
              layerNames: task.result.layerNames || [],
              textRegionCount: task.result.textRegionCount || 0,
              instanceCount: task.result.instanceCount || 0
            }
          : undefined
      }
    })
    localStorage.setItem(PSD_TASKS_KEY, JSON.stringify(payload))
  } catch (error) {
    console.warn('PSD 任务历史写入失败：', error)
  }
}

function restorePsdTasks(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(PSD_TASKS_KEY) || '[]') as PsdTask[]
    if (!Array.isArray(raw)) {
      psdTasks.value = []
      return
    }
    psdTasks.value = raw
      .filter((task) => task && task.id && task.image)
      .slice(0, 80)
      .map((task) => {
        const image = {
          id: task.image.id || '',
          name: task.image.name || '商品图',
          type: task.image.type || 'image/png',
          size: Number(task.image.size || 0),
          previewDataUrl: task.image.previewDataUrl || ''
        }
        // 已有导出结果 → 一律视为成功（防止历史状态被写坏）
        if (task.result?.path) {
          return {
            ...task,
            status: 'success' as const,
            progress: 100,
            stage: task.stage?.includes('图层') ? task.stage : `已导出 ${task.result.layerNames?.length || 0} 个图层`,
            error: '',
            image
          }
        }
        // 启动时清理「进行中」僵尸任务：无结果记为中断（不是业务失败，勿显示成「失败」）
        if (task.status === 'processing' || task.status === 'interrupted') {
          return {
            ...task,
            status: 'interrupted' as const,
            progress: 0,
            stage: '上次未完成（应用关闭）',
            error: '上次退出时任务未完成，请重新选图分层',
            image
          }
        }
        // 旧版把中断误标成 failed：升级为 interrupted
        if (
          task.status === 'failed' &&
          (
            String(task.error || '').includes('应用关闭') ||
            String(task.error || '').includes('退出时任务未完成') ||
            String(task.stage || '').includes('中断') ||
            String(task.stage || '').includes('上次未完成')
          )
        ) {
          return {
            ...task,
            status: 'interrupted' as const,
            progress: 0,
            stage: '上次未完成（应用关闭）',
            error: '上次退出时任务未完成，请重新选图分层',
            image
          }
        }
        return { ...task, image }
      })
    // 有历史时默认展开右栏，方便接着看
    if (psdTasks.value.length) psdRailOpen.value = true
  } catch {
    psdTasks.value = []
  }
}

/** 清理「仅因退出中断」的失败记录，成功记录保留 */
function clearInterruptedPsdTasks(): void {
  psdTasks.value = psdTasks.value.filter((task) => {
    if (task.result?.path) return true
    if (task.status === 'interrupted') return false
    if (task.status !== 'failed') return true
    const msg = `${task.error || ''}${task.stage || ''}`
    return !msg.includes('退出') && !msg.includes('中断') && !msg.includes('关闭') && !msg.includes('未完成')
  })
}

function psdStatusLabel(status: PsdTaskStatus): string {
  if (status === 'success') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'interrupted') return '已中断'
  return '进行中'
}

function isPsdInterruptedTask(task: PsdTask): boolean {
  if (task.status === 'interrupted') return true
  if (task.status !== 'failed' || task.result?.path) return false
  const msg = `${task.error || ''}${task.stage || ''}`
  return msg.includes('退出') || msg.includes('中断') || msg.includes('关闭') || msg.includes('未完成')
}

function sortNewestFirst(items: LocalTask[]): LocalTask[] {
  return items.sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id))
}

function restoreTasks(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]') as LocalTask[]
    const list = Array.isArray(raw) ? raw.filter((task) => Number(task.id) > 0 && !isTaskHidden(Number(task.id))) : []
    tasks.value = sortNewestFirst(list.slice(0, 100))
    void restoreLocalCropPreviews()
  } catch {
    tasks.value = []
  }
}

async function restoreLocalCropPreviews(): Promise<void> {
  if (!window.desktop?.readLocalCropPreview) return
  let changed = false
  for (const task of tasks.value) {
    if (!isLocalCropTask(task) && !task.localCropMeta && !task.savedFiles.some((file) => String(file.url || '').startsWith('local-crop-composite://'))) {
      continue
    }
    if (!task.toolScene && isLocalCropTask(task)) {
      task.toolScene = 'crop'
      changed = true
    }
    // 历史同步曾丢掉 localCropMeta 时，尝试从 savedFiles 找回拼合路径
    if (!task.localCropMeta?.compositePath) {
      const saved = task.savedFiles.find((file) => String(file.url || '').startsWith('local-crop-composite://'))
      if (saved?.path && task.localCropMeta) {
        task.localCropMeta.compositePath = saved.path
        changed = true
      } else if (saved?.path) {
        // meta 整段丢失时至少挂上路径，让画廊能恢复拼合预览
        task.localCropMeta = {
          sceneImageId: '',
          cropBox: { x: 0, y: 0, size: 0 },
          hasMask: false,
          compositePath: saved.path
        }
        changed = true
      }
    }
    // 主进程可按任务 ID 找回输出目录里的 local-crop-{id}-*.png
    if (!task.localCropMeta?.compositePath && window.desktop.findLocalCropComposite) {
      try {
        const found = await window.desktop.findLocalCropComposite(task.id)
        if (found?.path) {
          task.localCropMeta = {
            sceneImageId: task.localCropMeta?.sceneImageId || '',
            cropBox: task.localCropMeta?.cropBox || { x: 0, y: 0, size: 0 },
            hasMask: Boolean(task.localCropMeta?.hasMask),
            maskPaths: task.localCropMeta?.maskPaths,
            productSources: task.localCropMeta?.productSources,
            scenePath: task.localCropMeta?.scenePath,
            compositePath: found.path,
            compositeWidth: Number(found.width || task.localCropMeta?.compositeWidth || 0) || undefined,
            compositeHeight: Number(found.height || task.localCropMeta?.compositeHeight || 0) || undefined
          }
          if (!task.savedFiles.some((file) => file.path === found.path)) {
            task.savedFiles.push({ url: `local-crop-composite://${task.id}`, path: found.path, sha256: '' })
          }
          changed = true
        }
      } catch {
        // 找不到本地拼合文件时继续
      }
    }
    const compositePath = task.localCropMeta?.compositePath
    if (!compositePath || task.resultImages.some((url) => url.startsWith('data:'))) continue
    try {
      const preview = await window.desktop.readLocalCropPreview(compositePath)
      task.resultImages = [preview.previewDataUrl, ...task.resultImages.filter((url) => !url.startsWith('data:'))]
      changed = true
    } catch {
      // 合成预览丢失时 galleryImages 会对 crop 任务返回空，避免裁切小图冒充作品
    }
  }
  if (changed) persistTasks()
}

async function maybeCompositeLocalCrop(task: LocalTask): Promise<void> {
  const meta = task.localCropMeta
  if (!meta || meta.compositePath || !task.resultImages[0] || !window.desktop?.compositeLocalCrop) return
  try {
    const result = await window.desktop.compositeLocalCrop({
      taskId: task.id,
      sceneImageId: meta.sceneImageId,
      scenePath: meta.scenePath,
      patchUrl: task.resultImages[0],
      // meta 来自响应式 tasks 数组，meta.cropBox 读出来仍是 Proxy；IPC 走 structured clone
      // 无法序列化 Proxy，这里转成纯对象再传给主进程
      cropBox: { x: meta.cropBox.x, y: meta.cropBox.y, size: meta.cropBox.size },
      maskPaths: Array.isArray(meta.maskPaths)
        ? meta.maskPaths.map((pathItem) => ({
            points: (pathItem.points || []).map((pt) => ({ x: Number(pt.x || 0), y: Number(pt.y || 0) })),
            brushSize: Number(pathItem.brushSize || 0),
            isEraser: Boolean(pathItem.isEraser)
          }))
        : undefined
    })
    meta.compositePath = result.path
    meta.compositeWidth = Number(result.width || 0) || undefined
    meta.compositeHeight = Number(result.height || 0) || undefined
    task.toolScene = 'crop'
    task.resultImages = [result.previewDataUrl, ...task.resultImages.filter((url) => !String(url).startsWith('data:'))]
    if (!task.savedFiles.some((file) => file.path === result.path)) {
      task.savedFiles.push({
        url: `local-crop-composite://${task.id}`,
        path: result.path,
        sha256: ''
      })
    }
    showMessage('局部重绘结果已回贴到原图')
    persistTasks()
  } catch (error) {
    task.downloadError = error instanceof Error ? error.message : '回贴合成失败，仍可查看生成原片'
    persistTasks()
  }
}

function parseCreatedAt(value: unknown): number {
  const numeric = Number(value || 0)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = Date.parse(String(value || '').trim().replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function parseToolInputs(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function extractToolScene(row: Record<string, unknown>, cached?: LocalTask): string {
  const regenerate = row.regenerate_params && typeof row.regenerate_params === 'object'
    ? row.regenerate_params as Record<string, unknown>
    : null
  const fromRow = String(
    row.tool_scene
    || row.scene
    || regenerate?.tool_scene
    || regenerate?.scene
    || cached?.toolScene
    || ''
  ).trim()
  if (fromRow) return fromRow
  const prompt = String(row.prompt || cached?.prompt || '')
  if (prompt.includes(LOCAL_CROP_PRESERVE_GUARD) || prompt.includes('灰色选区') || prompt.includes(DEFAULT_LOCAL_CROP_PROMPT.slice(0, 18))) {
    return 'crop'
  }
  if (cached?.localCropMeta) return 'crop'
  return ''
}

function localCropMetaFromServer(
  row: Record<string, unknown>,
  cached: LocalTask | undefined,
  toolScene: string,
  sourceImages: string[]
): LocalCropMeta | undefined {
  const regenerate = row.regenerate_params && typeof row.regenerate_params === 'object'
    ? row.regenerate_params as Record<string, unknown>
    : null
  const inputs = parseToolInputs(regenerate?.tool_inputs ?? row.tool_inputs)
  const cropBoxRaw = inputs?.crop_box && typeof inputs.crop_box === 'object'
    ? inputs.crop_box as Record<string, unknown>
    : null
  const cropBox = cropBoxRaw
    ? {
        x: Number(cropBoxRaw.x || 0),
        y: Number(cropBoxRaw.y || 0),
        size: Number(cropBoxRaw.size || 0)
      }
    : cached?.localCropMeta?.cropBox
  const hasMask = Boolean(
    inputs?.has_mask
    ?? cached?.localCropMeta?.hasMask
    ?? (cropBox && cropBox.size > 0)
  )
  const compositeFromSaved = (cached?.savedFiles || []).find((file) => String(file.url || '').startsWith('local-crop-composite://'))
  const compositePath = cached?.localCropMeta?.compositePath || compositeFromSaved?.path || undefined
  const productSources = [
    ...(cached?.localCropMeta?.productSources || []),
    ...sourceImages.slice(1)
  ].filter((url, index, arr) => url && arr.indexOf(url) === index).slice(0, 3)

  if (cached?.localCropMeta) {
    return {
      ...cached.localCropMeta,
      cropBox: cropBox && cropBox.size > 0 ? cropBox : cached.localCropMeta.cropBox,
      hasMask: cached.localCropMeta.hasMask || hasMask,
      compositePath: cached.localCropMeta.compositePath || compositePath,
      productSources: cached.localCropMeta.productSources?.length ? cached.localCropMeta.productSources : productSources
    }
  }

  if (toolScene !== 'crop' && !compositePath && !(cropBox && cropBox.size > 0)) return undefined
  return {
    sceneImageId: cached?.localCropMeta?.sceneImageId || '',
    cropBox: cropBox && cropBox.size > 0 ? cropBox : { x: 0, y: 0, size: 0 },
    hasMask,
    maskPaths: cached?.localCropMeta?.maskPaths,
    productSources: productSources.length ? productSources : undefined,
    scenePath: cached?.localCropMeta?.scenePath,
    compositePath
  }
}

function historyTaskFromServer(row: Record<string, unknown>, cached?: LocalTask): LocalTask | null {
  const id = Number(row.id || row.task_id || 0)
  if (id <= 0 || String(row.media_type || 'image') !== 'image') return null
  const statusCode = Number(row.status ?? 0)
  const resultImages = normalizeResultImages(
    row.result_images || row.result_image || row.images || row.result_thumbs || row.image || row.cover
  )
  const status: TaskStatus = statusCode === 3
    ? 'failed'
    : (statusCode === 2 || resultImages.length ? 'success' : (statusCode === 0 ? 'queued' : 'running'))
  const sourceImages = normalizeResultImages(row.source_images || row.source_image)
  const toolScene = extractToolScene(row, cached)
  const mergedSources = sourceImages.length ? sourceImages : (cached?.sourceImages || [])
  const localCropMeta = localCropMetaFromServer(row, cached, toolScene, mergedSources)
  // 局部重绘：服务端 result 是裁切补丁；本地已有 data/blob 拼合预览时优先保留，避免同步冲掉
  const cachedCompositePreview = (cached?.resultImages || []).find((url) => url.startsWith('data:') || url.startsWith('blob:'))
  const mergedResults = (toolScene === 'crop' || localCropMeta)
    ? (cachedCompositePreview ? [cachedCompositePreview, ...resultImages.filter((url) => url !== cachedCompositePreview)] : resultImages)
    : resultImages
  return {
    id,
    prompt: String(row.prompt || row.title || cached?.prompt || 'AI 生成图片'),
    size: String(row.size || cached?.size || ''),
    status,
    progress: status === 'success' ? 100 : Math.max(0, Math.min(99, Number(row.progress ?? cached?.progress ?? 0))),
    createdAt: parseCreatedAt(row.create_time || row.created_at || cached?.createdAt),
    resultImages: mergedResults,
    savedFiles: cached?.savedFiles || [],
    sourceImages: mergedSources.length ? mergedSources : undefined,
    quality: String(row.quality || cached?.quality || '') || undefined,
    resolution: String(row.resolution || cached?.resolution || '') || undefined,
    providerId: Number(row.provider_id || cached?.providerId || 0) || undefined,
    error: status === 'failed' ? String(row.error_msg || row.fail_reason || cached?.error || '生成失败') : '',
    downloadError: cached?.downloadError || '',
    toolScene: toolScene || cached?.toolScene,
    localCropMeta
  }
}

async function syncTaskHistory(): Promise<void> {
  if (!getToken() || historySyncing.value) return
  historySyncing.value = true
  historySyncError.value = ''
  try {
    const cachedById = new Map(tasks.value.map((task) => [task.id, task]))
    const rows: Array<Record<string, unknown>> = []
    const seen = new Set<number>()
    let page = 1
    let total = Number.POSITIVE_INFINITY
    while (page <= HISTORY_MAX_PAGES && rows.length < total) {
      const data = await api.taskHistory(page, HISTORY_PAGE_SIZE)
      const pageRows = normalizeList(data)
      total = Math.max(0, Number(data.count ?? pageRows.length))
      for (const row of pageRows) {
        const id = Number(row.id || row.task_id || 0)
        if (id <= 0 || seen.has(id)) continue
        seen.add(id)
        rows.push(row)
      }
      if (pageRows.length < HISTORY_PAGE_SIZE || rows.length >= total) break
      page += 1
    }
    const synced = rows
      .map((row) => historyTaskFromServer(row, cachedById.get(Number(row.id || row.task_id || 0))))
      .filter((task): task is LocalTask => Boolean(task))
      .filter((task) => !isTaskHidden(task.id))
    const serverIds = new Set(synced.map((task) => task.id))
    const localPending = tasks.value.filter(
      (task) => !serverIds.has(task.id) && (task.status === 'queued' || task.status === 'running') && !isTaskHidden(task.id)
    )
    // 赋值前再滤一遍：避免同步过程中用户删除导致已隐藏任务被写回
    tasks.value = purgeHiddenTasksFromList(sortNewestFirst([...localPending, ...synced]))
    persistTasks()
    // 同步会用服务端 resultImages 覆盖本地；把已拼合任务的预览从 compositePath 再挂回去
    void restoreLocalCropPreviews()
    for (const task of tasks.value.filter((item) => item.status === 'queued' || item.status === 'running')) {
      void pollTask(task.id, 0)
    }
  } catch (error) {
    historySyncError.value = error instanceof Error ? error.message : '历史图片同步失败'
    if (error instanceof ApiError && error.authExpired) {
      user.value = null
      usage.value = null
      tasks.value = []
      localStorage.removeItem(TASKS_KEY)
      loginOpen.value = true
    }
  } finally {
    historySyncing.value = false
  }
}

async function restorePersistentSession(): Promise<void> {
  if (!window.desktop) return
  try {
    const session = await window.desktop.getSession()
    if (session?.token) {
      setToken(session.token)
      user.value = session.user as UserInfo
      setStoredUser(user.value)
      return
    }
    const token = getToken()
    if (token && user.value) {
      await window.desktop.saveSession({
        token,
        user: user.value as unknown as Record<string, unknown>
      })
    }
  } catch {
    // 系统安全存储不可用时继续使用当前渲染层会话，不阻断启动。
  }
}

function applyTheme(): void {
  const next = settings.theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : settings.theme
  document.documentElement.dataset.theme = next
}

async function loadDesktopState(): Promise<void> {
  if (!window.desktop) return
  try {
    const info = await window.desktop.getInfo()
    Object.assign(appInfo, info)
    setDevKeepSession(Boolean(info.devFakeSession))
    Object.assign(settings, await window.desktop.getSettings())
    selectedProviderId.value = settings.generationProviderId
    selectedSize.value = settings.generationSize
    quality.value = settings.generationQuality
    resolution.value = settings.generationResolution
    count.value = settings.generationCount
    applyTheme()
  } catch (error) {
    showError(error, '桌面设置加载失败')
  }
}

function currentDesktopSettings(): DesktopSettings {
  return {
    ...settings,
    generationProviderId: selectedProviderId.value,
    generationSize: selectedSize.value,
    generationQuality: quality.value,
    generationResolution: resolution.value,
    generationCount: count.value
  }
}

async function persistGenerationSettings(): Promise<void> {
  if (!window.desktop || !generationSettingsReady.value) return
  try {
    Object.assign(settings, await window.desktop.saveSettings(currentDesktopSettings()))
  } catch (error) {
    showError(error, '生成参数保存失败')
  }
}

function scheduleGenerationSettingsSave(): void {
  if (!generationSettingsReady.value) return
  if (generationSettingsTimer !== null) window.clearTimeout(generationSettingsTimer)
  generationSettingsTimer = window.setTimeout(() => {
    generationSettingsTimer = null
    void persistGenerationSettings()
  }, 180)
}

async function loadServiceConfig(): Promise<void> {
  try {
    const config = await api.serviceConfig()
    const pcSite = config.pc_site && typeof config.pc_site === 'object' ? config.pc_site as Record<string, unknown> : {}
    brandName.value = String(pcSite.site_title || config.brand_name || 'AI 图像工作台')
    fallbackUnitCost.value = Math.max(0, Number(config.credits_per_image || 49))
    const loginConfig = config.login && typeof config.login === 'object' ? config.login as Record<string, unknown> : {}
    loginAgreementRequired.value = Number(loginConfig.login_agreement || 0) === 1
    wechatLoginAvailable.value = Number(loginConfig.third_auth || 0) === 1 && Number(loginConfig.wechat_auth || 0) === 1
  } catch {
    brandName.value = 'AI 图像工作台'
  }
}

function normalizeParameterOptions(value: unknown): ParameterOption[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return { label: item, value: item, credits: null }
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const optionValue = String(row.value ?? row.id ?? '').trim()
      if (!optionValue) return null
      const rawCredits = row.credits
      return {
        label: String(row.label || row.name || optionValue),
        value: optionValue,
        credits: rawCredits === undefined || rawCredits === null ? null : Math.max(0, Number(rawCredits) || 0)
      }
    })
    .filter((item): item is ParameterOption => Boolean(item))
}

function syncProviderSelections(): void {
  const provider = activeProvider.value
  if (!provider) return
  if (!provider.sizeOptions.some((item) => item.value === selectedSize.value)) {
    selectedSize.value = provider.sizeOptions[0]?.value || '1:1'
  }
  if (!provider.qualityOptions.some((item) => item.value === quality.value)) {
    quality.value = provider.qualityOptions[0]?.value || 'low'
  }
  if (!provider.resolutionOptions.some((item) => item.value === resolution.value)) {
    resolution.value = provider.resolutionOptions[0]?.value || '1K'
  }
}

async function loadProviders(): Promise<void> {
  try {
    const data = await api.providers(createMode.value === 'image' ? 'img2img' : 'text2img')
    const options = normalizeList(data).map((row) => ({
      id: Number(row.id || row.provider_id || 0),
      label: String(row.name || row.label || row.title || '默认线路'),
      model: String(row.model_label || row.model || ''),
      isDefault: Boolean(Number(row.is_default || row.default || 0)),
      sizeOptions: normalizeParameterOptions(row.size_options),
      qualityOptions: normalizeParameterOptions(row.quality_options),
      resolutionOptions: normalizeParameterOptions(row.resolution_options),
      priceMatrix: row.price_matrix && typeof row.price_matrix === 'object' ? row.price_matrix as PriceMatrix : {},
      referenceImageCredits: Math.max(0, Number(row.reference_image_credits || 0))
    }))
    providers.value = options.length ? options : [{
      id: 0,
      label: '租户默认线路',
      model: '',
      isDefault: true,
      sizeOptions: [{ label: '正方形', value: '1:1', credits: fallbackUnitCost.value }],
      qualityOptions: [{ label: '默认', value: 'low', credits: 0 }],
      resolutionOptions: [{ label: '标准 1K', value: '1K', credits: 0 }],
      priceMatrix: {},
      referenceImageCredits: 0
    }]
    if (!providers.value.some((item) => item.id === selectedProviderId.value)) {
      selectedProviderId.value = (providers.value.find((item) => item.isDefault) || providers.value[0]).id
    }
    syncProviderSelections()
  } catch {
    providers.value = [{
      id: 0,
      label: '租户默认线路',
      model: '',
      isDefault: true,
      sizeOptions: [{ label: '正方形', value: '1:1', credits: fallbackUnitCost.value }],
      qualityOptions: [{ label: '默认', value: 'low', credits: 0 }],
      resolutionOptions: [{ label: '标准 1K', value: '1K', credits: 0 }],
      priceMatrix: {},
      referenceImageCredits: 0
    }]
    selectedProviderId.value = 0
    syncProviderSelections()
  }
}

async function refreshCredits(): Promise<void> {
  if (!getToken()) return
  try {
    const stats = await api.userStats()
    user.value = {
      ...(user.value || {}),
      credits: Number(stats.credits ?? user.value?.credits ?? 0),
      balance: Number(stats.balance ?? user.value?.balance ?? 0),
      isMember: Number(stats.is_member ?? (user.value?.isMember ? 1 : 0)) === 1
    }
    usedCredits.value = Number(stats.used_credits || 0)
    setStoredUser(user.value)
    const token = getToken()
    if (token && user.value) {
      void window.desktop?.saveSession({
        token,
        user: user.value as unknown as Record<string, unknown>
      }).catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof ApiError && error.authExpired) {
      user.value = null
      usage.value = null
      tasks.value = []
      localStorage.removeItem(TASKS_KEY)
      loginOpen.value = true
    }
  }
}

function switchMode(mode: CreateMode): void {
  createMode.value = mode
  void loadProviders()
}

async function addReferences(): Promise<void> {
  if (createMode.value !== 'image') switchMode('image')
  await pickImages()
}

async function pickImages(): Promise<void> {
  if (references.value.length >= MAX_REFERENCES) return showError(new Error('最多选择 4 张参考图'))
  if (!window.desktop) {
    inputRef.value?.click()
    return
  }
  try {
    const selected = await window.desktop.selectImages()
    const remaining = MAX_REFERENCES - references.value.length
    references.value.push(...selected.slice(0, remaining).map((item) => ({
      key: item.id,
      nativeId: item.id,
      name: item.name,
      preview: item.previewDataUrl
    })))
    if (selected.length) createMode.value = 'image'
  } catch (error) {
    showError(error, '选择图片失败')
  }
}

function addBrowserFiles(files: File[]): void {
  const accepted = files.filter((file) => file.type.startsWith('image/')).slice(0, MAX_REFERENCES - references.value.length)
  references.value.push(...accepted.map((file) => ({
    key: `${file.name}-${file.lastModified}-${Math.random()}`,
    name: file.name,
    preview: URL.createObjectURL(file),
    file
  })))
  if (accepted.length) createMode.value = 'image'
}

function onFileInput(event: Event): void {
  const target = event.target as HTMLInputElement
  addBrowserFiles(Array.from(target.files || []))
  target.value = ''
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  addBrowserFiles(Array.from(event.dataTransfer?.files || []))
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
  if (!files.length) return
  event.preventDefault()
  if (references.value.length >= MAX_REFERENCES) return showError(new Error('最多选择 4 张参考图'))
  addBrowserFiles(files)
}

function removeReference(index: number): void {
  const [removed] = references.value.splice(index, 1)
  if (removed?.file && removed.preview.startsWith('blob:')) URL.revokeObjectURL(removed.preview)
}

async function referenceToFile(item: ReferenceImage): Promise<File> {
  if (item.file) return item.file
  if (!item.nativeId || !window.desktop) throw new Error('本地图片授权已失效，请重新选择')
  const selected = await window.desktop.readSelectedImage(item.nativeId)
  const view = selected.bytes instanceof Uint8Array ? selected.bytes : new Uint8Array(selected.bytes)
  const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  return new File([buffer], selected.name, { type: selected.type })
}

async function uploadReferences(): Promise<string[]> {
  const urls: string[] = []
  for (const item of references.value.slice(0, MAX_REFERENCES)) {
    if (item.remoteUrl) {
      urls.push(item.remoteUrl)
      continue
    }
    item.uploading = true
    item.error = ''
    try {
      const file = await referenceToFile(item)
      const url = extractUploadUrl(await api.uploadImage(file))
      if (!url) throw new Error('上传接口未返回图片地址')
      urls.push(url)
    } catch (error) {
      item.error = error instanceof Error ? error.message : '上传失败'
      throw error
    } finally {
      item.uploading = false
    }
  }
  return urls
}

function createLocalTask(
  id: number,
  taskPrompt = prompt.value.trim() || '参考上传图片生成新图',
  taskSize = selectedSize.value,
  extras?: Partial<Pick<LocalTask, 'sourceImages' | 'quality' | 'resolution' | 'providerId' | 'localCropMeta' | 'toolScene'>>
): LocalTask {
  return {
    id,
    prompt: taskPrompt,
    size: taskSize,
    status: 'queued',
    progress: 4,
    createdAt: Date.now(),
    resultImages: [],
    savedFiles: [],
    sourceImages: extras?.sourceImages?.length ? extras.sourceImages : undefined,
    quality: extras?.quality ?? quality.value,
    resolution: extras?.resolution ?? resolution.value,
    providerId: extras?.providerId ?? selectedProviderId.value,
    toolScene: extras?.toolScene || (extras?.localCropMeta ? 'crop' : undefined),
    localCropMeta: extras?.localCropMeta
  }
}

async function uploadWorkflowImage(image: DesktopSelectedImage): Promise<string> {
  if (!window.desktop) throw new Error('桌面图片读取能力不可用')
  const selected = await window.desktop.readSelectedImage(image.id)
  const view = selected.bytes instanceof Uint8Array ? selected.bytes : new Uint8Array(selected.bytes)
  const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  const file = new File([buffer], selected.name || image.name, { type: selected.type || image.type })
  const url = extractUploadUrl(await api.uploadImage(file))
  if (!url) throw new Error(`上传 ${image.name} 后未返回图片地址`)
  return url
}

function focusCreationFeed(): void {
  navMode.value = 'creation'
  // 局部重绘/图片生成：留在当前页；批量创作也留在当前页，只打开右栏看进度
  // 不要再强制切到 quick，否则提交后表单被卸掉、体验像“页面被冲掉”
  void nextTick(() => contentRef.value?.scrollTo({ top: 0, behavior: 'smooth' }))
}

function runningTaskCaption(task: LocalTask): string {
  if (task.id <= 0) return '生成中 · 准备中'
  return `生成中 · 任务 #${task.id}`
}

function beginPreparingTask(
  taskPrompt: string,
  extras?: Partial<Pick<LocalTask, 'size' | 'quality' | 'resolution' | 'providerId' | 'localCropMeta'>>
): number {
  focusCreationFeed()
  // 提交即打开右栏；中间工作区保持当前生成模式，不再切成作品瀑布。
  setHistoryRail(true)
  if (preparingTaskId.value != null) {
    tasks.value = tasks.value.filter((task) => task.id !== preparingTaskId.value)
  }
  const id = -Date.now()
  preparingTaskId.value = id
  const task = createLocalTask(id, taskPrompt, extras?.size || selectedSize.value, {
    quality: extras?.quality,
    resolution: extras?.resolution,
    providerId: extras?.providerId,
    localCropMeta: extras?.localCropMeta
  })
  task.progress = 8
  tasks.value = sortNewestFirst([task, ...tasks.value])
  return id
}

function bumpPreparingProgress(next = 18): void {
  const id = preparingTaskId.value
  if (id == null) return
  const task = tasks.value.find((item) => item.id === id)
  if (!task || task.status === 'failed') return
  task.progress = Math.max(task.progress, next)
}

function clearPreparingTask(): void {
  const id = preparingTaskId.value
  if (id == null) return
  preparingTaskId.value = null
  tasks.value = tasks.value.filter((task) => task.id !== id)
}

function failPreparingTask(message: string): void {
  const id = preparingTaskId.value
  if (id == null) return
  const task = tasks.value.find((item) => item.id === id)
  preparingTaskId.value = null
  if (!task) return
  task.status = 'failed'
  task.error = message
  task.progress = 100
}

function onWorkflowBegin(payload: { prompt: string }): void {
  beginPreparingTask(payload.prompt.trim() || '局部重绘生成中…')
}

function onWorkflowBeginFailed(message: string): void {
  failPreparingTask(message || '准备失败')
}

async function submitWorkflowBatch(payload: WorkflowSubmission): Promise<void> {
  if (workflowSubmitting.value) return
  if (!getToken()) {
    loginOpen.value = true
    failPreparingTask('登录后可继续提交')
    showMessage('登录后可继续提交，当前选择的图片尚未上传')
    return
  }
  // 一点生成就切到创作；若局部重绘已 begin，则复用占位卡
  if (preparingTaskId.value == null) {
    beginPreparingTask(payload.items[0]?.prompt?.trim() || '正在提交任务…', {
      size: payload.size,
      quality: payload.quality,
      resolution: payload.resolution,
      providerId: payload.providerId,
      localCropMeta: payload.localCrop
        ? {
            sceneImageId: payload.localCrop.sceneImageId,
            cropBox: payload.localCrop.cropBox,
            hasMask: payload.localCrop.hasMask,
            maskPaths: payload.localCrop.maskPaths,
            productSources: payload.localCrop.productSources
          }
        : undefined
    })
  } else {
    focusCreationFeed()
    bumpPreparingProgress(22)
    // begin 时还没有 localCropMeta；submit 到达后补上，避免异常路径丢回贴参数
    const preparing = tasks.value.find((item) => item.id === preparingTaskId.value)
    if (preparing && payload.localCrop) {
      preparing.localCropMeta = {
        sceneImageId: payload.localCrop.sceneImageId,
        cropBox: payload.localCrop.cropBox,
        hasMask: payload.localCrop.hasMask,
        maskPaths: payload.localCrop.maskPaths,
        productSources: payload.localCrop.productSources
      }
      preparing.size = payload.size
      preparing.quality = payload.quality
      preparing.resolution = payload.resolution
      preparing.providerId = payload.providerId
    }
  }
  workflowSubmitting.value = true
  const uploaded = new Map<string, string>()
  const createdTasks: LocalTask[] = []
  const failures: string[] = []
  try {
    for (const item of payload.items) {
      try {
        bumpPreparingProgress(28)
        const sourceImages: string[] = []
        for (const image of item.sources.slice(0, MAX_REFERENCES)) {
          let url = uploaded.get(image.id)
          if (!url) {
            url = await uploadWorkflowImage(image)
            uploaded.set(image.id, url)
          }
          sourceImages.push(url)
        }
        bumpPreparingProgress(48)
        const toolInputs: Record<string, unknown> = {
          workflow: payload.kind,
          source_count: sourceImages.length
        }
        if (payload.kind === 'crop' && payload.localCrop) {
          toolInputs.crop_box = payload.localCrop.cropBox
          toolInputs.has_mask = payload.localCrop.hasMask
        }
        const toolTitle = payload.kind === 'sellVideo'
          ? '一键带货转台'
          : (plannedViews.find((view) => view.id === payload.kind)?.label || 'Mac 批量创作')
        const response = await api.createGenerate({
          type: sourceImages.length ? 2 : 1,
          prompt: item.prompt,
          source_image: sourceImages[0] || '',
          source_images: sourceImages,
          style_id: 0,
          provider_id: payload.providerId,
          model: payload.model,
          size: payload.size,
          quality: payload.quality,
          resolution: payload.resolution,
          count: 1,
          tool_title: toolTitle,
          tool_scene: payload.kind,
          tool_inputs: toolInputs
        })
        const rawIds = Array.isArray(response.task_ids) && response.task_ids.length ? response.task_ids : [response.task_id]
        const ids = rawIds.map((id) => Number(id || 0)).filter((id) => id > 0)
        if (!ids.length) throw new Error('服务端未返回任务 ID')
        const local = ids.map((id) => createLocalTask(id, item.prompt, payload.size, {
          sourceImages,
          quality: payload.quality,
          resolution: payload.resolution,
          providerId: payload.providerId,
          toolScene: payload.kind === 'crop' ? 'crop' : payload.kind,
          localCropMeta: payload.localCrop
            ? {
                sceneImageId: payload.localCrop.sceneImageId,
                cropBox: payload.localCrop.cropBox,
                hasMask: payload.localCrop.hasMask,
                maskPaths: payload.localCrop.maskPaths,
                // sourceImages[0] 是烘焙后的裁切场景；其后才是产品参考
                productSources: sourceImages.slice(1).filter((url) => /^https?:\/\//i.test(url)).slice(0, 3)
              }
            : undefined
        }))
        for (const task of local) {
          if (task.localCropMeta && window.desktop?.cacheLocalCropScene) {
            try {
              const cached = await window.desktop.cacheLocalCropScene({
                taskId: task.id,
                imageId: task.localCropMeta.sceneImageId
              })
              task.localCropMeta.scenePath = cached.scenePath
            } catch {
              // 缓存失败不阻断生成；回贴时再尝试用 imageId
            }
          }
        }
        createdTasks.push(...local)
        clearPreparingTask()
        tasks.value = sortNewestFirst([...local, ...tasks.value])
        persistTasks()
        local.forEach((task) => void pollTask(task.id, 0))
      } catch (error) {
        if (error instanceof ApiError && error.authExpired) {
          loginOpen.value = true
          throw error
        }
        failures.push(cleanErrorMessage(error, '任务提交失败'))
      }
    }
    if (!createdTasks.length) throw new Error(failures[0] || '没有任务提交成功')
    if (failures.length) showError(new Error(`已提交 ${createdTasks.length} 个，${failures.length} 个失败，可修正后单独重试`))
    else showMessage(`已提交 ${createdTasks.length} 个任务，正在生成`)
    if (payload.kind === 'sellVideo') setHistoryRail(true)
    void Promise.all([refreshCredits(), loadOverview()])
  } catch (error) {
    failPreparingTask(cleanErrorMessage(error, '批量任务提交失败'))
    showError(error, '批量任务提交失败')
  } finally {
    workflowSubmitting.value = false
  }
}

async function submitTask(): Promise<void> {
  if (submitting.value || !canSubmit.value) return
  if (!getToken()) {
    pendingSubmit.value = true
    loginOpen.value = true
    showMessage('登录后会继续提交，当前本地图片不会上传')
    return
  }
  // 一点生成就切到创作，并立刻出现进度卡
  const taskPrompt = prompt.value.trim() || '参考上传图片生成新图'
  beginPreparingTask(taskPrompt)
  submitting.value = true
  try {
    bumpPreparingProgress(20)
    const sourceImages = createMode.value === 'image' ? await uploadReferences() : []
    bumpPreparingProgress(45)
    const activeProvider = providers.value.find((item) => item.id === selectedProviderId.value)
    const response = await api.createGenerate({
      type: createMode.value === 'image' ? 2 : 1,
      prompt: taskPrompt,
      source_image: sourceImages[0] || '',
      source_images: sourceImages,
      style_id: 0,
      provider_id: activeProvider?.id || 0,
      model: activeProvider?.model || '',
      size: selectedSize.value,
      quality: quality.value,
      resolution: resolution.value,
      count: count.value
    })
    const rawIds = Array.isArray(response.task_ids) && response.task_ids.length ? response.task_ids : [response.task_id]
    const taskIds = rawIds.map((id) => Number(id || 0)).filter((id) => id > 0)
    if (!taskIds.length) throw new Error('任务创建失败，服务端未返回任务 ID')
    const created = taskIds.map((id) => createLocalTask(id, taskPrompt, undefined, { sourceImages }))
    clearPreparingTask()
    tasks.value = sortNewestFirst([...created, ...tasks.value])
    persistTasks()
    showMessage(taskIds.length > 1 ? `已提交 ${taskIds.length} 个任务` : '任务已提交，正在生成')
    // 提交成功后像 Claude 出 Plan 一样拉出右侧历史记录栏
    setHistoryRail(true)
    for (const task of created) void pollTask(task.id, 0)
    void refreshCredits()
  } catch (error) {
    failPreparingTask(cleanErrorMessage(error, '提交失败，请稍后重试'))
    if (error instanceof ApiError && error.authExpired) {
      pendingSubmit.value = true
      loginOpen.value = true
    }
    showError(error, '提交失败，请稍后重试')
  } finally {
    submitting.value = false
  }
}

function taskFromServer(task: LocalTask, data: Record<string, unknown>): void {
  const status = Number(data.status ?? 0)
  const images = normalizeResultImages(data.result_images || data.result_image || data.images)
  task.progress = Math.min(100, Math.max(task.progress, Number(data.progress || 0)))
  if (status === 2 || images.length) {
    task.status = 'success'
    task.progress = 100
    task.resultImages = images
    task.error = ''
  } else if (status === 3) {
    task.status = 'failed'
    task.error = String(data.error_msg || data.fail_reason || '生成失败，已按服务端规则处理')
  } else {
    task.status = status === 0 ? 'queued' : 'running'
    task.progress = Math.max(task.progress, status === 0 ? 8 : Math.min(92, task.progress + 4))
  }
}

function schedulePoll(taskId: number, attempt: number, delay = POLL_DELAY): void {
  window.clearTimeout(pollTimers.get(taskId))
  if (!isOnline.value) return
  const timer = window.setTimeout(() => void pollTask(taskId, attempt), delay)
  pollTimers.set(taskId, timer)
}

/* 系统通知：主进程发原生横幅；不支持或被系统关闭时静默忽略，不影响主流程 */
function notifySystem(title: string, body: string): void {
  if (!window.desktop?.notify) return
  void window.desktop.notify({ title, body }).catch(() => undefined)
}

async function pollTask(taskId: number, attempt: number): Promise<void> {
  if (taskId <= 0) return
  if (!isOnline.value) return
  if (isTaskHidden(taskId)) {
    pollTimers.delete(taskId)
    return
  }
  if (activePolls.has(taskId)) return
  const task = tasks.value.find((item) => item.id === taskId)
  if (!task || task.status === 'success' || task.status === 'failed') return
  if (isTaskHidden(task.id)) return
  if (attempt >= MAX_POLLS) {
    task.status = 'failed'
    task.error = '轮询超时，可点击重试状态查询'
    persistTasks()
    return
  }
  activePolls.add(taskId)
  try {
    const data = attempt === 0 ? await api.taskDetail(taskId) : await api.pollTask(taskId)
    taskFromServer(task, data)
    persistTasks()
    const nextStatus = (task as LocalTask).status
    if (nextStatus === 'success') {
      await maybeCompositeLocalCrop(task)
      await autoDownloadTask(task)
      const count = task.resultImages.length
      notifySystem('生成完成', count > 1 ? `已出图 ${count} 张，点击查看` : '已出图，点击查看')
    } else if (nextStatus === 'failed') {
      notifySystem('生成失败', task.error || '任务未能完成，可在应用内重试')
    } else {
      schedulePoll(taskId, attempt + 1, Number(data.next_poll_seconds || 5) * 1000)
    }
  } catch (error) {
    if (error instanceof ApiError && error.authExpired) {
      loginOpen.value = true
      task.error = '登录已过期，重新登录后可继续查询'
    } else {
      task.error = attempt > 2 ? '网络波动，正在自动重试' : ''
      schedulePoll(taskId, attempt + 1, 3000)
    }
    persistTasks()
  } finally {
    activePolls.delete(taskId)
  }
}

function resumePendingTasks(): void {
  for (const task of tasks.value.filter((item) => item.status === 'queued' || item.status === 'running')) {
    void pollTask(task.id, 0)
  }
}

function handleOnline(): void {
  const wasOffline = !isOnline.value
  isOnline.value = true
  if (wasOffline) showMessage('网络已恢复，正在继续同步任务')
  resumePendingTasks()
  void Promise.all([loadOverview(), syncTaskHistory()])
}

function handleOffline(): void {
  isOnline.value = false
  pollTimers.forEach((timer) => window.clearTimeout(timer))
  pollTimers.clear()
  showError(new Error('当前网络不可用，任务会在网络恢复后自动继续'))
}

function handleSystemResume(): void {
  resumePendingTasks()
  if (getToken() && isOnline.value) void Promise.all([loadOverview(), syncTaskHistory()])
}

async function autoDownloadTask(task: LocalTask): Promise<void> {
  if (!settings.autoDownload || !window.desktop) return
  for (let index = 0; index < task.resultImages.length; index += 1) {
    const url = task.resultImages[index]
    if (!url || url.startsWith('data:') || url.startsWith('local-crop-composite://')) continue
    if (task.savedFiles.some((file) => file.url === url) || activeDownloads.has(url)) continue
    activeDownloads.add(url)
    try {
      const saved = await window.desktop.downloadResult({ url, taskId: task.id, index })
      task.savedFiles.push({ url, path: saved.path, sha256: saved.sha256 })
      task.downloadError = ''
    } catch (error) {
      task.downloadError = error instanceof Error ? error.message : '自动下载失败'
    } finally {
      activeDownloads.delete(url)
      persistTasks()
    }
  }
}

async function retryTask(task: LocalTask): Promise<void> {
  task.error = ''
  task.downloadError = ''
  if (task.status === 'success') {
    try {
      const fresh = await api.taskDetail(task.id)
      taskFromServer(task, fresh)
      await autoDownloadTask(task)
    } catch (error) {
      task.downloadError = error instanceof Error ? error.message : '结果地址刷新失败'
      showError(error, '结果地址刷新失败')
    }
  } else {
    task.status = 'running'
    task.progress = Math.max(task.progress, 5)
    await pollTask(task.id, 0)
  }
  persistTasks()
}

async function manualDownload(task: LocalTask, url: string, index: number): Promise<void> {
  // 拼合图是 data: URI（合成时已经直接落盘到工作目录），不是可下载的远程 URL，
  // 点下载按钮时直接提示已保存即可，不要真的发起网络下载（会报「只允许下载 http(s) 结果」）。
  if (url.startsWith('data:')) {
    showMessage('这张图已在生成完成时自动保存到工作目录')
    return
  }
  if (!window.desktop) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  try {
    const saved = await window.desktop.downloadResult({ url, taskId: task.id, index })
    if (!task.savedFiles.some((file) => file.path === saved.path)) {
      task.savedFiles.push({ url, path: saved.path, sha256: saved.sha256 })
    }
    task.downloadError = ''
    persistTasks()
    showMessage('图片已保存到工作目录')
  } catch (error) {
    task.downloadError = error instanceof Error ? error.message : '下载失败'
    showError(error, '下载失败')
  }
}

let promptCopiedTimer: number | null = null
let imageCopiedTimer: number | null = null

async function copyPreviewPrompt(): Promise<void> {
  const preview = previewImage.value
  if (!preview?.task) return
  try {
    if (window.desktop?.writeClipboard) await window.desktop.writeClipboard(preview.task.prompt)
    else await navigator.clipboard.writeText(preview.task.prompt)
    promptCopied.value = true
    if (promptCopiedTimer !== null) window.clearTimeout(promptCopiedTimer)
    promptCopiedTimer = window.setTimeout(() => {
      promptCopied.value = false
      promptCopiedTimer = null
    }, 1600)
  } catch (error) {
    showError(error, '复制失败')
  }
}

async function ensurePreviewLocalPath(preview: { src: string; task: LocalTask }): Promise<string | null> {
  if (!window.desktop?.downloadResult) return null
  let filePath = preview.task.savedFiles.find((file) => file.url === preview.src)?.path
  if (filePath) return filePath
  if (preview.src.startsWith('data:') || preview.src.startsWith('blob:')) return null
  const index = Math.max(0, preview.task.resultImages.indexOf(preview.src))
  const saved = await window.desktop.downloadResult({ url: preview.src, taskId: preview.task.id, index })
  if (!preview.task.savedFiles.some((file) => file.path === saved.path)) {
    preview.task.savedFiles.push({ url: preview.src, path: saved.path, sha256: saved.sha256 })
    persistTasks()
  }
  return saved.path
}

async function copyPreviewImage(): Promise<void> {
  const preview = previewImage.value
  if (!preview?.task || copyingImage.value) return
  copyingImage.value = true
  try {
    if (window.desktop?.writeClipboardImage) {
      if (preview.src.startsWith('data:image/')) {
        await window.desktop.writeClipboardImage({ dataUrl: preview.src })
      } else {
        const filePath = await ensurePreviewLocalPath({ src: preview.src, task: preview.task })
        if (!filePath) throw new Error('无法准备图片文件')
        await window.desktop.writeClipboardImage({ path: filePath })
      }
    } else {
      const response = await fetch(preview.src)
      const blob = await response.blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
    }
    imageCopied.value = true
    if (imageCopiedTimer !== null) window.clearTimeout(imageCopiedTimer)
    imageCopiedTimer = window.setTimeout(() => {
      imageCopied.value = false
      imageCopiedTimer = null
    }, 1600)
  } catch (error) {
    showError(error, '复制图片失败')
  } finally {
    copyingImage.value = false
  }
}

async function removeTaskCompletely(task: LocalTask): Promise<void> {
  if (deletingTaskIds.value.has(task.id)) return
  deletingTaskIds.value = new Set(deletingTaskIds.value).add(task.id)
  try {
    // 正数 ID 必须先由服务端确认删除；失败时保留任务，避免只在本机“假删除”。
    if (task.id > 0) {
      if (!getToken()) {
        loginOpen.value = true
        throw new Error('登录后才能从服务器删除任务')
      }
      try {
        await api.deleteTask(task.id)
      } catch (error) {
        if (!(error instanceof ApiError && /不存在|已删除|找不到/.test(error.message))) throw error
      }
      hideTaskIds([task.id])
    }
    if (preparingTaskId.value === task.id) preparingTaskId.value = null
    const pollTimer = pollTimers.get(task.id)
    if (pollTimer) {
      window.clearTimeout(pollTimer)
      pollTimers.delete(task.id)
    }
    tasks.value = tasks.value.filter((item) => item.id !== task.id)
    persistTasks()
    if (previewImage.value?.task?.id === task.id) previewImage.value = null
    if (taskDetail.value?.id === task.id) taskDetail.value = null
    showMessage('已从服务器删除任务')
  } catch (error) {
    showError(error, '删除失败，任务仍保留')
  } finally {
    const next = new Set(deletingTaskIds.value)
    next.delete(task.id)
    deletingTaskIds.value = next
  }
}

async function removeTaskImage(task: LocalTask, _index: number): Promise<void> {
  // 作品以任务为单位删除；只删本地某张图会被历史同步整任务拉回
  await removeTaskCompletely(task)
}

async function openPreviewInPhotoshop(): Promise<void> {
  const preview = previewImage.value
  const task = preview?.task
  if (!preview || !task || openingInPhotoshop.value) return
  if (!window.desktop?.openInPhotoshop) {
    showError(new Error('当前版本不支持在 Photoshop 打开'))
    return
  }
  openingInPhotoshop.value = true
  try {
    const filePath = await ensurePreviewLocalPath({ src: preview.src, task })
    if (!filePath) throw new Error('无法准备图片文件')
    const result = await window.desktop.openInPhotoshop(filePath)
    if (result?.fallback) showMessage('未检测到 Photoshop，已用系统默认应用打开')
  } catch (error) {
    showError(error, '在 Photoshop 打开失败')
  } finally {
    openingInPhotoshop.value = false
  }
}

/*
 * 一键转 PSD（beta）：不另起链路，先用 importAuthorizedImage 把预览图登记成受权图片
 * （主进程 net.fetch 下载，绕开渲染层跨域），再复用「图片转 PSD」同一条任务队列。
 */
async function convertPreviewToPsd(): Promise<void> {
  const preview = previewImage.value
  const task = preview?.task
  if (!preview || !task || convertingPreviewPsd.value) return
  if (!window.desktop?.importAuthorizedImage) {
    showError(new Error('一键转 PSD 需要在 Mac App 中使用'))
    return
  }
  convertingPreviewPsd.value = true
  try {
    const image = await window.desktop.importAuthorizedImage({
      source: preview.src,
      name: preview.name
    })
    previewImage.value = null
    // PSD 任务栏只在图片转 PSD 视图渲染，切过去才能看到进度
    activateNavigation('psd')
    startPsdTask(image)
  } catch (error) {
    showError(error, '一键转 PSD 失败')
  } finally {
    convertingPreviewPsd.value = false
  }
}

/* ===== 微信扫码充值 ===== */

function stopRechargePoll(): void {
  if (rechargePollTimer !== null) {
    window.clearTimeout(rechargePollTimer)
    rechargePollTimer = null
  }
}

function closeRecharge(): void {
  stopRechargePoll()
  rechargeOpen.value = false
  rechargeQrDataUrl.value = ''
  rechargeActivePackage.value = null
  rechargePaid.value = false
  rechargeError.value = ''
}

async function openRecharge(): Promise<void> {
  openPopover.value = ''
  rechargeOpen.value = true
  rechargePaid.value = false
  rechargeQrDataUrl.value = ''
  rechargeActivePackage.value = null
  rechargeError.value = ''
  if (rechargePackages.value.length) return
  rechargeLoading.value = true
  try {
    const data = await api.rechargePackages()
    rechargePackages.value = normalizeList(data).map((row) => ({
      id: Number(row.id || 0),
      name: String(row.name || '充值套餐'),
      price: String(row.price ?? '0'),
      credits: Number(row.credits || 0),
      draw_count: Number(row.draw_count || 0)
    })).filter((item) => item.id > 0)
    if (!rechargePackages.value.length) rechargeError.value = '暂无可用充值套餐'
  } catch (error) {
    rechargeError.value = cleanErrorMessage(error, '套餐加载失败')
  } finally {
    rechargeLoading.value = false
  }
}

function pollRechargeStatus(orderNo: string, attempt: number): void {
  stopRechargePoll()
  // 二维码 5 分钟左右过期，按 3 秒一次轮询封顶 100 次
  if (attempt > 100) return
  rechargePollTimer = window.setTimeout(async () => {
    try {
      const data = await api.rechargePayStatus(orderNo)
      if (Number((data as Record<string, unknown>).pay_status ?? 0) === 1) {
        rechargePaid.value = true
        stopRechargePoll()
        await refreshCredits()
        showMessage('充值已到账')
        notifySystem('充值成功', rechargeActivePackage.value ? `${rechargeActivePackage.value.name} 已到账` : '积分已到账')
        window.setTimeout(() => closeRecharge(), 1200)
        return
      }
    } catch {
      // 轮询期间的网络抖动不打断，继续下一次
    }
    pollRechargeStatus(orderNo, attempt + 1)
  }, 3000)
}

async function pickRechargePackage(item: RechargePackage): Promise<void> {
  if (rechargeCreating.value) return
  rechargeCreating.value = true
  rechargeError.value = ''
  rechargeQrDataUrl.value = ''
  rechargeActivePackage.value = item
  stopRechargePoll()
  try {
    const data = await api.createRechargeOrder(item.id)
    const row = data as Record<string, unknown>
    const orderNo = String(row.order_no || '')
    const pay = (row.pay || {}) as Record<string, unknown>
    // 微信 Native 下单成功时 config 就是 weixin:// 开头的 code_url
    const codeUrl = String(pay.config || '')
    if (!codeUrl) throw new Error('未获取到微信支付二维码，请确认后台已开启 PC 端微信支付')
    rechargeQrDataUrl.value = await qrCodeToDataURL(codeUrl, { width: 220, margin: 1 })
    if (orderNo) pollRechargeStatus(orderNo, 0)
  } catch (error) {
    rechargeError.value = cleanErrorMessage(error, '发起充值失败')
    rechargeActivePackage.value = null
  } finally {
    rechargeCreating.value = false
  }
}

function reusePreviewTask(): void {
  const task = previewImage.value?.task
  if (!task) return
  applyReuseTask(task)
  previewImage.value = null
}

function reuseFromDetail(task: LocalTask): void {
  applyReuseTask(task)
  taskDetail.value = null
}

function isLocalCropTask(task: LocalTask): boolean {
  if (task.toolScene === 'crop') return true
  const meta = task.localCropMeta
  if (meta && Boolean(meta.cropBox?.size || meta.scenePath || meta.compositePath || meta.sceneImageId || meta.hasMask)) {
    return true
  }
  if (task.savedFiles.some((file) => String(file.url || '').startsWith('local-crop-composite://'))) return true
  const prompt = String(task.prompt || '')
  if (prompt.includes(LOCAL_CROP_PRESERVE_GUARD)) return true
  if (prompt.includes('灰色选区') && prompt.includes('框外')) return true
  return false
}

async function importAuthorizedImageSource(source: string, name: string): Promise<DesktopSelectedImage | null> {
  const raw = String(source || '').trim()
  if (!raw) return null
  if (!window.desktop?.importAuthorizedImage) throw new Error('当前版本不支持导入历史图片')
  return window.desktop.importAuthorizedImage({ source: raw, name })
}

async function resolveLocalCropSceneSource(task: LocalTask): Promise<string> {
  const meta = task.localCropMeta
  // 拼合结果保留了原图其余区域，优先作为下一轮场景底图
  if (meta?.compositePath) return meta.compositePath
  const savedComposite = task.savedFiles.find((file) => String(file.url || '').startsWith('local-crop-composite://') && file.path)
  if (savedComposite?.path) return savedComposite.path
  if (meta?.scenePath) return meta.scenePath
  const preview = task.resultImages.find((url) => url.startsWith('data:') || url.startsWith('blob:'))
  if (preview) return preview
  // 没有拼合图时，不要拿远端 1:1 补丁冒充场景；退回 source 裁切图让用户重设框
  return String(task.sourceImages?.[0] || '')
}

function applyReuseQuickTask(task: LocalTask): void {
  prompt.value = task.prompt
  if (task.providerId && providers.value.some((item) => item.id === task.providerId)) {
    selectedProviderId.value = task.providerId
  }
  const provider = providers.value.find((item) => item.id === selectedProviderId.value)
  const canUse = (options: ParameterOption[] | undefined, value?: string): boolean =>
    Boolean(value) && (!options?.length || options.some((option) => option.value === value))
  if (canUse(provider?.sizeOptions, task.size)) selectedSize.value = task.size!
  if (canUse(provider?.qualityOptions, task.quality)) quality.value = task.quality!
  if (canUse(provider?.resolutionOptions, task.resolution)) resolution.value = task.resolution!
  for (const item of references.value) {
    if (item.file && item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview)
  }
  const sources = (task.sourceImages || []).slice(0, MAX_REFERENCES)
  references.value = sources.map((url, index) => ({
    key: `reuse-${task.id}-${index}`,
    name: `参考图 ${index + 1}`,
    preview: url,
    remoteUrl: url
  }))
  switchMode(sources.length ? 'image' : 'text')
  activeView.value = 'quick'
  navMode.value = 'creation'
  showMessage(sources.length ? '已复用提示词、参数和参考图' : '已复用提示词和参数')
  void nextTick(() => {
    autoGrowPrompt()
    promptRef.value?.focus()
  })
}

async function applyReuseLocalCropTask(task: LocalTask): Promise<void> {
  if (cropReuseBusy.value) return
  cropReuseBusy.value = true
  try {
    if (task.providerId && providers.value.some((item) => item.id === task.providerId)) {
      selectedProviderId.value = task.providerId
    }
    const provider = providers.value.find((item) => item.id === selectedProviderId.value)
    const canUse = (options: ParameterOption[] | undefined, value?: string): boolean =>
      Boolean(value) && (!options?.length || options.some((option) => option.value === value))
    if (canUse(provider?.qualityOptions, task.quality)) quality.value = task.quality!
    if (canUse(provider?.resolutionOptions, task.resolution)) resolution.value = task.resolution!

    // 先切到局部重绘，避免导入耗时过程中用户仍停在图片生成
    navMode.value = 'creation'
    if (activeView.value === 'quick' || activeView.value === 'crop') switchPrimaryMode('crop')
    else activeView.value = 'crop'

    const sceneSource = await resolveLocalCropSceneSource(task)
    if (!sceneSource) throw new Error('找不到可复用的场景图（需要拼合结果或原场景缓存）')
    const scene = await importAuthorizedImageSource(sceneSource, `local-crop-scene-${task.id}.png`)
    if (!scene) throw new Error('场景图导入失败')

    const meta = task.localCropMeta
    const productUrls = [
      ...(meta?.productSources || []),
      // 兼容旧任务：sourceImages[0] 是烘焙裁切图，后面才是产品参考
      ...((task.sourceImages || []).slice(1))
    ].filter((url, index, arr) => url && arr.indexOf(url) === index).slice(0, 3)

    const products: DesktopSelectedImage[] = []
    for (const [index, url] of productUrls.entries()) {
      try {
        const image = await importAuthorizedImageSource(url, `local-crop-product-${task.id}-${index + 1}.png`)
        if (image) products.push(image)
      } catch {
        // 单张产品图失败不阻断整单复用
      }
    }

    const maskPaths = Array.isArray(meta?.maskPaths)
      ? meta!.maskPaths!.map((pathItem) => ({
          points: (pathItem.points || []).map((pt) => ({ x: Number(pt.x || 0), y: Number(pt.y || 0) })),
          brushSize: Number(pathItem.brushSize || 0),
          isEraser: Boolean(pathItem.isEraser)
        }))
      : []
    const cropBox = meta?.cropBox?.size
      ? { x: Number(meta.cropBox.x || 0), y: Number(meta.cropBox.y || 0), size: Number(meta.cropBox.size || 0) }
      : null

    cropDraft.value = {
      token: Date.now(),
      prompt: stripLocalCropGuard(task.prompt) || DEFAULT_LOCAL_CROP_PROMPT,
      providerId: selectedProviderId.value,
      quality: quality.value,
      resolution: resolution.value,
      scene,
      products,
      cropBox,
      maskPaths,
      maskOpacity: 50,
      // 有拼合底图时默认不弹编辑器；无框时再打开
      openEditor: !cropBox
    }

    const parts = ['已复用到局部重绘']
    if (cropBox && maskPaths.length) parts.push('框与笔刷已完整恢复')
    else if (cropBox) parts.push('重绘框已恢复')
    else parts.push('已载入拼合图，请重新设置重绘框')
    if (products.length) parts.push(`产品参考 ${products.length} 张`)
    showMessage(parts.join(' · '))
  } catch (error) {
    showError(error, '复用到局部重绘失败')
  } finally {
    cropReuseBusy.value = false
  }
}

function applyReuseTask(task: LocalTask): void {
  // 同步标记，防止历史同步后 meta 丢失时仍误进图片生成
  if (isLocalCropTask(task)) {
    if (!task.toolScene) task.toolScene = 'crop'
    void applyReuseLocalCropTask(task)
    return
  }
  applyReuseQuickTask(task)
}

async function copyTaskDetailPrompt(): Promise<void> {
  const task = liveTaskDetail.value
  if (!task?.prompt) return
  try {
    if (window.desktop?.writeClipboard) await window.desktop.writeClipboard(task.prompt)
    else await navigator.clipboard.writeText(task.prompt)
    showMessage('提示词已复制')
  } catch (error) {
    showError(error, '复制失败')
  }
}

async function applyLoginSuccess(data: Record<string, unknown>): Promise<void> {
  const token = String(data.token || '')
  if (!token) throw new Error('登录返回缺少 token')
  setToken(token)
  user.value = {
    id: Number(data.user_id || data.id || 0),
    nickname: String(data.nickname || '用户'),
    avatar: absoluteAssetUrl(String(data.avatar || '')),
    mobile: String(data.mobile || data.phone || ''),
    credits: Number(data.credits || 0),
    balance: Number(data.balance || 0)
  }
  setStoredUser(user.value)
  if (window.desktop) {
    try {
      await window.desktop.saveSession({
        token,
        user: user.value as unknown as Record<string, unknown>
      })
    } catch {
      // 系统安全存储写入失败不应让已经成功的登录回滚。
    }
  }
  loginOpen.value = false
  await refreshCredits()
  await Promise.all([loadOverview(), syncTaskHistory()])
  if (pendingSubmit.value) {
    pendingSubmit.value = false
    await nextTick()
    void submitTask()
  }
}

async function login(): Promise<void> {
  if (loginSubmitting.value) return
  loginError.value = ''
  if (!loginForm.account.trim() || !loginForm.password) {
    loginError.value = '请输入账号和密码'
    return
  }
  if (loginAgreementRequired.value && !loginForm.agreement) {
    loginError.value = '请先同意用户协议和隐私政策'
    return
  }
  loginSubmitting.value = true
  try {
    const data = await api.login(loginForm.account.trim(), loginForm.password, loginForm.agreement)
    await applyLoginSuccess(data)
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败'
  } finally {
    loginSubmitting.value = false
  }
}

function stopWechatLoginPoll(): void {
  if (wechatPollTimer !== null) {
    window.clearTimeout(wechatPollTimer)
    wechatPollTimer = null
  }
}

function scheduleWechatLoginPoll(attempt: number): void {
  stopWechatLoginPoll()
  wechatPollTimer = window.setTimeout(() => void pollWechatLogin(attempt), WECHAT_POLL_DELAY)
}

async function startWechatLogin(): Promise<void> {
  stopWechatLoginPoll()
  wechatLoginError.value = ''
  wechatQrExpired.value = false
  wechatQrDataUrl.value = ''
  wechatQrLoading.value = true
  try {
    const { url, state } = await api.wechatAuthUrl()
    wechatQrState.value = state
    wechatQrDataUrl.value = await qrCodeToDataURL(url, { margin: 1, width: 220 })
    scheduleWechatLoginPoll(0)
  } catch (error) {
    wechatLoginError.value = error instanceof Error ? error.message : '二维码生成失败，请重试'
  } finally {
    wechatQrLoading.value = false
  }
}

async function pollWechatLogin(attempt: number): Promise<void> {
  if (loginMode.value !== 'wechat' || !wechatQrState.value) return
  if (attempt >= WECHAT_POLL_MAX) {
    wechatQrExpired.value = true
    wechatLoginError.value = '二维码已过期，请刷新后重试'
    return
  }
  try {
    const data = await api.wechatLoginPoll(wechatQrState.value)
    if (data.status === 'pending') {
      scheduleWechatLoginPoll(attempt + 1)
      return
    }
    if (data.status === 'success') {
      await applyLoginSuccess(data)
      return
    }
    if (data.status === 'expired') {
      wechatQrExpired.value = true
      wechatLoginError.value = '二维码已过期，请刷新后重试'
      return
    }
    wechatLoginError.value = data.message || '登录失败，请重试'
  } catch (error) {
    wechatLoginError.value = error instanceof Error ? error.message : '登录状态查询失败'
    scheduleWechatLoginPoll(attempt + 1)
  }
}

function switchLoginMode(mode: 'password' | 'wechat'): void {
  if (loginMode.value === mode) return
  loginMode.value = mode
  loginError.value = ''
  if (mode === 'wechat') void startWechatLogin()
  else stopWechatLoginPoll()
}

watch(loginOpen, (open) => {
  if (open) return
  stopWechatLoginPoll()
  loginMode.value = 'password'
  wechatQrDataUrl.value = ''
  wechatQrState.value = ''
  wechatLoginError.value = ''
  wechatQrExpired.value = false
})

async function logout(): Promise<void> {
  setToken('')
  setStoredUser(null)
  try {
    await window.desktop?.clearSession()
  } catch {
    // 本地会话已在渲染层清除，系统存储清理失败不阻断退出。
  }
  user.value = null
  usage.value = null
  tasks.value = []
  localStorage.removeItem(TASKS_KEY)
  openPopover.value = ''
  showMessage('已退出登录')
}

async function saveSettings(): Promise<void> {
  if (!window.desktop) {
    settingsOpen.value = false
    applyTheme()
    return
  }
  try {
    Object.assign(settings, await window.desktop.saveSettings(currentDesktopSettings()))
    applyTheme()
    settingsOpen.value = false
    showMessage('设置已保存')
  } catch (error) {
    showError(error, '设置保存失败')
  }
}

async function chooseOutputDirectory(): Promise<void> {
  if (!window.desktop) return
  const selected = await window.desktop.chooseOutputDirectory()
  if (selected) settings.outputDirectory = selected
}

async function openOutputDirectory(): Promise<void> {
  if (!window.desktop) return showError(new Error('请在 Mac App 中使用保存目录'))
  try {
    await window.desktop.openOutputDirectory()
  } catch (error) {
    showError(error, '无法打开保存目录')
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

watch(settings, applyTheme, { deep: true })
watch(tasks, persistTasks, { deep: true })
watch(psdTasks, persistPsdTasks, { deep: true })
watch(selectedProviderId, syncProviderSelections)
watch([selectedProviderId, selectedSize, quality, resolution, count], scheduleGenerationSettingsSave)
watch(sidebarCollapsed, syncHistoryRailToViewport)
watch(activeView, (next, previous) => {
  if (navigatingBack) {
    navigatingBack = false
  } else if (next !== previous) {
    if (viewHistory.value.at(-1) !== previous) viewHistory.value.push(previous)
    if (viewHistory.value.length > 30) viewHistory.value.shift()
  }
  void nextTick(() => contentRef.value?.scrollTo({ top: 0, behavior: 'auto' }))
})

onMounted(async () => {
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
  await nextTick()
  contentRef.value?.scrollTo({ top: 0, behavior: 'auto' })
  document.addEventListener('mousedown', onDocumentMousedown, true)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  window.addEventListener('resize', syncSidebarToViewport)
  window.addEventListener('resize', syncHistoryRailToViewport)
  syncHistoryRailToViewport()
  // 启动时不强制收起侧栏：默认最小窗口也保留侧栏；仅在用户拖拽变窄时自动收起
  // syncSidebarToViewport()
  shuffleHeroIdeas()
  restoreTasks()
  restorePsdTasks()
  /*
   * 启动时不能一看到 user 为空就判定未登录：本地只存了 token 时，
   * 用户信息要等 refreshCredits 回来才有，中间会闪一屏登录页。
   * 没有 token 才是真未登录，可以立刻放行到登录页。
   */
  try {
    await restorePersistentSession()
  } catch {
    // 会话恢复失败按未登录处理，下面统一放行
  }
  if (!getToken()) sessionRestoring.value = false
  await loadDesktopState()
  await Promise.all([loadServiceConfig(), loadProviders()])
  generationSettingsReady.value = true
  scheduleGenerationSettingsSave()
  if (getToken()) {
    try {
      await refreshCredits()
      await Promise.all([loadOverview(), syncTaskHistory()])
    } finally {
      // 无论续期成功还是 token 失效，到这里用户态都已确定，不能再卡在过渡态
      sessionRestoring.value = false
    }
  }
  sessionRestoring.value = false
  await refreshPsdStorage()
  if (window.desktop) {
    removePsdProgressListener = window.desktop.onPsdProgress(({ taskId, progress, stage }) => {
      const task = psdTasks.value.find((item) => item.id === taskId)
      if (!task || task.status !== 'processing') return
      task.progress = Math.max(task.progress, Math.min(100, Number(progress || 0)))
      task.stage = String(stage || task.stage)
    })
    removeSystemResumeListener = window.desktop.onSystemResume(handleSystemResume)
    removeMenuListener = window.desktop.onMenu?.((action) => {
      if (action === 'settings') settingsOpen.value = true
      else if (action === 'manual') manualOpen.value = true
      else if (action === 'check-updates') void checkForUpdates(true)
    })
    modelStatus.value = await window.desktop.modelsStatus().catch(() => ({ phase: 'checking' as const }))
    removeModelsStatusListener = window.desktop.onModelsStatus((value) => {
      modelStatus.value = value
      if (value.phase === 'ready') void window.desktop?.modelsDiskUsage().then((bytes) => (modelDiskBytes.value = bytes))
    })
    if (window.desktop.updateState) {
      updateState.value = await window.desktop.updateState().catch(() => ({ phase: 'idle' as const }))
      removeUpdateStateListener = window.desktop.onUpdateState((value) => {
        updateState.value = value
        if (value.phase === 'available') showMessage(`发现新版本 ${value.version}`)
      })
    }
    if (window.desktop.onWindowChrome) {
      removeWindowChromeListener = window.desktop.onWindowChrome(({ fullscreen }) => {
        windowFullscreen.value = Boolean(fullscreen)
      })
    }
if (window.desktop.onVoiceEvent) removeVoiceEventListener = window.desktop.onVoiceEvent(handleNativeVoiceEvent)
    if (window.desktop.onPhotopeaEvent) {
      removePhotopeaEventListener = window.desktop.onPhotopeaEvent(handlePhotopeaEvent)
    }
  }
  await nextTick()
  contentRef.value?.scrollTo({ top: 0, behavior: 'auto' })
})

onBeforeUnmount(() => {
  stopRechargePoll()
  document.removeEventListener('mousedown', onDocumentMousedown, true)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('resize', syncSidebarToViewport)
  window.removeEventListener('resize', syncHistoryRailToViewport)
  pollTimers.forEach((timer) => window.clearTimeout(timer))
  stopWechatLoginPoll()
  if (generationSettingsTimer !== null) window.clearTimeout(generationSettingsTimer)
  if (primaryModeTransitionTimer !== null) window.clearTimeout(primaryModeTransitionTimer)
  if (primaryModeTransitionFrame !== null) window.cancelAnimationFrame(primaryModeTransitionFrame)
  if (batchTransitionTimer !== null) window.clearTimeout(batchTransitionTimer)
  primaryMotion.cancel()
  batchMotion.cancel()
  crossMotion.cancel()
  finishHistoryRailResize()
  clearSidebarPreviewTimers()
  cancelSidebarDock()
  if (promptCopiedTimer !== null) window.clearTimeout(promptCopiedTimer)
  if (imageCopiedTimer !== null) window.clearTimeout(imageCopiedTimer)
  if (resolutionSnapRaf) cancelAnimationFrame(resolutionSnapRaf)
  gridResizeObserver?.disconnect()
  speechRecognition?.abort()
  references.value.forEach((item) => {
    if (item.file && item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview)
  })
removePsdProgressListener?.()
  removeSystemResumeListener?.()
  removeModelsStatusListener?.()
  removeMenuListener?.()
  removeUpdateStateListener?.()
  removeWindowChromeListener?.()
  removePhotopeaEventListener?.()
  removeVoiceEventListener?.()
  if (nativeVoiceActive) void window.desktop?.voiceStop()
})
</script>

<template>
  <!-- 会话恢复中：只铺一层与主题一致的底，避免闪过登录页 -->
  <div v-if="sessionRestoring" :class="['login-shell', { 'is-fullscreen': windowFullscreen }]">
    <div class="login-shell-drag" />
  </div>

  <!-- 未登录时整个工作台都不渲染，只留一个登录窗口 -->
  <div v-else-if="!isLoggedIn" :class="['login-shell', { 'is-fullscreen': windowFullscreen }]">
    <div class="login-shell-drag" />
    <section class="login-standalone" role="dialog" aria-modal="true" aria-label="登录AI 图像工作台">
      <h2>登录</h2>
      <p>登录后同步积分与任务。</p>
      <div v-if="wechatLoginAvailable" class="login-mode-tabs">
        <button type="button" :class="{ active: loginMode === 'password' }" @click="switchLoginMode('password')">账号密码</button>
        <button type="button" :class="{ active: loginMode === 'wechat' }" @click="switchLoginMode('wechat')"><QrCode :size="14" /> 微信扫码</button>
      </div>
      <template v-if="loginMode === 'password'">
        <label class="modal-field"><span>账号</span><input v-model="loginForm.account" autocomplete="username" placeholder="手机号或账号" @keydown.enter="login" /></label>
        <label class="modal-field"><span>密码</span><input v-model="loginForm.password" type="password" autocomplete="current-password" placeholder="请输入密码" @keydown.enter="login" /></label>
        <label v-if="loginAgreementRequired" class="agreement"><input v-model="loginForm.agreement" type="checkbox" /> <span>我已阅读并同意用户协议和隐私政策</span></label>
        <p v-if="loginError" class="login-error"><AlertCircle :size="14" /> {{ loginError }}</p>
        <button class="modal-primary" type="button" :disabled="loginSubmitting" @click="login">
          <LoaderCircle v-if="loginSubmitting" :size="16" class="spin" />
          {{ loginSubmitting ? '登录中…' : '登录并继续' }}
        </button>
      </template>
      <template v-else>
        <div class="wechat-qr-panel">
          <LoaderCircle v-if="wechatQrLoading" :size="24" class="spin" />
          <img v-else-if="wechatQrDataUrl" :src="wechatQrDataUrl" alt="微信扫码登录二维码" width="220" height="220" />
          <button v-if="wechatQrExpired" type="button" class="ghost-btn" @click="startWechatLogin"><RefreshCw :size="14" /> 二维码已过期，点击刷新</button>
          <p v-else class="wechat-qr-hint">请使用微信扫一扫登录</p>
        </div>
        <p v-if="wechatLoginError" class="login-error"><AlertCircle :size="14" /> {{ wechatLoginError }}</p>
      </template>
    </section>
  </div>

  <div v-else :class="['app-shell', { 'is-fullscreen': windowFullscreen, 'has-psd-rail': activeView === 'psd' && psdRailOpen && !(psdMaskEditor.open && psdMaskEditor.draft) }]">
    <aside
      :class="['sidebar', { collapsed: sidebarCollapsed, preview: sidebarPreview, 'preview-closing': sidebarPreviewClosing }]"
      @mouseenter="openSidebarPreview"
      @mouseleave="scheduleSidebarPreviewClose"
    >
      <div class="sidebar-drag" />
      <div class="nav-mode" role="tablist" aria-label="工作区">
        <button :class="{ active: navMode === 'creation' }" type="button" role="tab" :aria-selected="navMode === 'creation'" @click="setNavMode('creation')">创作</button>
        <button :class="{ active: navMode === 'tools' }" type="button" role="tab" :aria-selected="navMode === 'tools'" @click="setNavMode('tools')">实验</button>
      </div>

      <nav class="side-nav">
        <template v-for="item in visibleNavigation" :key="item.id">
          <template v-if="isNavigationGroup(item)">
            <div class="nav-row nav-group-row">
              <button
                :class="['nav-item', 'nav-group-item', { active: navigationGroupActive(item) }]"
                type="button"
                :aria-expanded="expandedNavGroups[item.id]"
                @click="toggleNavigationGroup(item.id)"
              >
                <component :is="item.icon" :size="17" />
                <span>{{ item.label }}</span>
              </button>
              <button
                :class="['nav-expand', { open: expandedNavGroups[item.id] }]"
                type="button"
                :aria-label="expandedNavGroups[item.id] ? `收起${item.label}` : `展开${item.label}`"
                :aria-expanded="expandedNavGroups[item.id]"
                @click="toggleNavigationGroup(item.id)"
              >
                <ChevronDown :size="13" />
              </button>
            </div>
            <div v-if="expandedNavGroups[item.id]" class="nav-sublist nav-group-sublist">
              <button
                v-for="child in item.children"
                :key="child.id"
                :class="['nav-subitem', 'nav-destination', { active: child.id !== 'folder' && activeView === child.id }]"
                type="button"
                @click="activateNavigation(child.id)"
              >
                <component :is="child.icon" :size="14" />
                <span>{{ child.label }}</span>
                <span v-if="child.id === 'quick' && runningCount" class="nav-dot" />
              </button>
            </div>
          </template>

          <div v-else class="nav-row">
            <button
              :class="['nav-item', { active: item.id !== 'folder' && activeView === item.id }]"
              type="button"
              @click="activateNavigation(item.id)"
            >
              <component :is="item.icon" :size="17" />
              <span>{{ item.label }}</span>
              <span v-if="item.id === 'psd' && psdRunningCount" class="nav-dot" />
              <span v-if="item.id === 'history' && historySyncing" class="nav-spinner"><LoaderCircle :size="13" class="spin" /></span>
            </button>
          </div>
        </template>
      </nav>

      <div class="sidebar-footer pop-wrap">
        <Transition name="pop">
          <div v-if="openPopover === 'account'" class="menu-pop account-menu" role="menu">
            <div class="menu-head">
              <span class="menu-head-main">{{ user?.mobile || user?.nickname || '已登录' }}</span>
              <span class="menu-head-sub">{{ Number(user?.credits || 0).toLocaleString() }} 积分 · {{ membershipLabel }}</span>
            </div>
            <button v-if="updateAvailable" class="menu-item menu-item-accent" type="button" role="menuitem" @click="updateModalOpen = true; openPopover = ''">
              <ArrowUp :size="15" /> 有新版本 {{ updateState.version }}
            </button>
            <div v-if="updateAvailable" class="menu-sep" />
            <button class="menu-item" type="button" role="menuitem" @click="openRecharge">
              <Wallet :size="15" /> 充值
            </button>
            <button class="menu-item" type="button" role="menuitem" @click="settingsOpen = true; openPopover = ''">
              <Settings :size="15" /> 设置
            </button>
            <button class="menu-item" type="button" role="menuitem" @click="helpPlaceholder">
              <HelpCircle :size="15" /> 帮助
            </button>
            <div class="menu-sep" />
            <button class="menu-item" type="button" role="menuitem" @click="logout">
              <LogOut :size="15" /> 退出登录
            </button>
          </div>
        </Transition>
        <button v-if="isLoggedIn" :class="['account-chip', { open: openPopover === 'account' }]" type="button" @click="togglePopover('account')">
          <span class="avatar">
            <img v-if="user?.avatar" :src="user.avatar" alt="" />
            <template v-else>{{ accountInitial }}</template>
            <span v-if="updateAvailable" class="avatar-update-dot" aria-label="有新版本" />
          </span>
          <span class="account-copy">
            <strong>{{ user?.nickname || '已登录' }}</strong>
            <span>{{ membershipLabel }}</span>
          </span>
          <ChevronDown :size="14" class="account-chevron" />
        </button>
        <button v-else class="account-chip" type="button" @click="loginOpen = true">
          <span class="avatar"><LogIn :size="14" /></span>
          <span class="account-copy">
            <strong>登录</strong>
            <span>同步积分与任务</span>
          </span>
        </button>
      </div>
    </aside>

    <main class="content">
      <header class="topbar">
        <div v-if="activeView === 'quick' || activeView === 'crop'" class="topbar-mode-switch" role="tablist" aria-label="生成模式">
          <button :class="{ active: activeView === 'quick' }" type="button" role="tab" :aria-selected="activeView === 'quick'" @click="switchPrimaryMode('quick')">
            <span class="mode-label-full">图片生成</span><span class="mode-label-short">生成</span>
          </button>
          <button :class="{ active: activeView === 'crop' }" type="button" role="tab" :aria-selected="activeView === 'crop'" @click="switchPrimaryMode('crop')">
            <span class="mode-label-full">局部重绘</span><span class="mode-label-short">重绘</span>
          </button>
        </div>
        <div
          v-else-if="activeView === 'replication' || activeView === 'batchSku' || activeView === 'detailV4'"
          class="topbar-mode-switch batch-mode-switch"
          role="tablist"
          aria-label="批量创作模式"
        >
          <button :class="{ active: activeView === 'replication' }" type="button" role="tab" :aria-selected="activeView === 'replication'" @click="switchBatchMode('replication')">
            批量复刻
          </button>
          <button :class="{ active: activeView === 'batchSku' }" type="button" role="tab" :aria-selected="activeView === 'batchSku'" @click="switchBatchMode('batchSku')">
            批量 SKU
          </button>
          <button :class="{ active: activeView === 'detailV4' }" type="button" role="tab" :aria-selected="activeView === 'detailV4'" @click="switchBatchMode('detailV4')">
            整套详情
          </button>
        </div>
        <span v-else class="topbar-title">{{ activeViewTitle }}</span>
        <div class="topbar-actions">
          <button
            v-if="activeView === 'history' || activeView === 'quick' || activeView === 'crop'"
            class="panel-toggle"
            type="button"
            aria-label="清理失败任务"
            data-tooltip="清理失败任务"
            :disabled="clearingFailed"
            @click="clearFailedTasks"
          >
            <LoaderCircle v-if="clearingFailed" :size="15" class="spin" />
            <Trash2 v-else :size="15" />
          </button>
          <button class="panel-toggle" type="button" aria-label="打开网站" data-tooltip="打开网站" @click="openSiteUrl">
            <Globe :size="15" />
          </button>
          <button class="panel-toggle" type="button" aria-label="设置" data-tooltip="设置" @click="settingsOpen = true">
            <Settings :size="15" />
          </button>
          <div class="pop-wrap">
            <button
              :class="['panel-toggle', { active: openPopover === 'topbarAccount' }]"
              type="button"
              aria-label="账号菜单"
              data-tooltip="账号"
              @click="togglePopover('topbarAccount')"
            >
              <MoreHorizontal :size="15" />
            </button>
            <Transition name="pop">
              <div v-if="openPopover === 'topbarAccount'" class="menu-pop account-menu topbar-menu" role="menu">
                <template v-if="isLoggedIn">
                  <div class="menu-head">
                    <span class="menu-head-main">{{ user?.mobile || user?.nickname || '已登录' }}</span>
                    <span class="menu-head-sub">{{ Number(user?.credits || 0).toLocaleString() }} 积分 · {{ membershipLabel }}</span>
                  </div>
                  <button class="menu-item" type="button" role="menuitem" @click="settingsOpen = true; openPopover = ''">
                    <Settings :size="15" /> 设置
                  </button>
                  <button class="menu-item" type="button" role="menuitem" @click="helpPlaceholder">
                    <HelpCircle :size="15" /> 帮助
                  </button>
                  <div class="menu-sep" />
                  <button class="menu-item" type="button" role="menuitem" @click="logout">
                    <LogOut :size="15" /> 退出登录
                  </button>
                </template>
                <button v-else class="menu-item" type="button" role="menuitem" @click="loginOpen = true; openPopover = ''">
                  <LogIn :size="15" /> 登录
                </button>
              </div>
            </Transition>
          </div>
        </div>
      </header>
      <div
        ref="contentRef"
        :class="[
          'content-scroll',
          {
            'no-scroll':
              activeWorkflowKind === 'crop' ||
              activeWorkflowKind === 'replication' ||
              activeWorkflowKind === 'batchSku' ||
              activeWorkflowKind === 'detailV4' ||
              activeView === 'quick'
          }
        ]"
      >
      <!-- 左右分栏开关：固定在窗口两角，展开/收起/预览时位置纹丝不动 -->
      <button
        :class="['panel-toggle', 'floating', { active: sidebarPreview || sidebarPreviewClosing }]"
        type="button"
        aria-label="侧栏"
        :data-tooltip="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
        @mouseenter="openSidebarPreview"
        @mouseleave="scheduleSidebarPreviewClose"
        @focus="openSidebarPreview"
        @blur="scheduleSidebarPreviewClose"
        @click="toggleSidebar"
      >
        <PanelLeft :size="16" />
      </button>
      <button
        class="panel-toggle floating-back"
        type="button"
        aria-label="后退"
        data-tooltip="返回上一个页面"
        :disabled="!canNavigateBack"
        @click="navigateBack"
      >
        <ArrowLeft :size="16" />
      </button>
      <button
        v-if="activeView !== 'psd'"
        :class="['panel-toggle', 'floating-right', 'history-rail-toggle-btn', { active: historyRailOpen, busy: runningCount > 0 }]"
        type="button"
        aria-label="历史记录栏"
        :data-tooltip="historyRailOpen ? (runningCount ? `收起历史记录栏 · ${runningCount} 生成中` : '收起历史记录栏') : (runningCount ? `打开历史记录栏 · ${runningCount} 生成中` : '打开历史记录栏')"
        @click="toggleHistoryRail"
      >
        <PanelRight :size="15" />
        <em v-if="runningCount" class="history-rail-toggle-badge">{{ runningCount }}</em>
      </button>

      <div
        v-if="activeView === 'quick' || activeView === 'crop'"
        :class="['view', 'quick-view', 'primary-generator-view', 'hero', { 'crop-mode': activeView === 'crop' }]"
      >
        <!-- 问候是两个生成模式共享的固定锚点，切换时不参与动画。 -->
        <div class="hero-greeting">
          <div class="hero-greeting-main">
            <h1>{{ greeting }}</h1>
          </div>
          <p class="hero-greeting-en">{{ greetingEnglish }}</p>
        </div>

        <div
          ref="primaryModeStageRef"
          :class="[
            'primary-mode-stage',
            { 'has-primary-visual': isLoggedIn },
            primaryModeTransition ? `mode-transition-to-${primaryModeTransition}` : ''
          ]"
        >
          <div
            :class="['primary-mode-pane', 'quick-mode-pane', { active: activeView === 'quick' }]"
            :aria-hidden="activeView !== 'quick'"
            :inert="activeView !== 'quick'"
          >

        <section v-if="isLoggedIn" ref="usageCardRef" class="usage-card primary-visual-frame" aria-label="生图数据总览">
          <header class="usage-head">
            <div class="usage-view-tabs" role="tablist" aria-label="统计视图">
              <button :class="{ active: usageTab === 'overview' }" type="button" @click="usageTab = 'overview'">总览 <em>Overview</em></button>
              <button :class="{ active: usageTab === 'images' }" type="button" @click="usageTab = 'images'">生图数 <em>Output</em></button>
            </div>
            <div class="usage-actions">
              <div class="range-tabs" role="tablist" aria-label="统计范围">
                <button :class="{ active: usageRange === 'all' }" type="button" @click="usageRange = 'all'">全部</button>
                <button :class="{ active: usageRange === '30d' }" type="button" @click="usageRange = '30d'">30天</button>
                <button :class="{ active: usageRange === '7d' }" type="button" @click="usageRange = '7d'">7天</button>
              </div>
              <button class="sync-button" type="button" :disabled="historySyncing" title="同步全部历史图片" @click="syncTaskHistory">
                <LoaderCircle v-if="historySyncing" :size="14" class="spin" />
                <RefreshCw v-else :size="14" />
              </button>
            </div>
          </header>
          <div v-if="usageTab === 'overview'" class="usage-body">
            <div class="usage-tiles">
              <div class="usage-tile"><span>生成次数 <em>Runs</em></span><strong>{{ usageTotals.tasks.toLocaleString() }}</strong></div>
              <div class="usage-tile"><span>出图数 <em>Images</em></span><strong>{{ usageTotals.images.toLocaleString() }}</strong></div>
              <div class="usage-tile"><span>累计消耗 <em>Credits</em></span><strong>{{ usageTotals.credits.toLocaleString() }}</strong></div>
              <div class="usage-tile"><span>活跃天数 <em>Active</em></span><strong>{{ usageTotals.activeDays }}</strong></div>
              <div class="usage-tile"><span>连续活跃 <em>Streak</em></span><strong>{{ usageStreaks.current }} 天</strong></div>
              <div class="usage-tile"><span>最长连续 <em>Best</em></span><strong>{{ usageStreaks.longest }} 天</strong></div>
              <div class="usage-tile"><span>高峰时段 <em>Peak</em></span><strong>{{ usagePeakHour }}</strong></div>
              <div class="usage-tile"><span>常用比例 <em>Ratio</em></span><strong>{{ usageTopRatio }}</strong></div>
            </div>
            <div class="usage-heatmap" aria-label="每日出图热力图">
              <button
                v-for="cell in usageHeatmap"
                :key="cell.key"
                :class="[`lv-${cell.level}`, { selected: usageSelectedDate === cell.key }]"
                type="button"
                :aria-label="`${cell.key}，生成 ${cell.count} 张`"
                :title="`${cell.key} · ${cell.count} 张`"
                @click="usageSelectedDate = cell.key"
              />
            </div>
            <p class="usage-foot">
              <span v-if="usageSelectedCell">{{ usageSelectedCell.key }} 生成了 {{ usageSelectedCell.count }} 张。</span>
              <span v-else>{{ usageFootnote }}</span>
            </p>
          </div>

          <div v-else class="usage-body">
            <div class="usage-chart-summary">
              <span>{{ usageSelectedChartDay ? `${usageSelectedChartDay.date} · ${usageSelectedChartDay.total} 张` : '每日成功出图数 Daily output' }}</span>
              <strong>{{ usageTotals.images.toLocaleString() }} 张</strong>
            </div>
            <div class="usage-chart-shell">
              <div class="usage-y-axis" aria-hidden="true">
                <span>{{ usageChartMax }}</span>
                <span>{{ Math.ceil(usageChartMax / 2) }}</span>
                <span>0</span>
              </div>
              <div class="usage-chart" aria-label="按日期和分辨率统计的出图柱状图">
                <button
                  v-for="row in usageChartRows"
                  :key="row.date"
                  :class="['usage-bar-day', { selected: usageSelectedDate === row.date }]"
                  type="button"
                  :title="`${row.date} · ${row.total} 张`"
                  :aria-label="`${row.date}，生成 ${row.total} 张`"
                  @click="usageSelectedDate = row.date"
                >
                  <span class="usage-bar-stack">
                    <i class="res-4k" :style="{ height: `${(row.k4 / usageChartMax) * 100}%` }" />
                    <i class="res-2k" :style="{ height: `${(row.k2 / usageChartMax) * 100}%` }" />
                    <i class="res-1k" :style="{ height: `${(row.k1 / usageChartMax) * 100}%` }" />
                  </span>
                  <small v-if="row.showLabel">{{ row.label }}</small>
                </button>
              </div>
            </div>
            <div class="usage-resolution-list">
              <div v-for="(item, index) in usageResolutionBreakdown" :key="item.key" class="usage-resolution-row">
                <span><i :class="`res-${index}`" />{{ item.key }}</span>
                <span>{{ item.images.toLocaleString() }} 张</span>
                <strong>{{ item.percent.toFixed(1) }}%</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="composer-shell primary-composer">
          <div class="composer-card mode-composer-surface" @dragover.prevent @drop="onDrop">
            <div v-if="references.length" class="ref-thumbs">
              <button
                v-for="(item, index) in references"
                :key="item.key"
                class="ref-thumb"
                type="button"
                :aria-label="`预览 ${item.name}`"
                @click="previewImage = { src: item.preview, name: item.name }"
              >
                <img :src="item.preview" :alt="item.name" />
                <span v-if="item.uploading" class="ref-thumb-state"><LoaderCircle :size="13" class="spin" /></span>
                <span v-else-if="item.error" class="ref-thumb-state error" :title="item.error"><AlertCircle :size="13" /></span>
                <span class="ref-thumb-x" role="button" aria-label="移除图片" @click.stop="removeReference(index)"><X :size="11" /></span>
              </button>
            </div>

            <div class="prompt-area">
              <textarea
                id="prompt"
                ref="promptRef"
                v-model="prompt"
                rows="2"
                @input="autoGrowPrompt"
                :placeholder="promptPlaceholder"
                maxlength="2000"
                @paste="onPaste"
                @keydown.meta.enter="submitTask"
                @keydown.ctrl.enter="submitTask"
              />
            </div>
            <input ref="inputRef" class="visually-hidden" type="file" accept="image/*" multiple @change="onFileInput" />

            <div :class="['composer-bottom', { 'has-send': canSubmit || submitting }]">
              <button class="icon-round mode-add-control" type="button" :title="createMode === 'image' ? '添加参考图' : '添加参考图（切换到图生图）'" @click="addReferences">
                <Plus :size="16" />
              </button>
              <div class="seg-toggle mode-kind-control" role="tablist" aria-label="生成方式">
                <button :class="{ active: createMode === 'text' }" type="button" @click="switchMode('text')">文生图</button>
                <button :class="{ active: createMode === 'image' }" type="button" @click="switchMode('image')">图生图</button>
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
                        :aria-checked="provider.id === selectedProviderId"
                        @click="pickOption('provider', () => { selectedProviderId = provider.id })"
                      >
                        <span class="menu-option-label">{{ provider.label }}</span>
                        <span v-if="provider.model" class="menu-option-hint">{{ provider.model }}</span>
                        <Check v-if="provider.id === selectedProviderId" :size="14" class="menu-check" />
                      </button>
                    </div>
                  </Transition>
                </div>
                <div class="pop-wrap mode-size-control">
                  <button :class="['param-btn', { open: openPopover === 'size' }]" type="button" aria-label="画面比例" @click="togglePopover('size')">
                    {{ selectedSizeLabel }}
                    <ChevronDown :size="12" />
                  </button>
                  <Transition name="pop">
                    <div v-if="openPopover === 'size'" class="menu-pop param-menu scrollable" role="menu">
                      <span class="menu-title">画面比例</span>
                      <button
                        v-for="item in currentSizeOptions"
                        :key="item.value"
                        class="menu-option"
                        type="button"
                        role="menuitemradio"
                        :aria-checked="item.value === selectedSize"
                        @click="pickOption('size', () => { selectedSize = item.value })"
                      >
                        <span class="menu-option-label">{{ item.label }}</span>
                        <span class="menu-option-hint">{{ item.value }}</span>
                        <Check v-if="item.value === selectedSize" :size="14" class="menu-check" />
                      </button>
                    </div>
                  </Transition>
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
                        @click="pickOption('quality', () => { quality = item.value })"
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
                <div class="pop-wrap mode-count-control">
                  <button :class="['param-btn', { open: openPopover === 'count' }]" type="button" aria-label="生成张数" @click="togglePopover('count')">
                    {{ count }} 张
                    <ChevronDown :size="12" />
                  </button>
                  <Transition name="pop">
                    <div v-if="openPopover === 'count'" class="menu-pop param-menu" role="menu">
                      <span class="menu-title">生成张数</span>
                      <button
                        v-for="item in [1, 3, 5, 7, 10, 15, 20]"
                        :key="item"
                        class="menu-option"
                        type="button"
                        role="menuitemradio"
                        :aria-checked="item === count"
                        @click="pickOption('count', () => { count = item })"
                      >
                        <span class="menu-option-label">{{ item }} 张</span>
                        <Check v-if="item === count" :size="14" class="menu-check" />
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>
              <div class="composer-trailing mode-trailing-control">
                <button
                  :class="['voice-btn', { listening: isVoiceListening, recognizing: isVoiceRecognizing }]"
                  type="button"
                  :disabled="submitting"
                  :aria-label="isVoiceListening ? '停止语音输入' : '语音输入'"
                  :title="isVoiceListening ? '停止并识别' : '语音输入提示词'"
                  @click="toggleVoiceInput"
                >
                  <LoaderCircle v-if="isVoiceRecognizing" :size="15" class="spin" />
                  <Square v-else-if="isVoiceListening" :size="11" fill="currentColor" />
                  <Mic v-else :size="16" />
                  <span v-if="isVoiceListening" class="voice-pulse" aria-hidden="true" />
                </button>
                <!-- 槽位从 0→34 弹开：参数区被挤窄，卡片外框宽度不变 -->
                <div class="send-slot" :class="{ open: canSubmit || submitting }">
                  <button
                    class="send-btn"
                    type="button"
                    tabindex="-1"
                    :disabled="!canSubmit"
                    :aria-hidden="!(canSubmit || submitting)"
                    :aria-label="isLoggedIn ? '开始生成' : '登录并生成'"
                    @click="submitTask"
                  >
                    <LoaderCircle v-if="submitting" :size="16" class="spin" />
                    <ArrowUp v-else :size="17" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="composer-tray mode-composer-tray">
            <div class="composer-tray-left">
              <span>{{ isLoggedIn ? `预计 ${totalCost} 积分` : `未登录 · 提交时需登录 · 预计 ${totalCost} 积分` }}</span>
              <span v-if="voiceStatus" class="voice-status" role="status" aria-live="polite">{{ voiceStatus }}</span>
            </div>
            <span>⌘ ↵ 生成</span>
          </div>
        </section>

        <!-- Claude 式「Ideas for you」：单列行样式，图标块 + 名称 + 右侧标签；hover 时输入框浮现示例文案 -->
        <section v-if="heroIdeas.length" class="hero-ideas" aria-label="为你推荐">
          <h2 class="hero-ideas-title">为你推荐</h2>
          <ul class="hero-ideas-list">
            <li v-for="idea in heroIdeas" :key="idea.id">
              <button
                class="hero-idea-item"
                type="button"
                @mouseenter="hoveredIdeaPreview = idea.preview"
                @mouseleave="hoveredIdeaPreview = ''"
                @focus="hoveredIdeaPreview = idea.preview"
                @blur="hoveredIdeaPreview = ''"
                @click="openHeroIdea(idea.id)"
              >
                <span class="hero-idea-icon"><component :is="idea.icon" :size="13" /></span>
                <span class="hero-idea-copy">
                  <strong>{{ idea.label }}</strong>
                  <small>{{ idea.hint }}</small>
                </span>
                <span class="hero-idea-tag">{{ idea.tag }}</span>
              </button>
            </li>
          </ul>
        </section>
          </div>

          <div
            :class="['primary-mode-pane', 'crop-mode-pane', { active: activeView === 'crop' }]"
            :aria-hidden="activeView !== 'crop'"
            :inert="activeView !== 'crop'"
          >
            <div class="workflow-inline-crop">
              <WorkflowStudio
                kind="crop"
                :active="activeView === 'crop'"
                :providers="providers"
                :default-provider-id="selectedProviderId"
                :default-size="selectedSize"
                :default-quality="quality"
                :default-resolution="resolution"
                :submitting="workflowSubmitting || cropReuseBusy"
                :crop-draft="cropDraft"
                @begin="onWorkflowBegin"
                @begin-failed="onWorkflowBeginFailed"
                @submit="submitWorkflowBatch"
              />
            </div>
          </div>

        </div>
      </div>

      <div v-else-if="activeView === 'history'" class="view history-view">
        <header class="page-toolbar history-toolbar">
          <p class="page-toolbar-note">网页、小程序与 Mac 的生成记录会汇总到这里。</p>
          <button v-if="isLoggedIn" class="ghost-btn" type="button" :disabled="historySyncing" @click="syncTaskHistory">
            <LoaderCircle v-if="historySyncing" :size="14" class="spin" />
            <RefreshCw v-else :size="14" />
            {{ historySyncing ? '同步中' : '同步全部' }}
          </button>
        </header>

        <div v-if="!isLoggedIn" class="placeholder-card compact">
          <LogIn :size="28" />
          <h2>登录后同步全部图片</h2>
          <p>登录一次后，Mac 会安全保存会话，后续打开无需重复输入账号密码。</p>
          <button class="primary-btn" type="button" @click="loginOpen = true"><LogIn :size="15" /> 登录</button>
        </div>
        <p v-else-if="historySyncError" class="sync-error">
          <AlertCircle :size="13" /> {{ historySyncError }}
          <button type="button" @click="syncTaskHistory">重试</button>
        </p>
        <div v-else-if="historySyncing && !tasks.length" class="history-loading">
          <LoaderCircle :size="20" class="spin" /> 正在同步全部历史图片…
        </div>
        <div v-else-if="tasks.length" ref="historyGridRef" class="waterfall history-waterfall">
          <div v-for="(column, columnIndex) in historyColumns" :key="columnIndex" class="wf-col">
            <template v-for="cell in column" :key="cell.key">
              <div v-if="cell.kind === 'card' && (cell.task.status === 'queued' || cell.task.status === 'running')" class="wf-card" @click="openTaskDetail(cell.task)">
                <div class="progress"><span :style="{ width: `${cell.task.progress}%` }" /></div>
                <p class="wf-prompt">{{ cell.task.prompt }}</p>
                <small><LoaderCircle :size="11" class="spin" /> {{ runningTaskCaption(cell.task) }}</small>
                <button class="wf-delete" type="button" aria-label="删除任务" @click.stop="removeTaskCompletely(cell.task)"><X :size="12" /></button>
              </div>
              <div v-else-if="cell.kind === 'card'" class="wf-card" @click="openTaskDetail(cell.task)">
                <p class="task-error"><AlertCircle :size="13" /> {{ cell.task.error || '生成失败' }}</p>
                <p class="wf-prompt">{{ cell.task.prompt }}</p>
                <button class="ghost-btn accent" type="button" @click.stop="retryTask(cell.task)"><RotateCcw :size="13" /> 重试</button>
                <button class="wf-delete" type="button" aria-label="删除任务" @click.stop="removeTaskCompletely(cell.task)"><X :size="12" /></button>
              </div>
              <figure v-else class="wf-item">
                <img
                  :src="cell.src"
                  :alt="cell.task.prompt"
                  loading="lazy"
                  :style="{ aspectRatio: `auto ${cell.ratio}` }"
                  @click="previewImage = { src: cell.src!, name: cell.task.prompt, task: cell.task }"
                />
                <button class="wf-delete" type="button" aria-label="删除图片" @click.stop="removeTaskImage(cell.task, cell.index!)"><X :size="12" /></button>
                <figcaption class="wf-overlay">
                  <button type="button" :aria-label="`下载结果 ${cell.index! + 1}`" @click="manualDownload(cell.task, cell.src!, cell.index!)"><Download :size="15" /></button>
                  <span class="wf-prompt">{{ cell.task.prompt }}</span>
                </figcaption>
              </figure>
            </template>
          </div>
        </div>
        <button v-if="historyVisibleCount < tasks.length" class="history-more" type="button" @click="historyVisibleCount += 120">
          再加载 {{ Math.min(120, tasks.length - historyVisibleCount) }} 条
        </button>
        <div v-else-if="!tasks.length" class="empty history-empty">
          <Images :size="22" />
          <strong>还没有生成记录</strong>
          完成第一张图后会自动出现在这里。
        </div>
      </div>

      <div v-else-if="activeWorkflowKind" :class="['view', 'workflow-view', { 'workflow-crop': activeWorkflowKind === 'crop', 'workflow-replication': activeWorkflowKind === 'replication' || activeWorkflowKind === 'batchSku' || activeWorkflowKind === 'detailV4', 'batch-mode-transition': batchTransition !== null }]">
        <WorkflowStudio
          :kind="activeWorkflowKind"
          :providers="providers"
          :default-provider-id="selectedProviderId"
          :default-size="selectedSize"
          :default-quality="quality"
          :default-resolution="resolution"
          :submitting="workflowSubmitting"
          @begin="onWorkflowBegin"
          @begin-failed="onWorkflowBeginFailed"
          @submit="submitWorkflowBatch"
        />
      </div>

      <div v-else-if="activeView === 'sellVideo'" class="view workflow-view workflow-replication">
        <TurntableStudio
          :providers="providers"
          :default-provider-id="selectedProviderId"
          :default-size="selectedSize"
          :default-quality="quality"
          :default-resolution="resolution"
          :submitting="workflowSubmitting"
          :tasks="tasks"
          @begin="onWorkflowBegin"
          @submit="submitWorkflowBatch"
        />
      </div>

      <div v-else-if="activePlaceholder" class="view placeholder-view">
        <section class="placeholder-card">
          <span class="placeholder-icon"><component :is="activePlaceholder.icon" :size="28" /></span>
          <p>{{ activePlaceholder.description }}</p>
          <span class="placeholder-status">即将推出</span>
        </section>
      </div>

      <div v-else-if="activeView === 'psd'" class="view view-psd">
        <template v-if="psdMaskEditor.open && psdMaskEditor.draft">
          <section class="psd-mask-wrap">
            <PsdMaskEditor
              :draft="psdMaskEditor.draft"
              :exporting="psdMaskEditor.exporting"
              @cancel="cancelPsdMaskEditor"
              @export="exportPsdFromMaskEditor"
            />
          </section>
        </template>

        <template v-else>
          <header class="page-toolbar psd-toolbar">
            <p class="page-toolbar-note">本机分层导出，文件不上传。</p>
            <div class="psd-toolbar-actions">
              <span
                v-if="psdEngine"
                :class="['psd-chip', 'engine', psdEngine.ready ? 'ok' : 'warn']"
                :title="psdEngine.ready ? '发丝级抠图与背景修复由本地 AI 模型完成' : `AI 模型缺失：${psdEngine.missing.join('、')}，将使用兼容模式`"
              >
                <Sparkles :size="13" />
                <span>{{ psdEngine.ready ? 'AI 精细引擎' : '兼容模式' }}</span>
              </span>
              <button
                class="psd-chip action"
                type="button"
                :class="{ active: psdRailOpen }"
                :aria-pressed="psdRailOpen"
                :title="psdRailOpen ? '收起任务栏' : '打开任务栏'"
                @click="togglePsdRail"
              >
                <PanelLeft :size="14" class="flip-x" />
                <span>任务</span>
                <em v-if="psdTasks.length">{{ psdTasks.length }}</em>
              </button>
            </div>
          </header>

          <section
            class="psd-stage"
            :class="{ filled: Boolean(selectedPsdImage) }"
            @dragover.prevent
            @drop="onPsdDrop"
          >
            <button v-if="!selectedPsdImage" class="psd-drop" type="button" @click="pickPsdImage">
              <span class="psd-drop-icon"><UploadCloud :size="28" /></span>
              <strong>拖入商品图，或点击选择</strong>
              <small>支持 PNG / JPG / WebP · 仅本机处理</small>
            </button>

            <div v-else class="psd-selected-panel">
              <div class="psd-selected-visual">
                <img :src="selectedPsdImage.previewDataUrl" :alt="selectedPsdImage.name" />
              </div>
              <div class="psd-selected-meta">
                <div class="psd-selected-copy">
                  <strong :title="selectedPsdImage.name">{{ selectedPsdImage.name }}</strong>
                  <span>{{ formatBytes(selectedPsdImage.size) }} · 准备分层</span>
                </div>
                <div class="psd-selected-actions">
                  <button class="ghost-btn" type="button" @click="pickPsdImage"><RefreshCw :size="14" /> 更换</button>
                  <button class="primary-btn" type="button" @click="createPsdTask">
                    <Layers3 :size="16" /> {{ psdSettings.semiAutoMask ? '识别并修蒙版' : '开始分层' }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <details class="psd-advanced">
            <summary>
              <span>高级选项</span>
              <ChevronDown :size="14" class="psd-advanced-chevron" />
            </summary>
            <div class="psd-advanced-body">
              <label class="switch-row compact">
                <input v-model="psdSettings.semiAutoMask" type="checkbox" />
                <span class="switch" />
                <span class="switch-copy">
                  <strong>半自动修蒙版</strong>
                  <em>先出草稿，再手涂主体/道具后导出</em>
                </span>
              </label>
              <label class="switch-row compact">
                <input v-model="psdSettings.autoExport" type="checkbox" />
                <span class="switch" />
                <span class="switch-copy">
                  <strong>完成后自动导出</strong>
                  <em>直接写入工作目录，不再弹出另存</em>
                </span>
              </label>
              <label class="switch-row compact">
                <input v-model="psdSettings.writeLayerMasks" type="checkbox" />
                <span class="switch" />
                <span class="switch-copy">
                  <strong>写入图层蒙版</strong>
                  <em>导出后在 Photoshop / Photopea 中可再编辑</em>
                </span>
              </label>
              <label class="switch-row compact">
                <input v-model="psdSettings.subjectProtection" type="checkbox" />
                <span class="switch" />
                <span class="switch-copy">
                  <strong>主体保护</strong>
                  <em>修复背景时尽量避免侵蚀主体边缘</em>
                </span>
              </label>
            </div>
          </details>
        </template>
      </div>
      </div>
    </main>

    <!-- 提交生图后自动拉出的历史记录右栏：与左侧 sidebar 同级，可收起/打开 -->
      <aside
        v-if="activeView !== 'psd'"
        :class="['psd-window-rail', 'history-window-rail', { open: historyRailOpen, resizing: historyRailResizing }]"
        :style="historyRailStyle"
      >
        <div
          v-if="historyRailOpen"
          class="history-rail-resizer"
          role="separator"
          aria-label="调整历史记录栏宽度"
          aria-orientation="vertical"
          :aria-valuemin="HISTORY_RAIL_MIN_WIDTH"
          :aria-valuemax="HISTORY_RAIL_MAX_WIDTH"
          :aria-valuenow="historyRailWidth"
          tabindex="0"
          @pointerdown="startHistoryRailResize"
          @keydown.left.prevent="nudgeHistoryRailWidth(16)"
          @keydown.right.prevent="nudgeHistoryRailWidth(-16)"
        />
        <div class="psd-rail-head">
          <div class="psd-rail-head-row">
            <div>
              <strong>历史记录</strong>
              <span>{{ runningCount ? `${runningCount} 个任务生成中` : `共 ${tasks.length} 条记录` }}</span>
            </div>
          </div>
        </div>

        <div v-if="!railTasks.length" class="psd-rail-empty">
          <History :size="20" />
          <p>还没有生成记录</p>
        </div>

        <div v-else class="history-rail-list">
          <div class="waterfall history-rail-waterfall">
            <div v-for="(column, columnIndex) in railColumns" :key="columnIndex" class="wf-col">
              <template v-for="cell in column" :key="cell.key">
                <div v-if="cell.kind === 'card'" class="wf-card history-rail-task-card" @click="openTaskDetail(cell.task)">
                  <button class="wf-delete" type="button" aria-label="删除任务" :disabled="deletingTaskIds.has(cell.task.id)" @click.stop="removeTaskCompletely(cell.task)"><X :size="11" /></button>
                  <div v-if="cell.task.status === 'queued' || cell.task.status === 'running'" class="progress compact">
                    <span :style="{ width: `${Math.max(cell.task.progress, 8)}%` }" />
                  </div>
                  <p v-else-if="cell.task.status === 'failed'" class="task-error"><AlertCircle :size="12" /> 失败</p>
                  <p class="wf-prompt">{{ cell.task.prompt }}</p>
                  <small>{{ cell.task.status === 'queued' || cell.task.status === 'running' ? runningTaskCaption(cell.task) : taskStatusLabel(cell.task) }}</small>
                </div>
                <figure v-else class="wf-item history-rail-wf-item">
                  <button class="wf-delete" type="button" aria-label="删除图片任务" :disabled="deletingTaskIds.has(cell.task.id)" @click.stop="removeTaskImage(cell.task, cell.index!)"><X :size="11" /></button>
                  <img
                    :src="cell.src"
                    :alt="cell.task.prompt"
                    loading="lazy"
                    :style="{ aspectRatio: `auto ${cell.ratio}` }"
                    @click="previewImage = { src: cell.src!, name: cell.task.prompt, task: cell.task }"
                  />
                  <figcaption class="wf-overlay">
                    <button type="button" :aria-label="`下载结果 ${cell.index! + 1}`" @click="manualDownload(cell.task, cell.src!, cell.index!)">
                      <Download :size="13" />
                    </button>
                    <span class="wf-prompt">{{ cell.task.prompt }}</span>
                  </figcaption>
                </figure>
              </template>
            </div>
          </div>
        </div>
      </aside>

    <!-- 窗口级右侧栏：与左侧 sidebar 同级，占满窗口高度 -->
    <aside
      v-if="activeView === 'psd' && psdRailOpen && !(psdMaskEditor.open && psdMaskEditor.draft)"
      class="psd-window-rail"
    >
      <div class="psd-rail-head">
        <div class="psd-rail-head-row">
          <div>
            <strong>任务状态</strong>
            <span>{{ psdRunningCount ? `${psdRunningCount} 进行中` : '历史记录会保留' }}</span>
          </div>
          <button class="psd-rail-close" type="button" title="收起" @click="psdRailOpen = false">
            <X :size="16" />
          </button>
        </div>
        <div class="psd-rail-filters" role="tablist" aria-label="PSD 任务筛选">
          <button type="button" :class="{ active: psdTaskFilter === 'all' }" @click="psdTaskFilter = 'all'">全部</button>
          <button type="button" :class="{ active: psdTaskFilter === 'running' }" @click="psdTaskFilter = 'running'">进行</button>
          <button type="button" :class="{ active: psdTaskFilter === 'attention' }" @click="psdTaskFilter = 'attention'">失败</button>
          <button type="button" :class="{ active: psdTaskFilter === 'completed' }" @click="psdTaskFilter = 'completed'">完成</button>
        </div>
        <button
          v-if="psdInterruptedCount"
          class="psd-rail-clear"
          type="button"
          title="清除因退出而中断的记录（不是业务失败）"
          @click="clearInterruptedPsdTasks"
        >
          清除中断记录{{ psdInterruptedCount ? ` · ${psdInterruptedCount}` : '' }}
        </button>
      </div>

      <div v-if="!visiblePsdTasks.length" class="psd-rail-empty">
        <Layers3 :size="20" />
        <p>暂无任务</p>
      </div>

      <div v-else class="psd-rail-list">
        <article v-for="task in visiblePsdTasks" :key="task.id" class="psd-rail-card">
          <div class="psd-rail-thumb">
            <img v-if="task.image.previewDataUrl" :src="task.image.previewDataUrl" :alt="task.image.name" />
            <span v-else class="psd-rail-thumb-fallback">{{ (task.image.name || '?').slice(0, 1) }}</span>
          </div>
          <div class="psd-rail-body">
            <div class="psd-rail-title">
              <strong :title="task.image.name">{{ task.image.name }}</strong>
              <span :class="['status-pill', task.status]">{{ psdStatusLabel(task.status) }}</span>
            </div>
            <p class="psd-rail-stage">{{ task.stage }}</p>
            <div v-if="task.status === 'processing'" class="progress compact"><span :style="{ width: `${task.progress}%` }" /></div>
            <div class="psd-rail-meta">
              <Clock3 :size="11" /> {{ formatTime(task.createdAt) }}
              <template v-if="task.result"> · {{ task.result.layerNames.length }} 层</template>
            </div>
            <p v-if="task.error" class="task-error tight"><AlertCircle :size="12" /> {{ task.error }}</p>
            <button
              v-if="task.status === 'failed'"
              class="ghost-btn accent tiny"
              type="button"
              @click="retryPsdTask(task)"
            >
              <RotateCcw :size="12" /> 重试
            </button>
          </div>
<div v-if="task.result" class="psd-rail-side-actions">
            <button class="ghost-btn accent tiny" type="button" :disabled="openingInPhotopea" @click="openPsdInPhotopea(task)">
              <WandSparkles :size="12" /> 在 Photopea 编辑
            </button>
            <button class="ghost-btn tiny" type="button" @click="openPsd(task)">
              <Layers3 :size="12" /> 在 Photoshop 打开
            </button>
            <button class="ghost-btn tiny" type="button" @click="revealPsd(task)">
              <FolderOpen :size="12" /> 定位
            </button>
          </div>
        </article>
      </div>
    </aside>

    <Transition name="fade">
      <div v-if="previewImage" class="lightbox" @mousedown="previewImage = null">
        <button class="lightbox-close" type="button" aria-label="关闭预览"><X :size="20" /></button>
        <div class="lightbox-stage">
          <img :src="previewImage.src" :alt="previewImage.name" />
<div v-if="previewImage.task" class="lightbox-actions" @mousedown.stop>
            <button type="button" :disabled="openingInPhotopea" @click="openPreviewInPhotopea">
              <LoaderCircle v-if="openingInPhotopea" :size="14" class="spin" />
              <WandSparkles v-else :size="14" />
              Photopea 打开
            </button>
            <button type="button" :disabled="openingInPhotoshop" @click="openPreviewInPhotoshop">
              <LoaderCircle v-if="openingInPhotoshop" :size="14" class="spin" />
              <Layers3 v-else :size="14" />
              在 Photoshop 打开
            </button>
            <button type="button" :disabled="convertingPreviewPsd" @click="convertPreviewToPsd">
              <LoaderCircle v-if="convertingPreviewPsd" :size="14" class="spin" />
              <Layers3 v-else :size="14" />
              一键转 PSD
              <em class="beta-tag">beta</em>
            </button>
            <button type="button" :disabled="copyingImage" @click="copyPreviewImage">
              <LoaderCircle v-if="copyingImage" :size="14" class="spin" />
              <Check v-else-if="imageCopied" :size="14" />
              <ClipboardCopy v-else :size="14" />
              {{ imageCopied ? '已复制' : '复制图片' }}
            </button>
            <button type="button" @click="copyPreviewPrompt">
              <Check v-if="promptCopied" :size="14" />
              <Copy v-else :size="14" />
              {{ promptCopied ? '已复制' : '复制提示词' }}
            </button>
            <button type="button" @click="reusePreviewTask">
              <RotateCcw :size="14" />
              复用
            </button>
          </div>
        </div>
        <span class="lightbox-name">{{ previewImage.name }}</span>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="liveTaskDetail" class="task-detail-overlay" @mousedown.self="closeTaskDetail">
        <aside class="task-detail-panel" role="dialog" aria-label="任务详情" @mousedown.stop>
          <header class="task-detail-head">
            <div>
              <strong>任务详情</strong>
              <span :class="['task-detail-status', liveTaskDetail.status]">{{ taskStatusLabel(liveTaskDetail) }}</span>
            </div>
            <button type="button" class="icon-round" aria-label="关闭" @click="closeTaskDetail"><X :size="16" /></button>
          </header>

          <div v-if="liveTaskDetail.status === 'queued' || liveTaskDetail.status === 'running'" class="task-detail-progress">
            <div class="progress"><span :style="{ width: `${Math.max(liveTaskDetail.progress, 8)}%` }" /></div>
            <small>生成中 · {{ liveTaskDetail.progress }}%</small>
          </div>

          <p v-if="liveTaskDetail.error" class="task-detail-error"><AlertCircle :size="14" /> {{ liveTaskDetail.error }}</p>

          <dl class="task-detail-grid">
            <div><dt>任务 ID</dt><dd>#{{ liveTaskDetail.id }}</dd></div>
            <div><dt>时间</dt><dd>{{ formatDateTime(liveTaskDetail.createdAt) }}</dd></div>
            <div><dt>比例</dt><dd>{{ liveTaskDetail.size || '-' }}</dd></div>
            <div><dt>分辨率</dt><dd>{{ liveTaskDetail.resolution || '-' }}</dd></div>
            <div><dt>质量</dt><dd>{{ liveTaskDetail.quality || '-' }}</dd></div>
            <div><dt>线路</dt><dd>{{ taskProviderLabel(liveTaskDetail) }}</dd></div>
          </dl>

          <div class="task-detail-prompt">
            <div class="task-detail-label">
              <span>提示词</span>
              <button type="button" class="ghost-btn" @click="copyTaskDetailPrompt"><Copy :size="13" /> 复制</button>
            </div>
            <p>{{ liveTaskDetail.prompt || '（无提示词）' }}</p>
          </div>

          <div v-if="liveTaskDetail.sourceImages?.length" class="task-detail-refs">
            <span class="task-detail-label">参考图</span>
            <div class="task-detail-thumbs">
              <img v-for="(src, index) in liveTaskDetail.sourceImages" :key="`${liveTaskDetail.id}-src-${index}`" :src="src" alt="" />
            </div>
          </div>

          <div v-if="galleryImages(liveTaskDetail).length" class="task-detail-results">
            <span class="task-detail-label">结果图 · {{ galleryImages(liveTaskDetail).length }}</span>
            <div class="task-detail-thumbs results">
              <button
                v-for="(src, index) in galleryImages(liveTaskDetail)"
                :key="`${liveTaskDetail.id}-out-${index}`"
                type="button"
                @click="previewImage = { src, name: liveTaskDetail.prompt, task: liveTaskDetail }"
              >
                <img :src="src" alt="" />
              </button>
            </div>
          </div>

          <footer class="task-detail-actions">
            <button v-if="liveTaskDetail.status === 'failed'" type="button" class="ghost-btn accent" @click="retryTask(liveTaskDetail)"><RotateCcw :size="14" /> 重试</button>
            <button type="button" class="ghost-btn" @click="reuseFromDetail(liveTaskDetail)"><RotateCcw :size="14" /> 复用参数</button>
            <button type="button" class="ghost-btn danger" :disabled="deletingTaskIds.has(liveTaskDetail.id)" @click="removeTaskCompletely(liveTaskDetail)">
              <Trash2 :size="14" /> 删除任务
            </button>
          </footer>
        </aside>
      </div>
    </Transition>

    <Transition name="toast">
      <div v-if="globalMessage || globalError" :class="['toast', { error: globalError }]">
        <CheckCircle2 v-if="globalMessage" :size="16" />
        <AlertCircle v-else :size="16" />
        {{ globalMessage || globalError }}
      </div>
    </Transition>

    <div v-if="loginOpen" class="modal-backdrop" @mousedown.self="loginOpen = false">
      <section class="modal" role="dialog" aria-modal="true" aria-label="登录AI 图像工作台">
        <button class="modal-close" type="button" aria-label="关闭" @click="loginOpen = false"><X :size="17" /></button>
        <h2>登录</h2>
        <p>登录后同步积分和任务，本地选择的图片仍未上传。</p>
        <div v-if="wechatLoginAvailable" class="login-mode-tabs">
          <button type="button" :class="{ active: loginMode === 'password' }" @click="switchLoginMode('password')">账号密码</button>
          <button type="button" :class="{ active: loginMode === 'wechat' }" @click="switchLoginMode('wechat')"><QrCode :size="14" /> 微信扫码</button>
        </div>
        <template v-if="loginMode === 'password'">
          <label class="modal-field"><span>账号</span><input v-model="loginForm.account" autocomplete="username" placeholder="手机号或账号" @keydown.enter="login" /></label>
          <label class="modal-field"><span>密码</span><input v-model="loginForm.password" type="password" autocomplete="current-password" placeholder="请输入密码" @keydown.enter="login" /></label>
          <label v-if="loginAgreementRequired" class="agreement"><input v-model="loginForm.agreement" type="checkbox" /> <span>我已阅读并同意用户协议和隐私政策</span></label>
          <p v-if="loginError" class="login-error"><AlertCircle :size="14" /> {{ loginError }}</p>
          <button class="modal-primary" type="button" :disabled="loginSubmitting" @click="login">
            <LoaderCircle v-if="loginSubmitting" :size="16" class="spin" />
            {{ loginSubmitting ? '登录中…' : '登录并继续' }}
          </button>
        </template>
        <template v-else>
          <div class="wechat-qr-panel">
            <LoaderCircle v-if="wechatQrLoading" :size="24" class="spin" />
            <img v-else-if="wechatQrDataUrl" :src="wechatQrDataUrl" alt="微信扫码登录二维码" width="220" height="220" />
            <button v-if="wechatQrExpired" type="button" class="ghost-btn" @click="startWechatLogin"><RefreshCw :size="14" /> 二维码已过期，点击刷新</button>
            <p v-else class="wechat-qr-hint">请使用微信扫一扫登录</p>
          </div>
          <p v-if="wechatLoginError" class="login-error"><AlertCircle :size="14" /> {{ wechatLoginError }}</p>
        </template>
      </section>
    </div>

    <div v-if="rechargeOpen" class="modal-backdrop" @mousedown.self="closeRecharge">
      <section class="modal" role="dialog" aria-modal="true" aria-label="充值">
        <button class="modal-close" type="button" aria-label="关闭" @click="closeRecharge"><X :size="17" /></button>
        <h2>充值</h2>
        <p>选择套餐后用微信扫码支付，到账会自动刷新积分。</p>

        <p v-if="rechargeError" class="login-error"><AlertCircle :size="14" /> {{ rechargeError }}</p>

        <div v-if="rechargeLoading" class="wechat-qr-panel"><LoaderCircle :size="24" class="spin" /></div>

        <template v-else-if="!rechargeQrDataUrl">
          <div class="recharge-list">
            <button
              v-for="item in rechargePackages"
              :key="item.id"
              class="recharge-item"
              type="button"
              :disabled="rechargeCreating"
              @click="pickRechargePackage(item)"
            >
              <span class="recharge-item-main">
                <strong>{{ item.name }}</strong>
                <em>{{ item.credits.toLocaleString() }} 积分<template v-if="item.draw_count"> · 约 {{ item.draw_count }} 张</template></em>
              </span>
              <span class="recharge-item-price">¥ {{ item.price }}</span>
            </button>
          </div>
        </template>

        <template v-else>
          <div class="wechat-qr-panel">
            <Check v-if="rechargePaid" :size="40" class="recharge-paid-icon" />
            <img v-else :src="rechargeQrDataUrl" alt="微信支付二维码" width="220" height="220" />
            <p class="wechat-qr-hint">
              {{ rechargePaid ? '支付成功，积分已到账' : `微信扫码支付 ¥ ${rechargeActivePackage?.price ?? ''}，支付后自动到账` }}
            </p>
          </div>
          <button v-if="!rechargePaid" class="ghost-btn" type="button" @click="rechargeQrDataUrl = ''"><RotateCcw :size="14" /> 换个套餐</button>
        </template>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-backdrop" @mousedown.self="settingsOpen = false">
      <section class="modal" role="dialog" aria-modal="true" aria-label="设置">
        <button class="modal-close" type="button" aria-label="关闭" @click="settingsOpen = false"><X :size="17" /></button>
        <h2>设置</h2>
        <p>仅保存在本机。</p>
        <label class="modal-field">
          <span>外观</span>
          <div class="select-wrap">
            <select v-model="settings.theme"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select>
            <ChevronDown :size="14" />
          </div>
        </label>
        <label class="modal-field">
          <span>问候称呼 <small>可选</small></span>
          <input v-model="settings.greetingName" type="text" maxlength="12" autocomplete="off" placeholder="留空则不显示名字" />
        </label>
        <div class="modal-field">
          <span>保存目录</span>
          <button class="directory-picker" type="button" @click="chooseOutputDirectory"><FolderOpen :size="15" /><span>{{ settings.outputDirectory }}</span></button>
        </div>
        <label class="modal-field">
          <span>网站地址</span>
          <input v-model="settings.siteUrl" type="url" placeholder="https://…（填写后顶栏显示打开网站按钮）" />
        </label>
        <div class="storage-row">
          <span>本地产物占用 {{ formatBytes(psdStorageBytes) }}</span>
          <button type="button" @click="openOutputDirectory"><FolderOpen :size="13" /> 打开保存目录</button>
        </div>
        <div class="storage-row">
          <span>{{ modelStatusLabel }}</span>
          <span class="storage-row-actions">
            <button type="button" :disabled="modelBusy" @click="verifyModels"><RefreshCw :size="13" :class="{ spinning: modelBusy }" /> 重新校验</button>
            <button v-if="modelStatus.phase === 'error'" type="button" :disabled="modelBusy" @click="repairModels"><Download :size="13" /> 修复</button>
          </span>
        </div>
        <label class="settings-check"><input v-model="settings.autoDownload" type="checkbox" /><span><strong>完成后自动下载</strong><small>写入临时文件后原子落盘，并记录 SHA-256。</small></span></label>
        <div class="storage-row">
          <span>版本 {{ appInfo.version || '…' }}<template v-if="appInfo.arch"> · {{ appInfo.arch }}</template></span>
          <span class="storage-row-actions">
            <button v-if="updateAvailable" type="button" @click="settingsOpen = false; updateModalOpen = true"><ArrowUp :size="13" /> 新版本 {{ updateState.version }}</button>
            <button v-else type="button" :disabled="updateState.phase === 'checking'" @click="checkForUpdates(true)">
              <RefreshCw :size="13" :class="{ spinning: updateState.phase === 'checking' }" /> 检查更新
            </button>
          </span>
        </div>
        <button class="modal-primary" type="button" @click="saveSettings"><Check :size="16" /> 保存设置</button>
      </section>
    </div>

    <div v-if="updateModalOpen" class="modal-backdrop" @mousedown.self="updateModalOpen = false">
      <section class="modal update-modal" role="dialog" aria-modal="true" aria-label="软件更新">
        <button class="modal-close" type="button" aria-label="关闭" @click="updateModalOpen = false"><X :size="17" /></button>
        <h2>发现新版本 {{ updateState.version }}</h2>
        <p v-if="updateState.notes" class="update-notes">{{ updateState.notes }}</p>
        <p v-else>当前 {{ appInfo.version }} → 新版本 {{ updateState.version }}。</p>

        <div v-if="updateState.phase === 'downloading'" class="update-progress">
          <div class="update-progress-bar"><span :style="{ width: `${updateState.progress || 0}%` }" /></div>
          <span>正在下载… {{ updateState.progress || 0 }}%</span>
        </div>
        <p v-else-if="updateState.phase === 'error'" class="update-error">{{ updateState.message }}</p>

        <div class="update-actions">
          <button v-if="updateState.releasePage" class="ghost-btn" type="button" @click="openUpdateReleasePage"><Globe :size="14" /> 手动下载</button>
          <button v-if="updateState.phase === 'available' || updateState.phase === 'error'" class="modal-primary" type="button" @click="downloadUpdate"><Download :size="16" /> 下载更新</button>
          <button v-else-if="updateState.phase === 'staged'" class="modal-primary" type="button" @click="applyUpdate"><ArrowUp :size="16" /> 立即重启更新</button>
          <button v-else-if="updateState.phase === 'downloading'" class="modal-primary" type="button" disabled><LoaderCircle :size="16" class="spin" /> 下载中</button>
          <button v-else-if="updateState.phase === 'applying'" class="modal-primary" type="button" disabled>准备重启…</button>
        </div>
      </section>
    </div>

    <div v-if="manualOpen" class="modal-backdrop" @mousedown.self="manualOpen = false">
      <section class="modal guide-modal" role="dialog" aria-modal="true" aria-label="功能说明">
        <button class="modal-close" type="button" aria-label="关闭" @click="manualOpen = false"><X :size="17" /></button>
        <h2>功能说明</h2>
        <p>四个工作流的最短上手路径。素材先在本地选择，点击提交后才会上传。</p>
        <div class="guide-list">
          <article v-for="guide in featureGuides" :key="guide.title" class="guide-item">
            <header>
              <component :is="guide.icon" :size="17" />
              <h3>{{ guide.title }}</h3>
            </header>
            <p>{{ guide.summary }}</p>
            <ol>
              <li v-for="step in guide.steps" :key="step">{{ step }}</li>
            </ol>
          </article>
        </div>
        <p class="guide-note"><AlertCircle :size="14" /> 单次生成最多使用 4 张参考图；积分以提交前显示为准。</p>
      </section>
    </div>
  </div>
</template>
