import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'

import {
  WIDGET_SKELETON_IDS,
  compileWidgetSkeletonSpec,
  widgetSkeletonRequiresTriggerKeyword,
  RAMP_IDS,
} from '../shared/document-widget-skeletons'
import { compileDocumentWidgetSpec } from '../shared/document-widget-openui'
import { renderReadyChart, resolveDotUnit } from '../shared/document-widget-dot-charts'
import { mapComponentSpecToSkeletonSpec } from '../shared/document-widget-skeleton-mapping'
import { resolveDocumentWidgetRenderCode } from '../shared/document-widget-render-code'
import {
  buildWidgetBaseStyleCss,
  WIDGET_THEME_DARK,
  WIDGET_THEME_LIGHT,
} from '../shared/document-widget-theme'
import {
  buildDocumentWidgetGuidanceSnippet,
  buildDocumentWidgetSkeletonRulesSnippet,
  inferDocumentWidgetProfile,
} from '../main/modules/claude-bridge/widget-guidance'
import { buildToolGuidance, type ToolPolicy } from '../main/modules/agent-control/tool-policy/execution-tool-config'
import { resolveWidgetThemePayload } from '../renderer/components/document/widget-css-bridge'

/** 旧 Tailwind 冷灰蓝 pastel 十六进制（大小写不敏感），编译产物中不得再出现。 */
const LEGACY_HEXES = [
  '#eef2ff', '#c7d2fe', '#818cf8', '#4f46e5', '#3730a3',
  '#fffbeb', '#fde68a', '#fbbf24', '#d97706', '#92400e',
  '#fff1f2', '#fecdd3', '#fb7185', '#e11d48', '#9f1239',
  '#f0f9ff', '#bae6fd', '#38bdf8', '#0284c7', '#075985',
  '#0f172a', '#2563eb', '#e2e8f0', '#64748b', '#94a3b8',
  '#dbeafe', '#eef2f7', '#60a5fa', '#0ea5e9',
]

function assertNoLegacyPalette(html: string, context: string): void {
  const lower = html.toLowerCase()
  for (const hex of LEGACY_HEXES) {
    assert.ok(!lower.includes(hex), `${context} 不应包含 legacy 色 ${hex}`)
  }
}

const CHART_DATA = [
  { label: '一', value: 4 },
  { label: '二', value: 6 },
  { label: '三', value: 3 },
]

describe('document widget ready design language', () => {
  it('chart marks are pinned to brand accent in both light and dark token sets', () => {
    assert.equal(WIDGET_THEME_LIGHT.dcOn, '#FF4B2B')
    assert.equal(WIDGET_THEME_DARK.dcOn, '#FF4B2B')
  })

  it('iframe bridge keeps Ready widget surfaces warm instead of replacing them with app functional-blue surfaces', () => {
    const dom = new JSDOM('<!doctype html><html data-theme="light"><body></body></html>')
    const previousDocument = globalThis.document
    const previousGetComputedStyle = globalThis.getComputedStyle
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
    Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle.bind(dom.window), configurable: true })
    const root = dom.window.document.documentElement
    root.style.setProperty('--bg-content', '#F1F5FB')
    root.style.setProperty('--bg-canvas', '#EEF3FA')
    root.style.setProperty('--border-default', 'rgba(150,169,205,.34)')

    try {
      const payload = resolveWidgetThemePayload()
      assert.equal(payload.vars['--widget-bg-primary'], WIDGET_THEME_LIGHT.card)
      assert.equal(payload.vars['--widget-bg-secondary'], WIDGET_THEME_LIGHT.canvas)
      assert.equal(payload.vars['--widget-border'], WIDGET_THEME_LIGHT.hair)
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: Document }).document
      else Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
      if (previousGetComputedStyle === undefined) delete (globalThis as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle
      else Object.defineProperty(globalThis, 'getComputedStyle', { value: previousGetComputedStyle, configurable: true })
      dom.window.close()
    }
  })

  it('skeleton compiles reference widget vars instead of legacy pastel hexes', () => {
    const specs: Array<{ skeleton: string; props: Record<string, unknown> }> = [
      { skeleton: 'single_focus', props: { body: '金句', decoration: 'quote_mark' } },
      {
        skeleton: 'dual_compare',
        props: {
          title: 'A vs B',
          left: { heading: 'A', items: ['轻'] },
          right: { heading: 'B', items: ['稳'] },
        },
      },
      {
        skeleton: 'metric_grid',
        props: { title: '指标', metrics: [{ label: 'a', value: '1' }, { label: 'b', value: '2', ramp: 'rose' }] },
      },
      {
        skeleton: 'vertical_timeline',
        props: { title: '时间线', events: [{ time: '09:00', heading: '晨会', status: 'active' }] },
      },
      {
        skeleton: 'chart_focus',
        props: { title: '分布', chart: { type: 'bar', data: CHART_DATA } },
      },
    ]
    for (const spec of specs) {
      const compiled = compileWidgetSkeletonSpec(spec)
      assertNoLegacyPalette(compiled.widgetCode, spec.skeleton)
      assert.match(compiled.widgetCode, /--widget-/, `${spec.skeleton} 应引用 --widget-* 令牌变量`)
    }
  })

  it('info_card facts render as mono label/value rows (一眼看懂 shape)', () => {
    const compiled = compileDocumentWidgetSpec({
      component: 'info_card',
      props: {
        heading: '一眼看懂｜本章速览',
        body: '这是一支功能证明型广告，用可信演示建立购买理由。',
        facts: [
          { label: '广告定位', value: '季节性功能服饰广告' },
          { label: '核心策略', value: '内容先行型 + 功能证明型' },
          { label: '一句话概括', value: '从"怕晒怕热"带到"愿意试一试"。' },
        ],
      },
    })
    const rows = (compiled.widgetCode.match(/data-info-fact(?=[\s=>])/g) || []).length
    assert.equal(rows, 3)
    assert.match(compiled.widgetCode, /class="label"/)
    assert.match(compiled.widgetCode, /广告定位/)
    assertNoLegacyPalette(compiled.widgetCode, 'info_card facts')
  })

  it('OpenUI and skeleton info cards share the same designed composition and keep notes smaller than body copy', () => {
    const props = {
      title: '一眼看懂',
      body: '一句话结论。',
      facts: [{ label: '核心', value: '稳定的信息结构' }],
      points: ['来源口径仍需复核。'],
      kicker: '内容速览',
      ramp: 'amber' as const,
      decoration: 'none' as const,
    }
    const viaSkeleton = compileWidgetSkeletonSpec({ skeleton: 'single_focus', props })
    const viaOpenui = compileDocumentWidgetSpec({
      component: 'info_card',
      props: {
        heading: props.title,
        body: props.body,
        facts: props.facts,
        points: props.points,
        tone: 'info',
      },
    })

    for (const compiled of [viaSkeleton.widgetCode, viaOpenui.widgetCode]) {
      assert.match(compiled, /data-ready-info-card/)
      assert.match(compiled, /data-info-lede/)
      assert.match(compiled, /data-info-lede[^>]*font-size:15px/)
      assert.match(compiled, /data-info-fact[^>]*[\s\S]*?font-size:13px/)
      assert.match(compiled, /data-info-notes/)
      assert.match(compiled, /data-info-notes[^>]*[\s\S]*?font-size:12px/)
    }
  })

  it('existing stored widgets render from their structured spec so design upgrades are visible without rewriting documents', () => {
    const resolved = resolveDocumentWidgetRenderCode({
      widgetCode: '<div>legacy cached card</div>',
      componentSpec: {
        component: 'info_card',
        props: {
          heading: '现有文档里的卡',
          body: '仍应获得当前设计。',
          facts: [{ label: '状态', value: '已升级' }],
          points: ['缓存不再冻结视觉版本。'],
        },
      },
    })
    assert.equal(resolved.source, 'component_spec')
    assert.match(resolved.widgetCode, /data-ready-info-card/)
    assert.doesNotMatch(resolved.widgetCode, /legacy cached card/)
  })

  it('widget size choices have real layout semantics instead of metadata-only attributes', () => {
    const css = buildWidgetBaseStyleCss()
    assert.match(css, /data-widget-size="square_card"/)
    assert.match(css, /aspect-ratio:\s*1\s*\/\s*1/)
    assert.match(css, /data-widget-size="landscape_card"/)
    assert.match(css, /aspect-ratio:\s*16\s*\/\s*9/)
    assert.match(css, /data-widget-size="doc_block"/)
  })

  it('document widget shell actions use the Ready accent instead of the legacy functional blue', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/document-widget-editor.css'), 'utf8')
    const actionBlock = css.match(/\.ready-doc-widget-primary-action\s*\{[\s\S]*?html\[data-theme='dark'\] \.ready-doc-widget-primary-action:hover[\s\S]*?\}/)?.[0] || ''
    assert.ok(actionBlock, '应能读取 widget 操作栏样式块')
    assert.doesNotMatch(actionBlock, /--color-blue(?:-light)?/)
    assert.match(actionBlock, /--color-ready-orange/)
  })

  it('openui compiles reference widget vars instead of legacy pastel hexes', () => {
    const specs = [
      { component: 'info_card', props: { heading: '重点', body: '一句结论。' } },
      { component: 'callout_block', props: { heading: '提醒', body: '注意时限。', tone: 'warning' } },
      { component: 'stats_card', props: { heading: 'KPI', metrics: [{ label: 'A', value: '1' }] } },
      { component: 'bar_chart', props: { heading: '对比', series: CHART_DATA } },
      { component: 'line_chart', props: { heading: '趋势', series: CHART_DATA, annotation: '周二最佳' } },
      { component: 'progress_snapshot', props: { heading: '进度', items: [{ label: 'x', value: 40 }] } },
      {
        component: 'flow_diagram',
        props: {
          heading: '流程',
          nodes: [{ id: 'a', label: '开始' }, { id: 'b', label: '结束' }],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
      {
        component: 'relationship_graph',
        props: {
          heading: '关系',
          nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
          edges: [{ from: 'a', to: 'b', kind: 'emotion' }],
        },
      },
    ]
    for (const spec of specs) {
      const compiled = compileDocumentWidgetSpec(spec)
      assertNoLegacyPalette(compiled.widgetCode, String(spec.component))
      assert.match(compiled.widgetCode, /--widget-/, `${spec.component} 应引用 --widget-* 令牌变量`)
    }
  })

  it('mono label layer is present on data-heavy skeletons', () => {
    const metric = compileWidgetSkeletonSpec({
      skeleton: 'metric_grid',
      props: { title: '指标', metrics: [{ label: '完成', value: '23' }, { label: '专注', value: '14' }] },
    })
    assert.match(metric.widgetCode, /class="label"/)
    assert.match(metric.widgetCode, /class="num"/)
  })

  it('stacked_bar renders grouped part rows, distinct from plain bar', () => {
    const stacked = renderReadyChart({
      type: 'stacked_bar',
      data: [
        { label: 'Q1', value: 10, parts: [{ label: '线上', value: 6 }, { label: '线下', value: 4 }] },
        { label: 'Q2', value: 12, parts: [{ label: '线上', value: 8 }, { label: '线下', value: 4 }] },
      ],
    })
    const bar = renderReadyChart({ type: 'bar', data: CHART_DATA })
    assert.match(stacked, /Σ/)
    assert.match(stacked, /线上/)
    assert.notEqual(stacked, bar)
    assert.ok(!bar.includes('Σ'), 'plain bar 不应出现分组合计')
  })

  it('scatter renders an svg dot field with axes', () => {
    const scatter = renderReadyChart({
      type: 'scatter',
      data: [
        { label: 'A', value: 3, x: 1 },
        { label: 'B', value: 7, x: 2 },
        { label: 'C', value: 5, x: 4 },
      ],
    })
    assert.match(scatter, /<svg/)
    assert.match(scatter, /<circle/)
    assert.match(scatter, /<line/)
  })

  it('pie input degrades to compliant proportional forms (no pie slices)', () => {
    const multi = renderReadyChart({
      type: 'pie',
      data: [
        { label: '写作', value: 5 },
        { label: '会议', value: 3 },
        { label: '阅读', value: 2 },
      ],
    })
    assert.ok(!multi.includes('<path'), '多值 pie 不应渲染扇形 path')
    assert.match(multi, /%/)
    assert.match(multi, /写作/)

    const single = renderReadyChart({ type: 'pie', data: [{ label: '完成率', value: 62 }] })
    assert.match(single, /repeat\(10,1fr\)/)
    assert.match(single, /62/)
  })

  it('bar and line render one fine dot field (rest dots + lit dots on a shared grid)', () => {
    for (const type of ['bar', 'line'] as const) {
      const html = renderReadyChart({ type, data: CHART_DATA })
      assert.match(html, /<svg/, `${type} 应是 svg 点阵场`)
      const rest = html.match(/fill="var\(--widget-dc-rest[^"]*\)"/g) ?? []
      const lit = html.match(/fill="var\(--widget-dc-on[^"]*\)"/g) ?? []
      assert.ok(rest.length > 100, `${type} 需要铺满淡点背景，实际 ${rest.length}`)
      assert.ok(lit.length > 0 && lit.length < rest.length, `${type} 点亮的点应少于背景点`)
      const radii = new Set([...html.matchAll(/<circle [^>]*r="([\d.]+)"/g)].map((m) => Number(m[1])))
      assert.ok(Math.max(...radii) <= 4, `${type} 点应细小（r≤4），实际 ${[...radii]}`)
    }
  })

  it('bar and line charts always ship unit legend and direct value labels', () => {
    const bar = renderReadyChart({ type: 'bar', data: CHART_DATA, unitLabel: 'h' })
    assert.match(bar, /= /)
    for (const d of CHART_DATA) {
      assert.ok(bar.includes(`${d.value} h`), `bar 缺少真值直标 ${d.value}`)
    }
    const line = renderReadyChart({ type: 'line', data: CHART_DATA })
    assert.match(line, /<svg/)
    for (const d of CHART_DATA) {
      assert.ok(line.includes(`>${d.value}<`), `line 缺少真值直标 ${d.value}`)
    }
  })

  it('data tables use Ready theme tokens instead of the legacy cold-gray palette', () => {
    const table = compileDocumentWidgetSpec({
      component: 'data_table',
      props: { heading: '明细', columns: ['项目', '状态'], rows: [['信息卡', '完成']] },
    })
    assertNoLegacyPalette(table.widgetCode, 'data_table')
    assert.match(table.widgetCode, /--widget-border/)
    assert.match(table.widgetCode, /class="label"/)
  })

  it('OpenUI-to-skeleton mappings do not inject emoji icons into Ready cards', () => {
    for (const spec of [
      mapComponentSpecToSkeletonSpec({
        component: 'weekly_plan_board_manual',
        props: { heading: '计划', lanes: [{ heading: '进行中', cards: [{ label: '审查' }] }] },
      }),
      mapComponentSpecToSkeletonSpec({
        component: 'habit_streak_manual',
        props: { heading: '习惯', habits: [{ name: '复盘', completed: true }, { name: '记录', completed: false }] },
      }),
    ]) {
      assert.ok(spec)
      const compiled = compileWidgetSkeletonSpec(spec!)
      assert.ok(!/\p{Extended_Pictographic}/u.test(compiled.widgetCode))
    }
  })

  it('structured skeleton renderers ignore legacy emoji fields instead of painting emoji icons', () => {
    for (const compiled of [
      compileWidgetSkeletonSpec({
        skeleton: 'photo_note',
        props: {
          title: '图文笔记',
          hero: { type: 'emoji_block', emoji: '🌿', aspect: '4/3' },
        },
      }),
      compileWidgetSkeletonSpec({
        skeleton: 'grid_collection',
        props: {
          title: '清单',
          cols: 2,
          item_shape: 'square',
          items: [{ label: '甲', emoji: '📘' }, { label: '乙', emoji: '📗' }],
        },
      }),
    ]) {
      assert.ok(!/\p{Extended_Pictographic}/u.test(compiled.widgetCode))
    }
  })

  it('resolveDotUnit lands max value in the 8-15 dot band', () => {
    for (const max of [7, 23, 120, 4800, 0.9]) {
      const unit = resolveDotUnit(max)
      const dots = Math.round(max / unit)
      assert.ok(dots >= 4 && dots <= 16, `max=${max} unit=${unit} dots=${dots} 超出可读范围`)
    }
  })

  it('chart insight line has no emoji decoration', () => {
    const compiled = compileWidgetSkeletonSpec({
      skeleton: 'chart_focus',
      props: {
        title: '分布',
        chart: { type: 'bar', data: CHART_DATA },
        insight: '周二专注最佳。',
        source_note: '手工记录',
      },
    })
    assert.ok(!compiled.widgetCode.includes('💡'), 'insight 不应带 emoji 图标')
    assert.match(compiled.widgetCode, /INSIGHT/)
  })

  it('relation_map skeleton and openui relationship_graph share the same renderer', () => {
    const graphProps = {
      heading: '关系',
      nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
      edges: [{ from: 'a', to: 'b', kind: 'family' as const }],
    }
    const viaSkeleton = compileWidgetSkeletonSpec({ skeleton: 'relation_map', props: graphProps })
    const viaOpenui = compileDocumentWidgetSpec({ component: 'relationship_graph', props: graphProps })
    assert.match(viaSkeleton.widgetCode, /relationship-graph-widget/)
    assert.match(viaOpenui.widgetCode, /relationship-graph-widget/)
    assert.match(viaSkeleton.widgetCode, /data-rg-root/)
    assert.match(viaOpenui.widgetCode, /data-rg-root/)
  })

  it('relation_map drops invalid edges with a visible warning and keeps valid nodes', () => {
    const compiled = compileWidgetSkeletonSpec({
      skeleton: 'relation_map',
      props: {
        nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'ghost' },
        ],
      },
    })
    assert.match(compiled.widgetCode, /甲/)
    assert.match(compiled.widgetCode, /乙/)
    assert.match(compiled.widgetCode, /已跳过/)
  })

  it('process_flow renders ordered numbered steps, branches and outcome', () => {
    const compiled = compileWidgetSkeletonSpec({
      skeleton: 'process_flow',
      props: {
        heading: '光合作用',
        steps: [
          { label: '吸收光能' },
          { label: '水的光解', kind: 'decision', branches: [{ label: '释放氧气' }, { label: '产生电子' }] },
          { label: '暗反应固碳' },
        ],
        outcome: { label: '生成葡萄糖' },
      },
    })
    assert.match(compiled.widgetCode, /01/)
    assert.match(compiled.widgetCode, /02/)
    assert.match(compiled.widgetCode, /03/)
    const branchCount = (compiled.widgetCode.match(/data-flow-branch/g) || []).length
    assert.equal(branchCount, 2)
    assert.match(compiled.widgetCode, /data-flow-outcome/)
    assert.match(compiled.widgetCode, /OUTCOME/)
  })

  it('new diagram skeletons are freely usable (no trigger keyword gate)', () => {
    assert.equal(widgetSkeletonRequiresTriggerKeyword('relation_map'), false)
    assert.equal(widgetSkeletonRequiresTriggerKeyword('process_flow'), false)
  })

  it('legacy ramp ids stay accepted and compile without rainbow output', () => {
    for (const ramp of RAMP_IDS) {
      const compiled = compileWidgetSkeletonSpec({
        skeleton: 'single_focus',
        props: { body: '兼容检查', ramp },
      })
      assertNoLegacyPalette(compiled.widgetCode, `ramp=${ramp}`)
    }
  })

  it('chart datum accent input is accepted but never painted', () => {
    const compiled = compileDocumentWidgetSpec({
      component: 'bar_chart',
      props: {
        heading: '对比',
        series: [
          { label: 'A', value: 3, accent: '#123456' },
          { label: 'B', value: 5 },
        ],
      },
    })
    assert.ok(!compiled.widgetCode.includes('#123456'), '数据项 accent 不应进入渲染')
  })

  it('skeleton rules snippet advertises the new diagram skeletons with a consistent count', () => {
    const snippet = buildDocumentWidgetSkeletonRulesSnippet()
    assert.match(snippet, /relation_map/)
    assert.match(snippet, /process_flow/)
    assert.match(snippet, new RegExp(`${WIDGET_SKELETON_IDS.length} 个骨架`))
  })

  it('skeleton rules snippet forbids passing off markdown tables as info cards', () => {
    const snippet = buildDocumentWidgetSkeletonRulesSnippet()
    assert.match(snippet, /document_insert_widget/)
    assert.match(snippet, /markdown 表格/)
    assert.match(snippet, /冒充/)
  })

  it('info card ask routes to the widget tool with an explicit hard instruction', () => {
    const profile = inferDocumentWidgetProfile('在文档开头插入一张信息卡，一眼看懂本章')
    assert.ok(profile, '信息卡话术必须命中 widget family')
    assert.equal(profile!.family, 'info_card')
    const snippet = buildDocumentWidgetGuidanceSnippet(profile)
    assert.match(snippet, /document_insert_widget/)
    assert.match(snippet, /不要把 markdown 表格写进正文/)
  })

  it('document tool guidance maps card-family asks to document_insert_widget and forbids text-tool impersonation', () => {
    const policy: ToolPolicy = {
      forceDocumentTool: true,
      allowDocumentTools: true,
      forceDesignTool: false,
      preferredDesignTool: null,
      primaryDesignInstruction: null,
      allowMultipleDesignArtifacts: false,
      preferSectionRewrite: false,
      preferFormatOnly: false,
      allowBrowserTools: false,
    }
    const guidance = buildToolGuidance(policy)
    assert.match(guidance, /信息卡[\s\S]*?document_insert_widget/)
    assert.match(guidance, /禁止[\s\S]*?document_replace_text[\s\S]*?冒充卡片/)
  })
})
