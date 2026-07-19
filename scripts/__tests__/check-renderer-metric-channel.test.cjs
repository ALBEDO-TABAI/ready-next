const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const test = require('node:test')

const { checkRendererMetricChannel } = require('../check-renderer-metric-channel.cjs')

test('passes when main/preload/types and renderer dogfood emit points exist', () => {
  withFixture({
    'src/shared/renderer-agent-metrics.ts': 'export const RENDERER_AGENT_METRICS = ["renderer_send_persistence_failed","renderer_attachment_input_failed","renderer_friendly_error_surfaced","renderer_send_success_without_canonical_terminal","renderer_steering_send_failed"] as const\n',
    'src/main/modules/claude-bridge/ipc-handler.ts': "ipcMain.handle('agent:emitRendererMetric', () => {})\n",
    'src/preload/index.ts': "emitRendererMetric: (name, payload) => ipcRenderer.invoke('agent:emitRendererMetric', { name, payload })\n",
    'src/renderer/types/electron.d.ts': 'emitRendererMetric: (name: RendererAgentMetricName, payload: Record<string, unknown>) => Promise<{ success: boolean }>\n',
    'src/renderer/stores/useAgent.ts': [
      "emitRendererAgentMetric('renderer_send_persistence_failed', {})",
      "emitRendererAgentMetric('renderer_attachment_input_failed', {})",
      "emitRendererAgentMetric('renderer_friendly_error_surfaced', {})",
      "emitRendererAgentMetric('renderer_send_success_without_canonical_terminal', {})",
      "emitRendererAgentMetric('renderer_steering_send_failed', {})",
    ].join('\n'),
  }, (root) => {
    const result = checkRendererMetricChannel({ root })
    assert.equal(result.ok, true, result.errors.join('\n'))
  })
})

test('fails when the main IPC handler is missing', () => {
  withFixture({
    'src/shared/renderer-agent-metrics.ts': 'export const RENDERER_AGENT_METRICS = ["renderer_send_persistence_failed","renderer_attachment_input_failed","renderer_friendly_error_surfaced","renderer_send_success_without_canonical_terminal","renderer_steering_send_failed"] as const\n',
    'src/preload/index.ts': "emitRendererMetric: (name, payload) => ipcRenderer.invoke('agent:emitRendererMetric', { name, payload })\n",
    'src/renderer/types/electron.d.ts': 'emitRendererMetric: (name: RendererAgentMetricName, payload: Record<string, unknown>) => Promise<{ success: boolean }>\n',
    'src/renderer/stores/useAgent.ts': [
      "emitRendererAgentMetric('renderer_send_persistence_failed', {})",
      "emitRendererAgentMetric('renderer_attachment_input_failed', {})",
      "emitRendererAgentMetric('renderer_friendly_error_surfaced', {})",
      "emitRendererAgentMetric('renderer_send_success_without_canonical_terminal', {})",
      "emitRendererAgentMetric('renderer_steering_send_failed', {})",
    ].join('\n'),
  }, (root) => {
    const result = checkRendererMetricChannel({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /agent:emitRendererMetric IPC handler/)
  })
})

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-renderer-metric-'))
  try {
    for (const [file, text] of Object.entries(files)) write(root, file, text)
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function write(root, file, text) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
