#!/usr/bin/env node

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const port = Number(process.env.MOCK_OPENAI_PORT || 8787)
const root = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.resolve(root, '../../resources/icons/app-icon.png')
const fallbackPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

let fixture = fallbackPng
try {
  fixture = (await readFile(fixturePath)).toString('base64')
} catch {
  // A tiny valid PNG keeps the server self-contained if the app icon is absent.
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function countFromBody(body) {
  const match = /(?:"n"|name="n"\r?\n\r?\n)\s*:?\s*([0-9]+)/i.exec(body)
  return Math.max(1, Math.min(10, Number(match?.[1] || 1)))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: 'mock-image2', object: 'model', owned_by: 'local-demo' }] })
  }
  if (req.method === 'POST' && (url.pathname === '/v1/images/generations' || url.pathname === '/v1/images/edits')) {
    const body = await readBody(req)
    const count = countFromBody(body.toString('utf8'))
    // Never print or persist headers/body: the demo accepts a fake Bearer key
    // only to exercise the same auth shape as a compatible provider.
    return json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: count }, () => ({ b64_json: fixture, revised_prompt: 'Local mock result' }))
    })
  }
  json(res, 404, { error: { message: 'Mock server only implements /v1/models and /v1/images/*' } })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock OpenAI-compatible Images API listening at http://127.0.0.1:${port}/v1`)
})

function close() {
  server.close(() => process.exit(0))
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
