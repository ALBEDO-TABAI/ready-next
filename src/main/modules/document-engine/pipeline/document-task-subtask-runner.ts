import type { DocumentTaskJob, DocumentTaskPlan } from './document-task-plan'
import type { SubtaskInlineWorkerResult, SubtaskInlineWorkerUpdate } from '../../agent-control/contracts/run-contracts'
import { SubtaskRuntime } from '../../agent-control/runtime-core/subtask-runtime'
import { buildWorkerOverviewSteps, buildWorkerParentProjectionPatch } from '../../agent-control/worker-projection'
import type { ConversationScope, ScopeRunEventPayload, ScopeRunTaskStep } from '../../agent-control/contracts/types'

interface DocumentTaskSubtaskJobResult extends SubtaskInlineWorkerResult {
  writeSummary: string
  saveSummary: string
  verifySummary: string
}

interface DocumentTaskSubtaskRunnerResult {
  success: boolean
  finalText?: string
  error?: string
  results?: Array<{
    job: DocumentTaskJob
    writeSummary: string
    saveSummary: string
    verifySummary: string
  }>
}

function getDocumentTaskJobTarget(job: DocumentTaskJob) {
  return job.bindings.find((binding) => binding.role === 'target_document')?.resource || null
}

function getDocumentTaskJobSources(job: DocumentTaskJob) {
  return job.bindings
    .filter((binding) => binding.role === 'primary_source' || binding.role === 'secondary_source')
    .map((binding) => binding.resource)
}

function buildOverviewStepTitle(job: DocumentTaskJob, jobIndex: number, totalJobs: number): string {
  const sources = getDocumentTaskJobSources(job)
  const target = getDocumentTaskJobTarget(job)
  const sourceLabel = sources.map((resource) => resource.name).join(' + ') || '材料'
  const targetLabel = target?.name || '目标文档'
  const prefix = totalJobs > 1 ? `${jobIndex + 1}. ` : ''
  return `${prefix}${sourceLabel} -> ${targetLabel}`
}

function buildChildTaskTitle(job: DocumentTaskJob, jobIndex: number, totalJobs: number): string {
  const sources = getDocumentTaskJobSources(job)
  const target = getDocumentTaskJobTarget(job)
  const sourceLabel = sources.map((resource) => resource.name).join(' + ') || '材料'
  const targetLabel = target?.name || '目标文档'
  const prefix = totalJobs > 1 ? `${jobIndex + 1}. ` : ''
  return `${prefix}文档子任务：${sourceLabel} -> ${targetLabel}`
}

function buildChildInitialSteps(): ScopeRunTaskStep[] {
  const updatedAt = new Date().toISOString()
  return [
    { id: 'collect_materials', title: '读取来源材料', status: 'pending', updatedAt },
    { id: 'build_insight', title: '提炼重点', status: 'pending', updatedAt },
    { id: 'compose_widget', title: '生成卡片草稿', status: 'pending', updatedAt },
    { id: 'write_target', title: '写入目标文档', status: 'pending', updatedAt },
    { id: 'save_target', title: '保存目标文档', status: 'pending', updatedAt },
    { id: 'verify_result', title: '核对结果', status: 'pending', updatedAt },
  ]
}

export async function runDocumentTaskPlanWithSubtasks(params: {
  plan: DocumentTaskPlan
  scope: ConversationScope
  parentTaskId: string
  parentRunId?: string | null
  taskTitle?: string
  subtaskRuntime: SubtaskRuntime
  emitStructuredTaskPayload: (payload: Record<string, unknown>) => void
  publishParentScopeRunEvent?: (payload: ScopeRunEventPayload) => Promise<void> | void
  runJob: (params: {
    job: DocumentTaskJob
    jobIndex: number
    totalJobs: number
    emitChildUpdate: (payload: SubtaskInlineWorkerUpdate) => void
  }) => Promise<DocumentTaskSubtaskJobResult>
}): Promise<DocumentTaskSubtaskRunnerResult> {
  const taskTitle = params.taskTitle || '文档信息卡'
  if (params.plan.blockedReason) {
    params.emitStructuredTaskPayload({
      module: 'document',
      taskTitle,
      taskSummary: params.plan.blockedReason,
      blockedReason: params.plan.blockedReason,
      waitingFor: 'confirmation',
      resumableActions: ['continue', 'cancel'],
    })
    return {
      success: false,
      error: params.plan.blockedReason,
      finalText: params.plan.blockedReason,
    }
  }

  if (params.plan.jobs.length === 0) {
    return {
      success: false,
      error: '当前没有可执行的文档任务计划',
    }
  }

  if (params.plan.jobs.length === 1) {
    const inlineResult = await params.runJob({
      job: params.plan.jobs[0],
      jobIndex: 0,
      totalJobs: 1,
      emitChildUpdate: () => {},
    })
    return {
      success: true,
      finalText: inlineResult.finalText || inlineResult.verifySummary,
      results: [{
        job: params.plan.jobs[0],
        writeSummary: inlineResult.writeSummary,
        saveSummary: inlineResult.saveSummary,
        verifySummary: inlineResult.verifySummary,
      }],
    }
  }

  const overviewItems = params.plan.jobs.map((job, index) => ({
    id: job.id,
    title: buildOverviewStepTitle(job, index, params.plan.jobs.length),
  }))
  const completedStepIds: string[] = []
  const results: DocumentTaskSubtaskRunnerResult['results'] = []

  const emitParentUpdate = async (payload: {
    summary: string
    currentStepId?: string | null
    blockedStepId?: string | null
    blockedReason?: string | null
    waitingFor?: ScopeRunEventPayload['waitingFor']
    resumableActions?: ScopeRunEventPayload['resumableActions']
  }): Promise<void> => {
    const steps = buildWorkerOverviewSteps({
      items: overviewItems,
      currentStepId: payload.currentStepId || null,
      completedStepIds,
      blockedStepId: payload.blockedStepId || null,
    })
    const patch = buildWorkerParentProjectionPatch({
      taskTitle,
      taskSummary: payload.summary,
      steps,
      currentStepId: payload.currentStepId || null,
      waitingFor: payload.waitingFor || 'none',
      resumableActions: payload.resumableActions || ['cancel'],
      blockedReason: payload.blockedReason || null,
    })
    params.emitStructuredTaskPayload({
      module: 'document',
      taskType: 'multi_step_task',
      interactionState: 'running',
      ...patch,
    })
    await params.publishParentScopeRunEvent?.({
      type: 'updated',
      scopeId: params.scope.id,
      agent: params.scope.agent,
      runId: params.parentRunId || undefined,
      taskId: params.parentTaskId,
      phase: 'tool_running',
      module: 'document',
      taskTitle,
      taskSummary: payload.summary,
      taskType: 'multi_step_task',
      interactionState: 'running',
      steps,
      currentStepId: payload.currentStepId || null,
      waitingFor: payload.waitingFor || 'none',
      resumableActions: payload.resumableActions || ['cancel'],
      blockedReason: payload.blockedReason || null,
      taskProjectionId: params.parentTaskId,
      timestamp: new Date().toISOString(),
    })
  }

  for (const [jobIndex, job] of params.plan.jobs.entries()) {
    await emitParentUpdate({
      summary: `正在处理第 ${jobIndex + 1} 个文档子任务`,
      currentStepId: job.id,
      resumableActions: ['cancel'],
    })

    let jobResult: DocumentTaskSubtaskJobResult | null = null
    const childResult = await params.subtaskRuntime.runInlineWorker({
      scope: params.scope,
      parentTaskId: params.parentTaskId,
      parentStepId: job.id,
      taskTitle: buildChildTaskTitle(job, jobIndex, params.plan.jobs.length),
      module: 'document',
      taskType: 'multi_step_task',
      initialSummary: `准备处理第 ${jobIndex + 1} 个文档子任务`,
      initialSteps: buildChildInitialSteps(),
      runInlineWorker: async ({ emitUpdate }) => {
        jobResult = await params.runJob({
          job,
          jobIndex,
          totalJobs: params.plan.jobs.length,
          emitChildUpdate: emitUpdate,
        })
        return jobResult
      },
    })

    if (childResult.status !== 'done') {
      await emitParentUpdate({
        summary: childResult.error || `第 ${jobIndex + 1} 个文档子任务失败`,
        currentStepId: job.id,
        blockedStepId: job.id,
        blockedReason: childResult.error || `第 ${jobIndex + 1} 个文档子任务失败`,
        resumableActions: ['retry', 'cancel'],
      })
      return {
        success: false,
        error: childResult.error || `第 ${jobIndex + 1} 个文档子任务失败`,
        results,
      }
    }

    completedStepIds.push(job.id)
    const completedJobResult = jobResult || {
      writeSummary: '',
      saveSummary: '',
      verifySummary: childResult.finalText || '',
    }
    results.push({
      job,
      writeSummary: completedJobResult.writeSummary,
      saveSummary: completedJobResult.saveSummary,
      verifySummary: completedJobResult.verifySummary,
    })
  }

  await emitParentUpdate({
    summary: `已完成 ${params.plan.jobs.length} 个文档子任务`,
    currentStepId: params.plan.jobs.at(-1)?.id || null,
    resumableActions: ['none'],
  })

  return {
    success: true,
    finalText: `已完成 ${params.plan.jobs.length} 个文档子任务`,
    results,
  }
}
