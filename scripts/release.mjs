/*
 * 本地发布流水线（无 CI —— resources/ai-models 是 gitignore 的 417MB，CI 每次重下不现实）。
 *
 *   node scripts/release.mjs            # 打包 + 生成产物 + 签名，产物落在 build/release/
 *   node scripts/release.mjs --publish  # 额外 gh release create 上传到发布仓
 *
 * 产物：
 *   - AI-Image-Workspace-<v>-arm64.dmg   全新安装（含模型）
 *   - AI-Image-Workspace-<v>-update.zip  自更新包（不含模型，~110-130MB）
 *   - latest.json                      更新元数据（含 Ed25519 签名）
 *
 * 前置：私钥已在 Keychain（security add-generic-password -s image-workspace-update-key），gh 已登录。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSign, sign as edSign } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const publish = process.argv.includes('--publish')
const APP_NAME = 'AI 图像工作台'
// 发布前替换为自己的 GitHub 发布仓（上游产物仓，非源码仓）
const RELEASE_REPO = 'YOUR_GITHUB_USERNAME/YOUR_RELEASE_REPO'

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { cwd: root, stdio: 'pipe', encoding: 'utf8', maxBuffer: 1 << 26, ...opts })
}

function fail(message) {
  console.error(`\n❌ ${message}\n`)
  process.exit(1)
}

// 1. 前置断言（仅 --publish 时要求干净工作区/无重复 tag；纯构建可随时跑做验证）
const tag = `desktop-v${version}`
if (publish) {
  const gitStatus = run('git', ['status', '--porcelain']).trim()
  if (gitStatus) fail('工作区不干净，请先提交或清理后再发布')
  const existingTags = run('git', ['tag', '--list', tag]).trim()
  if (existingTags) fail(`tag ${tag} 已存在，请先 bump package.json 版本`)
}

// 2. 干净构建
run('npm', ['ci'])
run('npm', ['run', 'build'])

// 3. 打包（afterPack 关 fuse + 删重复 dylib）
run('npx', ['electron-builder', '--mac', '--arm64', '--dir'])
const appPath = path.join(root, 'build/release/mac-arm64', `${APP_NAME}.app`)
if (!existsSync(appPath)) fail('打包产物缺失')

// 4. 打包后断言
const resources = path.join(appPath, 'Contents/Resources')
const ortBin = path.join(resources, 'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6')
for (const platform of ['linux', 'win32']) {
  if (existsSync(path.join(ortBin, platform))) fail(`残留非 darwin onnxruntime：${platform}`)
}
const dylibDir = path.join(ortBin, 'darwin/arm64')
const dylibs = existsSync(dylibDir)
  ? run('ls', [dylibDir]).split('\n').filter((n) => n.endsWith('.dylib'))
  : []
if (dylibs.length !== 1) fail(`libonnxruntime dylib 应恰好一个，实际 ${dylibs.length}`)
const v8Cache = run('find', [appPath, '-name', '.v8-cache', '-type', 'd']).trim()
if (v8Cache) fail('残留 .v8-cache（构建机污染，请确认 npm ci 干净）')
const fuses = run('npx', ['@electron/fuses', 'read', '--app', appPath])
if (!/RunAsNode is Disabled/.test(fuses)) fail('RunAsNode fuse 未关闭')

const appSizeKb = parseInt(run('du', ['-sk', appPath]).trim().split(/\s+/)[0], 10)
console.log(`  .app 体积 ${(appSizeKb / 1024).toFixed(0)} MB`)

// 5. 生成 update.zip（剥离模型）
const releaseDir = path.join(root, 'build/release')
const staging = path.join(releaseDir, 'update-staging')
rmSync(staging, { recursive: true, force: true })
run('/usr/bin/ditto', [appPath, path.join(staging, `${APP_NAME}.app`)])
rmSync(path.join(staging, `${APP_NAME}.app/Contents/Resources/ai-models`), { recursive: true, force: true })
const updateZip = path.join(releaseDir, `AI-Image-Workspace-${version}-update.zip`)
rmSync(updateZip, { force: true })
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(staging, `${APP_NAME}.app`), updateZip])
rmSync(staging, { recursive: true, force: true })

// 6. DMG（含模型，供全新安装）—— 复用已打包的 .app，不二次完整 pack
run('npx', ['electron-builder', '--mac', 'dmg', '--arm64', '--prepackaged', path.join(root, 'build/release/mac-arm64')])
const dmg = path.join(releaseDir, `AI-Image-Workspace-${version}-arm64.dmg`)
if (!existsSync(dmg)) fail('DMG 生成失败')

// 7. 签名 + latest.json
const zipBytes = readFileSync(updateZip)
const sha256 = createHash('sha256').update(zipBytes).digest('hex')
const size = statSync(updateZip).size

let privatePem
try {
  // Keychain 里存的是 base64(PEM)，解码回 PEM
  const b64 = run('security', ['find-generic-password', '-s', 'image-workspace-update-key', '-w']).trim()
  privatePem = Buffer.from(b64, 'base64').toString('utf8')
  if (!privatePem.includes('BEGIN PRIVATE KEY')) throw new Error('bad key')
} catch {
  fail('Keychain 里没有可用的 image-workspace-update-key，请先运行 npm run gen-update-key 并导入私钥')
}
const message = Buffer.from(`${version}\n${sha256}\n${size}`, 'utf8')
let signature
try {
  signature = edSign(null, message, privatePem).toString('base64')
} catch {
  // 某些 Node 版本 Ed25519 走 createSign
  const signer = createSign('sha512')
  signer.update(message)
  signer.end()
  signature = signer.sign(privatePem).toString('base64')
}

const latest = {
  version,
  notes: `AI 图像工作台 ${version}`,
  url: `https://github.com/${RELEASE_REPO}/releases/download/${tag}/AI-Image-Workspace-${version}-update.zip`,
  sha256,
  size,
  signature
}
const latestPath = path.join(releaseDir, 'latest.json')
writeFileSync(latestPath, JSON.stringify(latest, null, 2))

console.log(`\n✅ 产物就绪（build/release/）：`)
console.log(`   ${path.basename(dmg)}`)
console.log(`   ${path.basename(updateZip)}  (${(size / 1024 / 1024).toFixed(1)} MB)`)
console.log(`   latest.json`)

// 8. 发布
if (publish) {
  run('git', ['tag', tag])
  run('git', ['push', 'origin', tag])
  run('gh', ['release', 'create', tag, dmg, updateZip, latestPath, '--repo', RELEASE_REPO, '--title', `Desktop ${version}`, '--notes', latest.notes])
  console.log(`\n🚀 已发布 ${tag} 到 ${RELEASE_REPO}`)
} else {
  console.log(`\n未发布。确认无误后加 --publish 上传，或手动 gh release create。`)
}
