/**
 * Stage T (W9.1) — Worker Event Ledger shape behavior test.
 *
 * Locks three contracts:
 *   1. The new ledger fields (`event_kind`, `ts`, `terminal_reason`,
 *      `rollback_target`) round-trip through the JSONL file unchanged
 *      via `readChildRunLog`.
 *   2. `rollback_target: null` (the cancel-without-safe-step encoding)
 *      survives the round-trip — distinct from `undefined` (round 11/12).
 *   3. The reader helper `readChildRunRollbackTarget` returns the cancel
 *      `rollback_target` (string | null) and `undefined` for non-cancel
 *      runs.
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
  readChildRunRollbackTarget,
} from '../main/modules/agent-control/skill-child-run-log'
import { createSkillChildRunId } from '../main/modules/agent-control/skill-child-run-id'
import type { SkillChildRunEvent } from '../main/modules/agent-control/skill-child-run-types'

async function makeTempOutputDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ready-event-ledger-'))
}

test('appendChildRunEvent passes through ledger fields verbatim', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('skill')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const ts = Date.now()
  const startedEvent: SkillChildRunEvent = {
    type: 'started',
    at: new Date().toISOString(),
    event_kind: 'started',
    ts,
    childRunId,
    input: {},
  }
  await appendChildRunEvent({ logPath, event: startedEvent })

  const result = await readChildRunLog(logPath)
  assert.equal(result.parseErrors.length, 0)
  assert.equal(result.events.length, 1)
  const written = result.events[0]
  assert.equal(written.type, 'started')
  assert.equal(written.event_kind, 'started')
  assert.equal(written.ts, ts, 'ts preserved verbatim')
})

test('cancel close event with rollback_target round-trips through JSONL', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('vea')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const cancelClose: SkillChildRunEvent = {
    type: 'close',
    at: new Date().toISOString(),
    event_kind: 'cancelled',
    terminal_reason: 'cancelled_user',
    rollback_target: 'video_expert_pipeline',
    close: {
      childRunId,
      skillId: 'video-expert-analyzer',
      status: 'killed',
      terminalReason: 'cancelled_user',
      outputDir,
      runStatePath: path.join(outputDir, 'run_state.json'),
      sceneScoresPath: null,
      deliveryReportPath: null,
      progress: {
        stage: 'video_expert_pipeline',
        totalUnits: null,
        completedUnits: null,
        coverageRatio: null,
        fingerprint: null,
      },
      framePatch: null,
      projectionPatch: null,
      error: null,
      errorKind: 'cancelled_user',
      message: 'cancelled_user',
    },
  }
  await appendChildRunEvent({ logPath, event: cancelClose })

  const result = await readChildRunLog(logPath)
  assert.equal(result.events.length, 1)
  const w = result.events[0]
  assert.equal(w.type, 'close')
  assert.equal(w.event_kind, 'cancelled')
  assert.equal(w.terminal_reason, 'cancelled_user')
  assert.equal(w.rollback_target, 'video_expert_pipeline')

  const rollback = await readChildRunRollbackTarget(logPath)
  assert.equal(rollback, 'video_expert_pipeline')
})

test('cancel close event with rollback_target=null (no safe step) survives round-trip', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('vea')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const cancelClose: SkillChildRunEvent = {
    type: 'close',
    at: new Date().toISOString(),
    event_kind: 'cancelled',
    terminal_reason: 'cancelled_user',
    rollback_target: null,
    close: {
      childRunId,
      skillId: 'video-expert-analyzer',
      status: 'killed',
      terminalReason: 'cancelled_user',
      outputDir,
      runStatePath: path.join(outputDir, 'run_state.json'),
      sceneScoresPath: null,
      deliveryReportPath: null,
      progress: {
        stage: null,
        totalUnits: null,
        completedUnits: null,
        coverageRatio: null,
        fingerprint: null,
      },
      framePatch: null,
      projectionPatch: null,
      error: null,
      errorKind: 'cancelled_user',
      message: 'cancelled before any safe step',
    },
  }
  await appendChildRunEvent({ logPath, event: cancelClose })

  const result = await readChildRunLog(logPath)
  assert.equal(result.events.length, 1)
  const w = result.events[0]
  assert.equal(w.event_kind, 'cancelled')
  assert.equal(w.rollback_target, null, 'null preserved (round 11/12)')

  const rollback = await readChildRunRollbackTarget(logPath)
  assert.equal(rollback, null, 'reader returns null distinctly from undefined')
})

test('non-cancel close events do not surface a rollback_target', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('skill')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const completedClose: SkillChildRunEvent = {
    type: 'close',
    at: new Date().toISOString(),
    event_kind: 'completed',
    terminal_reason: 'completed',
    close: {
      childRunId,
      skillId: 'lets-go-rss',
      status: 'completed',
      terminalReason: 'completed',
      outputDir,
      runStatePath: path.join(outputDir, 'run_state.json'),
      sceneScoresPath: null,
      deliveryReportPath: null,
      progress: {
        stage: 'finalized',
        totalUnits: 1,
        completedUnits: 1,
        coverageRatio: 1,
        fingerprint: 'done',
      },
      framePatch: null,
      projectionPatch: null,
      error: null,
    },
  }
  await appendChildRunEvent({ logPath, event: completedClose })

  const rollback = await readChildRunRollbackTarget(logPath)
  assert.equal(
    rollback,
    undefined,
    'no cancel close → reader returns undefined (distinct from null)',
  )
})
