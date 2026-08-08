export type ProviderConfig = {
  baseUrl: string
  model: string
  hasApiKey: boolean
  maskedApiKey: string
}

export type ImageRequestFile = {
  name: string
  type: string
  bytes: ArrayBuffer
}

export type ImageRequest = {
  model?: string
  prompt: string
  count?: number
  size?: string
  quality?: string
  sources?: ImageRequestFile[]
}

export type GeneratedImage = {
  src: string
  revisedPrompt?: string
}

type ImagesResponse = {
  data?: Array<{
    url?: string
    b64_json?: string
    revised_prompt?: string
  }>
  error?: { message?: string; type?: string; code?: string | number }
  message?: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

function requireDesktop(): NonNullable<Window['desktop']> {
  if (!window.desktop) throw new ApiError('Use this feature in the LUK Image Workspace desktop app')
  return window.desktop
}

function cleanMessage(value: unknown, fallback: string): string {
  const text = String(value || '').trim()
  if (!text) return fallback
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s)]+/gi, (raw) => {
      try {
        const parsed = new URL(raw)
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString()
      } catch {
        return '[redacted-url]'
      }
    })
    .replace(/\/Users\/[^\s/]+/g, '/Users/[redacted]')
    .slice(0, 800)
}

async function request(
  operation: 'models' | 'generate' | 'edit',
  json?: Record<string, unknown>,
  files?: ImageRequestFile[]
): Promise<unknown> {
  const desktop = requireDesktop()
  let response: { status: number; body: unknown }
  try {
    response = await desktop.apiRequest({
      operation,
      json,
      files: files?.map((file) => ({
        name: file.name,
        type: file.type,
        bytes: file.bytes
      }))
    })
  } catch (error) {
    throw new ApiError(cleanMessage(error instanceof Error ? error.message : error, 'Network connection failed'))
  }
  const body = response.body as ImagesResponse | null
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      cleanMessage(body?.error?.message || body?.message, `Provider request failed (HTTP ${response.status})`),
      response.status
    )
  }
  return body
}

function dataUrlFromBase64(value: string): string {
  const normalized = value.trim()
  if (/^data:image\//i.test(normalized)) return normalized
  return `data:image/png;base64,${normalized}`
}

function normalizeImages(value: unknown): GeneratedImage[] {
  const body = value as ImagesResponse | null
  const rows = Array.isArray(body?.data) ? body.data : []
  const images: GeneratedImage[] = []
  for (const row of rows) {
      const b64 = String(row?.b64_json || '').trim()
      const url = String(row?.url || '').trim()
      if (!b64 && !url) continue
      images.push({
        src: b64 ? dataUrlFromBase64(b64) : url,
        revisedPrompt: String(row?.revised_prompt || '').trim() || undefined
      })
  }
  return images
}

async function resolveModel(model?: string): Promise<string> {
  const config = await requireDesktop().getProviderConfig()
  const resolved = String(model || config.model || '').trim()
  if (!config.baseUrl || !resolved || !config.hasApiKey) {
    throw new ApiError('Add an API URL, API key, and Image2 model in Settings first')
  }
  return resolved
}

function clampCount(value: number | undefined): number {
  const count = Math.floor(Number(value || 1))
  return Math.max(1, Math.min(10, Number.isFinite(count) ? count : 1))
}

export async function generateImages(input: ImageRequest): Promise<GeneratedImage[]> {
  const model = await resolveModel(input.model)
  const body = await request('generate', {
    model,
    prompt: input.prompt.trim(),
    n: clampCount(input.count),
    size: input.size || '1024x1024',
    quality: input.quality || 'auto'
  })
  const images = normalizeImages(body)
  if (!images.length) throw new ApiError('The provider returned success but no usable image result')
  return images
}

export async function editImages(input: ImageRequest): Promise<GeneratedImage[]> {
  const model = await resolveModel(input.model)
  if (!input.sources?.length) throw new ApiError('Image editing requires at least one reference image')
  const body = await request('edit', {
    model,
    prompt: input.prompt.trim(),
    n: clampCount(input.count),
    size: input.size || '1024x1024',
    quality: input.quality || 'auto'
  }, input.sources.slice(0, 16))
  const images = normalizeImages(body)
  if (!images.length) throw new ApiError('The provider returned success but no usable edit result')
  return images
}

export async function getProviderConfig(): Promise<ProviderConfig> {
  return requireDesktop().getProviderConfig()
}

export async function saveProviderConfig(value: {
  baseUrl: string
  model: string
  apiKey?: string
  clearApiKey?: boolean
}): Promise<void> {
  await requireDesktop().saveProviderConfig(value)
}

export async function testProviderConnection(): Promise<void> {
  try {
    await requireDesktop().testProviderConnection()
  } catch (error) {
    throw new ApiError(cleanMessage(error instanceof Error ? error.message : error, 'Connection test failed'))
  }
}

/** No second model is required: keep the prompt helper deterministic and local. */
export async function rewritePrompt(prompt: string): Promise<{ content: string }> {
  const value = String(prompt || '').trim()
  if (!value) return { content: '' }
  const suffix = ' Commercial-ready composition, accurate subject details, clean lighting, no unwanted text or logos.'
  return { content: value.endsWith('.') ? `${value}${suffix}` : `${value}.${suffix}` }
}

export const api = {
  generateImages,
  editImages,
  getProviderConfig,
  saveProviderConfig,
  testProviderConnection,
  rewritePrompt
}

/** Kept for local-crop and legacy result rendering; relative URLs are rejected by callers. */
export function absoluteAssetUrl(value: string): string {
  const url = String(value || '').trim()
  if (/^(data:|blob:|https?:\/\/)/i.test(url)) return url
  return ''
}
