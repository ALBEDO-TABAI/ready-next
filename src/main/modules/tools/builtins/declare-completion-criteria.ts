import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { logAgentMetric } from '../../agent-control/metrics'

/**
 * D4 — 模型声明验收标准的结构化通道（合同：2026-07-05-p3-backlog-closeout §1）。
 *
 * 声明只落 task projection 行的 `modelCriteria` 字段（整组替换、幂等），
 * finalizer 终态经 `appendModelCriteria` 保留 m1/m2 命名空间，但自由文本
 * 没有代码可核验的证明合同，不会用“登记成功”冒充已完成。具体文件目标
 * 仍由 expectedOutputs 逐一核对。声明校验在代码侧：条数/长度/空串；漂移账本
 * `model_criteria_declared` 每次声明必发。
 */

export const DECLARE_CRITERIA_MAX_ITEMS = 8
export const DECLARE_CRITERIA_MAX_ITEM_CHARS = 120
export const DECLARE_EXPECTED_OUTPUT_MAX_ITEM_CHARS = 200

export interface CompletionDeclarationPatch {
  modelCriteria: string[]
  expectedOutputs: string[]
}

export interface DeclareCompletionCriteriaDeps {
  taskId: string | null
  sessionId?: string | null
  updateTaskCompletionDeclaration: (taskId: string, patch: CompletionDeclarationPatch) => void | Promise<void>
  outputContract?: {
    destinationResourceId: string
    maxExpectedOutputs: number
    /** The writable current document, when it lives in this folder: it is saved with document_save_tab. */
    currentDocumentFile?: { destinationPath: string; pathDigest: string }
  } | null
}

function isCurrentDocumentFile(file: { destinationPath: string; pathDigest: string }, target: string): boolean {
  // Native join matches the renderer's tab path form on each platform.
  const path = join(file.destinationPath, target)
  return [path, path.normalize('NFC'), path.normalize('NFD')]
    .some((candidate) => createHash('sha256').update(candidate).digest('hex') === file.pathDigest)
}

function normalizeExpectedOutputs(value: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(value) || value.length > DECLARE_CRITERIA_MAX_ITEMS) {
    return { ok: false, message: `未登记：expected_outputs 必须是 1-${DECLARE_CRITERIA_MAX_ITEMS} 个具体文件目标。` }
  }
  const outputs: string[] = []
  for (const item of value) {
    const target = String(item ?? '').trim()
    if (!target || target.length > DECLARE_EXPECTED_OUTPUT_MAX_ITEM_CHARS) {
      return { ok: false, message: `未登记：expected_outputs 每项必须非空且不超过 ${DECLARE_EXPECTED_OUTPUT_MAX_ITEM_CHARS} 字符。` }
    }
    if (/[\\/]$/.test(target) || target === '.' || target === '..') {
      return { ok: false, message: '未登记：expected_outputs 必须指向具体文件，不能只给目录。' }
    }
    outputs.push(target)
  }
  return { ok: true, value: outputs }
}

export async function executeDeclareCompletionCriteria(
  args: Record<string, unknown>,
  deps: DeclareCompletionCriteriaDeps,
): Promise<ToolExecutionOutput> {
  const raw = Array.isArray(args.criteria) ? args.criteria : null
  if (!raw || raw.length === 0) {
    return createToolExecutionOutput('未登记：criteria 必须是非空字符串数组。', {
      shape: 'json',
      data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
    })
  }
  if (raw.length > DECLARE_CRITERIA_MAX_ITEMS) {
    return createToolExecutionOutput(`未登记：最多 ${DECLARE_CRITERIA_MAX_ITEMS} 条验收标准（收到 ${raw.length} 条），请合并同类项。`, {
      shape: 'json',
      data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
    })
  }
  const criteria: string[] = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (!text) {
      return createToolExecutionOutput('未登记：存在空白条目，请移除后重试。', {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
    if (text.length > DECLARE_CRITERIA_MAX_ITEM_CHARS) {
      return createToolExecutionOutput(`未登记：单条上限 ${DECLARE_CRITERIA_MAX_ITEM_CHARS} 字符（有一条 ${text.length} 字符），请精简为可验证的一句话。`, {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
    criteria.push(text)
  }

  if (!deps.taskId) {
    // task_context_missing 走 envelope 模式表（/missing/→not_found），无需注册新 kind
    return createToolExecutionOutput('未登记：当前回合没有关联任务，验收标准无处挂靠。', {
      shape: 'json',
      data: { errorKind: 'task_context_missing', toolName: 'declare_completion_criteria' },
    })
  }

  const expectedOutputsResult = normalizeExpectedOutputs(args.expected_outputs)
  if (!expectedOutputsResult.ok) {
    return createToolExecutionOutput(expectedOutputsResult.message, {
      shape: 'json',
      data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
    })
  }
  const intent = args.folder_output_intent
  let folderOutputIntent: 'create' | 'save' | 'export' | 'no_write' | null = null
  let destinationResourceId: string | null = null
  if (deps.outputContract) {
    if (!['create', 'save', 'export', 'no_write'].includes(String(intent))) {
      return createToolExecutionOutput('未登记：当前回合有目标文件夹，必须明确 folder_output_intent。', {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
    folderOutputIntent = intent as typeof folderOutputIntent
    destinationResourceId = deps.outputContract.destinationResourceId
    if (folderOutputIntent === 'no_write' && expectedOutputsResult.value.length > 0) {
      return createToolExecutionOutput('未登记：no_write 不能同时声明 expected_outputs。', {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
    if (folderOutputIntent !== 'no_write' && expectedOutputsResult.value.length === 0) {
      return createToolExecutionOutput('未登记：写入目标文件夹时必须声明至少一个 expected_outputs。', {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
    if (expectedOutputsResult.value.length > deps.outputContract.maxExpectedOutputs
      || expectedOutputsResult.value.some((target) => (
        target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
        || target.split(/[\\/]/).some((part) => part === '..')
      ))) {
      return createToolExecutionOutput('未登记：目标文件必须是冻结目标文件夹内的相对路径。', {
        shape: 'json',
        data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
      })
    }
  } else if (intent !== undefined) {
    return createToolExecutionOutput('未登记：当前回合没有冻结的目标文件夹。', {
      shape: 'json',
      data: { errorKind: 'input_validation', toolName: 'declare_completion_criteria' },
    })
  }

  // The open document is edited in place and saved through its tab; folder delivery would prove a second copy.
  const documentFile = deps.outputContract?.currentDocumentFile
  const documentOutputs = documentFile
    ? expectedOutputsResult.value.filter((target) => isCurrentDocumentFile(documentFile, target))
    : []
  const expectedOutputs = expectedOutputsResult.value.filter((target) => !documentOutputs.includes(target))
  if (documentOutputs.length > 0 && expectedOutputs.length === 0) folderOutputIntent = 'no_write'
  const documentNote = documentOutputs.length > 0
    ? `「${documentOutputs.join('、')}」就是当前打开的文档：用 document_* 工具直接修改，改完用 document_save_tab 保存回原文件，不作为文件夹交付登记。`
    : ''

  await deps.updateTaskCompletionDeclaration(deps.taskId, {
    modelCriteria: criteria,
    expectedOutputs,
  })
  logAgentMetric('model_criteria_declared', {
    taskId: deps.taskId,
    sessionId: deps.sessionId || null,
    count: criteria.length,
  })
  logAgentMetric('expected_outputs_declared', {
    taskId: deps.taskId,
    sessionId: deps.sessionId || null,
    count: expectedOutputs.length,
  })
  return createToolExecutionOutput(
    `${documentNote}已登记 ${criteria.length} 条补充验收标准（整组替换）。具体文件目标会由系统逐一核对；登记动作本身不会冒充完成证明。`,
    {
      shape: 'json',
      data: {
        ok: true,
        count: criteria.length,
        criteria,
        expectedOutputs,
        ...(folderOutputIntent ? { folderOutputIntent, destinationResourceId } : {}),
      },
    },
  )
}
