import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  writeLifecycle,
} from '../main/modules/agent-control/output-dir-lifecycle'
import {
  deriveRuntimeChildRunLogPath,
} from '../main/modules/agent-control/skills/skill-child-run-log'
import {
  sweepOutputDirs,
} from '../main/modules/skills-runtime/output-dir-sweep'

async function makeRuntimeRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ready-output-sweep-'))
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function touchFile(target: string, content = 'x'): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

test('sweepOutputDirs removes expired retained outputDir and emits metric', async () => {
  const runtimeRoot = await makeRuntimeRoot()
  const outputDir = path.join(runtimeRoot, 'outputs', 'skill-a', 'run-expired')
  await touchFile(path.join(outputDir, 'artifact.txt'))
  writeLifecycle(outputDir, {
    state: 'retained',
    childRunId: 'run-expired',
    skillId: 'skill-a',
    terminalAt: '2026-04-01T00:00:00.000Z',
    terminalReason: 'completed',
    retainUntil: '2026-04-02T00:00:00.000Z',
  })
  const metrics: Array<{ metric: string; removedCount?: number }> = []

  const result = await sweepOutputDirs({
    runtimeRoot,
    now: new Date('2026-05-01T00:00:00.000Z'),
    emitMetric: (metric, payload) => metrics.push({ metric, ...payload }),
  })

  assert.equal(result.removedCount, 1)
  assert.equal(await exists(outputDir), false)
  assert.equal(metrics.some((event) => event.metric === 'output_dir_gc' && event.removedCount === 1), true)
})

test('sweepOutputDirs skips active lifecycle dirs', async () => {
  const runtimeRoot = await makeRuntimeRoot()
  const outputDir = path.join(runtimeRoot, 'outputs', 'skill-a', 'run-active')
  await touchFile(path.join(outputDir, 'artifact.txt'))
  writeLifecycle(outputDir, {
    state: 'active',
    childRunId: 'run-active',
    skillId: 'skill-a',
  })

  const result = await sweepOutputDirs({
    runtimeRoot,
    now: new Date('2026-05-01T00:00:00.000Z'),
  })

  assert.equal(result.removedCount, 0)
  assert.equal(await exists(outputDir), true)
})

test('sweepOutputDirs applies legacy grace to dirs without lifecycle', async () => {
  const runtimeRoot = await makeRuntimeRoot()
  const freshDir = path.join(runtimeRoot, 'outputs', 'skill-a', 'run-fresh')
  const oldDir = path.join(runtimeRoot, 'outputs', 'skill-a', 'run-old')
  await touchFile(path.join(freshDir, 'artifact.txt'))
  await touchFile(path.join(oldDir, 'artifact.txt'))
  const oldDate = new Date('2026-03-01T00:00:00.000Z')
  await fs.utimes(oldDir, oldDate, oldDate)

  const result = await sweepOutputDirs({
    runtimeRoot,
    now: new Date('2026-05-01T00:00:00.000Z'),
    legacyGraceDays: 30,
  })

  assert.equal(result.removedCount, 1)
  assert.equal(await exists(oldDir), false)
  assert.equal(await exists(freshDir), true)
})

test('sweepOutputDirs is idempotent', async () => {
  const runtimeRoot = await makeRuntimeRoot()
  const outputDir = path.join(runtimeRoot, 'outputs', 'skill-a', 'run-expired')
  await touchFile(path.join(outputDir, 'artifact.txt'))
  writeLifecycle(outputDir, {
    state: 'retained',
    childRunId: 'run-expired',
    skillId: 'skill-a',
    terminalAt: '2026-04-01T00:00:00.000Z',
    terminalReason: 'completed',
    retainUntil: '2026-04-02T00:00:00.000Z',
  })
  const now = new Date('2026-05-01T00:00:00.000Z')

  const first = await sweepOutputDirs({ runtimeRoot, now })
  const second = await sweepOutputDirs({ runtimeRoot, now })

  assert.equal(first.removedCount, 1)
  assert.equal(second.removedCount, 0)
})

test('outputDir sweep does not delete fresh runtime-root child-run jsonl', async () => {
  const runtimeRoot = await makeRuntimeRoot()
  const outputDir = path.join(runtimeRoot, 'outputs', 'skill-a', 'run-expired')
  await touchFile(path.join(outputDir, 'artifact.txt'))
  writeLifecycle(outputDir, {
    state: 'retained',
    childRunId: 'run-expired',
    skillId: 'skill-a',
    terminalAt: '2026-04-01T00:00:00.000Z',
    terminalReason: 'completed',
    retainUntil: '2026-04-02T00:00:00.000Z',
  })
  const logPath = deriveRuntimeChildRunLogPath(runtimeRoot, 'run-fresh-log')
  await touchFile(logPath, '{"type":"started"}\n')

  await sweepOutputDirs({
    runtimeRoot,
    now: new Date('2026-05-01T00:00:00.000Z'),
  })

  assert.equal(await exists(outputDir), false)
  assert.equal(await exists(logPath), true)
})
