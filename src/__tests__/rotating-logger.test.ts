import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createRotatingLogger,
  flushBufferedRotatingLoggers,
} from '../main/utils/rotating-logger'
import { PROCESS_METRICS } from '../main/utils/process-metrics'

function withTempDir(run: (root: string) => void | Promise<void>): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'ready-rotating-logger-'))
  const result = run(root)
  if (result && typeof (result as Promise<void>).then === 'function') {
    return (result as Promise<void>).finally(() => {
      rmSync(root, { recursive: true, force: true })
    })
  }
  rmSync(root, { recursive: true, force: true })
}

test('appends to fresh file when size below threshold', () => withTempDir((root) => {
  const logger = createRotatingLogger('ready-test.log', {
    maxBytes: 100,
    maxFiles: 5,
    resolvePath: (name) => join(root, name),
  })

  logger.append('hello\n')

  assert.equal(readFileSync(join(root, 'ready-test.log'), 'utf8'), 'hello\n')
  assert.equal(existsSync(join(root, 'ready-test.log.1')), false)
}))

test('rotates when current file would exceed threshold', () => withTempDir((root) => {
  const logger = createRotatingLogger('ready-test.log', {
    maxBytes: 10,
    maxFiles: 5,
    resolvePath: (name) => join(root, name),
  })

  logger.append('123456789\n')
  logger.append('next\n')

  assert.equal(readFileSync(join(root, 'ready-test.log.1'), 'utf8'), '123456789\n')
  assert.equal(readFileSync(join(root, 'ready-test.log'), 'utf8'), 'next\n')
}))

test('keeps at most the configured number of historical files', () => withTempDir((root) => {
  const logger = createRotatingLogger('ready-test.log', {
    maxBytes: 4,
    maxFiles: 2,
    resolvePath: (name) => join(root, name),
  })

  logger.append('aa\n')
  logger.append('bb\n')
  logger.append('cc\n')
  logger.append('dd\n')

  assert.equal(readFileSync(join(root, 'ready-test.log'), 'utf8'), 'dd\n')
  assert.equal(readFileSync(join(root, 'ready-test.log.1'), 'utf8'), 'cc\n')
  assert.equal(readFileSync(join(root, 'ready-test.log.2'), 'utf8'), 'bb\n')
  assert.equal(existsSync(join(root, 'ready-test.log.3')), false)
}))

test('handles rotation failure without breaking append', () => withTempDir((root) => {
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const logger = createRotatingLogger('ready-test.log', {
    maxBytes: 4,
    maxFiles: 1,
    resolvePath: (name) => join(root, name),
    emitMetric: (name, payload) => metrics.push({ name, payload }),
  })
  logger.append('aa\n')
  mkdirSync(join(root, 'ready-test.log.1'))

  logger.append('bb\n')

  assert.equal(readFileSync(join(root, 'ready-test.log'), 'utf8'), 'aa\nbb\n')
  assert.equal(metrics[0]?.name, PROCESS_METRICS.logRotationFailed)
}))

test('rotation is idempotent across logger restarts', () => withTempDir((root) => {
  createRotatingLogger('ready-test.log', {
    maxBytes: 4,
    maxFiles: 2,
    resolvePath: (name) => join(root, name),
  }).append('aa\n')

  const restarted = createRotatingLogger('ready-test.log', {
    maxBytes: 4,
    maxFiles: 2,
    resolvePath: (name) => join(root, name),
  })
  restarted.append('bb\n')

  assert.equal(readFileSync(join(root, 'ready-test.log'), 'utf8'), 'bb\n')
  assert.equal(readFileSync(join(root, 'ready-test.log.1'), 'utf8'), 'aa\n')
}))

test('handles both sync and async writers through the same rotation path', async () => withTempDir(async (root) => {
  const logger = createRotatingLogger('ready-browser.log', {
    maxBytes: 10,
    maxFiles: 5,
    resolvePath: (name) => join(root, name),
  })

  logger.append('sync-line\n')
  await logger.appendAsync('async-line\n')

  assert.equal(readFileSync(join(root, 'ready-browser.log.1'), 'utf8'), 'sync-line\n')
  assert.equal(readFileSync(join(root, 'ready-browser.log'), 'utf8'), 'async-line\n')
}))

test('buffered mode coalesces 1000 log lines until one explicit flush', () => withTempDir((root) => {
  const path = join(root, 'ready-tools.log')
  const logger = createRotatingLogger('ready-tools.log', {
    buffered: true,
    flushBytes: 1024 * 1024,
    flushIntervalMs: 60_000,
    resolvePath: () => path,
  })

  for (let index = 0; index < 1_000; index += 1) logger.append(`line-${index}\n`)
  assert.equal(existsSync(path), false)

  logger.flush()
  const output = readFileSync(path, 'utf8')
  assert.equal(output.match(/line-/g)?.length, 1_000)
}))

test('all buffered logger instances for one path share the exit flush sink', () => withTempDir((root) => {
  const path = join(root, 'ready-directchat.log')
  const options = {
    buffered: true,
    flushBytes: 1024 * 1024,
    flushIntervalMs: 60_000,
    resolvePath: () => path,
  }
  const first = createRotatingLogger('ready-directchat.log', options)
  const second = createRotatingLogger('ready-directchat.log', options)

  first.append('first\n')
  second.append('second\n')
  flushBufferedRotatingLoggers()

  assert.equal(readFileSync(path, 'utf8'), 'first\nsecond\n')
}))
