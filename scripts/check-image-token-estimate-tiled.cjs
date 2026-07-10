#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const context = fs.readFileSync(path.join(root, 'src/shared/context-budget-types.ts'), 'utf8')
const provider = fs.readFileSync(path.join(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-provider-runner.ts'), 'utf8')
const instrumentation = fs.readFileSync(path.join(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-provider-request-instrumentation.ts'), 'utf8')
const tests = fs.readFileSync(path.join(root, 'src/__tests__/provider-request-bill.test.ts'), 'utf8')
const violations = []

if (!/export const IMAGE_EST_TOKENS\s*=\s*1_600/.test(context)) violations.push('image estimate is not the shared 1600-token tile constant')
if (/OPAQUE_IMAGE_REF_TOKENS|85_000/.test(context)) violations.push('legacy 85K opaque-image estimate remains live')
if (!/type === 'input_image' \|\| type === 'computer_screenshot'/.test(context)) violations.push('typed image and screenshot items do not use the tile estimate')
if (!/emitProviderEstimateReconciliation\s*\(/.test(provider) || !/provider_estimate_reconciliation/.test(instrumentation)) {
  violations.push('provider estimate reconciliation metric is not emitted through the instrumentation leaf')
}
if (!/500_000[\s\S]*IMAGE_EST_TOKENS/.test(tests)) violations.push('large-payload fixed-cost regression test is missing')

if (violations.length > 0) {
  console.error(violations.map((item) => `- ${item}`).join('\n'))
  process.exit(1)
}
console.log('image token estimate contract: OK')
