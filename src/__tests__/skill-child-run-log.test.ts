/**
 * Phase 1 — Skill Child Run JSONL log acceptance tests.
 *
 * Locks the append/read contract from source plan §5.3:
 *   - one event per line, compact JSON, terminated by '\n'
 *   - reader returns valid events even when one line is corrupt
 *   - missing log file is empty, never an exception
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  appendChildRunEvent,
  deriveChildRunLogPath,
  readChildRunLog,
} from '../main/modules/agent-control/skill-child-run-log'
import {
  createSkillChildRunId,
} from '../main/modules/agent-control/skill-child-run-id'
import type { SkillChildRunEvent } from '../main/modules/agent-control/skill-child-run-types'

async function makeTempOutputDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ready-child-run-log-'))
}

test('deriveChildRunLogPath returns <outputDir>/.ready/child-runs/<id>.jsonl', () => {
  const id = createSkillChildRunId('vea')
  const got = deriveChildRunLogPath('/tmp/abc', id)
  assert.equal(got, path.join('/tmp/abc', '.ready', 'child-runs', `${id}.jsonl`))
})

test('appendChildRunEvent + readChildRunLog round-trip preserves order', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('vea')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const startedAt = new Date('2026-04-30T01:00:00.000Z').toISOString()
  const actionAt = new Date('2026-04-30T01:00:01.000Z').toISOString()
  const closeAt = new Date('2026-04-30T01:00:02.000Z').toISOString()

  const startedEvent: SkillChildRunEvent = {
    type: 'started',
    at: startedAt,
    childRunId,
    input: { url: 'https://example.com/v.mp4' },
  }
  const actionEvent: SkillChildRunEvent = {
    type: 'action_started',
    at: actionAt,
    action: 'video_expert_pipeline',
    input: { url: 'https://example.com/v.mp4' },
  }
  const closeEvent: SkillChildRunEvent = {
    type: 'close',
    at: closeAt,
    close: {
      childRunId,
      skillId: 'video-expert-analyzer',
      status: 'completed',
      terminalReason: 'completed',
      outputDir,
      runStatePath: path.join(outputDir, 'run_state.json'),
      sceneScoresPath: null,
      deliveryReportPath: null,
      progress: {
        stage: 'finalized',
        totalUnits: 97,
        completedUnits: 97,
        coverageRatio: 1,
        fingerprint: 'finalized:97/97',
      },
      framePatch: null,
      projectionPatch: null,
      error: null,
    },
  }

  await appendChildRunEvent({ logPath, event: startedEvent })
  await appendChildRunEvent({ logPath, event: actionEvent })
  await appendChildRunEvent({ logPath, event: closeEvent })

  const result = await readChildRunLog(logPath)
  assert.equal(result.parseErrors.length, 0, 'no parse errors expected')
  assert.equal(result.events.length, 3)
  assert.deepEqual(result.events[0], startedEvent)
  assert.deepEqual(result.events[1], actionEvent)
  assert.deepEqual(result.events[2], closeEvent)
})

test('readChildRunLog tolerates a corrupt line and reports it without throwing', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('vea')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const validA: SkillChildRunEvent = {
    type: 'started',
    at: '2026-04-30T01:00:00.000Z',
    childRunId,
    input: {},
  }
  const validB: SkillChildRunEvent = {
    type: 'action_started',
    at: '2026-04-30T01:00:02.000Z',
    action: 'video_expert_ai_analyze',
    input: { sceneScoresPath: '/tmp/scenes.json' },
  }

  await appendChildRunEvent({ logPath, event: validA })
  // Corrupt line manually (not valid JSON).
  await fs.appendFile(logPath, 'this-is-not-json\n', { encoding: 'utf8' })
  await appendChildRunEvent({ logPath, event: validB })

  const result = await readChildRunLog(logPath)
  assert.equal(result.events.length, 2, 'two valid events expected')
  assert.deepEqual(result.events[0], validA)
  assert.deepEqual(result.events[1], validB)
  assert.equal(result.parseErrors.length, 1, 'one parse error expected')
  assert.equal(result.parseErrors[0].line, 2, 'corrupt line should be line 2')
  assert.equal(result.parseErrors[0].raw, 'this-is-not-json')
})

test('readChildRunLog returns empty result for a missing log file (no throw)', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('vea')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)
  // Intentionally do NOT create the file.
  const result = await readChildRunLog(logPath)
  assert.deepEqual(result, { events: [], parseErrors: [] })
})

test('appendChildRunEvent creates the .ready/child-runs/ parent directory', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('skill')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)
  // Parent directory does not exist yet.
  await assert.rejects(fs.access(path.dirname(logPath)))

  await appendChildRunEvent({
    logPath,
    event: {
      type: 'started',
      at: '2026-04-30T01:00:00.000Z',
      childRunId,
      input: {},
    },
  })

  // After append, parent dir must exist.
  await fs.access(path.dirname(logPath))
})
