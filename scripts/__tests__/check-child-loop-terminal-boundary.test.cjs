'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  checkChildLoopTerminalBoundary,
} = require('../check-child-loop-terminal-boundary.cjs')

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-child-loop-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function validRunner(extra = '') {
  return `
class SkillChildRunner {
  private publishScopeRunClose(
    active: ActiveRun,
    close: SkillChildCloseEvent,
    args: { state: string; message: string },
  ): void {
    const publishClose = () => {
      const snapshot = buildChildTaskProjectionRecord({ active, close, args })
      publish({
        type: 'finished',
        taskId: snapshot.taskId,
      })
    }
    publishClose()
  }

  private upsertChildTaskProjection(args: { active: ActiveRun }): void {
    const apply = () => {
      const next = buildChildTaskProjectionRecord(args)
      store.update(taskId, next)
      store.create(next)
    }
    apply()
  }

  private publishInactiveChildRunClose(args: { close: SkillChildCloseEvent }): void {
    const publish = () => {
      const next = buildChildTaskProjectionRecord(args)
      store.update(taskId, next)
      this.updateInactiveChildRunProjectionSiblings()
    }
    publish()
  }

  private updateInactiveChildRunProjectionSiblings(): void {
    const update = () => {
      const next = buildChildTaskProjectionRecord(args)
      args.store.update(previous.taskId, next)
    }
    update()
  }

  private persistTerminalClose(childRunId: string): void {
    this.config.repository.updateChildRun(childRunId, {
      status: 'failed',
    })
  }

${extra}
}

function buildChildTaskProjectionRecord(args: unknown): TaskProjectionRecord {
  return {
    taskId: 'skill-child:x',
    status: childProjectionStatusForState('completed'),
  } as TaskProjectionRecord
}

function childProjectionStatusForState(state: string): string {
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'killed'
  return 'completed'
}
`
}

function writeRunner(root, body) {
  write(root, 'src/main/modules/agent-control/skills/skill-child-runner.ts', body)
}

test('child-loop terminal boundary gate passes a current-source-shaped boundary', (t) => {
  const root = makeRoot(t)
  writeRunner(root, validRunner())
  const result = checkChildLoopTerminalBoundary({ root })
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2))
})

test('child-loop terminal boundary gate rejects finished event outside publishScopeRunClose', (t) => {
  const root = makeRoot(t)
  writeRunner(root, validRunner(`
  private badFinishedEvent(): void {
    publish({ type: 'finished' })
  }
`))
  const result = checkChildLoopTerminalBoundary({ root })
  assert.equal(result.ok, false)
  assert.match(result.violations.map((item) => item.kind).join('\n'), /finished_event_outside_boundary/)
})

test('child-loop terminal boundary gate rejects child projection builder outside the boundary', (t) => {
  const root = makeRoot(t)
  writeRunner(root, validRunner(`
  private badProjectionWriter(): void {
    const next = buildChildTaskProjectionRecord(args)
    store.update(taskId, next)
  }
`))
  const result = checkChildLoopTerminalBoundary({ root })
  assert.equal(result.ok, false)
  assert.match(result.violations.map((item) => item.kind).join('\n'), /child_projection_builder_outside_boundary/)
})

test('child-loop terminal boundary gate rejects direct terminal child projection writes', (t) => {
  const root = makeRoot(t)
  writeRunner(root, validRunner(`
  private badDirectProjectionWrite(): void {
    store.update('skill-child:x', {
      taskId: 'skill-child:x',
      status: 'completed',
    })
  }
`))
  const result = checkChildLoopTerminalBoundary({ root })
  assert.equal(result.ok, false)
  assert.match(result.violations.map((item) => item.kind).join('\n'), /direct_terminal_projection_write/)
})

test('child-loop terminal boundary gate rejects external child terminal projection writes', (t) => {
  const root = makeRoot(t)
  writeRunner(root, validRunner())
  write(root, 'src/main/modules/agent-control/not-child-runner.ts', `
export function bad(taskProjectionStore: any): void {
  taskProjectionStore.update('skill-child:x', {
    taskId: 'skill-child:x',
    status: 'failed',
  })
}
`)
  const result = checkChildLoopTerminalBoundary({ root })
  assert.equal(result.ok, false)
  assert.match(result.violations.map((item) => item.kind).join('\n'), /external_child_terminal_projection_write/)
})

test('child-loop terminal boundary gate does not treat repository close persistence as projection write', (t) => {
  const root = makeRoot(t)
  writeRunner(root, validRunner(`
  private anotherRepositoryClose(childRunId: string): void {
    this.config.repository.updateChildRun(childRunId, {
      status: 'killed',
    })
  }
`))
  const result = checkChildLoopTerminalBoundary({ root })
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2))
})
