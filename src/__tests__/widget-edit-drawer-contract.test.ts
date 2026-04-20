import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDocumentWidgetFenceSource,
  tryParseWidgetPayload,
} from '../shared/document-widget-parse'
import { compileWidgetSkeletonSpec } from '../shared/document-widget-skeletons'
import { mapComponentSpecToSkeletonSpec } from '../shared/document-widget-skeleton-mapping'
import { mergeSkeletonSpecPatch } from '../shared/document-widget-patch'
import { getFieldMap, WIDGET_EDIT_DRAWER_FIELD_MAP } from '../renderer/components/document/widget-edit-drawer-field-map'

describe('widget edit drawer contract', () => {
  it('covers every A–G skeleton plus freeform skeletons in the field map', () => {
    const expected = [
      'single_focus',
      'dual_compare',
      'metric_grid',
      'vertical_timeline',
      'photo_note',
      'chart_focus',
      'grid_collection',
      'freeform_static',
      'freeform_interactive',
    ]
    for (const id of expected) {
      const descriptor = getFieldMap(id)
      assert.ok(descriptor, `missing drawer field map for ${id}`)
      assert.ok(descriptor!.fields.length >= 1, `empty fields for ${id}`)
    }
    assert.equal(Object.keys(WIDGET_EDIT_DRAWER_FIELD_MAP).length, expected.length)
  })

  it('saves skeletonSpec into the fence and preserves legacy componentSpec side-by-side', () => {
    const legacyComponent = {
      component: 'info_card',
      props: { heading: '今日总结', body: '完成三项计划。', ramp: 'emerald' },
    }
    const mapped = mapComponentSpecToSkeletonSpec(legacyComponent)
    assert.ok(mapped, 'legacy info_card must map to a skeleton')

    const edited = mergeSkeletonSpecPatch(
      { skeleton: mapped!.skeleton, size: mapped!.size, background_mode: mapped!.background_mode, props: mapped!.props ?? {} },
      { props: { title: '今日总结（编辑后）' } },
    )

    const compiled = compileWidgetSkeletonSpec({
      skeleton: edited.skeleton,
      size: edited.size as never,
      background_mode: edited.background_mode,
      props: edited.props,
    })

    const fence = buildDocumentWidgetFenceSource('test-widget', compiled.widgetCode, {
      componentSpec: legacyComponent,
      skeletonSpec: {
        skeleton: compiled.skeleton,
        size: compiled.size,
        background_mode: compiled.backgroundMode,
        props: edited.props,
      },
    })

    assert.match(fence, /"skeleton_spec"/)
    assert.match(fence, /"component_spec"/)

    const body = fence.replace(/^```show-widget\n/, '').replace(/\n```$/, '')
    const parsed = tryParseWidgetPayload(body, fence)
    assert.ok(parsed, 'fence must re-parse after save')
    assert.equal(parsed!.skeletonSpec?.skeleton, compiled.skeleton)
    assert.equal(parsed!.componentSpec?.component, 'info_card')
    assert.equal((parsed!.skeletonSpec?.props as { title?: string } | undefined)?.title, '今日总结（编辑后）')
  })

  it('transparent background flag round-trips through skeleton spec', () => {
    const compiled = compileWidgetSkeletonSpec({
      skeleton: 'single_focus',
      size: 'square_card',
      background_mode: 'transparent',
      props: { title: 'hello', body: 'body' },
    })
    assert.equal(compiled.backgroundMode, 'transparent')

    const fence = buildDocumentWidgetFenceSource('test-transparent', compiled.widgetCode, {
      skeletonSpec: {
        skeleton: compiled.skeleton,
        size: compiled.size,
        background_mode: compiled.backgroundMode,
        props: { title: 'hello', body: 'body' },
      },
    })

    const body = fence.replace(/^```show-widget\n/, '').replace(/\n```$/, '')
    const parsed = tryParseWidgetPayload(body, fence)
    assert.equal(parsed!.skeletonSpec?.background_mode, 'transparent')
  })

  it('widget_code patch for freeform_interactive survives round-trip', () => {
    const props = {
      widget_code: '<div class="card">hi</div>',
      aspect_ratio: '1:1',
      supports_animation: true,
    }
    const compiled = compileWidgetSkeletonSpec({
      skeleton: 'freeform_interactive',
      props,
    })
    const fence = buildDocumentWidgetFenceSource('interactive', compiled.widgetCode, {
      skeletonSpec: {
        skeleton: 'freeform_interactive',
        size: compiled.size,
        background_mode: compiled.backgroundMode,
        props,
      },
    })
    const body = fence.replace(/^```show-widget\n/, '').replace(/\n```$/, '')
    const parsed = tryParseWidgetPayload(body, fence)
    assert.equal(parsed!.skeletonSpec?.skeleton, 'freeform_interactive')
    assert.match((parsed!.skeletonSpec?.props as { widget_code?: string } | undefined)?.widget_code ?? '', /hi/)
  })
})
