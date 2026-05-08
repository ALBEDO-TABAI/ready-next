import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import type {
  SkillActionDefinition,
  SkillActionVisibility,
  SkillChildLoopDefinition,
  SkillDefinition,
  SkillExecutionMode,
  SkillGeneratedFileDefinition,
  SkillInputDefinition,
  SkillNextStepDefinition,
  SkillParamDefinition,
  SkillRuntimeKind,
  SkillSource,
  SkillStep,
  SkillStepAction,
  SkillSuccessCriterion,
  SkillValueSourceRef,
  SkillWorkflow,
} from '../../../shared/skill-execution-types'
import {
  SkillHostRequirementsSchema,
  type SkillHostRequirements,
} from '../../../shared/skill-host-contract'

const MANIFEST_CANDIDATES = ['ready-skill.json', '.ready-skill.json', 'skill.json', 'manifest.json']
const DOCUMENT_CANDIDATES = ['SKILL.md', 'README.md', 'README.zh-CN.md']

export interface SkillCompilerOptions {
  folderPath: string
  source: SkillSource
  managedPath?: string
  sourcePath?: string
  fallbackMeta?: {
    id?: string
    name?: string
    description?: string
    version?: string
    requirementsFile?: string
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  return undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => asString(item)).filter((item): item is string => Boolean(item))
}

/**
 * Stage S W11.1 — validate manifest `allowed_tools` field.
 *
 * Returns a normalised `string[]` (trimmed, deduped) when the field is
 * a valid array of strings; returns `undefined` when the field is absent.
 * Throws `ManifestValidationError` when the field exists but is not a
 * string array — surface "manifest is malformed" rather than silently
 * dropping the safeguard.
 */
class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestValidationError'
  }
}

function validateAllowedTools(skillId: string, raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new ManifestValidationError(
      `Skill ${skillId} allowed_tools 必须是 string 数组（收到 ${typeof raw}）`,
    )
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (typeof item !== 'string') {
      throw new ManifestValidationError(
        `Skill ${skillId} allowed_tools[${i}] 必须是 string（收到 ${typeof item}）`,
      )
    }
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export { ManifestValidationError, validateAllowedTools }

function findFirstExisting(folderPath: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const resolved = join(folderPath, candidate)
    if (existsSync(resolved)) return candidate
  }
  return null
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
}

function coerceRuntime(value: unknown, fallback: SkillRuntimeKind = 'reference'): SkillRuntimeKind {
  const raw = asString(value)?.toLowerCase()
  if (raw === 'python' || raw === 'node' || raw === 'shell' || raw === 'reference') return raw
  return fallback
}

function coerceVisibility(value: unknown): SkillActionVisibility {
  return asString(value)?.toLowerCase() === 'internal' ? 'internal' : 'public'
}

function normalizeReferenceReadSkillVisibility(action: SkillActionDefinition): SkillActionDefinition {
  if (action.name === 'read_skill' && action.runtime === 'reference') {
    return { ...action, visibility: 'internal' }
  }
  return action
}

function coerceExecutionMode(value: unknown): Exclude<SkillExecutionMode, 'direct'> | undefined {
  const raw = asString(value)?.toLowerCase()
  if (raw === 'advisory' || raw === 'workflow') return raw
  return undefined
}

function normalizeChildLoop(raw: unknown, actions: SkillActionDefinition[], skillId: string): SkillChildLoopDefinition | undefined {
  const obj = asObject(raw)
  if (!obj) return undefined
  const declaredActions = asStringArray(obj.actions)
  if (declaredActions.length === 0) return undefined
  const knownActions = new Set(actions.map((action) => action.name))
  const unknown = declaredActions.filter((action) => !knownActions.has(action))
  if (unknown.length > 0) {
    throw new Error(`Skill ${skillId} child_loop.actions 包含未知 action: ${unknown.join(', ')}`)
  }
  const version = Number(obj.version)
  return {
    version: Number.isFinite(version) && version > 0 ? version : 1,
    actions: Array.from(new Set(declaredActions)),
  }
}

function normalizeParams(raw: unknown): SkillParamDefinition[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => asObject(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => {
        const name = asString(item.name) || ''
        return {
          name,
          type: asString(item.type) || 'string',
          description: asString(item.description) || name,
          required: Boolean(item.required),
          enum: Array.isArray(item.enum) ? item.enum.map((entry) => String(entry)) : undefined,
        } satisfies SkillParamDefinition
      })
      .filter((item) => item.name.length > 0)
  }

  const obj = asObject(raw)
  if (!obj) return []
  const required = new Set(asStringArray(obj.required))
  const properties = asObject(obj.properties) || obj
  return Object.entries(properties).map(([name, value]) => {
    const field = asObject(value)
    return {
      name,
      type: asString(field?.type) || 'string',
      description: asString(field?.description) || name,
      required: required.has(name) || Boolean(field?.required),
      enum: Array.isArray(field?.enum) ? field.enum.map((entry) => String(entry)) : undefined,
    } satisfies SkillParamDefinition
  })
}

function normalizeAction(name: string, raw: unknown, inheritedRuntime: SkillRuntimeKind): SkillActionDefinition | null {
  if (typeof raw === 'string') {
    return {
      name,
      description: `执行 ${name}`,
      runtime: inheritedRuntime,
      entry: raw,
      params: [],
      inputMode: 'flags',
      visibility: 'public',
    }
  }

  const obj = asObject(raw)
  if (!obj) return null
  const entry =
    asString(obj.entry) ||
    asString(obj.script) ||
    asString(obj.path) ||
    asString(obj.file)
  if (!entry) return null

  const timeoutMs = Number(obj.timeoutMs ?? obj.timeout)
  return {
    name,
    description: asString(obj.description) || `执行 ${name}`,
    runtime: coerceRuntime(obj.runtime, inheritedRuntime),
    entry,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1000, Math.round(timeoutMs)) : undefined,
    params: normalizeParams(obj.params ?? obj.input_schema ?? obj.parameters),
    baseArgs: asStringArray(obj.args ?? obj.baseArgs),
    inputMode: asString(obj.inputMode) === 'json' ? 'json' : 'flags',
    visibility: coerceVisibility(obj.visibility),
  }
}

function normalizeActions(raw: unknown, runtime: SkillRuntimeKind, documentEntry?: string): SkillActionDefinition[] {
  const actions: SkillActionDefinition[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const obj = asObject(item)
      const name = asString(obj?.name)
      if (!name) continue
      const normalized = normalizeAction(name, obj, runtime)
      if (normalized) actions.push(normalizeReferenceReadSkillVisibility(normalized))
    }
  } else {
    const obj = asObject(raw)
    if (obj) {
      for (const [name, value] of Object.entries(obj)) {
        const normalized = normalizeAction(name, value, runtime)
        if (normalized) actions.push(normalizeReferenceReadSkillVisibility(normalized))
      }
    }
  }

  if (actions.length === 0 && documentEntry) {
    actions.push(normalizeReferenceReadSkillVisibility({
      name: 'read_skill',
      description: '读取并应用该技能的说明与方法完成当前任务',
      runtime: 'reference',
      entry: documentEntry,
      params: [],
      inputMode: 'flags',
      visibility: 'public',
    }))
  }
  return actions
}

function normalizeInputs(raw: unknown): SkillInputDefinition[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      key: asString(item.key) || asString(item.name) || '',
      label: asString(item.label) || undefined,
      description: asString(item.description) || asString(item.label) || asString(item.name) || '',
      type: asString(item.type) || 'string',
      required: asBoolean(item.required),
      enum: Array.isArray(item.enum) ? item.enum.map((entry) => String(entry)) : undefined,
      defaultValue: (item.defaultValue ?? item.default_value) as SkillInputDefinition['defaultValue'],
    }))
    .filter((item) => item.key.length > 0)
}

function normalizeValueSource(raw: unknown): SkillValueSourceRef | undefined {
  const obj = asObject(raw)
  if (!obj) return undefined
  const source = asString(obj.source)
  if (source !== 'input' && source !== 'output' && source !== 'literal') return undefined
  return {
    source,
    key: asString(obj.key) || undefined,
    stepId: asString(obj.stepId) || asString(obj.step_id) || undefined,
    value: (obj.value ?? obj.literal) as SkillValueSourceRef['value'],
  }
}

function normalizeGeneratedFiles(raw: unknown): SkillGeneratedFileDefinition[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const files = raw
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      outputKey: asString(item.outputKey) || asString(item.key) || '',
      pathTemplate: asString(item.pathTemplate) || asString(item.path_template) || '',
      description: asString(item.description) || undefined,
      mimeType: asString(item.mimeType) || asString(item.mime_type) || undefined,
    }))
    .filter((item) => item.outputKey.length > 0 && item.pathTemplate.length > 0)
  return files.length > 0 ? files : undefined
}

function normalizeStepAction(raw: unknown): SkillStepAction {
  const obj = asObject(raw)
  const type = asString(obj?.type) || 'runtime_call'
  if (type === 'agent_task') {
    return {
      type,
      prompt: asString(obj?.prompt) || asString(obj?.instruction) || '',
      outputKey: asString(obj?.outputKey) || asString(obj?.output_key) || undefined,
      generatedFiles: normalizeGeneratedFiles(obj?.generatedFiles ?? obj?.generated_files),
    }
  }
  if (type === 'user_input') {
    return {
      type,
      prompt: asString(obj?.prompt) || undefined,
      inputKeys: asStringArray(obj?.inputKeys ?? obj?.input_keys),
    }
  }
  if (type === 'confirmation') {
    return {
      type,
      message: asString(obj?.message) || asString(obj?.prompt) || '请确认是否继续',
      confirmLabel: asString(obj?.confirmLabel) || asString(obj?.confirm_label) || undefined,
      denyLabel: asString(obj?.denyLabel) || asString(obj?.deny_label) || undefined,
    }
  }
  const argsObj = asObject(obj?.args)
  const args = argsObj
    ? Object.fromEntries(
      Object.entries(argsObj).map(([key, value]) => [key, normalizeValueSource(value) || value as Record<string, unknown>]),
    )
    : undefined
  return {
    type: 'runtime_call',
    actionName: asString(obj?.actionName) || asString(obj?.action_name) || '',
    args,
  }
}

function normalizeSuccessCriteria(raw: unknown): SkillSuccessCriterion[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const criteria = raw
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      type: 'output_present' as const,
      outputKey: asString(item.outputKey) || asString(item.output_key) || '',
    }))
    .filter((item) => item.outputKey.length > 0)
  return criteria.length > 0 ? criteria : undefined
}

function normalizeNextSteps(raw: unknown): SkillNextStepDefinition[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const steps = raw
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      condition: (asString(item.condition) === 'failure' ? 'failure' : 'success') as 'success' | 'failure',
      targetStepId: asString(item.targetStepId) || asString(item.target_step_id) || undefined,
    }))
  return steps.length > 0 ? steps : undefined
}

function normalizeWorkflow(raw: unknown): SkillWorkflow | undefined {
  const obj = asObject(raw)
  if (!obj) return undefined
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : []
  const steps: SkillStep[] = rawSteps
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      id: asString(item.id) || '',
      name: asString(item.name) || asString(item.id) || '',
      description: asString(item.description) || asString(item.name) || '',
      prerequisites: asStringArray(item.prerequisites),
      requiredInputs: asStringArray(item.requiredInputs ?? item.required_inputs),
      action: normalizeStepAction(item.action),
      successCriteria: normalizeSuccessCriteria(item.successCriteria ?? item.success_criteria),
      outputContract: Array.isArray(asObject(item.outputContract ?? item.output_contract)?.outputs)
        ? {
          outputs: (asObject(item.outputContract ?? item.output_contract)?.outputs as unknown[])
            .map((entry) => asObject(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry))
            .map((entry) => ({
              key: asString(entry.key) || '',
              type: asString(entry.type) || 'string',
              required: asBoolean(entry.required),
              description: asString(entry.description) || undefined,
            }))
            .filter((entry) => entry.key.length > 0),
        }
        : undefined,
      nextSteps: normalizeNextSteps(item.nextSteps ?? item.next_steps),
    }))
    .filter((step) => step.id.length > 0)

  if (steps.length === 0) return undefined
  return {
    version: asString(obj.version) || '1',
    autoAdvance: asBoolean(obj.autoAdvance) ?? true,
    initialStep: asString(obj.initialStep) || steps[0].id,
    finalStep: asString(obj.finalStep) || undefined,
    inputs: normalizeInputs(obj.inputs),
    steps,
  }
}

function validateWorkflow(workflow: SkillWorkflow, actions: SkillActionDefinition[]): void {
  const stepIds = new Set(workflow.steps.map((step) => step.id))
  for (const step of workflow.steps) {
    if (step.action.type === 'runtime_call') {
      const actionName = step.action.actionName
      if (!actionName) {
        throw new Error(`Workflow step ${step.id} is missing actionName`)
      }
      const action = actions.find((entry) => entry.name === actionName)
      if (!action) {
        throw new Error(`Workflow step ${step.id} references unknown action: ${actionName}`)
      }
    }
    for (const next of step.nextSteps || []) {
      if (next.targetStepId && !stepIds.has(next.targetStepId)) {
        throw new Error(`Workflow step ${step.id} references unknown next step: ${next.targetStepId}`)
      }
    }
  }
}

export function compileSkillDefinition(options: SkillCompilerOptions): SkillDefinition {
  const { folderPath, source, managedPath, sourcePath, fallbackMeta } = options
  const manifestEntry = findFirstExisting(folderPath, MANIFEST_CANDIDATES)
  const documentEntry = findFirstExisting(folderPath, DOCUMENT_CANDIDATES) || undefined
  const manifestPath = manifestEntry ? join(folderPath, manifestEntry) : undefined
  const manifest = manifestPath ? asObject(readJson(manifestPath)) : null

  const fallbackName = fallbackMeta?.name || basename(folderPath)
  const id = asString(manifest?.id) || fallbackMeta?.id || slugify(fallbackName)
  const name = asString(manifest?.name) || fallbackName
  const description =
    asString(manifest?.description) ||
    fallbackMeta?.description ||
    (documentEntry ? `${name} skill` : '导入的技能')
  const version = asString(manifest?.version) || fallbackMeta?.version || '1.0.0'
  const defaultRuntime = coerceRuntime(manifest?.runtime, documentEntry ? 'reference' : 'python')
  const actions = normalizeActions(manifest?.actions, defaultRuntime, documentEntry)
  if (actions.length === 0) {
    throw new Error(`Skill ${id} 未声明可用 actions`)
  }

  const executionObj = asObject(manifest?.execution)
  const declaredExecutionMode = coerceExecutionMode(executionObj?.mode)
  // Stage Q (Stage 11) — `skill.workflow.json` default-probe retired.
  // §6.7 Phase 3 says the file no longer exists in any embedded skill;
  // the runtime workflow-start branch was retired in Phase 4 (see
  // `runtime-manager.ts:784-788`). Only an EXPLICIT `executionObj.workflowFile`
  // / `workflow_file` field still triggers a probe; otherwise no probe
  // is performed (avoids spurious fs reads on every skill load).
  const workflowFile = asString(executionObj?.workflowFile) || asString(executionObj?.workflow_file)
  const workflowPath = workflowFile ? join(folderPath, workflowFile) : null
  const workflow = (declaredExecutionMode === 'workflow' || (workflowPath && existsSync(workflowPath)))
    ? normalizeWorkflow(workflowPath && existsSync(workflowPath) ? readJson(workflowPath) : null)
    : undefined

  if (declaredExecutionMode === 'workflow' && !workflow) {
    throw new Error(`Workflow skill ${id} 缺少有效 workflow 文件`)
  }
  if (workflow) {
    validateWorkflow(workflow, actions)
  }

  let executionMode: SkillExecutionMode = 'direct'
  if (declaredExecutionMode) {
    executionMode = declaredExecutionMode
  } else if (workflow) {
    executionMode = 'workflow'
  } else if (actions.every((action) => action.runtime === 'reference')) {
    executionMode = 'advisory'
  }

  // Skill Host Contract — manifests can opt into a declarative host_requirements
  // block. Validate at load time so a malformed contract fails fast instead of
  // surfacing as a confusing spawn-time error. Snake-case in JSON manifest;
  // camelCase on the SkillDefinition (matches actions[].timeoutMs convention).
  let hostRequirements: SkillHostRequirements | undefined
  const rawHostRequirements = manifest?.host_requirements ?? manifest?.hostRequirements
  if (rawHostRequirements !== undefined && rawHostRequirements !== null) {
    const parsed = SkillHostRequirementsSchema.safeParse(rawHostRequirements)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new Error(`Skill ${id} host_requirements 校验失败: ${detail}`)
    }
    hostRequirements = parsed.data
  }
  // Stage N (Phase 0.4) — only embedded skills may opt into the child-loop
  // runtime. Custom user-installed skills shipping `child_loop` would slip
  // past the parent-force fence (their dynamic tool name is not in
  // `STATIC_SKILL_TOOL_NAMES_BY_ACTION`, so the manifest predicate cannot
  // reverse-look-up to fence them). We strip the field at compile and warn
  // so the operator notices.
  // Stage S W11.1 — validate optional manifest `allowed_tools` (string[]).
  // Accepts both snake_case (`allowed_tools`, deer-flow form) and camelCase
  // (`allowedTools`) for symmetry with other manifest fields.
  const allowedTools = validateAllowedTools(id, manifest?.allowed_tools ?? manifest?.allowedTools)

  const rawChildLoop = manifest?.child_loop ?? manifest?.childLoop
  const childLoop = (rawChildLoop !== undefined && rawChildLoop !== null && source !== 'embedded')
    ? (() => {
        console.warn(
          `[skill-compiler] custom skill ${id} declares child_loop; dropping (Stage N: only embedded skills may opt into child-loop runtime).`,
        )
        return undefined
      })()
    : normalizeChildLoop(rawChildLoop, actions, id)

  return {
    id,
    name,
    description,
    version,
    source,
    sourcePath: sourcePath || folderPath,
    managedPath,
    manifestPath,
    documentEntry,
    requirementsFile: asString(manifest?.requirementsFile) || asString(manifest?.requirements_file) || fallbackMeta?.requirementsFile,
    defaultAction:
      asString(manifest?.defaultAction) ||
      asString(manifest?.default_action) ||
      actions.find((action) => action.visibility !== 'internal')?.name ||
      actions[0].name,
    actions,
    executionMode,
    workflow,
    manifestValid: true,
    hostRequirements,
    childLoop,
    allowedTools,
  }
}
