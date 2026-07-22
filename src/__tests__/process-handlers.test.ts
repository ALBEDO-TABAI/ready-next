import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { PROCESS_METRICS } from '../main/utils/process-metrics'
import { registerMainProcessHandlers } from '../main/process-handlers'

type ProcessEvent = 'unhandledRejection' | 'uncaughtException'
type AppEvent = 'render-process-gone' | 'child-process-gone'

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createHarness() {
  const processTarget = new EventEmitter()
  const appTarget = new EventEmitter()
  const exits: number[] = []
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const records: unknown[] = []
  const warnings: unknown[][] = []

  registerMainProcessHandlers({
    app: {
      on: (event: AppEvent, listener: (...args: unknown[]) => void) => {
        appTarget.on(event, listener)
        return appTarget as never
      },
      exit: (code?: number) => {
        exits.push(code ?? 0)
      },
    },
    processTarget: {
      on: (event: ProcessEvent, listener: (...args: unknown[]) => void) => {
        processTarget.on(event, listener)
        return processTarget as never
      },
    },
    cleanup: () => undefined,
    emitMetric: (name, payload) => {
      metrics.push({ name, payload })
    },
    recordEvent: (event) => {
      records.push(event)
    },
    logger: {
      warn: (...args: unknown[]) => warnings.push(args),
      error: (...args: unknown[]) => warnings.push(args),
    },
    timeoutMs: 10,
  })

  return { processTarget, appTarget, exits, metrics, records, warnings }
}

test('fatal process handlers run bounded cleanup and exit once', async () => {
  const processTarget = new EventEmitter()
  const appTarget = new EventEmitter()
  const exits: number[] = []
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const records: unknown[] = []
  let cleanupCalls = 0

  registerMainProcessHandlers({
    app: {
      on: (event: AppEvent, listener: (...args: unknown[]) => void) => {
        appTarget.on(event, listener)
        return appTarget as never
      },
      exit: (code?: number) => {
        exits.push(code ?? 0)
      },
    },
    processTarget: {
      on: (event: ProcessEvent, listener: (...args: unknown[]) => void) => {
        processTarget.on(event, listener)
        return processTarget as never
      },
    },
    cleanup: async () => {
      cleanupCalls += 1
    },
    emitMetric: (name, payload) => metrics.push({ name, payload }),
    recordEvent: (event) => records.push(event),
    timeoutMs: 20,
  })

  processTarget.emit('unhandledRejection', new Error('boom'), Promise.resolve())
  processTarget.emit('uncaughtException', new Error('second'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(cleanupCalls, 1)
  assert.deepEqual(exits, [1])
  assert.equal(metrics[0]?.name, PROCESS_METRICS.processUnhandledRejection)
  assert.equal(records.length, 1)
})

test('fatal process cleanup timeout still exits', async () => {
  const processTarget = new EventEmitter()
  const appTarget = new EventEmitter()
  const exits: number[] = []

  registerMainProcessHandlers({
    app: {
      on: (event: AppEvent, listener: (...args: unknown[]) => void) => {
        appTarget.on(event, listener)
        return appTarget as never
      },
      exit: (code?: number) => {
        exits.push(code ?? 0)
      },
    },
    processTarget: {
      on: (event: ProcessEvent, listener: (...args: unknown[]) => void) => {
        processTarget.on(event, listener)
        return processTarget as never
      },
    },
    cleanup: () => new Promise<void>(() => undefined),
    timeoutMs: 5,
  })

  processTarget.emit('uncaughtException', new Error('fatal'))
  await waitFor(() => exits.length > 0)

  assert.deepEqual(exits, [1])
})

test('Electron runtime gone handlers record metrics without forcing exit', () => {
  const { appTarget, exits, metrics, records } = createHarness()

  appTarget.emit('render-process-gone', {}, {}, { reason: 'crashed' })
  appTarget.emit('child-process-gone', {}, { type: 'GPU', reason: 'abnormal-exit' })

  assert.deepEqual(exits, [])
  assert.deepEqual(metrics.map((entry) => entry.name), [
    PROCESS_METRICS.renderProcessGone,
    PROCESS_METRICS.childProcessGone,
  ])
  assert.equal(records.length, 2)
})

test('S0 R7: registering process observability records the Main boot identity', () => {
  const { records } = createHarness()
  assert.equal(
    (records[0] as { kind?: string } | undefined)?.kind,
    'main-process-started',
    'an event-only file with no boot record cannot distinguish silence from a dead logger',
  )
})
