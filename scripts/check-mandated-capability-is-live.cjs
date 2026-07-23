#!/usr/bin/env node
/**
 * 通用三态能力注册 + 正向存活 gate（梯队二，2026-07-03）。
 *
 * 负向 gate（check-unwired-capability-markers / check-dormant-compaction）只防
 * "误接"，防不了"该活的能力悄悄没接/断线"。本 gate 是 check-belief-decay-live
 * 的泛化（该 gate 已退役并被本表 belief-decay 条目原语义吸收），维护一张
 * 能力状态注册表，按状态断言：
 *
 *   - live-required：接线证据（import/调用）+ `*_fired` 可观测账本 + 文件上
 *     不得残留 unwired 标记；可选 delegation 边（"排除即托付"——某 live 路径
 *     把职责让渡给该能力时，该能力必须活着，否则让渡点成泄漏）。
 *   - deferred-by-design：不重复实现负向检查，只与 check-unwired-capability-markers
 *     的导出表做一致性握手——条目必须仍在对应 UNWIRED 表里。谁接线了能力
 *     （从 unwired 表移除）而没把本表翻成 live-required，本 gate 红，强制
 *     gate-flip 迁移显式发生。
 *   - dark-defect：建好没接、且尚无 defer 合同的能力。断言源码锚点仍存在 +
 *     暂缓登记文档明确提及（工单不许烂尾/静默消失）。
 *
 * 状态翻转规则（gate-flip）：接线一个 deferred/dark 能力时，必须同一变更内
 * 把本表条目翻成 live-required 并补 wiring/firedLedger 证据；反向退役同理。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

const {
  UNWIRED_PACKET_FILES,
  UNWIRED_MAINTENANCE_FILES,
  MIXED_MAINTENANCE_ROUND_REL,
} = require('./check-unwired-capability-markers.cjs')

const RUNTIME_REL = 'src/main/modules/agent-control/runtime-core/runtime.ts'
const DEFER_REGISTER_REL = 'docs/superpowers/plans/2026-07-03-deferred-work-register.md'

const REGISTRY = Object.freeze([
  {
    capability: 'belief-decay',
    status: 'live-required',
    delegation: {
      file: 'src/main/modules/agent-control/memory/memory-lifecycle.ts',
      pattern: /===\s*'belief'\s*\)\s*continue/,
      meaning:
        'memory-lifecycle 将 belief 行排除出通用 L2 归档，淘汰职责让渡给 belief-decay；'
        + '若 belief-decay 不活，信念卡永不淘汰（排除即托付被违反）',
    },
    wiring: [
      { name: 'runtime imports belief-decay', file: RUNTIME_REL, pattern: /from '\.\.\/memory\/belief-decay'/ },
      { name: 'runtime calls runBeliefDecayRound', file: RUNTIME_REL, pattern: /runBeliefDecayRound\s*\(/ },
    ],
    firedLedger: { file: RUNTIME_REL, event: 'belief_decay_round_fired' },
    noStaleMarker: {
      file: 'src/main/modules/agent-control/memory/belief-decay.ts',
      pattern: /P5d\/C26 unwired|not in production driver path/i,
    },
  },
  {
    capability: 'crystallize-round',
    status: 'live-required',
    wiring: [
      { name: 'runtime imports crystallize-gate', file: RUNTIME_REL, pattern: /from '\.\.\/maintenance\/crystallize-gate'/ },
      { name: 'runtime constructs CrystallizeScheduler', file: RUNTIME_REL, pattern: /new CrystallizeScheduler\s*\(/ },
    ],
    firedLedger: { file: RUNTIME_REL, event: 'crystallize_round_fired' },
    noStaleMarker: {
      file: 'src/main/modules/agent-control/maintenance/crystallize-gate.ts',
      pattern: /P5d\/C26 unwired|not in production driver path/i,
    },
  },
  {
    capability: 'candidate-maintenance',
    status: 'deferred-by-design',
    files: ['src/main/modules/agent-control/emergence/candidate-maintenance.ts'],
    unwiredList: 'UNWIRED_MAINTENANCE_FILES',
  },
  {
    capability: 'emergence-cards',
    status: 'live-required',
    wiring: [
      {
        name: 'ipc-handler registers emergenceFeedGroup',
        file: 'src/main/modules/claude-bridge/ipc-handler.ts',
        pattern: /emergenceFeedGroup\.register\(/,
      },
      {
        name: 'feed group assembles from emergence-cards',
        file: 'src/main/modules/claude-bridge/ipc/emergence-feed-group.ts',
        pattern: /assembleEmergenceFeed\(/,
      },
      {
        name: 'renderer feed section renders entries',
        file: 'src/renderer/components/ready/EmergenceFeedSection.tsx',
        pattern: /data-ready-emergence-feed/,
      },
      {
        // 真机反馈（2026-07-03）：feed 从聊天面板撤出，唯一前台面=ReadyMode
        // 仪表盘。该挂载点消失=能力回黑，正向 gate 必须能看见。
        name: 'ReadyMode TaskPanel mounts the feed section',
        file: 'src/renderer/components/ready/TaskPanel.tsx',
        pattern: /<EmergenceFeedSection/,
      },
    ],
    firedLedger: {
      file: 'src/main/modules/claude-bridge/ipc/emergence-feed-group.ts',
      event: 'emergence_feed_assembled',
    },
    noStaleMarker: {
      file: 'src/main/modules/agent-control/emergence/emergence-cards.ts',
      pattern: /P5d\/C26 unwired|not in production driver path/i,
    },
  },
  {
    capability: 'dynamic-delivery',
    status: 'live-required',
    wiring: [
      {
        name: 'coordinator calls bounded packet compiler',
        file: 'src/main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-coordinator.ts',
        pattern: /compileDynamicDeliveryPlan\s*\(/,
      },
      {
        name: 'SDK runtime constructs the coordinator',
        file: 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts',
        pattern: /new DynamicDeliveryCoordinator\s*\(/,
      },
      {
        name: 'runtime reconciles interrupted delivery on startup',
        file: RUNTIME_REL,
        pattern: /reconcileInterruptedDeliveryState\s*\(/,
      },
    ],
    firedLedger: {
      file: 'src/main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-coordinator.ts',
      event: 'dynamic_delivery_fired',
    },
    noStaleMarker: {
      file: 'src/main/modules/agent-control/quality/packet-compiler.ts',
      pattern: /P5c\/C22 unwired|not in production path/i,
    },
  },
  {
    // D7 gate-flip (2026-07-05)：crystallize tick 捎带驱动，三层预算闸在
    // maintenance-llm-driver（专项开关 / durable lastRunAt 进 EP2-C2 门控 /
    // 空信号跳过），LLM 写卡强制 staged。
    capability: 'maintenance-llm-round (runMaintenanceLlmRound)',
    status: 'live-required',
    wiring: [
      {
        name: 'runtime crystallize tick drives the llm round',
        file: RUNTIME_REL,
        pattern: /runMaintenanceLlmRoundTick\s*\(/,
      },
      {
        name: 'driver invokes the pinned maintenance round',
        file: 'src/main/modules/agent-control/maintenance/maintenance-llm-driver.ts',
        pattern: /runMaintenanceLlmRound\s*\(\{/,
      },
    ],
    firedLedger: {
      file: MIXED_MAINTENANCE_ROUND_REL,
      event: 'maintenance_audit',
    },
    noStaleMarker: {
      file: MIXED_MAINTENANCE_ROUND_REL,
      pattern: /P5d\/C26 unwired|not in production driver path/i,
    },
  },
  {
    // D4 gate-flip (2026-07-05)：声明通道裁决为新工具 declare_completion_criteria
    // （agent_interaction 组），落 projection.modelCriteria（整组替换），
    // finalizer 终态 appendModelCriteria 并入裁决 + model_criteria_merged 账本。
    capability: 'appendModelCriteria',
    status: 'live-required',
    wiring: [
      {
        name: 'declare tool registered on the agent_interaction surface',
        file: 'src/main/modules/tools/agent-interaction-tool-defs.ts',
        pattern: /'declare_completion_criteria'/,
      },
      {
        name: 'tool executor dispatches the declare builtin',
        file: 'src/main/modules/tools/tool-executor.ts',
        pattern: /executeDeclareCompletionCriteria\(/,
      },
      {
        name: 'finalizer merges declared criteria into adjudication',
        file: 'src/main/modules/agent-control/runtime-core/run-finalizer-adjudication.ts',
        pattern: /appendModelCriteria\(criteria\.items/,
      },
    ],
    firedLedger: {
      file: 'src/main/modules/agent-control/runtime-core/run-finalizer-adjudication.ts',
      event: 'model_criteria_merged',
    },
  },
  {
    capability: 'RunFeedbackRepository',
    status: 'live-required',
    wiring: [
      {
        name: 'ipc-handler registers runFeedbackGroup',
        file: 'src/main/modules/claude-bridge/ipc-handler.ts',
        pattern: /runFeedbackGroup\.register\(/,
      },
      {
        name: 'preload exposes runFeedback invoke channels',
        file: 'src/preload/index.ts',
        pattern: /agent:runFeedback:submit/,
      },
      {
        name: 'renderer rating control submits feedback',
        file: 'src/renderer/components/agent/chat-panel/task/RunFeedbackStars.tsx',
        pattern: /\.submit\(\{ taskId/,
      },
    ],
    firedLedger: {
      file: 'src/main/modules/claude-bridge/ipc/run-feedback-group.ts',
      event: 'run_feedback_submitted',
    },
  },
])

const UNWIRED_LISTS = Object.freeze({
  UNWIRED_PACKET_FILES: new Set(UNWIRED_PACKET_FILES),
  UNWIRED_MAINTENANCE_FILES: new Set(UNWIRED_MAINTENANCE_FILES),
})

function readOrNull(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

// registry 仅测试态可注入（机制覆盖用合成条目）；生产恒用本表。
function check({ root = REPO_ROOT, registry = REGISTRY } = {}) {
  const errors = []
  // D7 gate-flip: MIXED_MAINTENANCE_ROUND_REL 已 live，不再计入 unwired 约束面。
  const allUnwired = new Set([
    ...UNWIRED_PACKET_FILES,
    ...UNWIRED_MAINTENANCE_FILES,
  ])

  for (const entry of registry) {
    const tag = `[${entry.capability}]`

    if (entry.status === 'live-required') {
      // 表内矛盾：live-required 的文件绝不能同时挂在任何 unwired 表里。
      for (const item of [...(entry.wiring || []), entry.noStaleMarker].filter(Boolean)) {
        if (allUnwired.has(item.file)) {
          errors.push(`${tag} live-required 但 ${item.file} 仍在 unwired 表中 — 状态矛盾，先做 gate-flip。`)
        }
      }
      const delegation = entry.delegation
      const delegationSource = delegation ? readOrNull(root, delegation.file) : null
      const delegationActive = Boolean(delegationSource && delegation.pattern.test(delegationSource))
      const wiringResults = (entry.wiring || []).map((item) => {
        const source = readOrNull(root, item.file)
        return { item, ok: Boolean(source && item.pattern.test(source)) }
      })
      const allWired = wiringResults.every((result) => result.ok)
      if (delegation && delegationActive && !allWired) {
        const missing = wiringResults.filter((r) => !r.ok).map((r) => r.item.name).join(', ')
        errors.push(`${tag} 排除即托付被违反：${delegation.meaning}；缺失接线证据：${missing}`)
      }
      if (!delegation && !allWired) {
        const missing = wiringResults.filter((r) => !r.ok).map((r) => r.item.name).join(', ')
        errors.push(`${tag} live-required 能力缺失接线证据：${missing}`)
      }
      if (entry.firedLedger && allWired) {
        const source = readOrNull(root, entry.firedLedger.file)
        if (!source || !source.includes(entry.firedLedger.event)) {
          errors.push(`${tag} 已接线但缺 ${entry.firedLedger.event} 账本 — live-required 能力必须可观测。`)
        }
      }
      if (entry.noStaleMarker) {
        const source = readOrNull(root, entry.noStaleMarker.file)
        if (source && entry.noStaleMarker.pattern.test(source)) {
          errors.push(`${tag} 已 live，${entry.noStaleMarker.file} 不得残留 unwired 标记。`)
        }
      }
      continue
    }

    if (entry.status === 'deferred-by-design') {
      // 与负向 gate 的导出表握手：条目被接线（移出 unwired 表）却没翻本表 → 红。
      const listSet = UNWIRED_LISTS[entry.unwiredList]
      if (!listSet) {
        errors.push(`${tag} 引用了未知的 unwired 表 ${entry.unwiredList}。`)
        continue
      }
      for (const file of entry.files) {
        if (!listSet.has(file)) {
          errors.push(
            `${tag} 注册为 deferred-by-design，但 ${file} 已不在 check-unwired-capability-markers 的 `
            + `${entry.unwiredList} 中 — 若已接线，请把本表条目翻成 live-required 并补 wiring/fired 证据（gate-flip）。`,
          )
        }
      }
      continue
    }

    if (entry.status === 'dark-defect') {
      const anchorSource = readOrNull(root, entry.anchor.file)
      if (!anchorSource) {
        errors.push(`${tag} dark-defect 锚点文件缺失：${entry.anchor.file} — 若已删除该能力，请同步移除本表条目。`)
      } else if (!entry.anchor.pattern.test(anchorSource)) {
        errors.push(`${tag} dark-defect 锚点符号已消失于 ${entry.anchor.file} — 请同步更新本表与暂缓登记。`)
      }
      const registerSource = readOrNull(root, entry.register.file)
      if (!registerSource) {
        errors.push(`${tag} 暂缓登记文档缺失：${entry.register.file}`)
      } else if (!registerSource.includes(entry.register.mention)) {
        errors.push(`${tag} 暂缓登记文档 ${entry.register.file} 未提及 ${entry.register.mention} — dark-defect 必须挂工单。`)
      }
      continue
    }

    errors.push(`${tag} 未知状态 ${entry.status}（合法值：live-required | deferred-by-design | dark-defect）。`)
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-mandated-capability-is-live] FAIL')
    for (const error of result.errors) console.error(' - ' + error)
    process.exit(1)
  }
  console.log('[check-mandated-capability-is-live] ok')
}

module.exports = { check, REGISTRY }
