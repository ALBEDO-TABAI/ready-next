import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildWidgetExportSnapshot } from '../renderer/components/document/widget-export-snapshot'
import { buildDocumentHtmlSnapshotExport } from '../shared/document-widget-html-export'
import {
  getWidgetPersistenceKey,
  mergeWidgetStateMapIntoContent,
  renameWidgetFenceTitleInContent,
} from '../renderer/components/document/widget-card-helpers'

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

  it('defines a widget-level export file name helper for card exports', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/widget-export-snapshot.ts'),
      'utf8',
    )

    assert.match(source, /resolveWidgetExportSuggestedName/)
    assert.match(source, /replace\(\s*\/\[\^a-z0-9_-]\+\/gi/)
    assert.match(source, /\.png/)
  })

  it('supports binary save-as payloads for widget image exports', () => {
    const preloadSource = readFileSync(
      resolve(process.cwd(), 'src/preload/index.ts'),
      'utf8',
    )
    const mainSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/document-engine/ipc-handler.ts'),
      'utf8',
    )

    assert.match(preloadSource, /contentBase64\?: string/)
    assert.match(mainSource, /contentBase64\?: string/)
    assert.match(mainSource, /Buffer\.from\(payload\.contentBase64, 'base64'\)/)
  })

  it('writes widget_state into the saved widget fence content', () => {
    const source = [
      '```show-widget',
      '{"title":"chart","widget_code":"<div>hello</div>"}',
      '```',
    ].join('\n')

    const next = mergeWidgetStateMapIntoContent(source, {
      [getWidgetPersistenceKey('chart', '<div>hello</div>')]: {
        controls: [{ index: 0, tag: 'input', type: 'number', value: '42' }],
        activeTargets: [{ attr: 'data-focus-target', value: 'next' }],
      },
    })

    assert.match(next, /"widget_state":/)
    assert.match(next, /"value":"42"/)
    assert.match(next, /"data-focus-target"/)
  })

  it('preserves component_spec and id when renaming a widget fence title', () => {
    const source = [
      '```show-widget',
      JSON.stringify({
        id: 'widget_chart_01',
        title: 'chart',
        widget_code: '<div>hello</div>',
        component_spec: {
          component: 'info_card',
          props: { heading: 'Hello', body: 'World' },
        },
        widget_state: {
          controls: [{ index: 0, tag: 'input', type: 'number', value: '3' }],
        },
      }),
      '```',
    ].join('\n')

    const next = renameWidgetFenceTitleInContent(source, 'chart', '<div>hello</div>', 'chart_v2')

    assert.match(next, /"id":"widget_chart_01"/)
    assert.match(next, /"title":"chart_v2"/)
    assert.match(next, /"component_spec":/)
    assert.match(next, /"info_card"/)
    assert.match(next, /"widget_state":/)
  })

  it('preserves component_spec and id when merging widget_state back into content', () => {
    const source = [
      '```show-widget',
      JSON.stringify({
        id: 'widget_chart_02',
        title: 'chart',
        widget_code: '<div>hello</div>',
        component_spec: {
          component: 'info_card',
          props: { heading: 'Hello', body: 'World' },
        },
      }),
      '```',
    ].join('\n')

    const next = mergeWidgetStateMapIntoContent(source, {
      [getWidgetPersistenceKey('chart', '<div>hello</div>')]: {
        controls: [{ index: 0, tag: 'input', type: 'number', value: '99' }],
      },
    })

    assert.match(next, /"id":"widget_chart_02"/)
    assert.match(next, /"component_spec":/)
    assert.match(next, /"info_card"/)
    assert.match(next, /"widget_state":/)
    assert.match(next, /"value":"99"/)
  })
})
