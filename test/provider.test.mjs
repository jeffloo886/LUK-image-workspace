import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { providerEndpoint, normalizeProviderBaseUrl, sanitizeProviderText } from '../src/shared/provider.ts'

test('normalizes provider roots and builds only the supported Images endpoints', () => {
  assert.equal(normalizeProviderBaseUrl('https://example.test'), 'https://example.test/v1')
  assert.equal(normalizeProviderBaseUrl('https://example.test/v1/'), 'https://example.test/v1')
  assert.equal(normalizeProviderBaseUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/v1')
  assert.equal(normalizeProviderBaseUrl('http://remote.example/v1'), '')
  assert.equal(providerEndpoint('https://example.test/v1', 'models').pathname, '/v1/models')
  assert.equal(providerEndpoint('https://example.test/v1', 'generate').pathname, '/v1/images/generations')
  assert.equal(providerEndpoint('https://example.test/v1', 'edit').pathname, '/v1/images/edits')
})

test('sanitizes Bearer values and signed URL query strings', () => {
  const sanitized = sanitizeProviderText('Bearer super-secret https://cdn.example/result.png?X-Amz-Signature=secret&token=secret')
  assert.equal(sanitized.includes('super-secret'), false)
  assert.equal(sanitized.includes('?'), false)
  assert.equal(sanitized.includes('result.png'), true)
})

test('the renderer API has no browser request or local key storage fallback', async () => {
  const apiSource = await readFile(new URL('../src/renderer/src/api.ts', import.meta.url), 'utf8')
  assert.equal(/localStorage|sessionStorage/.test(apiSource), false)
  assert.equal(/\bfetch\s*\(/.test(apiSource), false)
  assert.equal(apiSource.includes('/api/app.image2.'), false)
})

test('provider key storage is main-process safeStorage backed', async () => {
  const mainSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(mainSource, /safeStorage\.isEncryptionAvailable\(\)/)
  assert.match(mainSource, /safeStorage\.encryptString\(key\)/)
  assert.match(mainSource, /safeStorage\.decryptString\(/)
  assert.match(mainSource, /provider-key\.json/)
  assert.doesNotMatch(mainSource, /apiKey\s*:\s*key/)
})

test('local task persistence strips remote output payloads', async () => {
  const appSource = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  assert.match(appSource, /resultImages:\s*\[\]/)
  assert.match(appSource, /sourceImages:\s*undefined/)
  assert.match(appSource, /local-result:\/\//)
  assert.doesNotMatch(appSource, /localStorage\.setItem\([^\n]*apiKey/i)
})

test('renderer preserves 401, 429, and 5xx status while sanitizing provider errors', async (t) => {
  const { generateImages } = await import(`../src/renderer/src/api.ts?status-test=${Date.now()}`)
  const statuses = [401, 429, 500]
  const secret = 'demo-status-secret'
  const originalWindow = globalThis.window
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  })

  for (const status of statuses) {
    globalThis.window = {
      desktop: {
        getProviderConfig: async () => ({ baseUrl: 'https://provider.example/v1', model: 'mock-image2', hasApiKey: true, maskedApiKey: 'dem••••cret' }),
        apiRequest: async () => ({
          status,
          body: { error: { message: `provider failed Bearer ${secret} https://provider.example/result.png?token=${secret}` } }
        })
      }
    }
    await assert.rejects(
      () => generateImages({ prompt: 'synthetic status fixture' }),
      (error) => {
        assert.equal(error.status, status)
        assert.equal(error.message.includes(secret), false)
        assert.equal(error.message.includes('?token='), false)
        return true
      }
    )
  }
})
