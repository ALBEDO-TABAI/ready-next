import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildReadyPythonCandidates,
  isSupportedReadyPythonVersion,
  parsePythonVersionText,
} from '../main/modules/skills-runtime/python-runtime-version'

test('Ready Python version gate accepts only Python 3.9 through 3.12', () => {
  for (const version of ['Python 3.9.18', 'Python 3.10.13', 'Python 3.11.8', 'Python 3.12.2']) {
    assert.equal(isSupportedReadyPythonVersion(parsePythonVersionText(version)), true, version)
  }

  for (const version of ['Python 3.8.18', 'Python 3.13.0', 'Python 3.14.0', 'Python 2.7.18', 'not python']) {
    assert.equal(isSupportedReadyPythonVersion(parsePythonVersionText(version)), false, version)
  }
})

test('Ready Python candidates prefer configured and PYTHON3 before supported minor fallbacks', () => {
  assert.deepEqual(
    buildReadyPythonCandidates('/custom/python', { PYTHON3: '/env/python3' }),
    [
      '/custom/python',
      '/env/python3',
      'python3.12',
      'python3.11',
      'python3.10',
      'python3.9',
      'python3',
      'python',
    ],
  )

  assert.deepEqual(
    buildReadyPythonCandidates('python3.12', { PYTHON3: 'python3.12' }),
    ['python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3', 'python'],
  )
})

test('skill runtime rebuild contract is pinned to stale venv state identity', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: stale venv rebuild and venvId binding live inside private runtime-manager branches
  const source = readFileSync(new URL('../main/modules/skills-runtime/runtime-manager.ts', import.meta.url), 'utf8')

  assert.match(source, /rmSync\(this\.venvRoot,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/)
  assert.match(source, /PYTHON_RUNTIME_STATE_FILENAME/)
  assert.match(source, /venvId\?: string/)
  assert.match(source, /state\.venvId\s*&&\s*state\.venvId === venvState\?\.venvId/)
})

test('agent sidecar is pinned to the shared Python version gate', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: sidecar private resolver must stay wired to the shared gate used by skill runtime
  const source = readFileSync(new URL('../main/modules/agent-control/sidecar-manager.ts', import.meta.url), 'utf8')

  assert.match(source, /buildReadyPythonCandidates/)
  assert.match(source, /isSupportedReadyPythonVersion/)
  assert.match(source, /No usable Python 3\.9-3\.12 interpreter found/)
  assert.doesNotMatch(source, /minor > 14/)
})
