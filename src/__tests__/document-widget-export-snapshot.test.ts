import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildWidgetExportSnapshot } from '../renderer/components/document/widget-export-snapshot'

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
})
