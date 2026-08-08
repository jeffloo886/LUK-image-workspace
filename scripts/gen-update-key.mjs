/*
 * 生成更新签名用的 Ed25519 密钥对。
 *
 *   node scripts/gen-update-key.mjs
 *
 * 输出：
 *   - 公钥 PEM → 打印到终端，粘进 src/main/updater/keys.ts 的 UPDATE_PUBLIC_KEY_PEM
 *   - 私钥 → base64 单行写到 ./update-private-key.b64（已 gitignore；导入 Keychain 后删除）
 *
 * 私钥存 base64 而非裸 PEM：PEM 带换行，security -w 会把它 hex 编码返回，读取端难处理；
 * base64 是单行干净字符串，security 原样存取。release.mjs 读取后 base64 解码回 PEM。
 *
 * 导入 Keychain：
 *   security add-generic-password -a "$USER" -s image-workspace-update-key -w "$(cat update-private-key.b64)"
 * 导入后删除明文并离线备份——私钥丢了就再也无法给已装用户推更新。
 */
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')

const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const privateB64 = Buffer.from(privatePem, 'utf8').toString('base64')

writeFileSync('update-private-key.b64', privateB64, { mode: 0o600 })

console.log('\n=== 公钥（粘进 src/main/updater/keys.ts）===\n')
console.log(publicPem)
console.log('=== 私钥（base64）已写入 ./update-private-key.b64（勿提交，导入后删除）===\n')
console.log('导入 Keychain：')
console.log('  security add-generic-password -a "$USER" -s image-workspace-update-key -w "$(cat update-private-key.b64)"')
console.log('  rm update-private-key.b64   # 导入后删除，并离线备份\n')
