const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const candidates = [
  process.env.READY_REMOTE_TEST_PYTHON,
  // Never the daily Ready app folder: Ready Next development stays out of ~/Library/Application Support/Ready (C15).
  join(process.cwd(), 'build/release-skill-runtime/python/bin/python3'),
  'python3.12', 'python3.11', 'python3',
].filter(Boolean)
const python = candidates.find(candidate => spawnSync(candidate,
  ['-c', 'import lark_oapi, requests, websockets, fastapi'], { stdio: 'ignore' }).status === 0)
if (!python) {
  console.error('Remote IM tests require Python with src/python/ready_sidecar/requirements.txt installed. Set READY_REMOTE_TEST_PYTHON to that interpreter.')
  process.exit(1)
}
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'src/python/tests', '-p', 'test_*.py'], {
  stdio: 'inherit', env: { ...process.env, PYTHONPATH: join(process.cwd(), 'src/python') },
})
process.exit(result.status ?? 1)
