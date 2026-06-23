/**
 * P1 follow-up — the DEFAULT run_state completion validator must recognise the
 * REAL VEA artifact shape: run_state.json with status "completed" + video_dir,
 * and a sibling delivery_report.json (the path is NOT back-filled into
 * run_state). Still-running and report-missing must NOT verify.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultVerifyRunStateTerminal } from '../main/modules/agent-control/runtime-core/run-finalizer'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ready-vea-runstate-'))
}

// Real VEA run_state shape (see scripts/run_state.py default_run_state +
// ai_analyzer.py mark_completed_state): status "completed", video_dir set, NO
// delivery_report path field; delivery_report.json sits in video_dir.
function veaRunState(dir: string, status: string): Record<string, unknown> {
  return {
    version: 'vnext', task_id: 't', child_run_id: 'c', status,
    current_stage: status === 'completed' ? 'completed' : 'score_batches',
    video_dir: dir, scores_path: join(dir, 'scene_scores.json'),
    can_finalize: status === 'completed', updated_at: '2026-06-24T00:00:00Z',
  }
}

test('real VEA completed run_state with a sibling delivery_report.json verifies', (t) => {
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runStatePath = join(dir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify(veaRunState(dir, 'completed')))
  writeFileSync(join(dir, 'delivery_report.json'), JSON.stringify({ ok: true }))
  assert.equal(defaultVerifyRunStateTerminal(runStatePath), true)
})

test('VEA run_state still running does NOT verify (even if a report file somehow exists)', (t) => {
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runStatePath = join(dir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify(veaRunState(dir, 'running')))
  writeFileSync(join(dir, 'delivery_report.json'), JSON.stringify({ ok: true }))
  assert.equal(defaultVerifyRunStateTerminal(runStatePath), false)
})

test('VEA completed run_state but MISSING delivery_report.json does NOT verify', (t) => {
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runStatePath = join(dir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify(veaRunState(dir, 'completed')))
  // no delivery_report.json written
  assert.equal(defaultVerifyRunStateTerminal(runStatePath), false)
})

test('delivery report in the run_state directory (not video_dir) is also found', (t) => {
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateDir = join(dir, 'state'); mkdirSync(stateDir)
  const runStatePath = join(stateDir, 'run_state.json')
  // run_state with no video_dir/outputDir → fall back to its own directory
  writeFileSync(runStatePath, JSON.stringify({ status: 'completed', updated_at: '2026-06-24T00:00:00Z' }))
  writeFileSync(join(stateDir, 'delivery_report.json'), JSON.stringify({ ok: true }))
  assert.equal(defaultVerifyRunStateTerminal(runStatePath), true)
})

test('missing run_state file → not verified', () => {
  assert.equal(defaultVerifyRunStateTerminal('/nonexistent/run_state.json'), false)
})
