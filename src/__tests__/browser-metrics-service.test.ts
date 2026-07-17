import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserMetricsService } from '../main/modules/browser-engine/browser-metrics-service'

test('browser metrics group shared renderer processes without double-counting memory', () => {
  let sampleCalls = 0
  const service = new BrowserMetricsService({
    getAppMetrics: () => {
      sampleCalls += 1
      return [{
        pid: 42,
        type: 'Tab',
        cpu: { percentCPUUsage: 3.5, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 12_345, peakWorkingSetSize: 13_000, privateBytes: 10_000 },
        creationTime: 99,
      }]
    },
    getTabs: () => [
      { id: 'a', domain: 'a.example', view: { webContents: { getOSProcessId: () => 42 } } },
      { id: 'b', domain: 'b.example', view: { webContents: { getOSProcessId: () => 42 } } },
    ],
    getLoadState: (tabId) => tabId === 'a' ? 'visible' : 'throttled',
  })

  assert.equal(sampleCalls, 0)
  assert.deepEqual(service.sample(), [{
    pid: 42,
    tabIds: ['a', 'b'],
    domains: ['a.example', 'b.example'],
    loadStates: ['visible', 'throttled'],
    cpuPercent: 3.5,
    memoryKB: 12_345,
    processType: 'Tab',
    creationTime: 99,
  }])
  assert.equal(sampleCalls, 1)
})
