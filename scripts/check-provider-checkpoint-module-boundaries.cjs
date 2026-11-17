#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const limits = new Map([
  ['src/main/modules/repositories/agent-session-checkpoint-resume.ts', 250],
  ['src/main/modules/repositories/agent-session-checkpoint-takeover.ts', 750],
  ['src/main/modules/repositories/agent-session-checkpoint-confirmation-lifecycle.ts', 300],
  ['src/main/modules/repositories/agent-session-checkpoint-owner-recovery.ts', 350],
  ['src/main/modules/repositories/agent-session-checkpoint-typed-resume.ts', 600],
  ['src/main/modules/repositories/agent-session-checkpoint-canonical-notice.ts', 250],
  ['src/main/modules/agent-control/runtime-core/run-finalizer.ts', 500],
  ['src/main/modules/agent-control/runtime-core/run-finalizer-contracts.ts', 260],
  ['src/main/modules/agent-control/runtime-core/run-finalizer-projection.ts', 260],
  ['src/main/modules/agent-control/runtime-core/run-finalizer-task-facts.ts', 420],
  ['src/main/modules/agent-control/runtime-core/run-finalizer-adjudication.ts', 500],
  ['src/main/modules/agent-control/runtime-core/run-finalizer-persistence.ts', 500],
  ['src/main/modules/browser-engine/ipc-handler.ts', 250],
  ['src/main/modules/browser-engine/browser-controller.ts', 900],
  ['src/main/modules/browser-engine/browser-controller-contract-base.ts', 1000],
  ['src/main/modules/browser-engine/browser-controller-composition.ts', 650],
  ['src/main/modules/browser-engine/browser-human-takeover-runtime.ts', 400],
  ['src/main/modules/browser-engine/browser-controller-tab-runtime.ts', 750],
  ['src/main/modules/browser-engine/browser-controller-host-runtime.ts', 650],
  ['src/main/modules/browser-engine/browser-controller-automation-runtime.ts', 750],
  ['src/main/modules/browser-engine/browser-controller-capture-runtime.ts', 750],
  ['src/main/modules/browser-engine/browser-controller-interaction-runtime.ts', 650],
  ['src/main/modules/browser-engine/browser-live-proof-runtime.ts', 300],
  ['src/main/modules/agent-control/runtime-core/runtime.ts', 2658],
  ['src/renderer/modules/agent/runtimeDriver.ts', 800],
  ['src/renderer/modules/agent/runtime-driver-session-state.ts', 320],
  ['src/renderer/modules/agent/runtime-driver-watchdog.ts', 400],
  ['src/renderer/modules/agent/runtime-driver-canonical-terminal.ts', 500],
  ['src/renderer/modules/agent/runtime-driver-stream-events.ts', 700],
  ['src/renderer/modules/agent/runtime-driver-scope-events.ts', 700],
  ['src/renderer/modules/agent/agentPanelTestHarness.ts', 180],
  ['src/renderer/modules/agent/agent-panel-test-harness-types.ts', 320],
  ['src/renderer/modules/agent/agent-panel-test-harness-snapshot.ts', 600],
  ['src/renderer/modules/agent/agent-panel-test-harness-diagnostics.ts', 300],
  ['src/renderer/modules/agent/agent-panel-test-harness-driver.ts', 700],
])

const checkpointLeaves = [
  'agent-session-checkpoint-takeover.ts',
  'agent-session-checkpoint-confirmation-lifecycle.ts',
  'agent-session-checkpoint-owner-recovery.ts',
  'agent-session-checkpoint-typed-resume.ts',
  'agent-session-checkpoint-canonical-notice.ts',
].map((name) => `src/main/modules/repositories/${name}`)

const finalizerLeaves = [
  'run-finalizer-contracts.ts',
  'run-finalizer-projection.ts',
  'run-finalizer-task-facts.ts',
  'run-finalizer-adjudication.ts',
  'run-finalizer-persistence.ts',
].map((name) => `src/main/modules/agent-control/runtime-core/${name}`)

const splitTests = [
  'agent-session-checkpoint-store-native.test.ts',
  'agent-session-checkpoint-owner-recovery-native.test.ts',
  'run-finalizer-task-facts.test.ts',
  'run-finalizer-adjudication.test.ts',
  'run-finalizer-canonical-checkpoint.test.ts',
  'runtime-driver-canonical-terminal.test.ts',
  'runtime-driver-checkpoint-unlock.test.ts',
].map((name) => `src/__tests__/${name}`)

function read(rel, errors) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    errors.push(`${rel}: missing`)
    return ''
  }
  return fs.readFileSync(abs, 'utf8')
}

function lineCount(text) {
  return text ? text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) : 0
}

function main() {
  const errors = []
  for (const [rel, limit] of limits) {
    const count = lineCount(read(rel, errors))
    if (count > limit) errors.push(`${rel}: ${count} lines exceeds ${limit}`)
    if (count > 1000 && limit <= 1000) errors.push(`${rel}: exceeds absolute 1000-line limit`)
  }

  for (const rel of splitTests) {
    const count = lineCount(read(rel, errors))
    if (count > 900) errors.push(`${rel}: ${count} lines exceeds 900`)
  }

  for (const rel of checkpointLeaves) {
    const source = read(rel, errors)
    if (/from ['"]\.\/agent-session-checkpoint-(?:repository|resume)['"]/.test(source)) {
      errors.push(`${rel}: checkpoint leaf must not import the repository facade`)
    }
  }
  for (const rel of finalizerLeaves) {
    const source = read(rel, errors)
    if (/from ['"]\.\/run-finalizer['"]/.test(source)) {
      errors.push(`${rel}: finalizer leaf must not import the finalizer facade`)
    }
  }

  for (const rel of [
    'src/renderer/modules/agent/runtime-driver-session-state.ts',
    'src/renderer/modules/agent/runtime-driver-watchdog.ts',
    'src/renderer/modules/agent/runtime-driver-canonical-terminal.ts',
    'src/renderer/modules/agent/runtime-driver-stream-events.ts',
    'src/renderer/modules/agent/runtime-driver-scope-events.ts',
  ]) {
    const source = read(rel, errors)
    if (/from ['"]\.\/runtimeDriver['"]/.test(source)) {
      errors.push(`${rel}: renderer leaf must not import the runtimeDriver facade`)
    }
  }

  const browserIpcFacade = read('src/main/modules/browser-engine/ipc-handler.ts', errors)
  if (/class BrowserController|attachAgentTabSupervision|openBackgroundPage\(/.test(browserIpcFacade)) {
    errors.push('src/main/modules/browser-engine/ipc-handler.ts: facade reabsorbed BrowserController business logic')
  }
  const runtimeFacade = read('src/main/modules/agent-control/runtime-core/runtime.ts', errors)
  if (/agentSessionCheckpoints\.resumeSuspendedBrowserWorkflow|agentSessionCheckpoints\.completeHumanTakeover/.test(runtimeFacade)) {
    errors.push('src/main/modules/agent-control/runtime-core/runtime.ts: Browser continuation transaction reabsorbed by host')
  }

  for (const retired of [
    'src/__tests__/agent-session-checkpoint-native.test.ts',
    'src/__tests__/run-finalizer-checkin.test.ts',
    'src/__tests__/runtime-driver-terminal-unlock.test.ts',
  ]) {
    if (fs.existsSync(path.join(ROOT, retired))) errors.push(`${retired}: retired aggregate test still exists`)
  }

  const providerRunner = read('scripts/run-provider-checkpoint-native-tests.cjs', errors)
  const targetRunner = read('scripts/run-browser-grounded-orchestration-native-tests.cjs', errors)
  const providerTests = new Set([...providerRunner.matchAll(/src\/__tests__\/[\w-]+\.test\.ts/g)].map((match) => match[0]))
  const targetTests = new Set([...targetRunner.matchAll(/src\/__tests__\/[\w-]+\.test\.ts/g)].map((match) => match[0]))
  for (const testPath of providerTests) {
    if (targetTests.has(testPath)) errors.push(`${testPath}: owned by both native runners`)
  }

  if (errors.length > 0) {
    console.error('[check-provider-checkpoint-module-boundaries] FAIL')
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-provider-checkpoint-module-boundaries] OK')
}

main()
