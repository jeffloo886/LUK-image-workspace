/*
 * 默认后端地址与租户号为占位符（与主进程保持一致）：
 * 本应用对接「图片生成」类后端协议，仓库不内置任何特定线上服务。
 * 配置自己的后端后，应用才能真正调用登录/积分/生成/充值接口。
 */
export const API_BASE_URL = 'https://api.example.com'
export const TENANT_SN = 'YOUR_TENANT_SN'
export const PC_TERMINAL = 4

const TOKEN_KEY = 'image_workspace_token'
const USER_KEY = 'image_workspace_user'

type ApiResponse<T> = {
  code: number
  msg?: string
  data: T
}

export type UserInfo = {
  id?: number
  nickname?: string
  avatar?: string
  mobile?: string
  credits?: number
  balance?: number
  isMember?: boolean
}

export type UsageOverview = {
  daily: Array<{
    date: string
    tasks: number
    images: number
    resolutions?: Record<'1K' | '2K' | '4K' | '历史', number>
  }>
  ranges?: Record<'all' | '30d' | '7d', {
    tasks: number
    images: number
    credits: number
    active_days: number
    current_streak: number
    longest_streak: number
    peak_hour: number | null
    top_ratio: string
    hour_histogram: number[]
    resolution_breakdown?: Record<'1K' | '2K' | '4K' | '历史', { tasks: number; images: number }>
    history_reconstructed?: number
  }>
  hour_histogram: number[]
  first_task_time: number
  total_tasks: number
  history_reconstructed?: number
}

export class ApiError extends Error {
  constructor(message: string, readonly authExpired = false) {
    super(message)
    this.name = 'ApiError'
  }
}

/* 仅在开发预览（IMAGE_WORKSPACE_DEV_FAKE_SESSION=1 且未打包）下由 App 启动时置为 true。
 * 打包构建里主进程永远返回 false，这条分支不可能被触发。 */
let devKeepSession = false

export function setDevKeepSession(value: boolean): void {
  devKeepSession = value
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export function getStoredUser(): UserInfo | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as UserInfo) : null
  } catch {
    return null
  }
}

export function setStoredUser(user: UserInfo | null): void {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
  else localStorage.removeItem(USER_KEY)
}

function endpoint(path: string): string {
  const url = new URL(path, API_BASE_URL)
  url.searchParams.set('tenant_sn', TENANT_SN)
  return url.toString()
}

type DesktopRequestOptions = {
  method?: 'GET' | 'POST'
  json?: Record<string, unknown>
  file?: File
}

async function request<T>(path: string, options: DesktopRequestOptions = {}, needLogin = true): Promise<T> {
  const token = getToken()
  if (needLogin && !token) throw new ApiError('请先登录后继续', true)
  let status = 0
  let rawBody: unknown
  try {
    if (window.desktop) {
      const file = options.file
        ? {
            name: options.file.name,
            type: options.file.type,
            bytes: await options.file.arrayBuffer()
          }
        : undefined
      const response = await window.desktop.apiRequest({
        path,
        method: options.method || 'GET',
        token,
        json: options.json,
        file
      })
      status = response.status
      rawBody = response.body
    } else {
      const headers = new Headers()
      if (token) {
        headers.set('token', token)
        headers.set('Authorization', `Bearer ${token}`)
      }
      let body: BodyInit | undefined
      if (options.file) {
        const form = new FormData()
        form.append('file', options.file)
        body = form
      } else if (options.json) {
        headers.set('Content-Type', 'application/json')
        body = JSON.stringify(options.json)
      }
      const response = await fetch(endpoint(path), { method: options.method || 'GET', headers, body })
      status = response.status
      rawBody = await response.json()
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : '网络连接失败，请检查网络后重试'
    throw new ApiError(message)
  }
  if (status < 200 || status >= 300) throw new ApiError(`服务请求失败（HTTP ${status}）`)
  const body = rawBody as ApiResponse<T>
  if (!body || typeof body !== 'object') throw new ApiError('后台返回格式异常')
  if (body.code === 1) return body.data
  if (body.code === -1) {
    // 开发预览用的是假 token，后端必然拒绝。此时既不清会话、也不标记 authExpired，
    // 否则渲染层任何一处「过期即登出」的分支（api / refreshCredits …）都会把界面踢回登录页。
    if (devKeepSession) throw new ApiError('开发预览：后端拒绝了假 token（已忽略）')
    setToken('')
    setStoredUser(null)
    void window.desktop?.clearSession().catch(() => undefined)
    throw new ApiError('登录已过期，请重新登录', true)
  }
  throw new ApiError(body.msg || '请求失败')
}

export function absoluteAssetUrl(value: string): string {
  const url = String(value || '').trim()
  if (!url) return ''
  if (/^(data:|blob:|https?:\/\/)/i.test(url)) return url
  return new URL(url.startsWith('/') ? url : `/${url}`, API_BASE_URL).toString()
}

export const api = {
  serviceConfig: () => request<Record<string, unknown>>('/api/app.image2.service/getConfig', {}, false),
  providers: (mode: 'text2img' | 'img2img') =>
    request<unknown>(`/api/app.image2.generate/providers?mode=${mode}`, {}, false),
  login: (account: string, password: string, agreement: boolean) =>
    request<Record<string, unknown>>(
      '/api/app.image2.auth/login',
      {
        method: 'POST',
        json: {
          account,
          password,
          captcha_key: '',
          captcha_code: '',
          agreement: agreement ? 1 : 0,
          terminal: PC_TERMINAL
        }
      },
      false
    ),
  wechatAuthUrl: () =>
    request<{ url: string; state: string; provider: string }>(
      '/api/app.image2.auth/wechatAuthUrl',
      {
        method: 'POST',
        json: {
          redirect_url: API_BASE_URL,
          provider: 'open',
          terminal: PC_TERMINAL,
          mode: 'poll'
        }
      },
      false
    ),
  wechatLoginPoll: (state: string) =>
    request<{ status: 'pending' | 'success' | 'fail' | 'expired'; message?: string } & Record<string, unknown>>(
      '/api/app.image2.auth/wechatLoginPoll',
      { method: 'POST', json: { state } },
      false
    ),
  /*
   * 充值：terminal=4(PC) 时后端走微信 Native 下单，
   * order/create 返回 pay.config 即可扫的 code_url，再轮询 payStatus 到账。
   */
  rechargePackages: () => request<Record<string, unknown>>('/api/app.image2.package/lists'),
  createRechargeOrder: (packageId: number) =>
    request<Record<string, unknown>>('/api/app.image2.order/create', {
      method: 'POST',
      json: { package_id: packageId, pay_way: 2, terminal: 4 }
    }),
  rechargePayStatus: (orderNo: string) =>
    request<Record<string, unknown>>(`/api/app.image2.order/payStatus?order_no=${encodeURIComponent(orderNo)}`),
  userStats: () => request<Record<string, unknown>>('/api/app.image2.user/stats'),
  userOverview: () => request<UsageOverview>('/api/app.image2.user/overview'),
  uploadImage: (file: File) => request<unknown>('/api/app.image2.upload/image', { method: 'POST', file }),
  createGenerate: (payload: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/app.image2.generate/create', {
      method: 'POST',
      json: payload
    }),
  rewritePrompt: (prompt: string) =>
    request<{ content?: string }>('/api/app.image2.generate/rewrite', {
      method: 'POST',
      json: { prompt }
    }),
  pollTask: (taskId: number) =>
    request<Record<string, unknown>>(`/api/app.image2.task/poll?task_id=${taskId}`),
  taskDetail: (taskId: number) =>
    request<Record<string, unknown>>(`/api/app.image2.task/detail?task_id=${taskId}`),
  taskHistory: (pageNo: number, pageSize = 50) =>
    request<Record<string, unknown>>(`/api/app.image2.task/history?page_no=${pageNo}&page_size=${pageSize}`),
  deleteTask: (taskId: number) =>
    request<Record<string, unknown>>('/api/app.image2.task/delete', {
      method: 'POST',
      json: { task_id: taskId }
    }),
  deleteFailedTasks: () =>
    request<Record<string, unknown>>('/api/app.image2.task/deleteFailed', {
      method: 'POST',
      json: {}
    })
}
