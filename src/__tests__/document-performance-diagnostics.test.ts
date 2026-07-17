import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { generateDocumentPerfFixtures } from '../../scripts/generate-document-perf-fixtures'
import {
  getDocumentPerformanceDiagnosticsSnapshot,
  recordDocumentPerformanceCounter,
  recordDocumentPerformanceMaximum,
  resetDocumentPerformanceDiagnostics,
  setDocumentPerformanceDiagnosticsEnabled,
} from '../shared/document-performance-diagnostics'
import { buildDocumentOutline } from '../shared/document-side-panels'
import { resolveDocumentWidgetRenderCode } from '../shared/document-widget-render-code'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import {
  extractWidgetStateMapFromContent,
  getWidgetFenceSignature,
} from '../renderer/components/document/widget-card-helpers'
import {
  advanceWidgetFenceSignatureForTextEdit,
  buildWidgetFenceSignatureSnapshot,
} from '../renderer/modules/document/widgetFenceSignature'

test('document performance diagnostics are opt-in, resettable, and timer-free', () => {
  const control = (globalThis as typeof globalThis & {
    __READY_DOCUMENT_PERFORMANCE__?: {
      enable(nextEnabled?: boolean): void
      reset(): void
      snapshot(): ReturnType<typeof getDocumentPerformanceDiagnosticsSnapshot>
    }
  }).__READY_DOCUMENT_PERFORMANCE__
  assert.ok(control, 'real Electron profiling needs a devtools-readable diagnostics control')
  setDocumentPerformanceDiagnosticsEnabled(false)
  resetDocumentPerformanceDiagnostics()
  buildDocumentOutline('# Hidden counter')
  assert.equal(getDocumentPerformanceDiagnosticsSnapshot().counters.outlineBuilds, 0)

  setDocumentPerformanceDiagnosticsEnabled(true)
  resetDocumentPerformanceDiagnostics()
  buildDocumentOutline('# Counted outline')
  for (let index = 0; index < 20; index += 1) extractWidgetStateMapFromContent(`plain text ${index}`)
  extractWidgetStateMapFromContent('```show-widget\n{"title":"A","widgetCode":"<div>A</div>"}\n```')
  buildStructuredNotePreview('# Preview')
  resolveDocumentWidgetRenderCode({ widgetCode: '<div>one diagnostic key</div>' })
  recordDocumentPerformanceCounter('boardDragCommits')
  recordDocumentPerformanceCounter('boardInteractionFrames', 2)
  recordDocumentPerformanceMaximum('pdfMountedPagesPeak', 7)
  recordDocumentPerformanceMaximum('pdfMountedPagesPeak', 3)

  const snapshot = getDocumentPerformanceDiagnosticsSnapshot()
  assert.equal(snapshot.counters.outlineBuilds, 1)
  assert.equal(snapshot.counters.widgetFenceScans, 0)
  assert.equal(snapshot.counters.widgetStateParses, 1)
  assert.equal(snapshot.counters.previewParses, 1)
  assert.equal(snapshot.counters.widgetCompiles, 1)
  assert.equal(snapshot.counters.boardDragCommits, 1)
  assert.equal(snapshot.counters.boardInteractionFrames, 2)
  assert.equal(snapshot.maxima.pdfMountedPagesPeak, 7)

  control.enable(false)
  control.reset()
  assert.equal(control.snapshot().enabled, false)

  setDocumentPerformanceDiagnosticsEnabled(false)
  resetDocumentPerformanceDiagnostics()
})

test('document performance fixtures cover dual documents, multiple boards, and worker formats', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'ready-document-perf-fixtures-test-'))
  try {
    await generateDocumentPerfFixtures(fixtureDir)
    const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')) as {
      files: Record<string, string>
      counts: { boards: number; boardNodes: number[]; workerFormats: number }
    }

    assert.equal(manifest.counts.boards, 2)
    assert.deepEqual(manifest.counts.boardNodes, [150, 30])
    assert.equal(manifest.counts.workerFormats, 3)
    for (const name of [
      'markdown',
      'secondaryMarkdown',
      'board',
      'secondaryBoard',
      'pdf',
      'docx',
      'xlsx',
      'epub',
    ]) {
      assert.ok(readFileSync(join(fixtureDir, manifest.files[name])).byteLength > 0, `${name} fixture exists`)
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('ordinary board node drag frames participate in the shared interaction counter', () => {
  const source = readFileSync(new URL('../renderer/components/document/BoardEditor.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const scheduleNodeDragFrame')
  const end = source.indexOf('const scheduleBoardInteractionFrame', start)
  assert.ok(start >= 0 && end > start)
  const scheduler = source.slice(start, end)
  assert.match(scheduler, /requestAnimationFrame\(\(\) => \{[\s\S]*recordDocumentPerformanceCounter\('boardInteractionFrames'\)[\s\S]*updateBoardNodeDragSession/)
})

test('widget fence signature ignores ordinary text edits around an unchanged widget', () => {
  const fence = '```show-widget\n{"title":"A","widgetCode":"<div>A</div>"}\n```'
  const initial = `before\n${fence}\nafter`
  const shifted = `new heading\nbefore\n${fence}\nafter with typing`
  assert.equal(getWidgetFenceSignature(initial), getWidgetFenceSignature(shifted))
  assert.notEqual(
    getWidgetFenceSignature(initial),
    getWidgetFenceSignature(initial.replace('<div>A</div>', '<div>B</div>')),
  )
})

test('ordinary typing advances widget fence ranges without rescanning the document', () => {
  const fence = '```show-widget\n{"title":"A","widgetCode":"<div>A</div>"}\n```'
  const initial = `before\n${fence}\nafter`
  setDocumentPerformanceDiagnosticsEnabled(true)
  resetDocumentPerformanceDiagnostics()
  const snapshot = buildWidgetFenceSignatureSnapshot(initial)
  const advanced = advanceWidgetFenceSignatureForTextEdit(snapshot, initial, {
    start: 0,
    end: 0,
    insertedText: 'typed ',
  })

  assert.ok(advanced)
  assert.equal(advanced.signature, snapshot.signature)
  assert.deepEqual(advanced.ranges, snapshot.ranges.map((range) => ({
    start: range.start + 6,
    end: range.end + 6,
  })))
  assert.equal(getDocumentPerformanceDiagnosticsSnapshot().counters.widgetFenceScans, 1)
  assert.equal(advanceWidgetFenceSignatureForTextEdit(advanced, `typed ${initial}`, {
    start: advanced.ranges[0].start + 20,
    end: advanced.ranges[0].start + 20,
    insertedText: 'changed',
  }), null)

  setDocumentPerformanceDiagnosticsEnabled(false)
  resetDocumentPerformanceDiagnostics()
})

test('completing an adjacent widget marker invalidates the incremental fence snapshot', () => {
  const existingFence = '```show-widget\n{}\n```'
  const initial = `\`\`\`show-widge\n${existingFence}`
  const snapshot = buildWidgetFenceSignatureSnapshot(initial)
  const insertAt = initial.indexOf('\n')

  assert.equal(advanceWidgetFenceSignatureForTextEdit(snapshot, initial, {
    start: insertAt,
    end: insertAt,
    insertedText: 't',
  }), null)
})
