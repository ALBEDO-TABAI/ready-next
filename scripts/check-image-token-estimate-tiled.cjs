#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const context = fs.readFileSync(path.join(root, 'src/shared/context-budget-types.ts'), 'utf8')
const provider = fs.readFileSync(path.join(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-provider-runner.ts'), 'utf8')
const instrumentation = fs.readFileSync(path.join(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-provider-request-instrumentation.ts'), 'utf8')
const violations = []

if (!/export const IMAGE_EST_TOKENS\s*=\s*1_600/.test(context)) violations.push('image estimate is not the shared 1600-token tile constant')
if (/OPAQUE_IMAGE_REF_TOKENS|85_000/.test(context)) violations.push('legacy 85K opaque-image estimate remains live')
if (!/type === 'input_image' \|\| type === 'computer_screenshot'/.test(context)) violations.push('typed image and screenshot items do not use the tile estimate')
if (!/emitProviderEstimateReconciliation\s*\(/.test(provider) || !/provider_estimate_reconciliation/.test(instrumentation)) {
  violations.push('provider estimate reconciliation metric is not emitted through the instrumentation leaf')
}

const probe = spawnSync(process.execPath, [require.resolve('tsx/cli'), '--eval', `
  import {
    IMAGE_EST_TOKENS,
    estimateImageDataTokens,
    estimateInputItemTokens,
  } from './src/shared/context-budget-types.ts'

  const smallUrl = \`data:image/png;base64,\${'A'.repeat(1_000)}\`
  const largeUrl = \`data:image/png;base64,\${'A'.repeat(500_000)}\`
  const threeLargeImages = Array.from({ length: 3 }, () => ({
    role: 'user',
    content: [{ type: 'input_image', image: largeUrl }],
  }))
  process.stdout.write(JSON.stringify({
    tileFloor: IMAGE_EST_TOKENS,
    small: estimateInputItemTokens([{ type: 'input_image', image: smallUrl }]),
    large: estimateInputItemTokens([{ type: 'input_image', image: largeUrl }]),
    expectedLarge: estimateImageDataTokens(largeUrl.length),
    opaque: estimateInputItemTokens([{ type: 'input_image', image: { id: 'image-1' } }]),
    screenshot: estimateInputItemTokens([{ type: 'computer_screenshot', data: largeUrl }]),
    threeLarge: estimateInputItemTokens(threeLargeImages),
  }))
`], {
  cwd: root,
  encoding: 'utf8',
})

if (probe.status !== 0) {
  violations.push(`production image estimate probe failed: ${String(probe.stderr || probe.stdout).trim()}`)
} else {
  try {
    const result = JSON.parse(probe.stdout)
    if (result.tileFloor !== 1_600 || result.small !== result.tileFloor) {
      violations.push('small data URLs do not preserve the shared 1600-token floor')
    }
    if (result.large !== result.expectedLarge || result.large <= result.tileFloor) {
      violations.push('large data URLs do not use the text-protocol payload estimate')
    }
    if (result.opaque !== result.tileFloor) {
      violations.push('opaque image references do not use the shared tile floor')
    }
    if (result.screenshot !== result.expectedLarge) {
      violations.push('computer screenshots do not use the text-protocol payload estimate')
    }
    if (result.threeLarge < 200_000 * 0.8) {
      violations.push('three large data URLs no longer trigger the 200K context safety threshold')
    }
  } catch (error) {
    violations.push(`production image estimate probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (violations.length > 0) {
  console.error(violations.map((item) => `- ${item}`).join('\n'))
  process.exit(1)
}
console.log('image token estimate contract: OK')
