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
