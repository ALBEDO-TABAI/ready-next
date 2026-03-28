export type SkillSource = 'embedded' | 'custom'
export type SkillRuntimeKind = 'python' | 'node' | 'shell' | 'reference'
export type SkillExecutionMode = 'advisory' | 'workflow' | 'direct'
export type SkillActionVisibility = 'public' | 'internal'
export type SkillInputValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  | boolean[]
  | Record<string, unknown>
  | Array<Record<string, unknown>>

export interface SkillParamDefinition {
  name: string
  type: string
  description: string
  required: boolean
  enum?: string[]
}

export interface SkillActionDefinition {
  name: string
  description: string
  runtime: SkillRuntimeKind
  entry: string
  timeoutMs?: number
  params: SkillParamDefinition[]
  baseArgs?: string[]
  inputMode?: 'flags' | 'json'
  visibility?: SkillActionVisibility
}

export interface SkillInputDefinition {
  key: string
  label?: string
  description: string
  type: string
  required?: boolean
  enum?: string[]
  defaultValue?: SkillInputValue
}

export interface SkillValueSourceRef {
  source: 'input' | 'output' | 'literal'
  key?: string
  stepId?: string
  value?: SkillInputValue
}

export interface SkillGeneratedFileDefinition {
  outputKey: string
  pathTemplate: string
  description?: string
  mimeType?: string
}

export interface SkillRuntimeCallAction {
  type: 'runtime_call'
  actionName: string
  args?: Record<string, SkillInputValue | SkillValueSourceRef>
}

export interface SkillAgentTaskAction {
  type: 'agent_task'
  prompt: string
  outputKey?: string
  generatedFiles?: SkillGeneratedFileDefinition[]
}

export interface SkillUserInputAction {
  type: 'user_input'
  inputKeys?: string[]
  prompt?: string
}

export interface SkillConfirmationAction {
  type: 'confirmation'
  message: string
  confirmLabel?: string
  denyLabel?: string
}

export type SkillStepAction =
  | SkillRuntimeCallAction
  | SkillAgentTaskAction
  | SkillUserInputAction
  | SkillConfirmationAction

export interface SkillOutputDefinition {
  key: string
  type: string
  required?: boolean
  description?: string
}

export interface SkillStepOutputContract {
  outputs: SkillOutputDefinition[]
}

export interface SkillSuccessCriterion {
  type: 'output_present'
  outputKey: string
}

export interface SkillNextStepDefinition {
  condition: 'success' | 'failure'
  targetStepId?: string
}

export interface SkillStep {
  id: string
  name: string
  description: string
  prerequisites?: string[]
  requiredInputs?: string[]
  action: SkillStepAction
  successCriteria?: SkillSuccessCriterion[]
  outputContract?: SkillStepOutputContract
  nextSteps?: SkillNextStepDefinition[]
}

export interface SkillWorkflow {
  version: string
  autoAdvance: boolean
  initialStep: string
  finalStep?: string
  inputs: SkillInputDefinition[]
  steps: SkillStep[]
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  version: string
  source: SkillSource
  sourcePath: string
  managedPath?: string
  manifestPath?: string
  documentEntry?: string
  requirementsFile?: string
  defaultAction?: string
  actions: SkillActionDefinition[]
  executionMode: SkillExecutionMode
  workflow?: SkillWorkflow
  manifestValid: boolean
}

export interface SkillArtifact {
  id: string
  label?: string
  kind?: string
  path?: string
  mimeType?: string
  metadata?: Record<string, unknown>
}

export interface SkillActionResult {
  ok: boolean
  status: 'success' | 'failed'
  outputs: Record<string, SkillInputValue>
  artifacts: SkillArtifact[]
  logs: {
    stdout: string
    stderr: string
  }
  error?: {
    message: string
  }
}

export interface SkillSourceMaterial {
  key: string
  path: string
  content: string
}

export interface ExecutionFrame {
  executionId: string
  skillId: string
  stepId: string
  title: string
  description: string
  prompt?: string
  sourceMaterials?: SkillSourceMaterial[]
}

export interface ExecutionBlockerInputField {
  key: string
  label?: string
  description: string
  required?: boolean
  type: string
  enum?: string[]
}

export interface ExecutionBlocker {
  type: 'need_input' | 'need_confirmation' | 'need_agent_result' | 'completed' | 'failed'
  executionId: string
  skillId: string
  stepId?: string
  message: string
  inputs?: ExecutionBlockerInputField[]
  confirmation?: {
    confirmLabel?: string
    denyLabel?: string
  }
  agentTask?: {
    prompt: string
    outputKey?: string
    generatedFiles?: SkillGeneratedFileDefinition[]
    sourceMaterials?: SkillSourceMaterial[]
  }
}

export interface SkillExecutionError {
  stepId?: string
  message: string
  timestamp: string
}

export interface SkillExecutionStepRecord {
  id: string
  executionId: string
  stepId: string
  attempt: number
  status: 'running' | 'success' | 'failed' | 'blocked' | 'cancelled'
  startedAt: string
  finishedAt?: string | null
  result?: SkillActionResult | null
  message?: string | null
}

export interface SkillExecutionState {
  id: string
  skillId: string
  entryAction: string
  sessionId?: string | null
  source: SkillSource
  status: 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  updatedAt: string
  finishedAt?: string | null
  currentStepId?: string | null
  compiledSkill: SkillDefinition
  blocker?: ExecutionBlocker | null
  lastFrame?: ExecutionFrame | null
  errors: SkillExecutionError[]
  stepOutputs: Record<string, Record<string, SkillInputValue>>
  confirmations: Record<string, boolean>
  inputs: Record<string, SkillInputValue>
}

export interface SkillExecutionDetail extends SkillExecutionState {
  steps: SkillExecutionStepRecord[]
  artifacts: SkillArtifact[]
}
