import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

if (process.platform !== 'darwin') {
  process.exit(0)
}

const sourceIcon = join(root, 'build', 'icon.icns')
const targetIcon = resolve(root, 'node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns')
const targetPlist = resolve(root, 'node_modules/electron/dist/Electron.app/Contents/Info.plist')

if (!existsSync(sourceIcon) || !existsSync(targetIcon)) {
  process.exit(0)
}

copyFileSync(sourceIcon, targetIcon)

if (existsSync(targetPlist)) {
  const bundleValues = {
    CFBundleDisplayName: 'Ready',
    CFBundleName: 'Ready',
    CFBundleIdentifier: 'com.ready.app.dev',
  }

  for (const [key, value] of Object.entries(bundleValues)) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, targetPlist])
  }
}

// 2026-07-04 真机启动崩溃根因：盖章改写 bundle 内容会破坏代码签名封印，
// macOS 一旦重新校验（签名缓存失效/安全数据更新）就拒绝渲染进程沙箱
// 初始化——三个 Renderer helper 启动即 abort("Failed to initialize
// sandbox")、主进程随之 SIGTRAP，表现为"dev 一打开就闪退"。盖章后自检
// 签名，破损即 ad-hoc 重签自愈；封印完好（重复盖同样内容）则零开销。
const appBundle = resolve(root, 'node_modules/electron/dist/Electron.app')
try {
  execFileSync('/usr/bin/codesign', ['-v', appBundle], { stdio: 'ignore' })
} catch {
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'ignore' })
    console.log('[sync-dev-icon] Electron.app signature was broken by branding; re-signed ad-hoc.')
  } catch (error) {
    console.warn('[sync-dev-icon] ad-hoc re-sign failed; dev may crash at renderer sandbox init:', String(error))
  }
}
