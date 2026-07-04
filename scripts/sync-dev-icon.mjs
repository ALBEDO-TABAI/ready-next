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

// 盖章改写 bundle 内容会破坏代码签名封印。封印破损是独立隐患（Gatekeeper
// 重新评估时可能拒载），但注意：它不是 2026-07-04 dev 闪退的根因——那次是
// tab-lifecycle 的空白 primer 双导航把偶发 renderer 沙箱初始化失败升级成
// Chromium 早期 RFH 交换路径的主进程 CHECK 崩溃（重签后的 Electron 跑最小
// app 全绿即可证明二进制无辜）。盖章后自检签名，破损即 ad-hoc 重签自愈；
// 封印完好（重复盖同样内容）则零开销。
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
