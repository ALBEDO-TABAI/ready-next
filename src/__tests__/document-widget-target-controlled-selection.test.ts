import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { resolveControlledWidgetTarget } from '../shared/document-widget-target'

test('候选集为空时返回 {}，调用方可跳过受控校验', () => {
  const result = resolveControlledWidgetTarget('anything', [])
  assert.deepEqual(result, {})
})

test('raw 为空字符串或 undefined 时报错', () => {
  const a = resolveControlledWidgetTarget(undefined, ['A', 'B'])
  const b = resolveControlledWidgetTarget('   ', ['A', 'B'])
  assert.match(a.unresolvedReason || '', /targetWidgetTitle 为空/)
  assert.match(b.unresolvedReason || '', /targetWidgetTitle 为空/)
})

test('大小写差异时归一化到候选集真实值', () => {
  const result = resolveControlledWidgetTarget('lck_week_preview_9_16', [
    'LCK_Week_Preview_9_16',
    'plan_overview',
  ])
  assert.equal(result.resolved, 'LCK_Week_Preview_9_16')
})

test('raw 和候选存在子串相互包含时仍能命中', () => {
  const result = resolveControlledWidgetTarget('9_16', [
    'lck_week_preview_9_16',
    'plan_overview',
  ])
  assert.equal(result.resolved, 'lck_week_preview_9_16')
})

test('完全不匹配时返回 unresolvedReason 并列出候选', () => {
  const result = resolveControlledWidgetTarget('ghost_card', [
    'lck_week_preview_9_16',
    'plan_overview',
  ])
  assert.equal(result.resolved, undefined)
  assert.match(result.unresolvedReason || '', /不在候选集/)
  assert.match(result.unresolvedReason || '', /lck_week_preview_9_16/)
  assert.match(result.unresolvedReason || '', /plan_overview/)
})

test('候选集中存在完全相等值时优先返回原值，不做大小写折叠', () => {
  const result = resolveControlledWidgetTarget('Card_A', ['Card_A', 'card_a'])
  assert.equal(result.resolved, 'Card_A')
})

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts',
)

test('executor 在 update 分支消费 envelope widget_target 作为 preferredTargetWidgetTitle', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: document-task-pipeline-executor.ts transitively imports `electron` (via ../ipc-handler readDocumentEditableText) and has no electron-free seam to drive the update-branch consumption of envelope widget_target end-to-end. Tracked in lint-exemption-ledger 2026-05-22.
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(
    source,
    /resources\.find\(\(resource\) => resource\.kind === 'widget_target'\)/,
  )
  assert.match(source, /preferredTargetWidgetTitle: envelopeWidgetTarget\?\.name/)
})

test('widget draft prompt 在 update 分支注入受控候选列表', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(source, /targetWidgetTitle 必须严格等于下列候选之一/)
  assert.match(source, /targetCandidates/)
  assert.match(source, /preferredTarget/)
})

test('executor 在 evaluateWidgetDraftAttempt 中对 LLM 输出做受控归一化', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(
    source,
    /resolveControlledWidgetTarget\(draft\.targetWidgetTitle, params\.targetCandidates\)/,
  )
  assert.match(source, /draft\.targetWidgetTitle = resolution\.resolved/)
  assert.match(source, /errors\.push\(resolution\.unresolvedReason\)/)
})
