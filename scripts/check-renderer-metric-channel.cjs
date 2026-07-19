#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const REQUIRED_METRICS = [
  'renderer_send_persistence_failed',
  'renderer_attachment_input_failed',
  'renderer_friendly_error_surfaced',
  'renderer_send_success_without_canonical_terminal',
  'renderer_steering_send_failed',
]

function checkRendererMetricChannel(options = {}) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const errors = []
  const read = (file) => {
    const path = resolve(root, file)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  const shared = read('src/shared/renderer-agent-metrics.ts')
  // Stage V V2.1j moved the `agent:emitRendererMetric` IPC handler out of
  // claude-bridge/ipc-handler.ts into the dedicated telemetry-group
  // sub-module. The gate now scans both locations so a future merge or
  // further extraction won't silently re-break this check.
  const main = [
    read('src/main/modules/claude-bridge/ipc-handler.ts'),
    read('src/main/modules/claude-bridge/ipc/telemetry-group.ts'),
  ].join('\n')
  const preload = read('src/preload/index.ts')
  const types = read('src/renderer/types/electron.d.ts')
  const rendererFiles = [
    read('src/renderer/stores/useAgent.ts'),
    read('src/renderer/modules/agent/runtimeDriver.ts'),
    read('src/renderer/modules/agent/rendererMetrics.ts'),
  ].join('\n')

  if (!/RENDERER_AGENT_METRICS/.test(shared)) {
    errors.push('shared renderer metric allowlist is missing')
  }
  if (!/ipcMain\.handle\(['"]agent:emitRendererMetric['"]/.test(main)) {
    errors.push('agent:emitRendererMetric IPC handler is missing')
  }
  if (!/emitRendererMetric:\s*\(/.test(preload) || !/agent:emitRendererMetric/.test(preload)) {
    errors.push('preload emitRendererMetric exposure is missing')
  }
  if (!/emitRendererMetric:\s*\(/.test(types)) {
    errors.push('renderer electron.d.ts emitRendererMetric type is missing')
  }
  for (const metric of REQUIRED_METRICS) {
    if (!shared.includes(metric)) errors.push(`metric "${metric}" missing from allowlist`)
    if (!rendererFiles.includes(metric)) errors.push(`metric "${metric}" has no renderer dogfood emit`)
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const result = checkRendererMetricChannel()
  if (!result.ok) {
    console.error('renderer metric channel check failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('renderer metric channel: ok')
}

if (require.main === module) main()

module.exports = { checkRendererMetricChannel }
