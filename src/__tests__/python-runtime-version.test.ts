import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildReadyPythonRuntimeNotFoundMessage,
  buildReadyPythonCandidates,
  isSupportedReadyPythonSslVersion,
  isSupportedReadyPythonVersion,
  parseOpenSslVersionText,
  parsePythonVersionText,
} from '../main/modules/skills-runtime/python-runtime-version'

test('parsePythonVersionText reads stdout or stderr style Python versions', () => {
  assert.deepEqual(parsePythonVersionText('Python 3.11.14'), { major: 3, minor: 11, patch: 14 })
  assert.deepEqual(parsePythonVersionText('warning\nPython 3.12'), { major: 3, minor: 12, patch: undefined })
  assert.equal(parsePythonVersionText('not python'), null)
})

test('Ready Python runtime accepts 3.9-3.12 and rejects newer interpreters', () => {
  assert.equal(isSupportedReadyPythonVersion({ major: 3, minor: 11 }), true)
  assert.equal(isSupportedReadyPythonVersion({ major: 3, minor: 12 }), true)
  assert.equal(isSupportedReadyPythonVersion({ major: 3, minor: 13 }), false)
  assert.equal(isSupportedReadyPythonVersion({ major: 3, minor: 14 }), false)
})

test('Ready Python runtime requires OpenSSL 1.1.1+ for network skills', () => {
  assert.deepEqual(parseOpenSslVersionText('OpenSSL 3.5.6 7 Apr 2026'), { major: 3, minor: 5, patch: 6 })
  assert.equal(isSupportedReadyPythonSslVersion('OpenSSL 1.1.1w 11 Sep 2023'), true)
  assert.equal(isSupportedReadyPythonSslVersion('OpenSSL 3.5.6 7 Apr 2026'), true)
  assert.equal(isSupportedReadyPythonSslVersion('OpenSSL 1.1.0'), false)
  assert.equal(isSupportedReadyPythonSslVersion('LibreSSL 2.8.3'), false)
  assert.equal(isSupportedReadyPythonSslVersion(''), false)
})

test('Ready Python runtime explains SSL-only rejection clearly', () => {
  assert.match(
    buildReadyPythonRuntimeNotFoundMessage({ sawSslIncompatibleCandidate: true }),
    /Python 3\.9-3\.12 with OpenSSL 1\.1\.1\+ support/,
  )
})

test('Ready Python candidates try configured/env first, then versioned stable interpreters before generic python3', () => {
  const candidates = buildReadyPythonCandidates('/custom/python', { PYTHON3: '/env/python3' })

  assert.deepEqual(candidates.slice(0, 6), [
    '/custom/python',
    '/env/python3',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3.9',
  ])
  assert.ok(candidates.indexOf('python3.11') < candidates.indexOf('python3'))
})
