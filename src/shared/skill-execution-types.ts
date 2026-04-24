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
  items?: Record<string, unknown>
  additionalProperties?: boolean
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

// B Phase 4 PR3: the retired state-machine types —
// `SkillSourceMaterial / ExecutionFrame / ExecutionBlockerInputField /
// ExecutionBlocker / SkillExecutionError / SkillExecutionStepRecord /
// SkillExecutionState / SkillExecutionDetail` — have been deleted.
// `SkillWorkflow` / `SkillStep*` / `SkillActionResult` / `SkillArtifact`
// / `SkillGeneratedFileDefinition` / `SkillValueSourceRef` etc. still
// surface through `skill-compiler.ts` manifest normalization and the
// direct-run structured-result path in `runtime-manager.ts`, so those
// remain. If a future refactor drops those consumers too, retire the
// types together with the callers.
