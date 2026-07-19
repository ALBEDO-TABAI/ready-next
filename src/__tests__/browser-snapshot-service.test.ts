import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  BrowserSnapshotService,
  parseBrowserSnapshotRef,
} from '../main/modules/browser-engine/browser-snapshot-service'
import { DEFAULT_AGENT_PAGE_MAP_MAX_BYTES } from '../main/modules/tools/browser-observe-tools'

function fixture() {
  let url = 'https://example.test/a'
  let timeOrigin = 100
  let mutationRevision = 0
  let frameDocumentToken = 'document-a'
  const controller = {
    getActiveTab: () => ({ id: 'tab-a' }),
    getPhysicalTargetToken: () => 'physical-a',
    executeJS: async () => ({ url, title: 'Fixture', timeOrigin, mutationRevision, frameDocumentToken }),
  } as unknown as BrowserController
  return {
    controller,
    mutate: () => { mutationRevision += 1 },
    navigate: (next: string) => {
      url = next
      timeOrigin += 100
      mutationRevision = 0
      frameDocumentToken = `document-${timeOrigin}`
    },
  }
}

function rawPayload(revision: number, names = ['Save']): Record<string, unknown> {
  return {
    pageIdentity: { url: 'https://example.test/a' },
    pageMap: {
      generation: revision,
      targets: names.map((name, index) => ({
        targetId: `${revision}:0:p${index + 1}`,
        role: 'button',
        name,
        frameId: '0',
        frameDocumentToken: 'document-a',
      })),
    },
  }
}

test('snapshot cache reuses a clean document and refreshes after mutation', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  let captures = 0
  const capture = (revision: number) => {
    captures += 1
    return Promise.resolve(rawPayload(revision))
  }
  const first = await service.capture(page.controller, 'tab-a', 16_384, capture)
  const second = await service.capture(page.controller, 'tab-a', 16_384, capture)
  assert.equal(captures, 1)
  assert.equal(first.observationFresh, true)
  assert.equal(second.observationFresh, false)
  assert.deepEqual({ ...second, observationFresh: true }, first)

  page.mutate()
  const third = await service.capture(page.controller, 'tab-a', 16_384, capture)
  assert.equal(captures, 2)
  assert.equal((third.pageIdentity as Record<string, unknown>).snapshotRevision, 2)
})

test('disposing a tab drops its snapshot and stale refs before rematerialization', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const first = await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  const ref = String(((first.pageMap as { targets: Array<{ targetId: string }> }).targets[0]).targetId)

  service.disposeTab(page.controller, 'tab-a')

  const resolution = await service.resolveRef(page.controller, 'tab-a', ref)
  assert.equal(resolution.ok, false)
  if (!resolution.ok) assert.equal(resolution.errorCode, 'stale_snapshot')
})

test('opaque refs bind tab, physical target, frame document, and snapshot revision', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const first = await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  const ref = String(((first.pageMap as { targets: Array<{ targetId: string }> }).targets[0]).targetId)
  assert.deepEqual(parseBrowserSnapshotRef(ref), {
    tabId: 'tab-a',
    physicalTargetToken: 'physical-a',
    frameId: '0',
    frameDocumentToken: 'document-a',
    snapshotRevision: 1,
    rawTargetId: '1:0:p1',
  })
  assert.equal((await service.resolveRef(page.controller, 'tab-b', ref)).ok, false)
  assert.equal((await service.resolveRef(page.controller, 'tab-a', ref)).ok, true)

  page.mutate()
  const staleSnapshot = await service.resolveRef(page.controller, 'tab-a', ref)
  assert.equal(staleSnapshot.ok, false)
  if (!staleSnapshot.ok) assert.equal(staleSnapshot.errorCode, 'stale_snapshot')

  await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  const stillStale = await service.resolveRef(page.controller, 'tab-a', ref)
  assert.equal(stillStale.ok, false)
  if (!stillStale.ok) assert.equal(stillStale.errorCode, 'stale_snapshot')

  page.navigate('https://example.test/b')
  const staleDocument = await service.resolveRef(page.controller, 'tab-a', ref)
  assert.equal(staleDocument.ok, false)
  if (!staleDocument.ok) assert.equal(staleDocument.errorCode, 'stale_document')
})

test('snapshot never rebinds a stale reference by semantic name', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const first = await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  const ref = String(((first.pageMap as { targets: Array<{ targetId: string }> }).targets[0]).targetId)
  page.mutate()
  await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision, ['Save', 'Save']))
  const resolution = await service.resolveRef(page.controller, 'tab-a', ref)
  assert.equal(resolution.ok, false)
  if (!resolution.ok) assert.equal(resolution.errorCode, 'stale_snapshot')
})

test('default page-map overview is 8 KiB while full targets remain private', () => {
  assert.equal(DEFAULT_AGENT_PAGE_MAP_MAX_BYTES, 8_192)
})

test('one snapshot budget covers text and targets while find retains tail recall', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const names = Array.from({ length: 1_000 }, (_, index) => (
    index === 999 ? 'Tail Submit' : `Very descriptive page target ${index} ${'x'.repeat(48)}`
  ))
  const payload = await service.capture(
    page.controller,
    'tab-a',
    DEFAULT_AGENT_PAGE_MAP_MAX_BYTES,
    async (revision) => ({
      ...rawPayload(revision, names),
      pageMap: {
        ...(rawPayload(revision, names).pageMap as Record<string, unknown>),
        text: `${'large page body '.repeat(3_000)}Tail Submit`,
      },
    }),
  )

  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
  const publicMap = payload.pageMap as { returnedTargets: number; totalTargets: number }
  assert.ok(publicMap.returnedTargets < publicMap.totalTargets)
  assert.equal(publicMap.totalTargets, 1_000)

  const found = service.find(page.controller, 'tab-a', { query: 'Tail Submit', limit: 20 })
  assert.equal(found?.total, 1)
  assert.equal(found?.matches[0]?.name, 'Tail Submit')
})

test('strict find scopes by purpose, availability, frame, and current ancestry', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const payload = await service.capture(page.controller, 'tab-a', 16_384, async (revision) => ({
    pageIdentity: { url: 'https://example.test/a' },
    pageMap: {
      generation: revision,
      targets: [
        { targetId: `${revision}:main:p1`, role: 'listbox', name: '城市', frameId: 'main', frameDocumentToken: 'document-main', visible: true, enabled: true },
        {
          targetId: `${revision}:main:p2`,
          role: 'option',
          name: '新加坡',
          frameId: 'main',
          frameDocumentToken: 'document-main',
          parentTargetId: `${revision}:main:p1`,
          ancestorTargetIds: [`${revision}:main:p1`],
          visible: true,
          enabled: true,
        },
        { targetId: `${revision}:frame-b:p3`, role: 'option', name: '新加坡', frameId: 'frame-b', frameDocumentToken: 'document-frame-b', visible: true, enabled: true },
        { targetId: `${revision}:main:p4`, role: 'textbox', name: '搜索', frameId: 'main', frameDocumentToken: 'document-main', visible: true, enabled: false },
        { targetId: `${revision}:main:p5`, role: 'button', name: '发送', frameId: 'main', frameDocumentToken: 'document-main', visible: false, enabled: true },
      ],
    },
  }))
  const targets = (payload.pageMap as { targets: Array<{ targetId: string }> }).targets
  const containerRef = targets[0]!.targetId
  assert.equal('parentTargetId' in targets[1]!, false)
  assert.equal('ancestorTargetIds' in targets[1]!, false)

  const scoped = service.find(page.controller, 'tab-a', {
    query: '新加坡',
    purpose: 'action',
    withinTargetId: containerRef,
    frameId: 'main',
  })
  assert.equal(scoped?.total, 1)
  assert.equal(scoped?.matches[0]?.targetId, targets[1]?.targetId)
  assert.equal(scoped?.matches[0]?.parentTargetId, containerRef)
  assert.deepEqual(scoped?.matches[0]?.ancestorTargetIds, [containerRef])

  assert.equal(service.find(page.controller, 'tab-a', { purpose: 'input' })?.total, 0)
  const actionCandidates = service.find(page.controller, 'tab-a', { purpose: 'action' })
  assert.equal(actionCandidates?.total, 2)
  assert.equal(actionCandidates?.matches.some((target) => target.name === '发送'), false)
  assert.equal(service.find(page.controller, 'tab-a', { visible: false })?.total, 1)

  page.mutate()
  await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  assert.equal(
    service.find(page.controller, 'tab-a', { withinTargetId: containerRef })?.errorCode,
    'within_target_stale',
  )
})
