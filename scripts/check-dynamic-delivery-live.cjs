#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

const requirements = [
  ['src/main/modules/agent-control/runtime-core/agent-sdk-turn-execution.ts', /prepareOwnerInput\s*\(/, 'pre-owner seam'],
  ['src/main/modules/agent-control/runtime-core/agent-sdk-turn-completion.ts', /verifyOwnerCandidate\s*\(/, 'post-owner seam'],
  ['src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', /new DynamicDeliveryCoordinator\s*\(/, 'composition owner'],
  ['src/main/modules/agent-control/runtime-core/runtime.ts', /reconcileInterruptedDeliveryState\s*\(/, 'startup reconciliation'],
  ['src/main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-coordinator.ts', /tools:\s*\[\]/, 'no-tools worker calls'],
  ['src/main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-coordinator.ts', /dynamic_delivery_fired/, 'fired metric'],
  ['src/main/modules/agent-control/runtime-core/run-finalizer.ts', /delivery_verifier_unsettled/, 'finalizer guard'],
  ['src/main/modules/repositories/task-projection-repository.ts', /createDeliveryTreeAtomic\s*\(/, 'atomic task tree'],
  ['src/main/modules/repositories/task-projection-repository.ts', /reduceDeliveryState\s*\(/, 'CAS reducer'],
  ['src/main/modules/agent-control/runtime-core/dynamic-delivery/candidate-session-fork.ts', /class CandidateSessionTransaction/, 'candidate fork'],
  ['src/main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-coordinator.ts', /dispatchDynamicDeliveryPackage\s*\(/, 'closed packet dispatch production caller'],
  ['src/main/modules/agent-control/quality/packet-failure.ts', /settleDeliveryFailure/, 'settlement-only failure boundary'],
  ['src/main/modules/agent-control/runtime-core/agent-sdk-turn-execution.ts', /deliveryMode\s*\?\?\s*'adaptive'/, 'adaptive runtime default'],
]

const errors = []
for (const [rel, pattern, label] of requirements) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs) || !pattern.test(fs.readFileSync(abs, 'utf8'))) errors.push(`${label}: ${rel}`)
}

const forbidden = [
  ['src/main/modules/agent-control/runtime-core/dynamic-delivery', /QuickJS|javascript executor|background lane/i, 'forbidden execution lane'],
  ['src/main/modules/agent-control/quality', /export type PacketChannel = 'chat_turn'|buildParentPacketAdjudication/, 'retired packet channel or parent adjudication'],
]
for (const [rel, pattern, label] of forbidden) {
  const abs = path.join(root, rel)
  const files = fs.readdirSync(abs).filter((name) => name.endsWith('.ts'))
  if (files.some((name) => pattern.test(fs.readFileSync(path.join(abs, name), 'utf8')))) errors.push(`${label}: ${rel}`)
}

if (errors.length) {
  console.error(`[check-dynamic-delivery-live] failed\n${errors.map((item) => `- ${item}`).join('\n')}`)
  process.exit(1)
}
console.log('[check-dynamic-delivery-live] ok')

module.exports = { requirements }
