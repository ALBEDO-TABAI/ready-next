'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-run-finalize-funnel.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-finalize-gate-'))
  writeFile(
    dir,
    'src/shared/run-meta-terminal-status.ts',
    `
export const RUN_META_TERMINAL_STATUSES = [
  'done',
  'error',
  'cancelled',
  'preempted',
  'interrupted',
  'checkpoint',
  'completed',
  'failed',
  'killed',
] as const
`
  )
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

const SPLIT_FINALIZER_FILES = [
  'src/main/modules/agent-control/runtime-core/run-finalizer.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-preparation.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-input-assembly.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-execution.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-closeout.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-guards.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-completion.ts'
]

function makeRealSplitFixture(t) {
  const root = makeHarnessRoot(t)
  for (const rel of SPLIT_FINALIZER_FILES) {
    writeFile(root, rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
  }
  return root
}

test('run finalize gate fails when a synthetic terminal writer is present', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(
    root,
    'src/main/modules/agent-control/runtime-core/run-finalizer.ts',
    `
export function buildTerminalProjectionPatch() {
  return { status: 'killed' }
}
`
  )
  writeFile(
    root,
    'src/main/modules/agent-control/task-projection/rogue-terminal.ts',
    `
export function rogue(runMetaRepository: any) {
  runMetaRepository.update('run-1', { status: 'done', terminalReason: 'done' })
  return {
    status: 'killed',
    interactionState: 'suspended',
    taskSummary: '已被新消息接管',
    blockedReason: '已被新消息接管',
    continuationRef: { blockerType: 'superseded' },
  }
}
`
  )

  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run_meta_terminal_update/)
  assert.match(r.stderr, /terminal_projection_patch_literal/)
})

test('run finalize gate scans terminal writers outside agent-control', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(
    root,
    'src/main/modules/agent-control/runtime-core/run-finalizer.ts',
    `export function buildTerminalProjectionPatch() { return { status: 'killed' } }`
  )
  writeFile(
    root,
    'src/main/modules/app-control/rogue.ts',
    `export function rogue(runMetaRepository: any) {
      runMetaRepository.update('run-1', { status: 'done', terminalReason: 'done' })
    }`
  )

  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run_meta_terminal_update/)
  assert.match(r.stderr, /app-control\/rogue\.ts/)
})

test('startup recovery exception does not hide another terminal writer in the same file', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(
    root,
    'src/main/modules/app-control/startup-run-reconciler.ts',
    `// run-finalizer-exempt: startup-recovery-only active-owner->interrupted
export function recover(db: any, runMetaRepository: any) {
  db.prepare(\`UPDATE run_meta
    SET status = 'interrupted', initiator = 'process_exit',
        terminal_reason = 'main_process_restarted', updated_at = ?
    WHERE status IN ('working', 'running')\`).run(Date.now())
  runMetaRepository.update('run-1', { status: 'done', terminalReason: 'done' })
}`
  )

  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run_meta_terminal_update/)
  assert.doesNotMatch(r.stderr, /run_meta_terminal_sql/)
})

test('migration 077 has one path-bound exception for repairing persisted false failures', (t) => {
  const root = makeRealSplitFixture(t)
  writeFile(
    root,
    'src/main/modules/agent-control/task-projection/direct-answer-history-migration.ts',
    `// run-finalizer-exempt: migration-077 repairs persisted legacy false failures only
export function migrate(db: any) {
  db.prepare(\`UPDATE run_meta SET status = 'done' WHERE status = 'error'\`).run()
}`
  )

  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('migration 077 exception marker cannot exempt another terminal writer', (t) => {
  const root = makeRealSplitFixture(t)
  writeFile(
    root,
    'src/main/modules/agent-control/task-projection/rogue-history-repair.ts',
    `// run-finalizer-exempt: migration-077 repairs persisted legacy false failures only
export function migrate(db: any) {
  db.prepare(\`UPDATE run_meta SET status = 'done' WHERE status = 'error'\`).run()
}`
  )

  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run_meta_terminal_sql/)
})

test('run finalize gate passes on the real codebase', () => {
  const r = runIn(REPO_ROOT)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /check-run-finalize-funnel: ok/)
})
