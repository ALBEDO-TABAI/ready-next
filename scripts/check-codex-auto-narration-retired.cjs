#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const PRODUCTION_ROOTS = [
  'src/main',
  'src/preload',
  'src/renderer',
  'src/shared',
]

const forbiddenProductionPatterns = [
  /autoNarration/i,
  /narration[_-]?continuation/i,
  /runCapabilityMode/i,
  /NARRATION_(?:VISIBLE_CAPABILITY_GROUP_IDS|ALLOWED_TOOL_NAMES)/,
  /agent\.autoNarrationContinuation/,
  /systemBackground(?:Ingress|Event|Provider|Turn)/i,
  /systemBackgroundEventSegment/i,
  /prepareSystemBackgroundIngress/i,
  /persistSystemBackgroundIngressAtomic/i,
  /startCodexSystemBackground/i,
  /registerAgentNotifier/,
  /background-task-terminal-reminder/,
  /insertPendingTaskEvent/,
  /getOldestPendingTaskEvent/,
  /markPendingTaskEvent(?:Consumed|Failed)/,
  /narration_(?:state|attempt|claim|error|settled)/i,
  /后台任务自动播报/,
]

const systemBackgroundAllowlist = new Set([
  'src/main/modules/agent-control/runtime-core/detached-skill-service.ts',
  'src/main/modules/agent-control/skills/skill-child-runner.ts',
  'src/main/modules/repositories/task-projection-repository.ts',
  'src/shared/agent-execution-profile.ts',
])

const systemBackgroundAllowlistCounts = new Map(
  [...systemBackgroundAllowlist].map((rel) => [rel, 1]),
)

const pendingTaskEventSchemaAllowlist = new Set([
  'src/main/modules/agent-control/codex-runtime/codex-thread-retirement-cleanup-migration.ts',
  'src/main/modules/migrations.ts',
])

const sqlQualifierIdentifier = String.raw`(?:[A-Za-z_]\w*|"[^"]+"|\`[^\`]+\`|\[[^\]]+\])`
const pendingTaskEventIdentifier = String.raw`(?:${sqlQualifierIdentifier}\s*\.\s*)?(?:pending_task_events|"pending_task_events"|\`pending_task_events\`|\[pending_task_events\])`
const pendingTaskEventMutationPattern = new RegExp(
  String.raw`\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+${pendingTaskEventIdentifier}(?=\s|\(|;|$)`,
  'i',
)

const expectedRegisterProjectionSinkIdentifiers = new Map([
  ['src/main/modules/agent-control/runtime-core/task-event-proof-subscription.ts', 1],
  ['src/main/modules/browser-engine/task-event-bridge.ts', 1],
])

const expectedSendScopedIdentifiers = new Map([
  ['src/main/modules/agent-control/runtime-core/runtime.ts', 1],
  ['src/main/modules/claude-bridge/ipc-handler.ts', 2],
  ['src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts', 2],
  ['src/preload/index.ts', 1],
  ['src/renderer/stores/agent-send-orchestration.ts', 2],
  ['src/renderer/types/electron.d.ts', 1],
])

const retiredFiles = [
  'src/main/modules/agent-control/contracts/system-background-contract.ts',
  'src/main/modules/agent-control/runtime-core/narration-continuation-service.ts',
  'src/main/modules/agent-control/system-reminders/background-task-terminal-reminder.ts',
  'src/main/modules/settings-engine/agent-auto-narration-setting.ts',
]

const forbiddenByFile = {
  'src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts': ["'system_background'"],
  'src/main/modules/agent-control/codex-runtime/codex-runtime-composition.ts': [
    'prepareSystemBackgroundIngress',
    'persistSystemBackgroundIngressAtomic',
  ],
  'src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts': [
    'prepareSystemBackgroundIngress',
    'persistSystemBackgroundIngressAtomic',
  ],
  'src/main/modules/agent-control/runtime-core/runtime.ts': [
    'NarrationContinuationService',
    'startCodexSystemBackground',
  ],
  'src/main/modules/browser-engine/task-event-bridge.ts': ['registerAgentNotifier'],
  'src/main/modules/settings-engine/ipc-handler.ts': ['AgentAutoNarrationContinuation'],
  'src/preload/index.ts': ['AgentAutoNarrationContinuation'],
  'src/renderer/types/electron.d.ts': ['AgentAutoNarrationContinuation'],
}

function check(root = ROOT) {
  const errors = []
  const bridgeImporters = []
  const retirementMigrationImporters = []
  const projectionSinkCallsites = []
  const sendScopedCallsites = []
  const registerProjectionSinkIdentifiers = new Map()
  const sendScopedIdentifiers = new Map()
  for (const rel of retiredFiles) {
    if (fs.existsSync(path.join(root, rel))) errors.push(`retired file exists: ${rel}`)
  }
  for (const [rel, tokens] of Object.entries(forbiddenByFile)) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      errors.push(`required production file missing: ${rel}`)
      continue
    }
    const source = fs.readFileSync(abs, 'utf8')
    for (const token of tokens) {
      if (source.includes(token)) errors.push(`${rel} contains retired token: ${token}`)
    }
  }
  for (const productionRoot of PRODUCTION_ROOTS) {
    const absRoot = path.join(root, productionRoot)
    for (const abs of walk(absRoot)) {
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const source = fs.readFileSync(abs, 'utf8')
      if (/from\s+['"][^'"]*task-event-bridge['"]/.test(source)) bridgeImporters.push(rel)
      if (/from\s+['"][^'"]*codex-thread-retirement-cleanup-migration['"]/.test(source)) {
        retirementMigrationImporters.push(rel)
      }
      if (/\b(?:registerProjectionSink|sendScoped)\b/.test(source)) {
        const parsed = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
        const references = new Map()
        const calls = new Set()
        const visit = (node) => {
          if ((ts.isIdentifier(node) || ts.isStringLiteral(node))
            && ['registerProjectionSink', 'sendScoped'].includes(node.text)) {
            references.set(node.text, (references.get(node.text) || 0) + 1)
          }
          if (ts.isCallExpression(node)) {
            const access = node.expression
            const name = ts.isPropertyAccessExpression(access) ? access.name.text
              : ts.isElementAccessExpression(access) && ts.isStringLiteral(access.argumentExpression)
                ? access.argumentExpression.text : null
            if (name) calls.add(name)
          }
          ts.forEachChild(node, visit)
        }
        visit(parsed)
        if (calls.has('registerProjectionSink')) projectionSinkCallsites.push(rel)
        if (calls.has('sendScoped')) sendScopedCallsites.push(rel)
        if (references.has('registerProjectionSink')) registerProjectionSinkIdentifiers.set(rel, references.get('registerProjectionSink'))
        if (references.has('sendScoped')) sendScopedIdentifiers.set(rel, references.get('sendScoped'))
      }
      for (const pattern of forbiddenProductionPatterns) {
        if (pattern.test(source)) errors.push(`${rel} contains retired production contract: ${pattern}`)
      }
      if (/system_background/i.test(source) && !systemBackgroundAllowlist.has(rel)) {
        errors.push(`${rel} contains non-allowlisted system_background production path`)
      }
      if (systemBackgroundAllowlist.has(rel)) {
        const count = source.match(/system_background/gi)?.length || 0
        if (count !== systemBackgroundAllowlistCounts.get(rel)) {
          errors.push(`${rel} contains ${count} system_background occurrences; expected exactly 1`)
        }
        if (/\b(?:kind|attemptKind)\s*:\s*['"]system_background['"]/i.test(source)) {
          errors.push(`${rel} contains retired Codex system_background ingress shape`)
        }
      }
      if (/pending_task_events/i.test(source)) {
        if (!pendingTaskEventSchemaAllowlist.has(rel)) {
          errors.push(`${rel} contains non-allowlisted pending_task_events production path`)
        }
        if (pendingTaskEventMutationPattern.test(source)) {
          errors.push(`${rel} mutates retired pending_task_events production data`)
        }
      }
    }
  }
  const expectedBridgeImporters = [
    'src/main/modules/agent-control/runtime-core/task-event-proof-subscription.ts',
    'src/main/modules/browser-engine/task-persistence-service.ts',
  ]
  if (bridgeImporters.sort().join('|') !== expectedBridgeImporters.sort().join('|')) {
    errors.push(`task-event-bridge production importers changed: ${bridgeImporters.sort().join(', ')}`)
  }
  const expectedRetirementMigrationImporters = ['src/main/modules/migrations.ts']
  if (retirementMigrationImporters.sort().join('|') !== expectedRetirementMigrationImporters.join('|')) {
    errors.push(`Codex retirement migration production importers changed: ${retirementMigrationImporters.sort().join(', ')}`)
  }
  if (
    projectionSinkCallsites.length !== 1
    || projectionSinkCallsites[0] !== 'src/main/modules/agent-control/runtime-core/task-event-proof-subscription.ts'
  ) {
    errors.push(`registerProjectionSink production callsites changed: ${projectionSinkCallsites.join(', ')}`)
  }
  const serializeCounts = (counts) => [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rel, count]) => `${rel}:${count}`)
    .join('|')
  if (serializeCounts(registerProjectionSinkIdentifiers) !== serializeCounts(expectedRegisterProjectionSinkIdentifiers)) {
    errors.push(`registerProjectionSink production references changed: ${serializeCounts(registerProjectionSinkIdentifiers)}`)
  }
  const proofSubscription = path.join(
    root,
    'src/main/modules/agent-control/runtime-core/task-event-proof-subscription.ts',
  )
  if (fs.existsSync(proofSubscription)) {
    const source = fs.readFileSync(proofSubscription, 'utf8')
    if (!/registerProjectionSink\(\s*createTaskEventProofListener\(createTaskProofSink\(store\)\)\s*,?\s*\)/s.test(source)) {
      errors.push('task event projection sink is not the exact proof-only listener')
    }
  }
  const expectedSendScopedCallsites = [
    'src/main/modules/claude-bridge/ipc-handler.ts',
    'src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts',
    'src/renderer/stores/agent-send-orchestration.ts',
  ]
  if (sendScopedCallsites.sort().join('|') !== expectedSendScopedCallsites.sort().join('|')) {
    errors.push(`sendScoped production callsites changed: ${sendScopedCallsites.sort().join(', ')}`)
  }
  if (serializeCounts(sendScopedIdentifiers) !== serializeCounts(expectedSendScopedIdentifiers)) {
    errors.push(`sendScoped production references changed: ${serializeCounts(sendScopedIdentifiers)}`)
  }
  return errors
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (/\.(?:ts|tsx|js|cjs|mjs)$/.test(entry.name)) out.push(abs)
  }
  return out
}

if (require.main === module) {
  const errors = check()
  if (errors.length > 0) {
    console.error('[check-codex-auto-narration-retired] FAIL')
    for (const error of errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('[check-codex-auto-narration-retired] OK')
}

module.exports = {
  check,
  expectedRegisterProjectionSinkIdentifiers,
  expectedSendScopedIdentifiers,
  forbiddenByFile,
  forbiddenProductionPatterns,
  pendingTaskEventSchemaAllowlist,
  pendingTaskEventMutationPattern,
  retiredFiles,
  systemBackgroundAllowlist,
  systemBackgroundAllowlistCounts,
}
