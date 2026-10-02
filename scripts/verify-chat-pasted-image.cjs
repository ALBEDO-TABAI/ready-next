const { spawnSync } = require('node:child_process')
const path = require('node:path')

if (process.versions.electron && process.type === 'browser') {
  require('tsx/cjs')
  require('../src/__tests__/chat-pasted-image.e2e.ts')
} else {
  const result = spawnSync(require('electron'), [__filename], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
