/**
 * B Phase 4 PR1 — SkillTaskTracker contract.
 *
 * Covers the in-memory todo lifecycle that replaces the retired
 * `skill_executions` state machine for UI task-card projection.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SkillTaskTracker,
  _resetSkillTaskTrackerForTests,
  getSkillTaskTracker,
} from '../main/modules/agent-control/skill-task-tracker'

test('startTodo returns a unique id with the st- prefix', () => {
  const tracker = new SkillTaskTracker()
  const ids = new Set<string>()
  for (let i = 0; i < 20; i += 1) {
    const id = tracker.startTodo({
      sessionId: 's1',
      skillId: 'skill-x',
      title: `step ${i}`,
      origin: 'run_shell',
    })
    assert.ok(id.startsWith('st-'), `id ${id} should start with "st-"`)
    ids.add(id)
  }
  assert.equal(ids.size, 20)
})

test('startTodo defaults to running; status=blocked honored for ask_user', () => {
  const tracker = new SkillTaskTracker()
  const running = tracker.startTodo({
    sessionId: 's1',
    skillId: 'skill',
    title: 't',
    origin: 'run_shell',
  })
  const blocked = tracker.startTodo({
    sessionId: 's1',
    skillId: 'skill',
    title: 'ask',
    origin: 'ask_user',
    status: 'blocked',
  })
  assert.equal(tracker.findTodo(running)?.status, 'running')
  assert.equal(tracker.findTodo(blocked)?.status, 'blocked')
})

test('markDone transitions to done, clears blockedReason, records artifactPath', () => {
  const tracker = new SkillTaskTracker()
  const id = tracker.startTodo({
    sessionId: 's',
    skillId: 'sk',
    title: 'run',
    origin: 'run_shell',
    status: 'blocked',
  })
  tracker.markBlocked(id, 'pre-existing reason')
  const ok = tracker.markDone(id, '/abs/output/result.json')
  assert.equal(ok, true)
  const todo = tracker.findTodo(id)
  assert.equal(todo?.status, 'done')
  assert.equal(todo?.artifactPath, '/abs/output/result.json')
  // blockedReason must be cleared on transition out of blocked
  assert.equal(todo?.blockedReason, undefined)
})

test('markBlocked records reason and status', () => {
  const tracker = new SkillTaskTracker()
  const id = tracker.startTodo({
    sessionId: 's',
    skillId: 'sk',
    title: 'run',
    origin: 'run_shell',
  })
  const ok = tracker.markBlocked(id, 'exit code 2')
  assert.equal(ok, true)
  const todo = tracker.findTodo(id)
  assert.equal(todo?.status, 'blocked')
  assert.equal(todo?.blockedReason, 'exit code 2')
})

test('markDone / markBlocked return false for unknown ids', () => {
  const tracker = new SkillTaskTracker()
  assert.equal(tracker.markDone('no-such'), false)
  assert.equal(tracker.markBlocked('no-such', 'reason'), false)
})

test('listTodos returns session todos in insertion order, filters by skill', () => {
  const tracker = new SkillTaskTracker()
  const a = tracker.startTodo({ sessionId: 's1', skillId: 'skill-a', title: 'A1', origin: 'run_shell' })
  const b = tracker.startTodo({ sessionId: 's1', skillId: 'skill-b', title: 'B1', origin: 'write_artifact' })
  const c = tracker.startTodo({ sessionId: 's1', skillId: 'skill-a', title: 'A2', origin: 'ask_user' })
  const all = tracker.listTodos('s1')
  assert.deepEqual(all.map((t) => t.id), [a, b, c])
  const onlyA = tracker.listTodos('s1', 'skill-a')
  assert.deepEqual(onlyA.map((t) => t.id), [a, c])
})

test('listTodos returns [] for unknown session or empty skillId filter miss', () => {
  const tracker = new SkillTaskTracker()
  tracker.startTodo({ sessionId: 's1', skillId: 'skill', title: 't', origin: 'manual' })
  assert.deepEqual(tracker.listTodos('other'), [])
  assert.deepEqual(tracker.listTodos('s1', 'different-skill'), [])
})

test('listTodos returns shallow clones — mutating a returned todo does not affect tracker state', () => {
  const tracker = new SkillTaskTracker()
  const id = tracker.startTodo({ sessionId: 's', skillId: 'sk', title: 'orig', origin: 'run_shell' })
  const todos = tracker.listTodos('s')
  todos[0].title = 'MUTATED'
  assert.equal(tracker.findTodo(id)?.title, 'orig')
})

test('clearSession removes session todos and returns count; idempotent on unknown session', () => {
  const tracker = new SkillTaskTracker()
  tracker.startTodo({ sessionId: 's1', skillId: 'sk', title: '1', origin: 'run_shell' })
  tracker.startTodo({ sessionId: 's1', skillId: 'sk', title: '2', origin: 'run_shell' })
  tracker.startTodo({ sessionId: 's2', skillId: 'sk', title: 'keep', origin: 'run_shell' })
  const removed = tracker.clearSession('s1')
  assert.equal(removed, 2)
  assert.deepEqual(tracker.listTodos('s1'), [])
  assert.equal(tracker.listTodos('s2').length, 1)
  // Idempotent — clearing again yields 0.
  assert.equal(tracker.clearSession('s1'), 0)
  assert.equal(tracker.clearSession('never-seen'), 0)
})

test('concurrent sessions on same skillId are isolated', () => {
  const tracker = new SkillTaskTracker()
  tracker.startTodo({ sessionId: 'sA', skillId: 'shared-skill', title: 'A', origin: 'run_shell' })
  tracker.startTodo({ sessionId: 'sB', skillId: 'shared-skill', title: 'B', origin: 'run_shell' })
  assert.equal(tracker.listTodos('sA').length, 1)
  assert.equal(tracker.listTodos('sB').length, 1)
  tracker.clearSession('sA')
  assert.equal(tracker.listTodos('sA').length, 0)
  assert.equal(tracker.listTodos('sB').length, 1)
})

test('getSkillTaskTracker singleton is reset by _resetSkillTaskTrackerForTests', () => {
  const t1 = getSkillTaskTracker()
  t1.startTodo({ sessionId: 's', skillId: 'sk', title: 'x', origin: 'run_shell' })
  assert.equal(t1.size(), 1)
  _resetSkillTaskTrackerForTests()
  const t2 = getSkillTaskTracker()
  // Must be a fresh instance with no carryover state.
  assert.equal(t2.size(), 0)
  assert.notStrictEqual(t1, t2)
})
