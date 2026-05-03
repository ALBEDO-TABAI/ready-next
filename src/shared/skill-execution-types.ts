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

export interface SkillChildLoopDefinition {
  version: number
  actions: string[]
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
  /**
   * Optional Skill Host Contract requirements. Validated at manifest-load time
   * by `SkillHostRequirementsSchema` (see `src/shared/skill-host-contract.ts`).
   * Null/undefined when the manifest does not opt into the host contract.
   * Imported as a structural type to avoid pulling the Zod schema into shared.
   */
  hostRequirements?: import('./skill-host-contract').SkillHostRequirements
  /**
   * Declarative child-loop ownership contract. Skills that launch durable
   * child runs declare the typed actions here; Ready core must consult this
   * contract instead of carrying per-skill action tables.
   */
  childLoop?: SkillChildLoopDefinition
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

// Phase 4: ExecutionFrame / ExecutionBlocker / ExecutionBlockerInputField /
// SkillExecutionError / SkillExecutionStepRecord / SkillExecutionState /
// SkillExecutionDetail retired along with the skill_executions state machine.
// The in-memory SkillTaskTracker (PR2) replaces the persistent projection
// model; ephemeral ask_user state is tracked by EphemeralExecutionStore
// instead of these types.
