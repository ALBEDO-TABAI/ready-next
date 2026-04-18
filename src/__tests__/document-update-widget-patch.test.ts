import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  mergeComponentSpecPatch,
  mergeRecordPatch,
} from '../shared/document-widget-patch'
import type { DocumentWidgetComponentSpecSummary } from '../shared/document-widget-parse'

test('mergeComponentSpecPatch 对单字段 patch 保留其它字段', () => {
  const base: DocumentWidgetComponentSpecSummary = {
    component: 'info_card',
    props: { heading: 'h', body: 'b', tone: 'info' },
  }
  const merged = mergeComponentSpecPatch(base, { props: { tone: 'warning' } })
  assert.equal(merged.component, 'info_card')
  assert.deepEqual(merged.props, { heading: 'h', body: 'b', tone: 'warning' })
})

test('mergeComponentSpecPatch 数组字段整体替换，不做 append', () => {
  const base: DocumentWidgetComponentSpecSummary = {
    component: 'points_card',
    props: { heading: 'h', points: ['a', 'b', 'c'] },
  }
  const merged = mergeComponentSpecPatch(base, { props: { points: ['x'] } })
  assert.deepEqual(merged.props?.points, ['x'])
})

test('mergeComponentSpecPatch null 值等价于删除字段', () => {
  const base: DocumentWidgetComponentSpecSummary = {
    component: 'info_card',
    props: { heading: 'h', body: 'b', tone: 'info' },
  }
  const merged = mergeComponentSpecPatch(base, { props: { tone: null } })
  assert.ok(merged.props && !('tone' in merged.props))
  assert.equal(merged.props!.heading, 'h')
})

test('mergeComponentSpecPatch 支持更换 component 名称', () => {
  const base: DocumentWidgetComponentSpecSummary = {
    component: 'info_card',
    props: { heading: 'h' },
  }
  const merged = mergeComponentSpecPatch(base, { component: 'callout_block', props: { tone: 'warning' } })
  assert.equal(merged.component, 'callout_block')
  assert.deepEqual(merged.props, { heading: 'h', tone: 'warning' })
})

test('mergeComponentSpecPatch 对嵌套对象做递归合并', () => {
  const base: DocumentWidgetComponentSpecSummary = {
    component: 'week_schedule_card',
    props: {
      weekLabel: '9/16',
      days: { mon: { slot1: 'A' }, tue: { slot1: 'B' } },
    },
  }
  const merged = mergeComponentSpecPatch(base, {
    props: { days: { mon: { slot1: 'A+' } } },
  })
  const days = merged.props?.days as Record<string, Record<string, unknown>>
  assert.equal(days.mon.slot1, 'A+')
  assert.equal(days.tue.slot1, 'B', '未被 patch 的嵌套字段必须保留')
})

test('mergeRecordPatch 忽略非对象 patch，返回 base', () => {
  const base = { tone: 'info' }
  assert.deepEqual(mergeRecordPatch(base, 'not-an-object'), base)
  assert.deepEqual(mergeRecordPatch(base, 42), base)
  assert.deepEqual(mergeRecordPatch(base, undefined), base)
})

test('mergeRecordPatch patch === null 整段删除字段', () => {
  const result = mergeRecordPatch({ a: 1 }, null)
  assert.equal(result, undefined)
})

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-task-pipeline-executor.ts',
)
const PIPELINE_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-task-pipeline.ts',
)
const ACTIONS_PATH = resolve(
  process.cwd(),
  'src/renderer/modules/agent/documentActions.ts',
)

test('DocumentWidgetDraft schema 新增 componentSpecPatch 字段', () => {
  const source = readFileSync(PIPELINE_PATH, 'utf8')
  assert.match(source, /componentSpecPatch\?: DocumentWidgetComponentSpecPatch/)
  assert.match(source, /interface DocumentWidgetComponentSpecPatch/)
})

test('normalizePipelineWidgetDraft 识别 patch-only 草稿不走 fallback', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(source, /componentSpecPatch: normalizedPatch!/)
  assert.match(source, /hasMeaningfulPatch/)
})

test('writeDocumentWidget 透传 componentSpecPatch 到 document.updateWidget', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(source, /componentSpecPatch: params\.draft\.componentSpecPatch/)
})

test('system prompt 在 update 分支引导 LLM 产出 componentSpecPatch', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(source, /字段级 patch/)
  assert.match(source, /componentSpecPatch/)
})

test('renderer update_widget action 支持 patch 分支合并既有 componentSpec', () => {
  const source = readFileSync(ACTIONS_PATH, 'utf8')
  assert.match(source, /mergeComponentSpecPatch/)
  assert.match(source, /字段级 patch/)
  assert.match(source, /不带 component_spec，无法做字段级 patch/)
})
