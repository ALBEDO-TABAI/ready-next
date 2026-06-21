#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const ORCHESTRATOR_REL = 'src/main/modules/agent-control/runtime-core/orchestrator.ts'
const RUNTIME_REL = 'src/main/modules/agent-control/runtime-core/runtime.ts'
const CHILD_RUNNER_REL = 'src/main/modules/agent-control/skills/skill-child-runner.ts'

function fail(message) {
  console.error(`[check-active-run-liveness-single-source] FAIL: ${message}`)
  process.exit(1)
}

function read(rel) {
  const file = path.join(ROOT, rel)
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read ${rel}: ${error.message}`)
  }
}

function sliceBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle)
  if (start < 0) return ''
  const end = text.indexOf(endNeedle, start + startNeedle.length)
  return end < 0 ? text.slice(start) : text.slice(start, end)
}

const orchestrator = read(ORCHESTRATOR_REL)
const runtime = read(RUNTIME_REL)
const childRunner = read(CHILD_RUNNER_REL)

if (!/export\s+interface\s+ChildLivenessProvider/.test(orchestrator)) {
  fail('orchestrator must expose ChildLivenessProvider')
}
if (!/hasActiveChildRunForScope\(scopeId:\s*string\):\s*boolean/.test(orchestrator)) {
  fail('ChildLivenessProvider must expose hasActiveChildRunForScope(scopeId)')
}
if (!/setChildLivenessProvider\(provider:\s*ChildLivenessProvider\s*\|\s*null\):\s*void/.test(orchestrator)) {
  fail('orchestrator must accept a child liveness provider')
}
if (!/isScopeLive\(agent:\s*string,\s*scopeId:\s*string\):\s*boolean/.test(orchestrator)) {
  fail('orchestrator must expose isScopeLive(agent, scopeId)')
}
const isScopeLive = sliceBetween(orchestrator, 'isScopeLive(agent: string, scopeId: string): boolean', 'interruptActiveRunIfMatches')
if (!/this\.hasActiveRun\(agent,\s*scopeId\)/.test(isScopeLive)) {
  fail('isScopeLive must include main-run liveness')
}
if (!/childLivenessProvider\?\.hasActiveChildRunForScope\(scopeId\)/.test(isScopeLive)) {
  fail('isScopeLive must include child-run liveness')
}

if (!/hasActiveChildRunForScope\(scopeId:\s*string\):\s*boolean/.test(childRunner)) {
  fail('SkillChildRunner must expose hasActiveChildRunForScope(scopeId)')
}
const childMethod = sliceBetween(childRunner, 'hasActiveChildRunForScope(scopeId: string): boolean', 'async startSkillChildRun')
if (!/this\.active\.values\(\)/.test(childMethod) || !/run\.scopeId\s*===\s*normalizedScopeId/.test(childMethod)) {
  fail('SkillChildRunner.hasActiveChildRunForScope must read the active child-run map by scopeId')
}

if (!/const\s+childRunner\s*=\s*configureSkillChildRunner\(/.test(runtime)) {
  fail('runtime must keep the configured child runner for liveness wiring')
}
if (!/this\.orchestrator\.setChildLivenessProvider\(childRunner\)/.test(runtime)) {
  fail('runtime must wire SkillChildRunner into orchestrator child liveness')
}
const staleCloseout = sliceBetween(
  runtime,
  'private async finalizeStaleWithoutHandleProjectionsForScope',
  'async suspendRun',
)
if (!staleCloseout) {
  fail('runtime stale projection closeout method not found')
}
if (/orchestrator\.hasActiveRun\(/.test(staleCloseout)) {
  fail('stale projection closeout must not bypass isScopeLive with orchestrator.hasActiveRun')
}
const isScopeLiveCalls = staleCloseout.match(/orchestrator\.isScopeLive\(/g) || []
if (isScopeLiveCalls.length < 2) {
  fail('stale projection closeout must use isScopeLive for preflight and finalizer callback')
}

console.log('[check-active-run-liveness-single-source] OK')
