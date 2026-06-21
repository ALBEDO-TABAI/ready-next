const assert = require('node:assert/strict')
const test = require('node:test')

const { validateReport } = require('../check-p7c-browser-live-proof-report.cjs')

function validReport() {
  return {
    ok: true,
    scope: 'P7c1-lock-events-and-live-proof',
    assertions: {
      userViewReclaimEnforced: {
        ok: true,
        userSignal: 'keyboard',
        errorKind: 'lease_takeover',
      },
      leasePushBeforePoll: {
        ok: true,
        latencyMs: 120,
      },
      activeTabUnchangedAfterTakeover: {
        ok: true,
        before: { tabId: 'tab-user', url: 'http://127.0.0.1/example', scrollY: 10 },
        after: { tabId: 'tab-user', url: 'http://127.0.0.1/example', scrollY: 10 },
      },
      backgroundAgentTabDidNotStealActive: {
        ok: true,
        beforeTabId: 'tab-user',
        afterTabId: 'tab-user',
      },
      fullIsolationDeferred: {
        ok: true,
        separatePartitionImplemented: false,
      },
    },
  }
}

function validP7c2Report() {
  const report = validReport()
  report.scope = 'P7c2-foreground-preservation-and-takeover'
  report.assertions.userViewReclaimEnforced.userSignal = 'tab-switch'
  report.assertions.activeTabFocusPreserved = {
    ok: true,
    before: { focusToken: 'article-search' },
    after: { focusToken: 'article-search' },
  }
  report.assertions.activeTabScrollPreserved = {
    ok: true,
    before: { scrollY: 320 },
    after: { scrollY: 320 },
  }
  return report
}

test('accepts a P7c1 live-proof report with enforced reclaim and no isolation overclaim', () => {
  assert.equal(validateReport(validReport()).ok, true)
})

test('accepts a P7c2 live-proof report only with tab-switch, focus, and scroll preservation', () => {
  assert.equal(validateReport(validP7c2Report()).ok, true)

  const report = validP7c2Report()
  report.assertions.userViewReclaimEnforced.userSignal = 'keyboard'
  delete report.assertions.activeTabFocusPreserved
  report.assertions.activeTabScrollPreserved.after.scrollY = 0

  const result = validateReport(report)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /tab-switch/)
  assert.match(result.errors.join('\n'), /activeTabFocusPreserved/)
  assert.match(result.errors.join('\n'), /activeTabScrollPreserved/)
})

test('rejects reports that claim full isolation or miss the lease_takeover proof', () => {
  const report = validReport()
  report.assertions.fullIsolationDeferred.separatePartitionImplemented = true
  report.assertions.userViewReclaimEnforced.errorKind = 'ok'

  const result = validateReport(report)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /lease_takeover/)
  assert.match(result.errors.join('\n'), /separatePartitionImplemented/)
})

test('rejects stale push evidence that only proves polling latency', () => {
  const report = validReport()
  report.assertions.leasePushBeforePoll.latencyMs = 2600

  const result = validateReport(report)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /latencyMs/)
})
