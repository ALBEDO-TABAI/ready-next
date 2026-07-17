import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DocumentWorkerBridge,
  type DocumentWorkerLike,
} from '../main/modules/document-engine/document-worker-bridge'
import type { DocumentWorkerRequest } from '../main/modules/document-engine/document-worker-protocol'

class FakeDocumentWorker implements DocumentWorkerLike {
  readonly messages: DocumentWorkerRequest[] = []
  terminateCount = 0
  private readonly listeners = {
    message: [] as Array<(message: unknown) => void>,
    error: [] as Array<(error: Error) => void>,
    exit: [] as Array<(code: number) => void>,
  }

  postMessage(value: unknown): void {
    const message = value as DocumentWorkerRequest
    this.messages.push(message)
    if (message.cmd === 'shutdown') queueMicrotask(() => this.emitExit(0))
  }

  on(event: 'message' | 'error' | 'exit', listener: ((value: never) => void)): void {
    ;(this.listeners[event] as Array<(value: never) => void>).push(listener)
  }

  terminate(): void {
    this.terminateCount += 1
    this.emitExit(0)
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.message) listener(message)
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.error) listener(error)
  }

  emitExit(code: number): void {
    for (const listener of this.listeners.exit) listener(code)
  }
}

test('document worker is lazy and correlates concurrent replies by request id', async () => {
  const workers: FakeDocumentWorker[] = []
  const bridge = new DocumentWorkerBridge(() => {
    const worker = new FakeDocumentWorker()
    workers.push(worker)
    return worker
  }, 60_000)
  assert.deepEqual(bridge.getStatsForTests(), { running: false, pending: 0, terminated: false })

  const docx = bridge.parseDocx('/tmp/a.docx')
  const xlsx = bridge.parseXlsx('/tmp/b.xlsx')
  assert.equal(workers.length, 1)
  const [docxRequest, xlsxRequest] = workers[0].messages
  workers[0].emitMessage({ id: xlsxRequest.id, ok: true, data: { kind: 'xlsx' } })
  workers[0].emitMessage({ id: docxRequest.id, ok: true, data: { kind: 'docx' } })

  assert.deepEqual(await docx, { kind: 'docx' })
  assert.deepEqual(await xlsx, { kind: 'xlsx' })
  assert.equal(bridge.getStatsForTests().pending, 0)
  await bridge.shutdown()
})

test('worker crash rejects current work and a later request starts a fresh worker', async () => {
  const workers: FakeDocumentWorker[] = []
  const bridge = new DocumentWorkerBridge(() => {
    const worker = new FakeDocumentWorker()
    workers.push(worker)
    return worker
  }, 60_000)

  const failed = bridge.parseDocx('/tmp/a.docx')
  workers[0].emitError(new Error('boom'))
  await assert.rejects(failed, (error: Error & { code?: string }) => error.code === 'DOCUMENT_WORKER_CRASH')

  const retriedByCaller = bridge.parseDocx('/tmp/a.docx')
  assert.equal(workers.length, 2)
  const request = workers[1].messages[0]
  workers[1].emitMessage({ id: request.id, ok: true, data: { success: true } })
  assert.deepEqual(await retriedByCaller, { success: true })
  await bridge.shutdown()
})

test('idle worker exits and the next request starts it again', async () => {
  const workers: FakeDocumentWorker[] = []
  const bridge = new DocumentWorkerBridge(() => {
    const worker = new FakeDocumentWorker()
    workers.push(worker)
    return worker
  }, 5)

  const first = bridge.readDocxText('/tmp/a.docx')
  const request = workers[0].messages[0]
  workers[0].emitMessage({ id: request.id, ok: true, data: { success: true, content: 'a' } })
  await first
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(bridge.getStatsForTests().running, false)
  assert.ok(workers[0].messages.some((message) => message.cmd === 'shutdown'))

  const second = bridge.readDocxText('/tmp/b.docx')
  assert.equal(workers.length, 2)
  const secondRequest = workers[1].messages[0]
  workers[1].emitMessage({ id: secondRequest.id, ok: true, data: { success: true, content: 'b' } })
  assert.equal((await second).content, 'b')
  await bridge.shutdown()
})
