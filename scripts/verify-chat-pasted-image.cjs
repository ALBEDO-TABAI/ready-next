const { spawnSync } = require('node:child_process')
const path = require('node:path')

// The test needs Electron's main process (app + nativeImage), so it cannot run under the node test runner. The test
// file is passed explicitly so the package script names what it runs.
const testFile = process.argv.slice(2).find((arg) => arg.endsWith('.e2e.ts'))
if (!testFile) throw new Error('usage: node scripts/verify-chat-pasted-image.cjs src/__tests__/chat-pasted-image.e2e.ts')

if (process.versions.electron && process.type === 'browser') {
  require('tsx/cjs')
  require(path.resolve(__dirname, '..', testFile))
} else {
  const result = spawnSync(require('electron'), [__filename, testFile], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
