#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const tests = [
  'src/__tests__/dynamic-delivery-task-facts.test.ts',
  'src/__tests__/dynamic-delivery-preflight.test.ts',
  'src/__tests__/dynamic-delivery-plan.test.ts',
  'src/__tests__/dynamic-delivery-wire.test.ts',
  'src/__tests__/dynamic-delivery-proof.test.ts',
  'src/__tests__/dynamic-delivery-task-store.test.ts',
  'src/__tests__/dynamic-delivery-scheduler.test.ts',
  'src/__tests__/dynamic-delivery-deadline.test.ts',
  'src/__tests__/dynamic-delivery-artifact-readback.test.ts',
  'src/__tests__/dynamic-delivery-reconciliation.test.ts',
  'src/__tests__/dynamic-delivery-worker-isolation.test.ts',
  'src/__tests__/specialist-model-subagent.test.ts',
  'src/__tests__/dynamic-delivery-candidate-session.test.ts',
  'src/__tests__/dynamic-delivery-verifier.test.ts',
  'src/__tests__/dynamic-delivery-verifier-contract.test.ts',
  'src/__tests__/dynamic-delivery-parent-finalizer-guard.test.ts',
  'src/__tests__/dynamic-delivery-run-context.test.ts',
  'src/__tests__/dynamic-delivery-coordinator.test.ts',
  'src/__tests__/dynamic-delivery-live.test.ts',
  'src/__tests__/dynamic-delivery-fixtures.test.ts',
  'src/__tests__/dynamic-delivery-contribution-receipt.test.ts',
  'src/__tests__/agent-task-learning-attribution.test.ts',
  'src/__tests__/dynamic-delivery-mode-ui.test.tsx',
  'src/__tests__/dynamic-delivery-boost-wire.test.ts',
  'src/__tests__/dynamic-delivery-task-card.test.tsx',
  'src/__tests__/dynamic-delivery-task-card.test.ts',
  'src/__tests__/dynamic-delivery-override-reset.test.tsx',
  'src/__tests__/skill-context-orchestrator.test.ts',
  'src/__tests__/use-skill-activation.test.ts',
  'src/__tests__/skill-doc-toolset-floor.test.ts',
  'src/__tests__/run-finalizer-checkin.test.ts',
  'src/__tests__/agent-run-duration-meter.test.ts',
  'src/__tests__/task-card-action-render.test.tsx',
  'src/__tests__/renderer-error-mapping.test.ts',
]

const missing = tests.filter((file) => !fs.existsSync(path.join(root, file)))
if (missing.length) {
  console.error(`Missing Dynamic Delivery tests:\n${missing.join('\n')}`)
  process.exit(1)
}

const result = spawnSync('npx', ['tsx@^4.19.2', '--test', '--test-concurrency=1', ...tests], {
  cwd: root,
  stdio: 'inherit',
})
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

const nativeResult = spawnSync(
  path.join(root, 'node_modules/.bin/electron'),
  [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--test',
    'src/__tests__/dynamic-delivery-live.test.ts',
    'src/__tests__/dynamic-delivery-task-store.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
)
process.exit(nativeResult.status ?? 1)
