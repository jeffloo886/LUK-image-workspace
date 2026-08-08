/*
 * 更新包的信任锚点：离线 Ed25519 公钥（SPKI / PEM）。
 *
 * 没有 Apple Developer ID 就没有 OS 级签名校验，这把公钥是唯一的自建锚点：
 * 发布时用配对的私钥（存在维护者 Keychain，绝不进仓库/CI）对
 *   `${version}\n${sha256}\n${size}`
 * 签名，更新器替换前用这把公钥验签。
 *
 * ⚠️ 下面是占位公钥。正式发布前必须替换为 scripts/gen-update-key.mjs 生成的真实公钥，
 * 且对应私钥要导入 Keychain（security add-generic-password -s image-workspace-update-key）。
 * 公钥换了、旧私钥丢了，等于所有已装用户再也收不到更新——务必备份私钥。
 */
export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
PLACEHOLDER_REPLACE_WITH_GENERATED_ED25519_PUBLIC_KEY
-----END PUBLIC KEY-----`

// 未替换占位公钥时，自动检查一律跳过（避免用占位公钥误判「无更新」或误装）。
export const UPDATE_KEY_IS_PLACEHOLDER = UPDATE_PUBLIC_KEY_PEM.includes('PLACEHOLDER')

// 更新元数据地址：走 releases/latest/download 的 CDN 直链，免鉴权免限流。
// 发布前替换为自己的 GitHub 发布仓。
export const UPDATE_MANIFEST_URL =
  'https://github.com/YOUR_GITHUB_USERNAME/YOUR_RELEASE_REPO/releases/latest/download/latest.json'
export const UPDATE_RELEASES_PAGE = 'https://github.com/YOUR_GITHUB_USERNAME/YOUR_RELEASE_REPO/releases/latest'

// 更新包内必须匹配的 bundle id，防止装错东西
export const EXPECTED_BUNDLE_ID = 'com.luk.image-workspace'
