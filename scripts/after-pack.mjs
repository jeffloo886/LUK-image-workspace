/*
 * electron-builder afterPack 钩子。
 *
 * 只做两件靠 files 负向 glob 做不到的事：
 *   1. 关掉三个默认开启的安全 fuse
 *   2. 删掉 onnxruntime 那份没人引用的重复 dylib
 *
 * 其余瘦身一律走 package.json 的 build.files，那些在 asar 打包前生效，
 * 不会破坏 asarUnpack 对原生模块的解析。
 */
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'
import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/* 两份 dylib 内容完全相同，但 onnxruntime_binding.node 只通过
 * @rpath/libonnxruntime.1.dylib 引用其中一份，另一份是纯粹的死重量（38.8MB）。
 * 删之前校验 sha256 一致，避免 onnxruntime 某次升级后它们不再等价。 */
const DEAD_DYLIB = 'libonnxruntime.1.27.0.dylib'
const LIVE_DYLIB = 'libonnxruntime.1.dylib'

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function dropDuplicateOnnxDylib(resourcesPath) {
  const dir = path.join(
    resourcesPath,
    'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64'
  )
  const dead = path.join(dir, DEAD_DYLIB)
  const live = path.join(dir, LIVE_DYLIB)

  const deadStat = await stat(dead).catch(() => null)
  if (!deadStat) return 0
  const liveStat = await stat(live).catch(() => null)
  if (!liveStat) {
    throw new Error(`${LIVE_DYLIB} 不存在，拒绝删除 ${DEAD_DYLIB} —— onnxruntime 的布局可能变了`)
  }
  if ((await sha256(dead)) !== (await sha256(live))) {
    throw new Error(`${DEAD_DYLIB} 与 ${LIVE_DYLIB} 内容已不一致，不能再当作重复文件删除`)
  }

  await rm(dead)
  return deadStat.size
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  const resourcesPath = path.join(appPath, 'Contents/Resources')

  const freed = await dropDuplicateOnnxDylib(resourcesPath)
  if (freed) {
    console.log(`  • 删除重复 dylib，省 ${(freed / 1024 / 1024).toFixed(1)} MB`)
  }

  /* 这三个 fuse 默认开启，会让 App 变成一个通用 Node 解释器
   * （ELECTRON_RUN_AS_NODE=1），是上线前必须关掉的本地提权/持久化面。
   * 不要顺手打开 EnableEmbeddedAsarIntegrityValidation —— 自建更新器
   * 走的是整包替换，开了要重新设计替换流程。 */
  await flipFuses(path.join(appPath, 'Contents/MacOS', context.packager.appInfo.productFilename), {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false
  })
  console.log('  • 已关闭 RunAsNode / NodeOptions / NodeCliInspect')
}
