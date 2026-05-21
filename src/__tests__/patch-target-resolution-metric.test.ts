import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-pipeline/document-task-pipeline-executor.ts',
)
const MODULE_EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/renderer/modules/agent/moduleExecutor.ts',
)

test('document-task-pipeline-executor 导入 logAgentMetric', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(source, /import\s+\{\s*logAgentMetric\s*\}\s+from\s+'\.\/metrics'/)
})

test('writeDocumentWidget.update 在 reason === target_not_resolved 时 emit patch_target_resolution_failed', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  // 条件必须在 update 分支里，且拿到 payload 之后
  assert.match(
    source,
    /payload\.ok === false && payload\.reason === 'target_not_resolved'/,
  )
  assert.match(
    source,
    /logAgentMetric\('patch_target_resolution_failed',\s*\{/,
  )
})

test('patch_target_resolution_failed payload 包含关键维度、不包含 target 本体', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  // 截取 logAgentMetric('patch_target_resolution_failed', { ... }) 这一块
  const start = source.indexOf("logAgentMetric('patch_target_resolution_failed'")
  assert.ok(start > 0, "未找到 patch_target_resolution_failed 埋点")
  const tail = source.slice(start, start + 600)
  assert.match(tail, /stage:\s*'document_task_pipeline_executor\.writeDocumentWidget'/)
  assert.match(tail, /targetKind:\s*\/\^widget_\[a-z0-9\]\+\$\/\.test\(target\)\s*\?\s*'internal_id'\s*:\s*'title_or_index'/)
  assert.match(tail, /targetLen:\s*target\.length/)
  assert.match(tail, /hadPatch:\s*Boolean\(params\.draft\.componentSpecPatch\)/)
  assert.match(tail, /hadComponentSpec:\s*Boolean\(params\.draft\.componentSpec\)/)
  assert.match(tail, /hadWidgetCode:\s*Boolean\(params\.draft\.widgetCode\)/)
  assert.match(tail, /tabId:\s*params\.snapshot\.tabId \|\| null/)
  // 禁止把 target 本体泄到指标里（避免 widget_xxx 暴露到日志）
  assert.doesNotMatch(tail, /target:\s*target\b/)
  assert.doesNotMatch(tail, /targetId:\s*target\b/)
})

test('moduleExecutor 使用 classifyDocActionFailureReason 把 ok/reason 并入 IPC payload', () => {
  const source = readFileSync(MODULE_EXECUTOR_PATH, 'utf8')
  assert.match(source, /classifyDocActionFailureReason/)
  assert.match(source, /payload\.ok\s*=\s*false/)
  assert.match(source, /payload\.reason\s*=\s*failureReason/)
})
