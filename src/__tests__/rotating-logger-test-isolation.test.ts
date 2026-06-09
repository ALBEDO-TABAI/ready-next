import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import { createRotatingLogger } from '../main/utils/rotating-logger'

type EnvSnapshot = Partial<Record<'READY_TEST_LOG_ISOLATION' | 'NODE_ENV' | 'VITEST' | 'NODE_TEST_CONTEXT' | 'TMPDIR' | 'TMP' | 'TEMP', string>>

function withIsolatedTmpdir(
  testEnv: Partial<Record<'READY_TEST_LOG_ISOLATION' | 'NODE_ENV' | 'VITEST' | 'NODE_TEST_CONTEXT', string | undefined>>,
  run: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'ready-log-isolation-'))
  const snapshot = captureEnv()
  try {
    for (const [key, value] of Object.entries(testEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    process.env.TMPDIR = root
    process.env.TMP = root
    process.env.TEMP = root
    run(root)
  } finally {
    restoreEnv(snapshot)
    rmSync(root, { recursive: true, force: true })
  }
}

test('default logger writes test logs under ready-test-logs without touching production log names', () => {
  withIsolatedTmpdir({ READY_TEST_LOG_ISOLATION: '1' }, (root) => {
    const productionLogPath = join(root, 'ready-tools.log')
    writeFileSync(productionLogPath, 'existing\n')
    const beforeBytes = statSync(productionLogPath).size

    const logger = createRotatingLogger('ready-tools.log', { emitMetric: null })
    logger.append('isolated\n')

    const isolatedLogPath = join(root, 'ready-test-logs', 'ready-tools.log')
    assert.equal(logger.path, isolatedLogPath)
    assert.equal(readFileSync(isolatedLogPath, 'utf8'), 'isolated\n')
    assert.equal(statSync(productionLogPath).size, beforeBytes)
    assert.equal(logger.path.startsWith(`${join(root, 'ready-test-logs')}${sep}`), true)
  })
})

test('node test runner context isolates default logger paths for npm test', () => {
  withIsolatedTmpdir({
    READY_TEST_LOG_ISOLATION: undefined,
    NODE_ENV: undefined,
    VITEST: undefined,
    NODE_TEST_CONTEXT: 'child-v8',
  }, (root) => {
    const productionLogPath = join(root, 'ready-agent-sdk.log')
    writeFileSync(productionLogPath, 'existing\n')
    const beforeBytes = statSync(productionLogPath).size

    const logger = createRotatingLogger('ready-agent-sdk.log', { emitMetric: null })
    logger.append('isolated\n')

    assert.equal(logger.path, join(root, 'ready-test-logs', 'ready-agent-sdk.log'))
    assert.equal(statSync(productionLogPath).size, beforeBytes)
  })
})

test('rotation failure metrics also stay under ready-test-logs in tests', () => {
  withIsolatedTmpdir({ READY_TEST_LOG_ISOLATION: '1' }, (root) => {
    const productionMetricPath = join(root, 'ready-agent-metrics.log')
    writeFileSync(productionMetricPath, 'existing\n')
    const beforeBytes = statSync(productionMetricPath).size

    const logger = createRotatingLogger('ready-browser.log', {
      maxBytes: 4,
      maxFiles: 1,
    })
    logger.append('aa\n')
    mkdirSync(`${logger.path}.1`)
    logger.append('bb\n')

    const isolatedMetricPath = join(root, 'ready-test-logs', 'ready-agent-metrics.log')
    assert.equal(existsSync(isolatedMetricPath), true)
    assert.match(readFileSync(isolatedMetricPath, 'utf8'), /log_rotation_failed/)
    assert.equal(statSync(productionMetricPath).size, beforeBytes)
  })
})

function captureEnv(): EnvSnapshot {
  return {
    READY_TEST_LOG_ISOLATION: process.env.READY_TEST_LOG_ISOLATION,
    NODE_ENV: process.env.NODE_ENV,
    VITEST: process.env.VITEST,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  }
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}
