import { existsSync, readFileSync } from 'fs'
import { extname } from 'path'
import type {
  ExecutionBlocker,
  SkillAgentTaskAction,
  SkillExecutionState,
  SkillInputDefinition,
  SkillInputValue,
  SkillSourceMaterial,
  SkillStep,
  SkillValueSourceRef,
} from '../../../shared/skill-execution-types'
import { buildExecutionFrame, buildSkillAgentPrompt } from './skill-prompt-builder'

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.srt', '.csv'])

function isSourceRef(value: unknown): value is SkillValueSourceRef {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'source' in (value as Record<string, unknown>) &&
    (value as Record<string, unknown>).source &&
    ['input', 'output', 'literal'].includes(String((value as Record<string, unknown>).source)),
  )
}

function isMissingValue(value: SkillInputValue | undefined): boolean {
  return value === undefined || value === null || value === ''
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8').slice(0, 8_000)
  } catch {
    return ''
  }
}

export function resolveStepRuntimeArgs(
  step: SkillStep,
  state: SkillExecutionState,
): Record<string, SkillInputValue> {
  if (step.action.type !== 'runtime_call' || !step.action.args) return {}
  return Object.fromEntries(
    Object.entries(step.action.args).map(([key, value]) => {
      if (!isSourceRef(value)) {
        return [key, value as SkillInputValue]
      }
      if (value.source === 'literal') {
        return [key, value.value as SkillInputValue]
      }
      if (value.source === 'input') {
        return [key, state.inputs[value.key || key]]
      }
      const outputs = value.stepId ? state.stepOutputs[value.stepId] : state.stepOutputs[step.id]
      return [key, outputs?.[value.key || key]]
    }),
  )
}

export function collectSourceMaterials(state: SkillExecutionState): SkillSourceMaterial[] {
  const materials: SkillSourceMaterial[] = []
  for (const [stepId, outputs] of Object.entries(state.stepOutputs)) {
    for (const [key, value] of Object.entries(outputs)) {
      if (typeof value !== 'string') continue
      if (!existsSync(value)) continue
      if (!TEXT_EXTENSIONS.has(extname(value).toLowerCase())) continue
      const content = readTextFile(value)
      if (!content) continue
      materials.push({
        key: `${stepId}.${key}`,
        path: value,
        content,
      })
    }
  }
  return materials
}

function toBlockerInputs(inputs: SkillInputDefinition[], requiredKeys: string[]): ExecutionBlocker['inputs'] {
  const target = inputs.filter((input) => requiredKeys.includes(input.key))
  return target.map((input) => ({
    key: input.key,
    label: input.label,
    description: input.description,
    required: input.required,
    type: input.type,
    enum: input.enum,
  }))
}

export function buildInputBlocker(
  state: SkillExecutionState,
  step: SkillStep,
  missingKeys: string[],
): { blocker: ExecutionBlocker; frame: SkillExecutionState['lastFrame'] } {
  const blocker: ExecutionBlocker = {
    type: 'need_input',
    executionId: state.id,
    skillId: state.skillId,
    stepId: step.id,
    message: `步骤 ${step.name} 缺少继续执行所需输入`,
    inputs: toBlockerInputs(state.compiledSkill.workflow?.inputs || [], missingKeys),
  }
  return {
    blocker,
    frame: buildExecutionFrame({
      executionId: state.id,
      skillId: state.skillId,
      stepId: step.id,
      title: step.name,
      description: blocker.message,
    }),
  }
}

export function resolveMissingInputs(state: SkillExecutionState, step: SkillStep): string[] {
  const requiredKeys = new Set<string>(step.requiredInputs || [])
  if (step.action.type === 'user_input') {
    for (const key of step.action.inputKeys || []) requiredKeys.add(key)
  }
  return Array.from(requiredKeys).filter((key) => isMissingValue(state.inputs[key]))
}

export function buildConfirmationBlocker(state: SkillExecutionState, step: SkillStep): { blocker: ExecutionBlocker; frame: SkillExecutionState['lastFrame'] } {
  if (step.action.type !== 'confirmation') {
    throw new Error(`Step ${step.id} is not a confirmation step`)
  }
  const blocker: ExecutionBlocker = {
    type: 'need_confirmation',
    executionId: state.id,
    skillId: state.skillId,
    stepId: step.id,
    message: step.action.message,
    confirmation: {
      confirmLabel: step.action.confirmLabel,
      denyLabel: step.action.denyLabel,
    },
  }
  return {
    blocker,
    frame: buildExecutionFrame({
      executionId: state.id,
      skillId: state.skillId,
      stepId: step.id,
      title: step.name,
      description: step.description || step.action.message,
    }),
  }
}

export function buildAgentTaskBlocker(state: SkillExecutionState, step: SkillStep): { blocker: ExecutionBlocker; frame: SkillExecutionState['lastFrame'] } {
  if (step.action.type !== 'agent_task') {
    throw new Error(`Step ${step.id} is not an agent task step`)
  }
  const action = step.action as SkillAgentTaskAction
  const sourceMaterials = collectSourceMaterials(state)
  const prompt = buildSkillAgentPrompt({
    stepPrompt: action.prompt,
    generatedFiles: action.generatedFiles,
    sourceMaterials,
  })
  const blocker: ExecutionBlocker = {
    type: 'need_agent_result',
    executionId: state.id,
    skillId: state.skillId,
    stepId: step.id,
    message: `步骤 ${step.name} 需要 Claude 产出结果`,
    agentTask: {
      prompt,
      outputKey: action.outputKey,
      generatedFiles: action.generatedFiles,
      sourceMaterials,
    },
  }
  return {
    blocker,
    frame: buildExecutionFrame({
      executionId: state.id,
      skillId: state.skillId,
      stepId: step.id,
      title: step.name,
      description: step.description,
      prompt,
      sourceMaterials,
    }),
  }
}

export function resolveNextStepId(state: SkillExecutionState, step: SkillStep, success = true): string | null {
  const condition = success ? 'success' : 'failure'
  const explicit = step.nextSteps?.find((entry) => entry.condition === condition)
  if (explicit) return explicit.targetStepId || null
  const workflow = state.compiledSkill.workflow
  if (!workflow) return null
  const currentIndex = workflow.steps.findIndex((entry) => entry.id === step.id)
  if (currentIndex < 0) return null
  const next = workflow.steps[currentIndex + 1]
  return next?.id || null
}
