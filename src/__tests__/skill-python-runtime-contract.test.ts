import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('skill runtime rejects unsupported Python versions and binds install state to the venv id', () => {
  const source = readFileSync(new URL('../main/modules/skills-runtime/runtime-manager.ts', import.meta.url), 'utf8')

  assert.match(source, /isSupportedReadyPythonVersion\(version\)/)
  assert.match(source, /rmSync\(this\.venvRoot,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/)
  assert.match(source, /PYTHON_RUNTIME_STATE_FILENAME/)
  assert.match(source, /venvId\?: string/)
  assert.match(source, /state\.venvId\s*&&\s*state\.venvId === venvState\?\.venvId/)
})

test('agent sidecar uses the same Python version gate as skill runtime', () => {
  const source = readFileSync(new URL('../main/modules/agent-control/sidecar-manager.ts', import.meta.url), 'utf8')

  assert.match(source, /buildReadyPythonCandidates/)
  assert.match(source, /isSupportedReadyPythonVersion/)
  assert.match(source, /No usable Python 3\.9-3\.12 interpreter found/)
  assert.doesNotMatch(source, /minor > 14/)
})
