export type ProviderOperation = 'models' | 'generate' | 'edit'

export function normalizeProviderBaseUrl(value: unknown): string {
  const raw = String(value || '').trim().slice(0, 500)
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    const isLocalHttp = parsed.protocol === 'http:' && localHost
    if (parsed.protocol !== 'https:' && !isLocalHttp) return ''
    parsed.search = ''
    parsed.hash = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/v1'
    if (!parsed.pathname.endsWith('/v1')) parsed.pathname = `${parsed.pathname}/v1`.replace(/\/+/g, '/')
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export function providerEndpoint(baseUrl: string, operation: ProviderOperation): URL {
  const pathName = operation === 'models'
    ? '/models'
    : operation === 'generate'
      ? '/images/generations'
      : '/images/edits'
  return new URL(pathName.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`)
}

export function sanitizeProviderText(value: unknown): string {
  return String(value || '')
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
    .slice(0, 2000)
}
