import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ExternalRefreshInFlightRequest,
  isPathWithinChangedDirectory,
  isReloadableTextDocumentPath,
  refreshCleanDocumentTabsFromDisk,
  shouldRefreshDocumentTabForDirectoryChange,
  shouldRefreshDocumentTabOnActivation,
} from '../renderer/modules/document/documentExternalRefresh'

test('document external refresh targets clean markdown tabs under changed directories', () => {
  assert.equal(isReloadableTextDocumentPath('/workspace/out/文案分析报告.md'), true)
  assert.equal(isReloadableTextDocumentPath('/workspace/out/video.mp4'), false)

  assert.equal(
    shouldRefreshDocumentTabForDirectoryChange(
      { path: '/workspace/out/文案分析报告.md', isDirty: false },
      ['/workspace/out'],
    ),
    true,
  )
  assert.equal(
    shouldRefreshDocumentTabForDirectoryChange(
      { path: '/workspace/out/文案分析报告.md', isDirty: true },
      ['/workspace/out'],
    ),
    false,
  )
  assert.equal(
    shouldRefreshDocumentTabForDirectoryChange(
      { path: '/workspace/other/文案分析报告.md', isDirty: false },
      ['/workspace/out'],
    ),
    false,
  )
})

test('document external refresh path matching handles Windows separators', () => {
  assert.equal(
    isPathWithinChangedDirectory('C:\\workspace\\out\\文案分析报告.md', 'C:\\workspace\\out'),
    true,
  )
  assert.equal(
    isPathWithinChangedDirectory('C:\\workspace\\outside\\文案分析报告.md', 'C:\\workspace\\out'),
    false,
  )
})

test('document activation refresh includes clean empty documents that changed while hidden', () => {
  assert.equal(
    shouldRefreshDocumentTabOnActivation({
      path: '/workspace/out/文案分析报告.md',
      isDirty: false,
      content: '',
    }),
    true,
  )
  assert.equal(
    shouldRefreshDocumentTabOnActivation({
      path: '/workspace/out/文案分析报告.md',
      isDirty: false,
      content: '# 已加载',
    }),
    true,
  )
  assert.equal(
    shouldRefreshDocumentTabOnActivation({
      path: '/workspace/out/文案分析报告.md',
      isDirty: true,
      content: '# 未保存',
    }),
    false,
  )

  assert.equal(
    shouldRefreshDocumentTabForDirectoryChange(
      { path: '/workspace/out/文案分析报告.md', isDirty: false },
      ['/workspace/out'],
    ),
    true,
  )
})

test('long-form Markdown extension uses the same external refresh contract', () => {
  assert.equal(isReloadableTextDocumentPath('/workspace/notes.markdown'), true)
})

test('external refresh coalesces in-flight reads, protects dirty tabs, and retains failed work', async () => {
  const current = new Map([
    ['clean', { id: 'clean', path: '/workspace/clean.md', isDirty: false, content: 'old' }],
    ['dirty', { id: 'dirty', path: '/workspace/dirty.md', isDirty: true, content: 'draft' }],
  ])
  const inFlight = new Map<string, ExternalRefreshInFlightRequest>()
  const hydrated: Array<{ id: string; content: string }> = []
  let reads = 0
  let releaseRead: (() => void) | null = null
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
  const dependencies = {
    readFile: async (path: string) => {
      reads += 1
      await readGate
      return path.includes('failed') ? { success: false } : { success: true, content: 'disk' }
    },
    getCurrentTab: (id: string) => current.get(id) || null,
    hydrateTab: (id: string, content: string) => {
      hydrated.push({ id, content })
      const tab = current.get(id)
      if (tab) current.set(id, { ...tab, content, isDirty: false })
    },
    inFlight,
  }
  const clean = current.get('clean')!
  const first = refreshCleanDocumentTabsFromDisk([clean], dependencies)
  const duplicate = refreshCleanDocumentTabsFromDisk([clean], dependencies)
  releaseRead?.()
  assert.deepEqual(await first, new Set(['clean']))
  assert.deepEqual(await duplicate, new Set(['clean']))
  assert.equal(reads, 2)
  assert.deepEqual(hydrated, [{ id: 'clean', content: 'disk' }])

  assert.deepEqual(
    await refreshCleanDocumentTabsFromDisk([current.get('dirty')!], dependencies),
    new Set(['dirty']),
  )
  assert.equal(reads, 2)

  const failed = { id: 'failed', path: '/workspace/failed.md', isDirty: false, content: 'old' }
  current.set('failed', failed)
  assert.deepEqual(await refreshCleanDocumentTabsFromDisk([failed], dependencies), new Set())
})

test('external refresh performs one trailing read when disk changes during an in-flight read', async () => {
  const current = new Map([
    ['clean', { id: 'clean', path: '/workspace/clean.md', isDirty: false, content: 'old' }],
  ])
  const inFlight = new Map<string, ExternalRefreshInFlightRequest>()
  const releases: Array<() => void> = []
  const contents = ['v1', 'v2']
  let reads = 0
  const dependencies = {
    readFile: async () => {
      const index = reads++
      await new Promise<void>((resolve) => { releases[index] = resolve })
      return { success: true, content: contents[index] }
    },
    getCurrentTab: (id: string) => current.get(id) || null,
    hydrateTab: (id: string, content: string) => {
      const tab = current.get(id)
      if (tab) current.set(id, { ...tab, content })
    },
    inFlight,
  }
  const candidate = current.get('clean')!
  const first = refreshCleanDocumentTabsFromDisk([candidate], dependencies)
  await Promise.resolve()
  assert.equal(reads, 1)
  const trailing = refreshCleanDocumentTabsFromDisk([candidate], dependencies)
  releases[0]()
  while (reads < 2) await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(reads, 2)
  releases[1]()

  assert.deepEqual(await first, new Set(['clean']))
  assert.deepEqual(await trailing, new Set(['clean']))
  assert.equal(current.get('clean')?.content, 'v2')
  assert.equal(inFlight.size, 0)
})

test('external refresh reports rejected reads and clears in-flight state', async () => {
  const candidate = { id: 'failed', path: '/workspace/failed.md', isDirty: false, content: 'old' }
  const inFlight = new Map<string, ExternalRefreshInFlightRequest>()
  const warnings: unknown[][] = []
  const previousWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const refreshed = await refreshCleanDocumentTabsFromDisk([candidate], {
      readFile: async () => { throw new Error('read rejected') },
      getCurrentTab: () => candidate,
      hydrateTab: () => { throw new Error('must not hydrate') },
      inFlight,
    })
    assert.deepEqual(refreshed, new Set())
    assert.equal(inFlight.size, 0)
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0]), /document-external-refresh/)
    assert.match(String(warnings[0]?.[2]), /read rejected/)
  } finally {
    console.warn = previousWarn
  }
})
