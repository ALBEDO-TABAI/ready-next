#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const failures = []
const fail = (message) => failures.push(message)

const files = {
  contract: 'src/main/modules/agent-control/contracts/task-open-status.ts',
  sharedStatus: 'src/shared/skill-child-run-status.ts',
  followup: 'src/shared/agent-followup-intent.ts',
  preroute: 'src/main/modules/agent-control/agents/session-preroute.ts',
  trace: 'src/main/modules/agent-control/agents/session-preroute-trace.ts',
  // B8-D R1 — the preroute method bodies moved from runtime.ts into the
  // delegated SessionPrerouteService; the off-mode short-circuit contract
  // is validated against the service source.
  prerouteService: 'src/main/modules/agent-control/runtime-core/session-preroute-service.ts',
}

for (const [label, rel] of Object.entries(files)) {
  if (!fs.existsSync(path.join(root, rel))) fail(`${label} file is missing: ${rel}`)
}

if (failures.length === 0) {
  const contract = read(files.contract)
  if (!contract.includes('SKILL_CHILD_RUN_OPEN_STATUSES')) {
    fail('task-open-status.ts must derive from SKILL_CHILD_RUN_OPEN_STATUSES.')
  }
  if (!contract.includes('isSkillChildRunOpenStatus')) {
    fail('task-open-status.ts must reuse isSkillChildRunOpenStatus.')
  }

  const sharedStatus = read(files.sharedStatus)
  for (const status of ['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked']) {
    if (!sharedStatus.includes(`'${status}'`)) fail(`shared skill-child status is missing ${status}.`)
  }
  if (sharedStatus.includes("'active'")) fail('shared skill-child task statuses must not include ghost status active.')

  const followup = read(files.followup)
  if (!followup.includes("from './skill-child-run-status'")) {
    fail('agent-followup-intent.ts must import the shared open-status helper.')
  }
  if (followup.includes('CONTINUABLE_STATUSES')) {
    fail('agent-followup-intent.ts must not keep a local continuable status set.')
  }
  if (/['"](running|queued|blocked|recoverable_paused|budget_paused|active)['"]/.test(followup)) {
    fail('agent-followup-intent.ts must not hard-code open task status literals.')
  }
  if (/new\s+Set\s*\(\s*\[[^\]]*(?:running|queued|blocked|recoverable_paused|budget_paused|active)[^\]]*\]/s.test(followup)) {
    fail('agent-followup-intent.ts must not recreate an inline continuable-status Set under any name.')
  }

  for (const rel of [files.preroute, files.trace]) {
    const source = read(rel)
    if (!source.includes("../contracts/task-open-status")) {
      fail(`${rel} must import the shared task-open-status contract.`)
    }
    if (source.includes('OPEN_TASK_STATUSES')) {
      fail(`${rel} must not declare or reference a local OPEN_TASK_STATUSES table.`)
    }
    if (/new\s+Set\s*\(\s*\[[^\]]*(?:running|queued|blocked|recoverable_paused|budget_paused)[^\]]*\]/s.test(source)) {
      fail(`${rel} must not recreate an inline open-status Set.`)
    }
    if (/['"]active['"]/.test(source)) {
      fail(`${rel} must not use quoted ghost status active as a task status.`)
    }
  }

  const runtime = read(files.prerouteService)
  const segment = (name, endMarker) => {
    const start = runtime.indexOf(name)
    const end = runtime.indexOf(endMarker, start)
    if (start < 0 || end < 0) return null
    return runtime.slice(start, end)
  }
  const evalBody = segment(
    'evaluateSessionPreroute(firstMessage: string): PrerouteResult {',
    '/** P8g-8a',
  )
  const studioBody = segment(
    'simulateSessionPrerouteForStudio(firstMessage: string): AgentSystemStudioRoutingSimulation {',
    'listRecentSessionPrerouteTraces',
  )

  const assertShortCircuitBeforeReads = (label, body, checks) => {
    if (!body) {
      fail(`${label} method body was not found.`)
      return
    }
    const offIndex = body.indexOf("mode === 'off'")
    if (offIndex < 0) {
      fail(`${label} must branch on mode === 'off'.`)
      return
    }
    const afterOff = body.slice(offIndex)
    const returnIndex = afterOff.search(/\breturn\b/)
    if (returnIndex < 0) {
      fail(`${label} off branch must return before any preroute inventory reads.`)
      return
    }
    const offReturnIndex = offIndex + returnIndex
    for (const needle of checks) {
      const index = body.indexOf(needle)
      if (index >= 0 && index < offReturnIndex) fail(`${label} reads ${needle} before the off short-circuit return.`)
    }
  }

  assertShortCircuitBeforeReads('evaluateSessionPreroute', evalBody, [
    'agentRegistry.list',
    'listRecentTasksForPreroute',
    'listRoutingCards',
    'pushSessionPrerouteTraceSafely',
  ])
  assertShortCircuitBeforeReads('simulateSessionPrerouteForStudio', studioBody, [
    'agentRegistry.list',
    'listRecentTasksForPreroute',
    'listRoutingCards',
    'listRoutingCardInventory',
    'buildSessionPrerouteTrace',
  ])
}

if (failures.length > 0) {
  console.error('[check-preroute-status-single-source] failed')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[check-preroute-status-single-source] ok')
