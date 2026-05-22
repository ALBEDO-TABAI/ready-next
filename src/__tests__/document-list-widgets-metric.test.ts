import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const PIPELINE_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline.ts',
)

test('document-task-pipeline 导入 logAgentMetric', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: document-task-pipeline.ts itself does not import electron, but the only live caller (document-task-pipeline-executor.ts) does (transitively via ipc-handler). The import-shape assertion locks structural placement of the metrics dependency; lifting this to a runtime test requires building a runnable pipeline fixture (>50 LOC), out of W1 scope. Tracked in lint-exemption-ledger 2026-05-22 with a "runtime-upgrade when pipeline gets an electron-free harness" trigger.
  const source = readFileSync(PIPELINE_PATH, 'utf8')
  assert.match(source, /import\s+\{\s*logAgentMetric\s*\}\s+from\s+'..\/..\/agent-control\/metrics'/)
})

test('document_list_widgets 分支在 return 前 emit list_widgets_summary_as_final_text', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: same rationale as the previous test in this file — the document_list_widgets branch lives inside runDocumentTaskPipeline and can only be exercised by constructing a full DocumentTaskPipeline fixture with a real plan + snapshot + emit callbacks (>50 LOC); the metric-order assertion is held structurally until that runnable harness exists. Tracked in lint-exemption-ledger 2026-05-22.
  const source = readFileSync(PIPELINE_PATH, 'utf8')
  // 截取 document_list_widgets 分支的上下文
  const branchStart = source.indexOf("if (plan.taskType === 'document_list_widgets')")
  assert.ok(branchStart > 0, "未找到 document_list_widgets 分支")
  const branchEnd = source.indexOf("if (plan.taskType === 'document_remove_widget')", branchStart)
  assert.ok(branchEnd > branchStart, "未找到 list 分支边界")
  const branchBody = source.slice(branchStart, branchEnd)

  assert.match(branchBody, /logAgentMetric\('list_widgets_summary_as_final_text',/, 'list 分支内必须 emit 指标')
  // 埋点必须位于最终 return 之前
  const metricIdx = branchBody.indexOf("logAgentMetric('list_widgets_summary_as_final_text'")
  const returnIdx = branchBody.indexOf('return {')
  assert.ok(metricIdx > 0 && returnIdx > metricIdx, '埋点必须在 return { success: true } 之前')
})

test('list_widgets_summary_as_final_text payload 含 widgetCount / hasTabTitle / intent / stage', () => {
  const source = readFileSync(PIPELINE_PATH, 'utf8')
  const start = source.indexOf("logAgentMetric('list_widgets_summary_as_final_text'")
  assert.ok(start > 0)
  const tail = source.slice(start, start + 500)
  assert.match(tail, /stage:\s*'document_task_pipeline\.document_list_widgets'/)
  assert.match(tail, /widgetCount:\s*listResult\.summaries\.length/)
  assert.match(tail, /hasTabTitle:\s*Boolean\(listResult\.tabTitle \|\| snapshot\?\.title\)/)
  assert.match(tail, /intent:\s*plan\.taskType/)
  // 不应把 tabTitle / widget title 原文落到指标
  assert.doesNotMatch(tail, /tabTitle:\s*listResult\.tabTitle/)
  assert.doesNotMatch(tail, /title:\s*listResult\.tabTitle/)
})

test('埋点命名避免 violation_ 前缀（这是常规路径、非裁决违反）', () => {
  const source = readFileSync(PIPELINE_PATH, 'utf8')
  const start = source.indexOf("logAgentMetric('list_widgets_summary_as_final_text'")
  const tail = source.slice(start, start + 200)
  assert.doesNotMatch(tail, /violation_/)
})
