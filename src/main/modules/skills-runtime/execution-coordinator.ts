import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type {
  ExecutionBlocker,
  SkillActionResult,
  SkillDefinition,
  SkillExecutionDetail,
  SkillExecutionState,
  SkillInputValue,
  SkillStep,
} from '../../../shared/skill-execution-types'
import { assertWorkflowSkill, getSkillStep } from './guardrails'
import { ExecutionStateStore } from './execution-state-store'
import {
  buildAgentTaskBlocker,
  buildConfirmationBlocker,
  buildInputBlocker,
  resolveMissingInputs,
  resolveNextStepId,
  resolveStepRuntimeArgs,
} from './next-action-resolver'

interface RuntimeExecutor {
  executeRuntimeAction(params: {
    definition: SkillDefinition
    actionName: string
    step: SkillStep
    args: Record<string, SkillInputValue>
    sessionId?: string | null
  }): Promise<SkillActionResult>
}

function ensureStep(definition: SkillDefinition, stepId: string | null | undefined): SkillStep {
  if (!stepId) {
    throw new Error(`Skill ${definition.id} has no active step`)
  }
  const step = getSkillStep(definition, stepId)
  if (!step) {
    throw new Error(`Unknown step ${stepId} for skill ${definition.id}`)
  }
  return step
}

function ensureOutputPresent(result: SkillActionResult, step: SkillStep): void {
  const criteria = step.successCriteria || []
  for (const criterion of criteria) {
    if (criterion.type === 'output_present' && !(criterion.outputKey in result.outputs)) {
      throw new Error(`Step ${step.id} missing required output: ${criterion.outputKey}`)
    }
  }
}

function mergeStepOutputs(state: SkillExecutionState, stepId: string, outputs: Record<string, SkillInputValue>): SkillExecutionState {
  return {
    ...state,
    stepOutputs: {
      ...state.stepOutputs,
      [stepId]: {
        ...(state.stepOutputs[stepId] || {}),
        ...outputs,
      },
    },
  }
}

function resolveExecutionOutputDir(state: SkillExecutionState, outputsRoot: string): string {
  const explicitInput = typeof state.inputs.outputDir === 'string' ? state.inputs.outputDir : ''
  if (explicitInput) {
    mkdirSync(explicitInput, { recursive: true })
    return explicitInput
  }
  for (const outputs of Object.values(state.stepOutputs)) {
    if (typeof outputs.outputDir === 'string' && outputs.outputDir) {
      mkdirSync(outputs.outputDir, { recursive: true })
      return outputs.outputDir
    }
  }
  const fallback = join(outputsRoot, state.skillId, state.id)
  mkdirSync(fallback, { recursive: true })
  return fallback
}

function applyTemplate(template: string, state: SkillExecutionState, outputsRoot: string): string {
  const outputDir = resolveExecutionOutputDir(state, outputsRoot)
  return template
    .replace(/\{\{executionId\}\}/g, state.id)
    .replace(/\{\{skillId\}\}/g, state.skillId)
    .replace(/\{\{executionOutputDir\}\}/g, outputDir)
}

export class ExecutionCoordinator {
  constructor(
    private readonly store: ExecutionStateStore,
    private readonly runtimeExecutor: RuntimeExecutor,
    private readonly outputsRoot: string,
  ) {}

  async startExecution(params: {
    definition: SkillDefinition
    entryAction: string
    inputs?: Record<string, SkillInputValue>
    sessionId?: string | null
  }): Promise<SkillExecutionDetail> {
    assertWorkflowSkill(params.definition)
    const created = this.store.createExecution({
      definition: params.definition,
      entryAction: params.entryAction,
      sessionId: params.sessionId,
      inputs: params.inputs,
    })
    return this.runUntilBlocked(created.id)
  }

  async runUntilBlocked(executionId: string): Promise<SkillExecutionDetail> {
    const initialDetail = this.store.getExecution(executionId)
    if (!initialDetail) {
      throw new Error(`Execution not found: ${executionId}`)
    }
    let state: SkillExecutionState = initialDetail

    let safetyCounter = 0
    while (state.status === 'running' && safetyCounter < 24) {
      safetyCounter += 1
      const step = ensureStep(state.compiledSkill, state.currentStepId)
      const missingInputs = resolveMissingInputs(state, step)
      if (missingInputs.length > 0) {
        const blocked = buildInputBlocker(state, step, missingInputs)
        state = this.store.updateExecution({ ...state, status: 'blocked', blocker: blocked.blocker, lastFrame: blocked.frame })
        break
      }

      if (step.action.type === 'user_input') {
        const nextStepId = resolveNextStepId(state, step, true)
        state = this.store.updateExecution(
          mergeStepOutputs({
            ...state,
            currentStepId: nextStepId,
            blocker: null,
            lastFrame: null,
            status: nextStepId ? 'running' : 'completed',
          }, step.id, {}),
        )
        continue
      }

      if (step.action.type === 'confirmation') {
        if (state.confirmations[step.id] !== true) {
          const blocked = buildConfirmationBlocker(state, step)
          state = this.store.updateExecution({ ...state, status: 'blocked', blocker: blocked.blocker, lastFrame: blocked.frame })
          break
        }
        const nextStepId = resolveNextStepId(state, step, true)
        state = this.store.updateExecution(
          mergeStepOutputs({
            ...state,
            currentStepId: nextStepId,
            blocker: null,
            lastFrame: null,
            status: nextStepId ? 'running' : 'completed',
          }, step.id, { confirmed: true }),
        )
        continue
      }

      if (step.action.type === 'agent_task') {
        if (state.stepOutputs[step.id]) {
          const nextStepId = resolveNextStepId(state, step, true)
          state = this.store.updateExecution({
            ...state,
            currentStepId: nextStepId,
            blocker: null,
            lastFrame: null,
            status: nextStepId ? 'running' : 'completed',
          })
          continue
        }
        const blocked = buildAgentTaskBlocker(state, step)
        state = this.store.updateExecution({ ...state, status: 'blocked', blocker: blocked.blocker, lastFrame: blocked.frame })
        break
      }

      const stepRecord = this.store.recordStepStart(state.id, step.id)
      try {
        const args = resolveStepRuntimeArgs(step, state)
        const result = await this.runtimeExecutor.executeRuntimeAction({
          definition: state.compiledSkill,
          actionName: step.action.actionName,
          step,
          args,
          sessionId: state.sessionId,
        })
        if (!result.ok || result.status !== 'success') {
          throw new Error(result.error?.message || `Step ${step.id} failed`)
        }
        ensureOutputPresent(result, step)
        this.store.recordStepFinish(stepRecord.id, 'success', result, null)
        this.store.addArtifacts(state.id, step.id, result.artifacts || [])
        const nextStepId = resolveNextStepId(state, step, true)
        state = this.store.updateExecution(
          mergeStepOutputs({
            ...state,
            currentStepId: nextStepId,
            blocker: null,
            lastFrame: null,
            status: nextStepId ? 'running' : 'completed',
          }, step.id, result.outputs),
        )
        continue
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.recordStepFinish(stepRecord.id, 'failed', null, message)
        const blocker: ExecutionBlocker = {
          type: 'failed',
          executionId: state.id,
          skillId: state.skillId,
          stepId: step.id,
          message,
        }
        state = this.store.updateExecution({
          ...state,
          status: 'failed',
          blocker,
          lastFrame: null,
          errors: [
            ...state.errors,
            {
              stepId: step.id,
              message,
              timestamp: new Date().toISOString(),
            },
          ],
        })
        break
      }
    }

    const refreshed = this.store.getExecution(executionId)
    if (!refreshed) {
      throw new Error(`Execution not found after run: ${executionId}`)
    }
    state = refreshed
    if (state.status === 'completed' && (!state.blocker || state.blocker.type !== 'completed')) {
      state = this.store.updateExecution({
        ...state,
        blocker: {
          type: 'completed',
          executionId: state.id,
          skillId: state.skillId,
          stepId: state.currentStepId || undefined,
          message: 'Skill execution completed',
        },
      })
    }
    return this.store.getExecution(executionId) as SkillExecutionDetail
  }

  async submitInput(executionId: string, inputs: Record<string, SkillInputValue>): Promise<SkillExecutionDetail> {
    const detail = this.store.getExecution(executionId)
    if (!detail) throw new Error(`Execution not found: ${executionId}`)
    this.store.updateExecution({
      ...detail,
      status: 'running',
      blocker: null,
      lastFrame: null,
      inputs: {
        ...detail.inputs,
        ...inputs,
      },
    })
    return this.runUntilBlocked(executionId)
  }

  async submitConfirmation(executionId: string, stepId: string, confirmed: boolean): Promise<SkillExecutionDetail> {
    const detail = this.store.getExecution(executionId)
    if (!detail) throw new Error(`Execution not found: ${executionId}`)
    if (!confirmed) {
      const next = this.store.updateExecution({
        ...detail,
        status: 'failed',
        blocker: {
          type: 'failed',
          executionId,
          skillId: detail.skillId,
          stepId,
          message: `Confirmation rejected at step ${stepId}`,
        },
        errors: [
          ...detail.errors,
          { stepId, message: `Confirmation rejected at step ${stepId}`, timestamp: new Date().toISOString() },
        ],
      })
      return this.store.getExecution(next.id) as SkillExecutionDetail
    }
    this.store.updateExecution({
      ...detail,
      status: 'running',
      blocker: null,
      lastFrame: null,
      confirmations: {
        ...detail.confirmations,
        [stepId]: true,
      },
    })
    return this.runUntilBlocked(executionId)
  }

  async submitAgentResult(params: {
    executionId: string
    stepId: string
    textContent?: string
    outputs?: Record<string, SkillInputValue>
  }): Promise<SkillExecutionDetail> {
    const detail = this.store.getExecution(params.executionId)
    if (!detail) throw new Error(`Execution not found: ${params.executionId}`)
    const step = ensureStep(detail.compiledSkill, params.stepId)
    if (step.action.type !== 'agent_task') {
      throw new Error(`Step ${params.stepId} is not an agent task`)
    }

    const outputs: Record<string, SkillInputValue> = { ...(params.outputs || {}) }
    const artifacts: Array<{ id: string; label: string; kind: string; path: string; mimeType?: string }> = []
    for (const file of step.action.generatedFiles || []) {
      if (!params.textContent) continue
      const path = applyTemplate(file.pathTemplate, detail, this.outputsRoot)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, params.textContent, 'utf-8')
      outputs[file.outputKey] = path
      artifacts.push({
        id: randomUUID(),
        label: file.description || file.outputKey,
        kind: 'generated_file',
        path,
        mimeType: file.mimeType,
      })
    }
    if (step.action.outputKey && params.textContent) {
      outputs[step.action.outputKey] = params.textContent
    }
    if (params.textContent && !step.action.outputKey && (step.action.generatedFiles || []).length === 0) {
      outputs.textContent = params.textContent
    }

    this.store.addArtifacts(detail.id, step.id, artifacts)
    this.store.updateExecution(
      mergeStepOutputs({
        ...detail,
        status: 'running',
        blocker: null,
        lastFrame: null,
      }, step.id, outputs),
    )
    return this.runUntilBlocked(params.executionId)
  }

  async restartFromStep(executionId: string, stepId: string, inputs?: Record<string, SkillInputValue>): Promise<SkillExecutionDetail> {
    const reset = this.store.resetFromStep(executionId, stepId)
    if (!reset) throw new Error(`Unable to restart execution ${executionId} from step ${stepId}`)
    if (inputs && Object.keys(inputs).length > 0) {
      this.store.updateExecution({
        ...reset,
        inputs: {
          ...reset.inputs,
          ...inputs,
        },
      })
    }
    return this.runUntilBlocked(executionId)
  }

  cancelExecution(executionId: string): SkillExecutionDetail | null {
    const next = this.store.cancelExecution(executionId)
    if (!next) return null
    return this.store.getExecution(executionId)
  }
}
