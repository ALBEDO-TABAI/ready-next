import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import {
  buildDocumentWidgetFenceSource,
  tryParseWidgetPayload,
} from '../shared/document-widget-parse'
import { compileWidgetSkeletonSpec, getWidgetSkeleton, type WidgetSkeletonId } from '../shared/document-widget-skeletons'
import { mapComponentSpecToSkeletonSpec } from '../shared/document-widget-skeleton-mapping'
import { mergeSkeletonSpecPatch } from '../shared/document-widget-patch'
import { getFieldMap, WIDGET_EDIT_DRAWER_FIELD_MAP } from '../renderer/components/document/widget-edit-drawer-field-map'
import { replaceWidgetFenceWithSkeletonInContent } from '../renderer/components/document/widget-card-helpers'
import { readFileSync } from 'node:fs'

const drawerFixtures: Record<WidgetSkeletonId, Record<string, unknown>> = {
  single_focus: { title: '标题', body: '正文', facts: [{ label: '标签', value: '内容' }], points: ['补充'] },
  dual_compare: { title: '对比', left: { heading: '左', items: ['甲'] }, right: { heading: '右', items: ['乙'] } },
  metric_grid: { title: '指标', metrics: [{ label: '甲', value: '1' }, { label: '乙', value: '2' }] },
  vertical_timeline: { title: '时间线', events: [{ time: '09:00', heading: '开始', status: 'active' }] },
  photo_note: { title: '图文', hero: { type: 'image', src: 'https://example.com/a.png' }, tags: ['标签'] },
  chart_focus: { title: '趋势', chart: { type: 'bar', data: [{ label: '甲', value: 1 }] } },
  grid_collection: { title: '清单', cols: 2, item_shape: 'square', items: [{ label: '甲' }, { label: '乙' }] },
  relation_map: { heading: '关系', nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }], edges: [{ from: 'a', to: 'b' }] },
  process_flow: { heading: '流程', steps: [{ label: '开始' }, { label: '结束' }] },
  freeform_static: { widget_code: '<div>静态</div>', aspect_ratio: '1:1' },
  freeform_interactive: { widget_code: '<div>交互</div>', aspect_ratio: '1:1', supports_animation: true },
}

function getPath(target: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = target
  for (const segment of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const next = structuredClone(target)
  const segments = path.split('.')
  let cursor = next
  for (const segment of segments.slice(0, -1)) {
    const child = cursor[segment]
    if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments.at(-1)!] = value
  return next
}

describe('widget edit drawer contract', () => {
  it('covers every structured skeleton plus freeform skeletons in the field map', () => {
    const expected = [
      'single_focus',
      'dual_compare',
      'metric_grid',
      'vertical_timeline',
      'photo_note',
      'chart_focus',
      'grid_collection',
      'relation_map',
      'process_flow',
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

  it('uses schema-backed field paths and dedicated editors for structured content', () => {
    const single = getFieldMap('single_focus')!
    assert.equal(single.fields.find((field) => field.path === 'facts')?.kind, 'key-value-list')
    assert.equal(single.fields.find((field) => field.path === 'points')?.kind, 'text-list')

    const comparePaths = getFieldMap('dual_compare')!.fields.map((field) => field.path)
    assert.ok(comparePaths.includes('left.heading'))
    assert.ok(comparePaths.includes('left.items'))
    assert.ok(comparePaths.includes('right.heading'))
    assert.ok(comparePaths.includes('right.items'))
    assert.ok(!comparePaths.includes('left.title'))
    assert.ok(!comparePaths.includes('left.body'))

    const metricPaths = getFieldMap('metric_grid')!.fields.map((field) => field.path)
    assert.ok(metricPaths.includes('period'))
    assert.ok(!metricPaths.includes('subtitle'))

    const timelinePaths = getFieldMap('vertical_timeline')!.fields.map((field) => field.path)
    assert.ok(timelinePaths.includes('axis_label'))
    assert.ok(!timelinePaths.includes('subtitle'))
  })

  it('every visible drawer field survives the target skeleton schema', () => {
    for (const skeletonId of Object.keys(WIDGET_EDIT_DRAWER_FIELD_MAP) as WidgetSkeletonId[]) {
      const skeleton = getWidgetSkeleton(skeletonId)!
      for (const field of WIDGET_EDIT_DRAWER_FIELD_MAP[skeletonId].fields) {
        const current = getPath(drawerFixtures[skeletonId], field.path)
        const sample = current ?? (
          field.kind === 'text' || field.kind === 'textarea' ? '已修改'
            : field.kind === 'ramp' ? 'amber'
              : field.kind === 'enum'
                ? (/^\d+$/.test(field.options[0].value) ? Number(field.options[0].value) : field.options[0].value)
                : field.kind === 'key-value-list' ? [{ label: '标签', value: '内容' }]
                  : field.kind === 'metrics-list' ? [{ label: '甲', value: '1' }, { label: '乙', value: '2' }]
                    : field.kind === 'text-list' ? ['内容']
                      : field.kind === 'events-list' ? [{ time: '09:00', heading: '事件', status: 'active' }]
                        : field.kind === 'grid-items-list' ? [{ label: '甲' }, { label: '乙' }]
                          : field.kind === 'tags-list' ? ['标签']
                            : { type: 'image', src: 'https://example.com/a.png' }
        )
        const parsed = skeleton.propsSchema.parse(setPath(drawerFixtures[skeletonId], field.path, sample)) as Record<string, unknown>
        assert.notEqual(
          getPath(parsed, field.path),
          undefined,
          `${skeletonId}.${field.path} was stripped by its schema`,
        )
      }
    }
  })

  it('saves skeletonSpec without retaining a stale legacy componentSpec beside it', () => {
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
      skeletonSpec: {
        skeleton: compiled.skeleton,
        size: compiled.size,
        background_mode: compiled.backgroundMode,
        props: edited.props,
      },
    })

    assert.match(fence, /"skeleton_spec"/)
    assert.doesNotMatch(fence, /"component_spec"/)

    const body = fence.replace(/^```show-widget\n/, '').replace(/\n```$/, '')
    const parsed = tryParseWidgetPayload(body, fence)
    assert.ok(parsed, 'fence must re-parse after save')
    assert.equal(parsed!.skeletonSpec?.skeleton, compiled.skeleton)
    assert.equal(parsed!.componentSpec, null)
    assert.equal((parsed!.skeletonSpec?.props as { title?: string } | undefined)?.title, '今日总结（编辑后）')
  })

  it('Tiptap drawer save drops the old componentSpec source after compiling a skeleton', () => {
    const source = readFileSync('src/renderer/components/document/TiptapEditor.tsx', 'utf8')
    const saveBlock = source.match(/const handleSaveEditDrawer[\s\S]*?\}, \[\]\)/)?.[0] ?? source
    assert.match(saveBlock, /componentSpec:\s*null/)
    assert.doesNotMatch(saveBlock, /componentSpec:\s*context\.widget\.componentSpec/)
  })

  it('live Markdown editor replacement keeps the widget id and makes skeletonSpec the only editable source', () => {
    const legacyComponent = {
      component: 'info_card',
      props: {
        heading: '速览',
        body: '一句结论。',
        facts: [{ label: '状态', value: '修复前' }],
      },
    }
    const original = buildDocumentWidgetFenceSource('速览卡', '<div>old</div>', {
      id: 'widget-live-edit',
      componentSpec: legacyComponent,
    })
    const mapped = mapComponentSpecToSkeletonSpec(legacyComponent)
    assert.ok(mapped)
    const compiled = compileWidgetSkeletonSpec(mapped!)
    const next = replaceWidgetFenceWithSkeletonInContent(original, 'widget-live-edit', compiled.widgetCode, {
      skeleton: compiled.skeleton,
      size: compiled.size,
      background_mode: compiled.backgroundMode,
      props: mapped!.props,
    })
    const body = next.replace(/^```show-widget\n/, '').replace(/\n```$/, '')
    const parsed = tryParseWidgetPayload(body, next)
    assert.equal(parsed?.id, 'widget-live-edit')
    assert.equal(parsed?.componentSpec, null)
    assert.equal(parsed?.skeletonSpec?.skeleton, 'single_focus')
    assert.match(parsed?.widgetCode || '', /data-info-facts/)
  })

  it('single_focus kicker/footer survive schema parse so drawer edits are not silently dropped (W10e)', () => {
    const compiled = compileWidgetSkeletonSpec({
      skeleton: 'single_focus',
      props: {
        title: '快速信息卡',
        kicker: 'QUICK FACTS',
        body: '一句话结论。',
        footer: '来源 · 第一轮调研 2026-07',
        decoration: 'none',
      },
    })
    assert.match(compiled.widgetCode, /QUICK FACTS/)
    assert.match(compiled.widgetCode, /来源 · 第一轮调研/)
    assert.match(compiled.widgetCode, /class="label"/)
  })

  it('drawer renders through a body portal so ancestor stacking contexts cannot eat clicks (W10e)', () => {
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract (W10e): 点击可达性依赖真实浏览器的包含块/堆叠行为，纯 Node 无法驱动；portal 挂点以源级 pin 钉住，交互本身由真机验收。
    const source = readFileSync('src/renderer/components/document/WidgetEditDrawer.tsx', 'utf8')
    assert.match(source, /createPortal\(/)
    assert.match(source, /document\.body,?\s*\)/)
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

  it('keeps unsaved drawer choices when the parent rerenders the same widget input', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    })
    const globals = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Event', 'MouseEvent', 'Element', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const
    const previous = new Map<string, unknown>()
    for (const key of globals) previous.set(key, (globalThis as Record<string, unknown>)[key])
    const install = (key: string, value: unknown) => {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    }
    install('window', dom.window)
    install('document', dom.window.document)
    install('HTMLElement', dom.window.HTMLElement)
    install('HTMLInputElement', dom.window.HTMLInputElement)
    install('HTMLTextAreaElement', dom.window.HTMLTextAreaElement)
    install('Node', dom.window.Node)
    install('Event', dom.window.Event)
    install('MouseEvent', dom.window.MouseEvent)
    install('Element', dom.window.Element)
    install('navigator', dom.window.navigator)
    install('IS_REACT_ACT_ENVIRONMENT', true)

    const { default: React, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { default: WidgetEditDrawer } = await import('../renderer/components/document/WidgetEditDrawer')
    const root = createRoot(dom.window.document.getElementById('root') as HTMLElement)
    const logicalInput = {
      id: 'widget-draft-stability',
      title: '信息卡',
      widgetCode: '<div>old</div>',
      componentSpec: {
        component: 'info_card',
        props: { heading: '原始标题', body: '原始正文。' },
      },
    }
    const render = () => React.createElement(WidgetEditDrawer, {
      open: true,
      input: { ...logicalInput },
      onClose: () => undefined,
      onSave: () => undefined,
    })

    try {
      await act(async () => { root.render(render()) })
      const title = dom.window.document.querySelector('input[aria-label="标题"]') as HTMLInputElement
      assert.ok(title, 'title field renders')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(title, '尚未保存的新标题')
        title.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      assert.equal(title.value, '尚未保存的新标题')

      await act(async () => { root.render(render()) })
      assert.equal(
        (dom.window.document.querySelector('input[aria-label="标题"]') as HTMLInputElement).value,
        '尚未保存的新标题',
        'same logical widget must not reload its initial spec on parent rerender',
      )

      const transparent = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('.ready-widget-edit-drawer-segmented button'))
        .find((button) => button.textContent === '透明')
      assert.ok(transparent)
      await act(async () => { transparent!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
      await act(async () => { root.render(render()) })
      assert.ok(
        Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('.ready-widget-edit-drawer-segmented button'))
          .find((button) => button.textContent === '透明')
          ?.classList.contains('is-active'),
        'background choice survives parent rerender',
      )
    } finally {
      await act(async () => { root.unmount() })
      for (const key of globals) {
        const value = previous.get(key)
        if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
      dom.window.close()
    }
  })
})
