'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { inspectReadpathTerminalGuard } = require('../check-no-readpath-terminal-write.cjs')

test('fails when reconcileTaskProjections updates without terminal-transition guard', () => {
  const findings = inspectReadpathTerminalGuard(`
const READ_PATH_TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed'])
function reconcileTaskProjections(params) {
  if (!target) return 0
  params.store.update(record.taskId, target, { silent: true })
}
`)
  assert.ok(findings.some((finding) => finding.includes('missing isReadPathTerminalStatusTransition')))
  assert.ok(findings.some((finding) => finding.includes('does not sanitize terminal-transition targets')))
})

test('passes when terminal-transition sanitizer runs before store.update', () => {
  const findings = inspectReadpathTerminalGuard(`
const READ_PATH_TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed'])
function isReadPathTerminalStatusTransition(record, target) {
  return Boolean(
    target.status
    && target.status !== record.status
    && READ_PATH_TERMINAL_STATUSES.has(target.status),
  )
}
function nonTerminalReadPathRepairTarget(record, target) {
  if (!isReadPathTerminalStatusTransition(record, target)) return target
  return { continuationRef: target.continuationRef }
}
function reconcileTaskProjections(params) {
  if (!target) return 0
  const safeTarget = nonTerminalReadPathRepairTarget(record, target)
  params.store.update(record.taskId, safeTarget, { silent: true })
}
`)
  assert.deepEqual(findings, [])
})

test('fails when sanitizer runs after store.update', () => {
  const findings = inspectReadpathTerminalGuard(`
const READ_PATH_TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed'])
function isReadPathTerminalStatusTransition(record, target) {
  return Boolean(target.status && target.status !== record.status && READ_PATH_TERMINAL_STATUSES.has(target.status))
}
function nonTerminalReadPathRepairTarget(record, target) {
  if (!isReadPathTerminalStatusTransition(record, target)) return target
  return { continuationRef: target.continuationRef }
}
function reconcileTaskProjections(params) {
  params.store.update(record.taskId, target, { silent: true })
  const safeTarget = nonTerminalReadPathRepairTarget(record, target)
}
`)
  assert.ok(findings.some((finding) => finding.includes('before params.store.update')))
})

test('fails when any terminal status is missing from READ_PATH_TERMINAL_STATUSES', () => {
  const findings = inspectReadpathTerminalGuard(`
const READ_PATH_TERMINAL_STATUSES = new Set(['completed', 'failed'])
function isReadPathTerminalStatusTransition(record, target) {
  return Boolean(
    target.status
    && target.status !== record.status
    && READ_PATH_TERMINAL_STATUSES.has(target.status),
  )
}
function nonTerminalReadPathRepairTarget(record, target) {
  if (!isReadPathTerminalStatusTransition(record, target)) return target
  return { continuationRef: target.continuationRef }
}
function reconcileTaskProjections(params) {
  const safeTarget = nonTerminalReadPathRepairTarget(record, target)
  params.store.update(record.taskId, safeTarget, { silent: true })
}
`)
  assert.ok(findings.some((finding) => finding.includes('terminal status killed')))
})
