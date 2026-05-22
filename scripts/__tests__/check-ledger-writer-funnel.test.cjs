'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-ledger-writer-funnel.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const VALID_REPO_BODY = `
export class SkillTaskRunRepository {
  private updateRowInternal(id: string, patch: any, opts: any) {
    const setClause = 'foo = ?'
    db.prepare(\`UPDATE skill_task_runs SET \${setClause} WHERE id = ?\`).run('x', id)
  }
  updateRowSync(id: string, patch: any) {
    this.updateRowInternal(id, patch, { allowStatus: true })
  }
}
`

function writeRepo(rootDir, body) {
  const p = path.join(rootDir, 'src/main/modules/repositories/skill-task-run-repository.ts')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

test('L1 gate passes when repo has sanctioned SQL and updateRowInternal', (t) => {
  const root = makeHarnessRoot(t)
  writeRepo(root, VALID_REPO_BODY)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L1 gate fails when a non-repo file contains UPDATE skill_task_runs SQL', (t) => {
  const root = makeHarnessRoot(t)
  writeRepo(root, VALID_REPO_BODY)
  const offender = path.join(root, 'src/main/modules/agent-control/some-rogue.ts')
  fs.mkdirSync(path.dirname(offender), { recursive: true })
  fs.writeFileSync(offender, `
export function rogue(db: any) {
  db.prepare('UPDATE skill_task_runs SET status = ? WHERE id = ?').run('done', '123')
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /illegal_update_sql/)
})

test('L1 gate fails when non-tracker, non-repo file calls updateRowSync', (t) => {
  const root = makeHarnessRoot(t)
  writeRepo(root, VALID_REPO_BODY)
  const offender = path.join(root, 'src/main/modules/agent-control/another-rogue.ts')
  fs.mkdirSync(path.dirname(offender), { recursive: true })
  fs.writeFileSync(offender, `
export function bad(repo: any) {
  repo.updateRowSync('id', { status: 'done' })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /illegal_updaterowsync_caller/)
})

test('L1 gate allows tracker file to call updateRowSync', (t) => {
  const root = makeHarnessRoot(t)
  writeRepo(root, VALID_REPO_BODY)
  const tracker = path.join(root, 'src/main/modules/agent-control/skills/skill-task-tracker.ts')
  fs.mkdirSync(path.dirname(tracker), { recursive: true })
  fs.writeFileSync(tracker, `
export function ok(repo: any) {
  repo.updateRowSync('id', { status: 'running' })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L1 gate fails when repo lacks the sanctioned SQL', (t) => {
  const root = makeHarnessRoot(t)
  writeRepo(root, `
export class SkillTaskRunRepository {
  private updateRowInternal(id: string, patch: any, opts: any) {}
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /sanctioned_sql_missing/)
})

test('L1 gate fails when repo lacks private updateRowInternal', (t) => {
  const root = makeHarnessRoot(t)
  writeRepo(root, `
export class SkillTaskRunRepository {
  update(id: string, patch: any) {
    const setClause = 'foo = ?'
    db.prepare(\`UPDATE skill_task_runs SET \${setClause} WHERE id = ?\`).run('x', id)
  }
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /private_writer_missing/)
})
