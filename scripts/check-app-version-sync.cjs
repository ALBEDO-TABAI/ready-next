const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const packageLock = JSON.parse(read('package-lock.json'))
const errors = []

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  errors.push(`package.json version is not valid semver: ${JSON.stringify(packageJson.version)}`)
}
if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  errors.push('package-lock.json root versions must match package.json')
}

const requiredSources = [
  ['src/shared/app-version.ts', /import packageJson from '..\/..\/package\.json'/, /APP_VERSION = packageJson\.version/, /READY_VERSION_LABEL/],
  ['src/renderer/components/layout/StatusBar.tsx', /READY_VERSION_LABEL/],
  ['src/renderer/pages/Settings.tsx', /READY_VERSION_LABEL/],
  ['src/main/modules/mcp/client.ts', /APP_VERSION/],
  ['src/main/modules/agent-control/sidecar-manager.ts', /READY_APP_VERSION: app\.getVersion\(\)/],
  ['src/python/ready_sidecar/channels/wechat_openclaw_adapter.py', /READY_APP_VERSION/],
]

for (const [relativePath, ...patterns] of requiredSources) {
  const source = read(relativePath)
  for (const pattern of patterns) {
    if (!pattern.test(source)) errors.push(`${relativePath} no longer uses the shared app version contract`)
  }
}

if (errors.length > 0) {
  console.error(`[version-sync] FAILED\n${errors.map((error) => `- ${error}`).join('\n')}`)
  process.exit(1)
}

console.log(`[version-sync] OK ${packageJson.version}`)
