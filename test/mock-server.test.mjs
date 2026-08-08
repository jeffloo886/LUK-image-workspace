import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/models`)
      if (response.ok) return
    } catch {
      // keep polling while the child starts
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  child.kill('SIGTERM')
  throw new Error('mock server did not start')
}

test('mock provider supports models, generation, and multipart edits', async (t) => {
  const port = 8878
  const child = spawn(process.execPath, ['examples/mock-openai-server/server.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, MOCK_OPENAI_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill('SIGTERM'))
  await waitForServer(`http://127.0.0.1:${port}/v1`, child)

  const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer demo-local-only' } })
  assert.equal(models.status, 200)
  assert.equal((await models.json()).data[0].id, 'mock-image2')

  const generation = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
    method: 'POST',
    headers: { authorization: 'Bearer demo-local-only', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-image2', prompt: 'synthetic fixture', n: 2 })
  })
  const generated = await generation.json()
  assert.equal(generation.status, 200)
  assert.equal(generated.data.length, 2)
  assert.match(generated.data[0].b64_json, /^[A-Za-z0-9+/=]+$/)

  const form = new FormData()
  form.append('model', 'mock-image2')
  form.append('prompt', 'synthetic edit')
  form.append('n', '2')
  form.append('image[]', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'fixture.png')
  const edit = await fetch(`http://127.0.0.1:${port}/v1/images/edits`, {
    method: 'POST',
    headers: { authorization: 'Bearer demo-local-only' },
    body: form
  })
  const edited = await edit.json()
  assert.equal(edit.status, 200)
  assert.equal(edited.data.length, 2)

  const output = await new Promise((resolve) => {
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk.toString() })
    setTimeout(() => resolve(text), 20)
  })
  assert.equal(output.includes('demo-local-only'), false)
  assert.equal(output.includes('authorization'), false)
})
