import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureMarkdownLineAnchor,
  DOCUMENT_READING_POSITIONS_KEY,
  loadDocumentReadingPosition,
  readDocumentReadingPositionMap,
  readObjectReadingPositions,
  resolveMarkdownLineFromAnchor,
  saveDocumentReadingPosition,
} from '../renderer/modules/document/documentScrollAnchor'

function makeChapter(title: string, lines: number): string {
  return [
    `# ${title}`,
    ...Array.from({ length: lines }, (_, index) => `${title} 正文 ${index + 1}`),
  ].join('\n')
}

function createStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

test('markdown scroll anchor keeps position inside a long chapter', () => {
  const content = [
    makeChapter('第一章', 120),
    makeChapter('第二章', 80),
  ].join('\n')
  const anchor = captureMarkdownLineAnchor(content, 91)
  assert.deepEqual(anchor?.title, '第一章')
  assert.equal(anchor?.ordinal, 0)

  const restored = resolveMarkdownLineFromAnchor(content, {
    anchorTitle: anchor?.title || null,
    anchorOrdinal: anchor?.ordinal ?? null,
    anchorProgress: anchor?.progress ?? null,
  })
  assert.ok(restored)
  assert.ok(Math.abs(restored - 91) <= 1)
})

test('markdown scroll anchor distinguishes duplicate chapter titles', () => {
  const content = [
    makeChapter('重复标题', 20),
    makeChapter('重复标题', 50),
  ].join('\n')
  const anchor = captureMarkdownLineAnchor(content, 40)
  assert.equal(anchor?.title, '重复标题')
  assert.equal(anchor?.ordinal, 1)

  const restored = resolveMarkdownLineFromAnchor(content, {
    anchorTitle: '重复标题',
    anchorOrdinal: 1,
    anchorProgress: anchor?.progress ?? null,
  })
  assert.ok(restored)
  assert.ok(restored >= 35)
})

test('document reading positions round-trip through persistent storage', () => {
  const storage = createStorage()

  saveDocumentReadingPosition('object-a', {
    top: 240,
    ratio: 0.4,
    maxScroll: 600,
    anchorTitle: 'Chapter 2',
    anchorOrdinal: 1,
    anchorProgress: 0.25,
  }, storage)

  assert.deepEqual(loadDocumentReadingPosition('object-a', storage), {
    top: 240,
    ratio: 0.4,
    maxScroll: 600,
    anchorTitle: 'Chapter 2',
    anchorOrdinal: 1,
    anchorProgress: 0.25,
  })
})

test('document reading position cache ignores corrupt rows and exposes a restore map', () => {
  const storage = createStorage()
  storage.setItem(DOCUMENT_READING_POSITIONS_KEY, JSON.stringify([
    { key: 'object-a', top: 10, ratio: 2, maxScroll: 50, updatedAt: 2 },
    { key: '', top: 5, ratio: 0.1, maxScroll: 20, updatedAt: 3 },
    { key: '/tmp/b.md', top: 'bad', ratio: 0.1, maxScroll: 20, updatedAt: 4 },
  ]))

  const records = readObjectReadingPositions(storage)
  assert.equal(records.length, 1)
  assert.equal(records[0].key, 'object-a')
  assert.equal(records[0].ratio, 1)

  const map = readDocumentReadingPositionMap(storage)
  assert.deepEqual(map.get('object-a'), {
    top: 10,
    ratio: 1,
    maxScroll: 50,
    anchorTitle: null,
    anchorOrdinal: null,
    anchorProgress: null,
  })
})

test('resize-time scroll capture skips expensive anchor discovery but keeps the exact scroll position', async () => {
  const previousHTMLElement = globalThis.HTMLElement
  const previousTextArea = globalThis.HTMLTextAreaElement
  class FakeHTMLElement {}
  class FakeTextAreaElement extends FakeHTMLElement {
    scrollTop = 240
    scrollHeight = 1_000
    clientHeight = 400
  }
  Object.assign(globalThis, {
    HTMLElement: FakeHTMLElement,
    HTMLTextAreaElement: FakeTextAreaElement,
  })
  try {
    const { captureElementScroll } = await import('../renderer/modules/document/documentScrollRuntime')
    const snapshot = captureElementScroll(
      new FakeTextAreaElement() as unknown as HTMLElement,
      '# A heading that would otherwise create an anchor',
      { includeAnchor: false },
    )
    assert.deepEqual(snapshot, {
      top: 240,
      ratio: 0.4,
      maxScroll: 600,
      anchorTitle: null,
      anchorOrdinal: null,
      anchorProgress: null,
    })
  } finally {
    if (previousHTMLElement) globalThis.HTMLElement = previousHTMLElement
    else delete (globalThis as { HTMLElement?: unknown }).HTMLElement
    if (previousTextArea) globalThis.HTMLTextAreaElement = previousTextArea
    else delete (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement
  }
})

test('正文段落位置持久保存，不依赖章节标题', () => {
  const storage = createStorage()
  const snapshot = { top: 500, ratio: 0.5, maxScroll: 1000, anchorTitle: null, anchorOrdinal: null, anchorProgress: null, sourceLine: 321, sourceProgress: 0.6 }
  saveDocumentReadingPosition('object-paragraph', snapshot, storage)
  assert.deepEqual(loadDocumentReadingPosition('object-paragraph', storage), snapshot)
})

test('预览按可见正文段落捕获，重排后恢复同一段落内部', async () => {
  const { JSDOM } = await import('jsdom')
  const { captureElementScroll, restoreElementScroll } = await import('../renderer/modules/document/documentScrollRuntime')
  const dom = new JSDOM('<div id="scroll"><div data-ready-block-source-line="1"></div><div data-ready-block-source-line="9"></div></div>', { pretendToBeVisual: true })
  const previous = new Map<string, unknown>()
  for (const key of ['window', 'HTMLTextAreaElement', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    previous.set(key, (globalThis as Record<string, unknown>)[key])
    Object.assign(globalThis, { [key]: (dom.window as unknown as Record<string, unknown>)[key] })
  }
  try {
    const surface = dom.window.document.getElementById('scroll')!
    const [first, target] = Array.from(surface.children) as HTMLElement[]
    let targetTop = 400
    Object.defineProperties(surface, { scrollHeight: { value: 3000 }, clientHeight: { value: 500 } })
    surface.scrollTop = 450
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect
    surface.getBoundingClientRect = () => rect(0, 500)
    first.getBoundingClientRect = () => rect(-surface.scrollTop, 400)
    target.getBoundingClientRect = () => rect(targetTop - surface.scrollTop, 300)
    const position = captureElementScroll(surface, '')
    assert.equal(position.sourceLine, 9)
    assert.equal(position.sourceProgress, 58 / 300)
    targetTop = 900
    surface.scrollTop = 0
    const cleanup = restoreElementScroll(surface, position, '')
    assert.equal(surface.scrollTop, 950)
    cleanup()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
      else Object.assign(globalThis, { [key]: value })
    }
    dom.window.close()
  }
})
