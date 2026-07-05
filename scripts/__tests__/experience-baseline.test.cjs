/**
 * Phase R E1-E5 体验基线脚本行为合同。用合成的 tools/metrics 日志断言五个
 * 维度的提取正确，尤其 E5 的"同一 tab 连续 read 段长"分段逻辑与硬线
 * （E2 泛化失败=0、E5 同页连读≥3）。
 */
const assert = require('node:assert/strict')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const SCRIPT = join(__dirname, '..', 'experience-baseline.cjs')

function runBaseline(toolsLines, metricEvents, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ready-exp-baseline-'))
  const toolsPath = join(dir, 'tools.log')
  const metricsPath = join(dir, 'metrics.log')
  writeFileSync(toolsPath, toolsLines.join('\n'))
  writeFileSync(metricsPath, metricEvents.map((e) => JSON.stringify(e)).join('\n'))
  try {
    const out = execFileSync('node', [SCRIPT, '--json', '--tools', toolsPath, '--metrics', metricsPath, ...extraArgs], {
      encoding: 'utf8',
    })
    return { json: JSON.parse(out), exitCode: 0, dir, toolsPath, metricsPath }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function toolLine(tool, tabId) {
  return `[2026-07-05T00:00:00.000Z] executeBrowserTool: ${tool} args={"tab_id":"${tabId}","max_bytes":20000}`
}

test('E1 computes first-delta distribution and true-stream ratio', () => {
  const { json } = runBaseline([], [
    { metric: 'provider_stream_first_delta', ms: 0 },
    { metric: 'provider_stream_first_delta', ms: 0 },
    { metric: 'provider_stream_first_delta', ms: 40 },
    { metric: 'renderer_infrastructure_timeout_paused_user_input' },
  ])
  assert.equal(json.E1_never_silent.firstDeltaSamples, 3)
  assert.equal(json.E1_never_silent.trueStreamRatio, 0.667)
  assert.equal(json.E1_never_silent.firstDeltaMs.max, 40)
  assert.equal(json.E1_never_silent.infrastructureTimeouts, 1)
})

test('E2 tallies terminal reasons and counts generic-failure signals as the hard line', () => {
  const { json } = runBaseline([], [
    { metric: 'run_close', terminalReason: 'done' },
    { metric: 'run_close', terminalReason: 'done' },
    { metric: 'run_close', terminalReason: 'blocked_external' },
    { metric: 'adjudicator_enforce_divergence' },
  ])
  assert.equal(json.E2_evidence_or_exit.runCloses, 3)
  assert.deepEqual(json.E2_evidence_or_exit.terminalReasons, { done: 2, blocked_external: 1 })
  assert.equal(json.E2_evidence_or_exit.genericFailureSignals, 1)
})

test('E4 tallies learning-visible fired signals', () => {
  const { json } = runBaseline([], [
    { metric: 'crystallize_round_fired' },
    { metric: 'belief_decay_round_fired' },
    { metric: 'reflection_outcome' },
    { metric: 'unrelated_metric' },
  ])
  assert.equal(json.E4_learning_visible.learningSignals, 3)
})

test('E5 segments consecutive same-tab reads; a different action or tab breaks the streak', () => {
  // tab-1 连读 2 次 → 被 click 打断 → tab-1 再读 1 次 → 切 tab-2 读 3 次（回执缺陷）
  const { json } = runBaseline([
    toolLine('browser_read_page_map', 'tab-1'),
    toolLine('browser_read_page_map', 'tab-1'),
    toolLine('browser_click_at', 'tab-1'),
    toolLine('browser_read_page', 'tab-1'),
    toolLine('browser_read_page_map', 'tab-2'),
    toolLine('browser_read_page_map', 'tab-2'),
    toolLine('browser_read_page_map', 'tab-2'),
  ], [])
  assert.equal(json.E5_observe_once.maxConsecutiveReads, 3)
  assert.equal(json.E5_observe_once.receiptDefectStreaks, 1, 'the 3-read tab-2 streak is a receipt defect')
})

test('--assert exits non-zero when E2 generic-failure or E5 receipt-defect hard lines break', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-exp-assert-'))
  const toolsPath = join(dir, 'tools.log')
  const metricsPath = join(dir, 'metrics.log')
  writeFileSync(toolsPath, '')
  writeFileSync(metricsPath, JSON.stringify({ metric: 'adjudicator_enforce_divergence' }))
  try {
    assert.throws(() => execFileSync('node', [SCRIPT, '--assert', '--tools', toolsPath, '--metrics', metricsPath], { encoding: 'utf8' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // clean logs → assert passes (exit 0)
  const cleanDir = mkdtempSync(join(tmpdir(), 'ready-exp-clean-'))
  const cleanTools = join(cleanDir, 'tools.log')
  const cleanMetrics = join(cleanDir, 'metrics.log')
  writeFileSync(cleanTools, toolLine('browser_read_page_map', 'tab-1'))
  writeFileSync(cleanMetrics, JSON.stringify({ metric: 'run_close', terminalReason: 'done' }))
  try {
    const out = execFileSync('node', [SCRIPT, '--assert', '--tools', cleanTools, '--metrics', cleanMetrics], { encoding: 'utf8' })
    assert.match(out, /体验基线硬线：ok/)
  } finally {
    rmSync(cleanDir, { recursive: true, force: true })
  }
})
