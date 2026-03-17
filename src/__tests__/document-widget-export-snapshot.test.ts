import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildWidgetExportSnapshot } from '../renderer/components/document/widget-export-snapshot'
import { buildDocumentHtmlSnapshotExport } from '../shared/document-widget-html-export'

describe('widget export snapshot helper', () => {
  it('keeps pure svg widgets as svg snapshots', () => {
    const snapshot = buildWidgetExportSnapshot(
      '<svg viewBox="0 0 100 50"><rect width="100" height="50" fill="#fff" /></svg>',
      'flow',
    )

    assert.ok(snapshot)
    assert.equal(snapshot?.kind, 'svg')
    assert.equal(snapshot?.fileExtension, '.svg')
    assert.match(snapshot?.content || '', /<svg/)
  })

  it('converts scripted widgets into static html snapshots', () => {
    const snapshot = buildWidgetExportSnapshot(
      '<div class="card">Hello</div><script>window.x = 1</script>',
      'calc',
    )

    assert.ok(snapshot)
    assert.equal(snapshot?.kind, 'html')
    assert.equal(snapshot?.fileExtension, '.html')
    assert.doesNotMatch(snapshot?.content || '', /<script/)
    assert.match(snapshot?.content || '', /widget-export-snapshot/)
  })

  it('builds a document html export with widget snapshots replacing show-widget fences', () => {
    const html = buildDocumentHtmlSnapshotExport([
      '# Demo',
      '',
      '```show-widget',
      '{"title":"score_calculator","widget_code":"<div>Hello</div><script>window.x=1</script>"}',
      '```',
      '',
      'Tail',
    ].join('\n'), 'Demo')

    assert.match(html, /score_calculator/)
    assert.match(html, /widget-export-snapshot/)
    assert.doesNotMatch(html, /```show-widget/)
    assert.doesNotMatch(html, /window\.x=1/)
  })

  it('wires html save-as through the widget snapshot export helper', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/document-engine/ipc-handler.ts'),
      'utf8',
    )

    assert.match(source, /HTML 快照/)
    assert.match(source, /buildDocumentHtmlSnapshotExport/)
  })
})
