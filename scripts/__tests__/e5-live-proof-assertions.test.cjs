const assert = require('node:assert/strict')
const test = require('node:test')

const {
  assertManualGatewayCaptureTurnIdentities,
  parseMacProcessRows,
} = require('../codex-runtime/e5-live-proof-assertions.cjs')

test('manual gateway fixture binds real turnId fields to all product and compaction turns', () => {
  const productTurns = [1, 2, 3].map((index) => ({
    readyRunId: `run-${index}`,
    codexTurnId: `turn-${index}`,
  }))
  const gatewayCapture = [
    { requestKind: 'product', readyRunId: 'run-1', turnId: 'turn-1' },
    { requestKind: 'manual_compaction', readyRunId: null, turnId: 'compact-turn' },
    { requestKind: 'product', readyRunId: 'run-2', turnId: 'turn-2' },
    { requestKind: 'product', readyRunId: 'run-3', turnId: 'turn-3' },
  ]

  assert.doesNotThrow(() => assertManualGatewayCaptureTurnIdentities({
    gatewayCapture,
    productTurns,
    manualCompactionTurnId: 'compact-turn',
  }))
  assert.throws(() => assertManualGatewayCaptureTurnIdentities({
    gatewayCapture: gatewayCapture.map(({ turnId: _turnId, ...entry }) => ({
      ...entry,
      codexTurnId: 'wrong-field',
    })),
    productTurns,
    manualCompactionTurnId: 'compact-turn',
  }), /turn identity mismatch/)
})

test('process evidence keeps a PATH-launched runner alongside absolute app and sidecar executables', () => {
  const rows = parseMacProcessRows([
    ' 101 1 101 Sat Aug  8 12:12:01 2026 node scripts/run-codex-runtime-e5-live-proof.mjs',
    ' 202 101 202 Sat Aug  8 12:12:02 2026 /Applications/Electron.app/Contents/MacOS/Electron .',
    ' 303 202 303 Sat Aug  8 12:12:03 2026 /tmp/codex app-server READY_CODEX_PROCESS_LEASE_ID=lease-1',
  ].join('\n'))
  assert.deepEqual(rows.map((row) => ({ pid: row.pid, executablePath: row.executablePath })), [
    { pid: 101, executablePath: 'node' },
    { pid: 202, executablePath: '/Applications/Electron.app/Contents/MacOS/Electron' },
    { pid: 303, executablePath: '/tmp/codex' },
  ])
})
