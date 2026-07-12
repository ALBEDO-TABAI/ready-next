const { spawnSync } = require('node:child_process')
const path = require('node:path')

const electron = require('electron')
const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
const tests = [
  'src/__tests__/file-activity-repository.test.ts',
  'src/__tests__/file-reading-session-repository.test.ts',
  'src/__tests__/file-emergence-native-integration.test.ts',
  'src/__tests__/file-project-identity-repository.test.ts',
  'src/__tests__/file-attention-repository.test.ts',
  'src/__tests__/file-emergence-feedback-repository.test.ts',
  'src/__tests__/tag-forge-repository.test.ts',
]

const result = spawnSync(electron, [tsxCli, '--test', '--test-concurrency=1', ...tests], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
