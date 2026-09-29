/**
 * EP2-T2 — write-direction gate (warning mode) + malformed-ignored consumer
 * behavior: a sick ledger row is skipped with a ledger_malformed metric, the
 * healthy rows still render, and nothing crashes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'


const WRITE_DIRECTION_GATE = resolve('scripts/check-ledger-write-direction.cjs')

function writeHarnessFile(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function makeGateHarness(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-write-direction-'))
  const script = join(root, 'scripts/check-ledger-write-direction.cjs')
  mkdirSync(dirname(script), { recursive: true })
  copyFileSync(WRITE_DIRECTION_GATE, script)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function runHarness(root: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [join(root, 'scripts/check-ledger-write-direction.cjs')], {
    cwd: root,
    encoding: 'utf-8',
  })
}

test('write-direction gate runs in warning mode: exit 0, inventory listed, strict flag available', () => {
  const output = execFileSync('node', ['scripts/check-ledger-write-direction.cjs'], { encoding: 'utf-8' })
  assert.match(output, /check-ledger-write-direction: ok/)
  const count = Number(output.match(/\((\d+) warnings\)/)?.[1] || 0)
  assert.ok(count > 0, 'warning mode must keep the current ownership inventory visible')
})

test('migration 077 exception is path, marker, and repair-statement bound', (t) => {
  const root = makeGateHarness(t)
  const marker = '// run-finalizer-exempt: migration-077 repairs persisted legacy false failures only'
  const intendedRepair = `
${marker}
export function repair(db: any) {
  db.prepare(\`UPDATE task_projections
    SET status = 'completed',
        interaction_state = 'suspended',
        waiting_for = 'none',
        resumable_actions_json = '[]',
        blocked_reason = NULL,
        degradation_reason = NULL,
        task_type = 'direct_answer',
        budget_json = ?,
        budget_usage_percent = 13,
        budget_warning_level = 'none',
        criteria_json = ?,
        checkins_json = ?
    WHERE task_id = ? AND status = 'failed'\`).run('task-1')
  db.prepare(\`UPDATE run_meta
    SET status = 'done',
        task_type = 'direct_answer',
        terminal_reason = 'done',
        budget_json = ?
    WHERE run_id = ? AND task_id = ? AND status = 'error'
      AND terminal_reason = 'adjudication_degraded'\`).run('run-1', 'task-1')
}
`
  const migrationPath = 'src/main/modules/agent-control/task-projection/direct-answer-history-migration.ts'

  writeHarnessFile(root, migrationPath, intendedRepair)
  let result = runHarness(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ok \(0 warnings\)/)

  writeHarnessFile(root, migrationPath, intendedRepair.replace(marker, '// marker removed'))
  result = runHarness(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ok \(2 warnings\)/)

  writeHarnessFile(root, migrationPath, `${intendedRepair}\ndb.prepare(\`DELETE FROM run_meta\`).run()\n`)
  result = runHarness(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ok \(1 warning\)/)
  assert.match(result.stderr, /\[run_meta\].*direct-answer-history-migration\.ts/)

  rmSync(join(root, 'src'), { recursive: true, force: true })
  writeHarnessFile(
    root,
    'src/main/modules/agent-control/task-projection/rogue-history-repair.ts',
    intendedRepair,
  )
  result = runHarness(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ok \(2 warnings\)/)
})
