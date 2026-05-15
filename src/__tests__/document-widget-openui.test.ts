import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  compileDocumentWidgetSpec,
  documentWidgetOpenUIPrompt,
  documentWidgetOpenUISchema,
  validateDocumentWidgetComponentSpec,
  type DocumentWidgetComponentSpec,
} from '../shared/document-widget-openui'

describe('document widget OpenUI artifacts', () => {
  it('keeps the shared widget catalog free from broken OpenUI runtime imports', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/document-widget-openui.ts'),
      'utf8',
    )

    assert.doesNotMatch(source, /@openuidev\/(?:react-lang|lang-core)/)
  })

  it('publishes a prompt artifact that covers both common and personal widget families', () => {
    assert.match(documentWidgetOpenUIPrompt, /info_card/)
    assert.match(documentWidgetOpenUIPrompt, /data_table/)
    assert.match(documentWidgetOpenUIPrompt, /relationship_graph/)
    assert.match(documentWidgetOpenUIPrompt, /day_schedule_card/)
    assert.match(documentWidgetOpenUIPrompt, /todo_list_manual/)
  })

  it('publishes a schema artifact with widget component defs', () => {
    const defs = (documentWidgetOpenUISchema as { $defs?: Record<string, unknown> }).$defs || {}
    assert.ok(defs.info_card)
    assert.ok(defs.callout_block)
    assert.ok(defs.relationship_graph)
    assert.ok(defs.day_schedule_card)
    assert.ok(defs.schedule_runtime_card)
  })

  it('writes generated prompt and schema documents for repo-side review', () => {
    const promptDoc = readFileSync(
      resolve(process.cwd(), 'docs/DOCUMENT_WIDGET_OPENUI_PROMPT.md'),
      'utf8',
    )
    const schemaDoc = JSON.parse(readFileSync(
      resolve(process.cwd(), 'docs/DOCUMENT_WIDGET_OPENUI_SCHEMA.json'),
      'utf8',
    )) as { $defs?: Record<string, unknown> }

    assert.match(promptDoc, /Document Widget OpenUI Prompt/)
    assert.match(promptDoc, /info_card/)
    assert.match(promptDoc, /relationship_graph/)
    assert.match(promptDoc, /day_schedule_card/)
    assert.ok(schemaDoc.$defs?.info_card)
    assert.ok(schemaDoc.$defs?.relationship_graph)
    assert.ok(schemaDoc.$defs?.todo_list_manual)
  })
})

describe('document widget OpenUI validation', () => {
  it('accepts approved component specs', () => {
    const result = validateDocumentWidgetComponentSpec({
      component: 'info_card',
      props: {
        heading: '今日重点',
        body: '把版本说明同步给团队。',
        tone: 'neutral',
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.errors.length, 0)
  })

  it('rejects unknown component specs', () => {
    const result = validateDocumentWidgetComponentSpec({
      component: 'unknown_widget',
      props: {},
    } as DocumentWidgetComponentSpec)

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /unknown_widget/)
  })

  it('rejects relationship graph edges that reference missing nodes', () => {
    const result = validateDocumentWidgetComponentSpec({
      component: 'relationship_graph',
      props: {
        heading: '人物关系图',
        nodes: [
          { id: 'duke', label: '梅诗金公爵' },
          { id: 'nastasya', label: '娜斯塔霞' },
        ],
        edges: [
          { from: 'duke', to: 'rogohin', label: '竞争' },
        ],
      },
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /unknown to node "rogohin"/)
  })
})

describe('document widget OpenUI compiler', () => {
  it('compiles common display specs into stable widget code', () => {
    const compiled = compileDocumentWidgetSpec({
      component: 'callout_block',
      props: {
        heading: '发布提醒',
        body: '今晚 20:00 前完成封面和标题检查。',
        tone: 'warning',
        points: ['核对时间', '确认封面', '检查摘要'],
      },
    })

    assert.equal(compiled.component, 'callout_block')
    assert.match(compiled.widgetCode, /发布提醒/)
    assert.match(compiled.widgetCode, /今晚 20:00 前完成封面和标题检查/)
  })

  it('compiles manual widgets with local interaction hooks', () => {
    const compiled = compileDocumentWidgetSpec({
      component: 'todo_list_manual',
      props: {
        heading: '今日待办',
        items: [
          { text: '补充更新日志', done: false },
          { text: '确认封面文案', done: true },
        ],
      },
    })

    assert.match(compiled.widgetCode, /checkbox/i)
    assert.match(compiled.widgetCode, /今日待办/)
    assert.match(compiled.widgetCode, /补充更新日志/)
  })

  it('compiles real-data widgets from calendar snapshots', () => {
    const compiled = compileDocumentWidgetSpec({
      component: 'day_schedule_card',
      dataSource: { type: 'calendar', preset: 'today' },
    }, {
      calendar: {
        dateLabel: '今天',
        events: [
          { title: '晨会', timeLabel: '09:30 - 10:00', accent: '#5B8DEF', meta: '工作' },
          { title: '复盘', timeLabel: '18:00 - 18:30', accent: '#34D399', meta: '内容' },
        ],
      },
    })

    assert.match(compiled.widgetCode, /今天/)
    assert.match(compiled.widgetCode, /晨会/)
    assert.match(compiled.widgetCode, /09:30 - 10:00/)
  })

  it('compiles relationship graphs as measured cards plus an SVG overlay', () => {
    const compiled = compileDocumentWidgetSpec({
      component: 'relationship_graph',
      props: {
        heading: '《白痴》人物关系图',
        groups: [
          { id: 'core', label: '核心三角', position: 'center', color: '#be123c' },
          { id: 'family', label: '叶班钦家族', position: 'right', color: '#2563eb' },
        ],
        nodes: [
          { id: 'duke', label: '梅诗金公爵', subtitle: '男主角', group: 'core', emphasis: 'primary' },
          { id: 'nastasya', label: '娜斯塔霞', subtitle: '女主角', group: 'core', emphasis: 'primary' },
          { id: 'rogohin', label: '罗果仁', group: 'core' },
          { id: 'aglaia', label: '阿格拉雅', group: 'family' },
        ],
        edges: [
          { from: 'duke', to: 'nastasya', kind: 'emotion', label: '怜悯/吸引', weight: 'heavy' },
          { from: 'rogohin', to: 'nastasya', kind: 'emotion', label: '执迷' },
          { from: 'aglaia', to: 'duke', kind: 'emotion', label: '好奇' },
        ],
      },
    })

    assert.equal(compiled.component, 'relationship_graph')
    assert.match(compiled.widgetCode, /data-rg-root/)
    assert.match(compiled.widgetCode, /data-rg-node="duke"/)
    assert.match(compiled.widgetCode, /ResizeObserver/)
    assert.match(compiled.widgetCode, /getBoundingClientRect/)
    assert.match(compiled.widgetCode, /梅诗金公爵/)
    assert.doesNotMatch(compiled.widgetCode, /<line\b[^>]*x1=/)
  })
})
