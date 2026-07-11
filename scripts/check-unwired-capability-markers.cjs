#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

// Dynamic Delivery gate-flip (2026-07-11): packet compilation is now in the
// production coordinator; scheduling and settlement moved to the typed
// dynamic-delivery modules. No packet module remains on the dormant list.
const UNWIRED_PACKET_FILES = Object.freeze([])

// P5d cluster — deterministic-parts migration (2026-07-03): crystallize-gate.ts
// was migrated to live (runtime.ts CrystallizeScheduler + belief-decay round);
// emergence-cards.ts was migrated to live on the same day (梯队三：
// emergence-feed-group 组装 + fired 账本 + TaskPanel feed 面；见
// check-mandated-capability-is-live 的 live-required 条目)。
// candidate-maintenance stays deferred (LLM 维护回合部分未接).
const UNWIRED_MAINTENANCE_FILES = Object.freeze([
  'src/main/modules/agent-control/emergence/candidate-maintenance.ts',
])

const LIVE_PACKET_FIELDS_REL = 'src/main/modules/agent-control/quality/packet-fields.ts'
const LIVE_CAS_MERGE_REL = 'src/main/modules/agent-control/maintenance/cas-merge.ts'
const MIXED_MAINTENANCE_ROUND_REL = 'src/main/modules/agent-control/maintenance/maintenance-llm-round.ts'
const MAINTENANCE_LLM_DRIVER_REL = 'src/main/modules/agent-control/maintenance/maintenance-llm-driver.ts'
const RUNTIME_REL = 'src/main/modules/agent-control/runtime-core/runtime.ts'
const IPC_HANDLER_REL = 'src/main/modules/claude-bridge/ipc-handler.ts'
const BELIEF_CARD_GROUP_REL = 'src/main/modules/claude-bridge/ipc/belief-card-group.ts'
const BELIEF_PANEL_REL = 'src/renderer/components/memory/BeliefCardsPanel.tsx'
const P5C_DOC_REL = 'docs/superpowers/plans/2026-06-20-p5c-packet-trio-disabled-implementation.md'
const P5D_DOC_REL = 'docs/superpowers/plans/2026-06-20-p5d-maintenance-emergence-status-implementation.md'
const DOC_REL = P5C_DOC_REL

const INTRA_CLUSTER_ALLOW = Object.freeze([
  [
    'src/main/modules/agent-control/quality/packet-failure.ts',
    'src/main/modules/agent-control/quality/packet-compiler.ts',
  ],
  [
    'src/main/modules/agent-control/quality/packet-dispatch.ts',
    'src/main/modules/agent-control/quality/packet-compiler.ts',
  ],
])

function normalizeRel(file) {
  return file.split(path.sep).join('/')
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir)) {
    const abs = path.join(dir, entry)
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      walk(abs, out)
      continue
    }
    if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) out.push(abs)
  }
  return out
}

function isTestRel(rel) {
  return rel.includes('/__tests__/') || /\.test\.[^.]+$/.test(rel) || rel.startsWith('scripts/__tests__/')
}

function isAllowedIntraCluster(fromRel, toRel) {
  return INTRA_CLUSTER_ALLOW.some(([from, to]) => from === fromRel && to === toRel)
}

function candidateRelativeTargets(root, fromAbs, specifier) {
  if (!specifier.startsWith('.')) return []
  const base = path.resolve(path.dirname(fromAbs), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ]
  return candidates.map((abs) => normalizeRel(path.relative(root, abs)))
}

function extractSpecifiers(source) {
  const specs = []
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]+\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source))) specs.push(match[1])
  }
  return specs
}

function check({ root = REPO_ROOT } = {}) {
  const errors = []
  const unwiredSet = new Set([...UNWIRED_PACKET_FILES, ...UNWIRED_MAINTENANCE_FILES])

  if (unwiredSet.has(LIVE_PACKET_FIELDS_REL)) {
    errors.push(`${LIVE_PACKET_FIELDS_REL} must not be in an unwired capability list.`)
  }
  if (unwiredSet.has(LIVE_CAS_MERGE_REL)) {
    errors.push(`${LIVE_CAS_MERGE_REL} is live CAS merge code and must not be in an unwired list.`)
  }
  if (unwiredSet.has(MIXED_MAINTENANCE_ROUND_REL)) {
    errors.push(`${MIXED_MAINTENANCE_ROUND_REL} is mixed: status getter is live, only runMaintenanceLlmRound is dormant.`)
  }

  for (const rel of UNWIRED_PACKET_FILES) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      errors.push(`missing unwired packet file: ${rel}`)
      continue
    }
    const source = fs.readFileSync(abs, 'utf8')
    if (!/unwired/i.test(source) || !/not in production path/i.test(source)) {
      errors.push(`${rel} must contain P5c/C22 markers "unwired" and "not in production path".`)
    }
  }

  for (const rel of UNWIRED_MAINTENANCE_FILES) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      errors.push(`missing unwired maintenance/emergence file: ${rel}`)
      continue
    }
    const source = fs.readFileSync(abs, 'utf8')
    if (!/unwired/i.test(source) || !/not in production driver path/i.test(source)) {
      errors.push(`${rel} must contain P5d/C26 markers "unwired" and "not in production driver path".`)
    }
  }

  const packetFieldsAbs = path.join(root, LIVE_PACKET_FIELDS_REL)
  if (fs.existsSync(packetFieldsAbs)) {
    const packetFields = fs.readFileSync(packetFieldsAbs, 'utf8')
    if (/unwired/i.test(packetFields) && /not in production path/i.test(packetFields)) {
      errors.push(`${LIVE_PACKET_FIELDS_REL} is live validation code and must not carry unwired/not-in-production markers.`)
    }
  }

  const casMergeAbs = path.join(root, LIVE_CAS_MERGE_REL)
  if (fs.existsSync(casMergeAbs)) {
    const casMerge = fs.readFileSync(casMergeAbs, 'utf8')
    if (/unwired/i.test(casMerge) && /not in production (?:driver )?path/i.test(casMerge)) {
      errors.push(`${LIVE_CAS_MERGE_REL} is live CAS merge code and must not carry unwired/not-in-production markers.`)
    }
  }

  // D7 gate-flip (2026-07-05): runMaintenanceLlmRound is live — driven from the
  // crystallize tick via maintenance-llm-driver. The file must no longer carry
  // dormant markers; wiring/fired evidence moved to check-mandated-capability-is-live.
  const mixedMaintenanceAbs = path.join(root, MIXED_MAINTENANCE_ROUND_REL)
  if (fs.existsSync(mixedMaintenanceAbs)) {
    const mixedMaintenance = fs.readFileSync(mixedMaintenanceAbs, 'utf8')
    if (/P5d\/C26 unwired/i.test(mixedMaintenance)
      || /not in production driver path/i.test(mixedMaintenance)) {
      errors.push(`${MIXED_MAINTENANCE_ROUND_REL} is live (D7 wired via maintenance-llm-driver); it must not carry P5d/C26 unwired markers.`)
    }
  }

  const docRules = [
    { rel: P5D_DOC_REL, label: 'P5d', phrase: '维护回合 / 涌现候选未启用' },
  ]
  for (const rule of docRules) {
    const docAbs = path.join(root, rule.rel)
    if (!fs.existsSync(docAbs)) {
      errors.push(`missing ${rule.label} enforce doc: ${rule.rel}`)
      continue
    }
    const doc = fs.readFileSync(docAbs, 'utf8')
    if (!doc.includes(rule.phrase)) {
      errors.push(`${rule.rel} must explicitly state "${rule.phrase}".`)
    }
  }

  const runtimeAbs = path.join(root, RUNTIME_REL)
  if (fs.existsSync(runtimeAbs) && !read(root, RUNTIME_REL).includes('runUserPictureCasMerge')) {
    errors.push(`${RUNTIME_REL} must keep the live runUserPictureCasMerge CAS wiring visible.`)
  }
  const ipcHandlerAbs = path.join(root, IPC_HANDLER_REL)
  if (fs.existsSync(ipcHandlerAbs) && !read(root, IPC_HANDLER_REL).includes('getLastMaintenanceRoundStatus')) {
    errors.push(`${IPC_HANDLER_REL} must keep the consumed getLastMaintenanceRoundStatus surface wired.`)
  }
  const beliefCardGroupAbs = path.join(root, BELIEF_CARD_GROUP_REL)
  if (fs.existsSync(beliefCardGroupAbs) && !read(root, BELIEF_CARD_GROUP_REL).includes('llmRound')) {
    errors.push(`${BELIEF_CARD_GROUP_REL} must keep the maintenance llmRound status in the settings payload.`)
  }
  const beliefPanelAbs = path.join(root, BELIEF_PANEL_REL)
  if (!fs.existsSync(beliefPanelAbs)) {
    errors.push(`missing belief-card maintenance status panel: ${BELIEF_PANEL_REL}`)
  } else {
    const panel = fs.readFileSync(beliefPanelAbs, 'utf8')
    if (!panel.includes('未接入驱动')) {
      errors.push(`${BELIEF_PANEL_REL} must describe null llmRound as "未接入驱动", not a silent missing record.`)
    }
  }

  const srcMain = path.join(root, 'src/main')
  for (const abs of walk(srcMain)) {
    const fromRel = normalizeRel(path.relative(root, abs))
    if (isTestRel(fromRel)) continue
    const source = fs.readFileSync(abs, 'utf8')
    for (const specifier of extractSpecifiers(source)) {
      const targets = candidateRelativeTargets(root, abs, specifier)
      const targetRel = targets.find((candidate) => unwiredSet.has(candidate))
      if (!targetRel) continue
      if (fromRel === targetRel) continue
      if (isAllowedIntraCluster(fromRel, targetRel)) continue
      errors.push(`${fromRel} must not import unwired module ${targetRel}.`)
    }
    // D7 gate-flip：符号禁令从「全仓不得引用（dormant）」翻为「生产驱动唯一
    // 经 maintenance-llm-driver（预算闸所在）」——旁路直调仍然违规。
    // （runMaintenanceLlmRoundTick 因 \b 边界不命中本正则，runtime 捎带合法。）
    if (
      fromRel !== MIXED_MAINTENANCE_ROUND_REL
      && fromRel !== MAINTENANCE_LLM_DRIVER_REL
      && /\brunMaintenanceLlmRound\b/.test(source)
    ) {
      errors.push(`${fromRel} must not call runMaintenanceLlmRound directly; production drive goes through maintenance-llm-driver (D7 budget gates).`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-unwired-capability-markers] failed')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('[check-unwired-capability-markers] ok')
}

module.exports = {
  check,
  UNWIRED_PACKET_FILES,
  UNWIRED_MAINTENANCE_FILES,
  LIVE_PACKET_FIELDS_REL,
  LIVE_CAS_MERGE_REL,
  MIXED_MAINTENANCE_ROUND_REL,
  INTRA_CLUSTER_ALLOW,
  DOC_REL,
  P5C_DOC_REL,
  P5D_DOC_REL,
}
