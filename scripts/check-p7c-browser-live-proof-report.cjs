#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_REPORT = path.resolve(
  process.cwd(),
  'outputs/agent-audit/live/p7c-browser-live-proof-report.json',
)

function readReport(reportPath) {
  const raw = fs.readFileSync(reportPath, 'utf8')
  return JSON.parse(raw)
}

function numberWithin(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < max
}

function validateReport(report) {
  const errors = []
  if (!report || typeof report !== 'object') {
    return { ok: false, errors: ['report must be an object'] }
  }
  const scope = report.scope
  const isP7c1 = scope === 'P7c1-lock-events-and-live-proof'
  const isP7c2 = scope === 'P7c2-foreground-preservation-and-takeover'
  if (!isP7c1 && !isP7c2) {
    errors.push(`scope must be P7c1-lock-events-and-live-proof or P7c2-foreground-preservation-and-takeover, got ${JSON.stringify(scope)}`)
  }
  if (report.ok !== true) {
    errors.push('report.ok must be true')
  }
  const assertions = report.assertions || {}
  const reclaim = assertions.userViewReclaimEnforced || {}
  if (reclaim.ok !== true) {
    errors.push('userViewReclaimEnforced.ok must be true')
  }
  if (reclaim.errorKind !== 'lease_takeover') {
    errors.push('userViewReclaimEnforced.errorKind must be lease_takeover')
  }
  if (isP7c1 && reclaim.userSignal !== 'keyboard') {
    errors.push('userViewReclaimEnforced.userSignal must be keyboard for P7c1')
  }
  if (isP7c2 && reclaim.userSignal !== 'tab-switch') {
    errors.push('userViewReclaimEnforced.userSignal must be tab-switch for P7c2')
  }

  const push = assertions.leasePushBeforePoll || {}
  if (push.ok !== true) {
    errors.push('leasePushBeforePoll.ok must be true')
  }
  if (!numberWithin(push.latencyMs, 2500)) {
    errors.push(`leasePushBeforePoll.latencyMs must be >=0 and <2500, got ${JSON.stringify(push.latencyMs)}`)
  }

  const active = assertions.activeTabUnchangedAfterTakeover || {}
  if (active.ok !== true) {
    errors.push('activeTabUnchangedAfterTakeover.ok must be true')
  }
  if (!active.before || !active.after || active.before.tabId !== active.after.tabId || active.before.url !== active.after.url) {
    errors.push('activeTabUnchangedAfterTakeover must preserve tabId and url')
  }
  if (isP7c2) {
    const focus = assertions.activeTabFocusPreserved || {}
    if (focus.ok !== true) {
      errors.push('activeTabFocusPreserved.ok must be true for P7c2')
    }
    if (!focus.before || !focus.after || focus.before.focusToken !== focus.after.focusToken) {
      errors.push('activeTabFocusPreserved must preserve focusToken for P7c2')
    }
    const scroll = assertions.activeTabScrollPreserved || {}
    if (scroll.ok !== true) {
      errors.push('activeTabScrollPreserved.ok must be true for P7c2')
    }
    if (!scroll.before || !scroll.after || scroll.before.scrollY !== scroll.after.scrollY) {
      errors.push('activeTabScrollPreserved must preserve scrollY for P7c2')
    }
  }

  const background = assertions.backgroundAgentTabDidNotStealActive || {}
  if (background.ok !== true) {
    errors.push('backgroundAgentTabDidNotStealActive.ok must be true')
  }
  if (!background.beforeTabId || background.beforeTabId !== background.afterTabId) {
    errors.push('backgroundAgentTabDidNotStealActive must preserve active tab id')
  }

  const isolation = assertions.fullIsolationDeferred || {}
  if (isolation.ok !== true) {
    errors.push('fullIsolationDeferred.ok must be true')
  }
  if (isolation.separatePartitionImplemented !== false) {
    errors.push('fullIsolationDeferred.separatePartitionImplemented must be false for P7c1')
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const reportPath = path.resolve(process.argv[2] || DEFAULT_REPORT)
  let report
  try {
    report = readReport(reportPath)
  } catch (error) {
    console.error(`[p7c-live-proof] failed to read ${reportPath}: ${error.message}`)
    process.exit(1)
  }
  const result = validateReport(report)
  if (!result.ok) {
    console.error('[p7c-live-proof] report rejected:')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`[p7c-live-proof] OK ${reportPath}`)
}

if (require.main === module) {
  main()
}

module.exports = { validateReport }
