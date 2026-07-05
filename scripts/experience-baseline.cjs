#!/usr/bin/env node
/**
 * Phase R E1-E5 体验断言基线统计（roadmap §4.1 / §5「体验也要合同化」）。
 *
 * 从 ready-tools.log + ready-agent-metrics.log 提取五条体验维度的可回归
 * 数字，防止体验回退像功能回退一样静默。这是**度量脚本不是 gate**——
 * 输出基线供人判读与趋势对照；`--assert` 下才对硬线（E2 泛化失败=0、
 * E5 同页连读≥3=回执缺陷）返回非零退出。
 *
 *   E1 永不静默   → provider 首 delta 延迟分布（ms=0 占比=真流式）；
 *                   renderer infrastructure timeout 计数（静默窗兜底触发）。
 *   E2 完成有证据 → run_close 的 terminalReason 分布；泛化失败信号
 *                   （adjudicator_*_divergence）计数——硬线=0。
 *   E3 部分进展   → collection verdict / retry 相关（有则统计，无则 n/a）。
 *   E4 学习可见   → 知识写入提示类 metric（crystallize/belief/reflection fired）。
 *   E5 观察一次   → 同一 tab 连续 read_page(_map) 段长；≥3 段=回执缺陷。
 *
 * 用法：
 *   node scripts/experience-baseline.cjs                # 人读基线（默认 tmp 日志）
 *   node scripts/experience-baseline.cjs --json         # 机读 JSON
 *   node scripts/experience-baseline.cjs --assert       # 硬线违反则退出码 1
 *   node scripts/experience-baseline.cjs --tools <path> --metrics <path>
 */

const { existsSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

function parseArgs(argv) {
  const opts = { json: false, assert: false, tools: null, metrics: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') opts.json = true
    else if (arg === '--assert') opts.assert = true
    else if (arg === '--tools') { opts.tools = argv[i + 1]; i += 1 }
    else if (arg === '--metrics') { opts.metrics = argv[i + 1]; i += 1 }
  }
  if (!opts.tools) opts.tools = join(tmpdir(), 'ready-tools.log')
  if (!opts.metrics) opts.metrics = join(tmpdir(), 'ready-agent-metrics.log')
  return opts
}

function readLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0)
}

function readMetrics(path) {
  const out = []
  for (const line of readLines(path)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // 非 JSON 行（轮转边界/半行）跳过——统计尽力而为
    }
  }
  return out
}

function tally(values) {
  const map = {}
  for (const value of values) map[value] = (map[value] || 0) + 1
  return map
}

// ---- E1：首 delta 延迟 + 静默兜底 ------------------------------------------
function computeE1(metrics) {
  const firstDeltas = metrics.filter((m) => m.metric === 'provider_stream_first_delta')
  const msValues = firstDeltas.map((m) => Number(m.ms)).filter((v) => Number.isFinite(v))
  const trueStreamCount = msValues.filter((v) => v === 0).length
  const infraTimeouts = metrics.filter((m) =>
    m.metric === 'renderer_infrastructure_timeout_paused_user_input'
    || m.metric === 'renderer_infrastructure_timeout_awaiting_user_input').length
  return {
    firstDeltaSamples: msValues.length,
    firstDeltaMs: msValues.length > 0 ? {
      min: Math.min(...msValues),
      median: median(msValues),
      max: Math.max(...msValues),
    } : null,
    trueStreamRatio: msValues.length > 0 ? round(trueStreamCount / msValues.length) : null,
    infrastructureTimeouts: infraTimeouts,
  }
}

// ---- E2：终态分布 + 泛化失败硬线 -------------------------------------------
function computeE2(metrics) {
  const runCloses = metrics.filter((m) => m.metric === 'run_close')
  const terminalReasons = tally(runCloses.map((m) => String(m.terminalReason || 'unknown')))
  const genericFailureSignals = metrics.filter((m) =>
    m.metric === 'adjudicator_enforce_divergence'
    || m.metric === 'adjudicator_shadow_divergence').length
  return {
    runCloses: runCloses.length,
    terminalReasons,
    // 硬线：泛化失败卡出现次数（roadmap E2「= 0」）——这里用裁决分歧作代理信号
    genericFailureSignals,
  }
}

// ---- E3：部分进展（有相应 metric 才统计） ----------------------------------
function computeE3(metrics) {
  const partial = metrics.filter((m) =>
    /collection|retry|checkpoint|resumable/i.test(String(m.metric || '')))
  return {
    partialProgressSignals: partial.length,
    byMetric: tally(partial.map((m) => m.metric)),
  }
}

// ---- E4：学习可见（知识写入 fired 提示） -----------------------------------
function computeE4(metrics) {
  const learning = metrics.filter((m) =>
    /crystallize_round_fired|belief_decay_round_fired|reflection_outcome|belief_startup_sync|skill_reference_inlined/.test(String(m.metric || '')))
  return {
    learningSignals: learning.length,
    byMetric: tally(learning.map((m) => m.metric)),
  }
}

// ---- E5：同一 tab 连续 read_page 段长 --------------------------------------
// tools.log 行例：`... executeBrowserTool: browser_read_page_map args={...tab_id":"tab-10"...}`
function computeE5(toolsLines) {
  // 只统计浏览器工具调用序列里的 read_page(_map)——被其它浏览器动作打断即断段
  const BROWSER_TOOL_RE = /executeBrowserTool:\s*(browser_[a-z_]+)\s+args=(\{.*\})?/
  let currentTab = null
  let streak = 0
  let maxStreak = 0
  let offenders = 0 // 段长 ≥3 的次数（回执缺陷）
  const streaks = []
  const flush = () => {
    if (streak >= 3) offenders += 1
    if (streak > 0) streaks.push(streak)
    maxStreak = Math.max(maxStreak, streak)
    streak = 0
  }
  for (const line of toolsLines) {
    const match = line.match(BROWSER_TOOL_RE)
    if (!match) continue
    const tool = match[1]
    const isRead = tool === 'browser_read_page' || tool === 'browser_read_page_map'
    const tabMatch = (match[2] || '').match(/"tab_id":"([^"]+)"/)
    const tab = tabMatch ? tabMatch[1] : currentTab
    if (isRead && tab === currentTab && currentTab !== null) {
      streak += 1
    } else if (isRead) {
      flush()
      currentTab = tab
      streak = 1
    } else {
      // 任何非 read 浏览器动作打断连读段
      flush()
      currentTab = tab
    }
  }
  flush()
  return {
    readStreaks: streaks.length,
    maxConsecutiveReads: maxStreak,
    receiptDefectStreaks: offenders, // 硬线信号：同页连读≥3
    medianStreak: streaks.length > 0 ? median(streaks) : null,
  }
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const toolsLines = readLines(opts.tools)
  const metrics = readMetrics(opts.metrics)

  const baseline = {
    generatedFrom: { tools: opts.tools, metrics: opts.metrics },
    sampleSize: { toolsLines: toolsLines.length, metricEvents: metrics.length },
    E1_never_silent: computeE1(metrics),
    E2_evidence_or_exit: computeE2(metrics),
    E3_partial_progress: computeE3(metrics),
    E4_learning_visible: computeE4(metrics),
    E5_observe_once: computeE5(toolsLines),
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`)
  } else {
    printHuman(baseline)
  }

  if (opts.assert) {
    const violations = []
    if (baseline.E2_evidence_or_exit.genericFailureSignals > 0) {
      violations.push(`E2: ${baseline.E2_evidence_or_exit.genericFailureSignals} 个泛化失败/裁决分歧信号（硬线=0）`)
    }
    if (baseline.E5_observe_once.receiptDefectStreaks > 0) {
      violations.push(`E5: ${baseline.E5_observe_once.receiptDefectStreaks} 段同页连读≥3（回执缺陷）`)
    }
    if (violations.length > 0) {
      console.error('\n体验基线硬线违反：')
      for (const v of violations) console.error(`- ${v}`)
      process.exit(1)
    }
    console.log('\n体验基线硬线：ok')
  }
}

function printHuman(b) {
  console.log('Ready 体验基线（E1-E5）')
  console.log(`  样本：${b.sampleSize.toolsLines} 条工具日志行 / ${b.sampleSize.metricEvents} 个 metric 事件`)
  console.log('')
  console.log('E1 永不静默：')
  console.log(`  首 delta 样本 ${b.E1_never_silent.firstDeltaSamples}，真流式(ms=0)占比 ${fmt(b.E1_never_silent.trueStreamRatio)}`)
  if (b.E1_never_silent.firstDeltaMs) {
    console.log(`  首 delta 延迟 ms：min ${b.E1_never_silent.firstDeltaMs.min} / 中位 ${b.E1_never_silent.firstDeltaMs.median} / max ${b.E1_never_silent.firstDeltaMs.max}`)
  }
  console.log(`  基础设施超时兜底触发：${b.E1_never_silent.infrastructureTimeouts}`)
  console.log('')
  console.log('E2 完成有证据/失败有出路：')
  console.log(`  run_close ${b.E2_evidence_or_exit.runCloses} 次，终态分布：${JSON.stringify(b.E2_evidence_or_exit.terminalReasons)}`)
  console.log(`  泛化失败/裁决分歧信号（硬线=0）：${b.E2_evidence_or_exit.genericFailureSignals}`)
  console.log('')
  console.log('E3 部分进展永不清零：')
  console.log(`  相关信号 ${b.E3_partial_progress.partialProgressSignals}：${JSON.stringify(b.E3_partial_progress.byMetric)}`)
  console.log('')
  console.log('E4 学习可见可控：')
  console.log(`  知识写入 fired 信号 ${b.E4_learning_visible.learningSignals}：${JSON.stringify(b.E4_learning_visible.byMetric)}`)
  console.log('')
  console.log('E5 观察一次就够：')
  console.log(`  read 连读段 ${b.E5_observe_once.readStreaks}，最长连读 ${b.E5_observe_once.maxConsecutiveReads}，中位段长 ${fmt(b.E5_observe_once.medianStreak)}`)
  console.log(`  同页连读≥3（回执缺陷段，硬线信号）：${b.E5_observe_once.receiptDefectStreaks}`)
}

function fmt(value) {
  return value === null ? 'n/a' : String(value)
}

main()
