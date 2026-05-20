/**
 * Handler for `skill_patch_config`.
 *
 * This primitive is intentionally narrower than shell/file primitives: it can
 * only edit JSON config files explicitly declared by the active skill
 * manifest. The handler writes atomically, rereads the file, and returns a
 * masked validation summary so provider keys never leak into model context.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { SkillHostRequirements } from '../../../../shared/skill-host-contract'
import { atomicWriteJson } from '../../agent-control/atomic-write'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import type { TurnFramePatch } from '../../agent-control/turn-frame'

export interface PatchConfigOperation {
  op: 'set' | 'delete'
  path: string
  value?: unknown
}

export interface PatchConfigArgs {
  target: string
  operations: PatchConfigOperation[]
}

export interface PatchConfigDeps {
  skillId: string
  hostRequirements?: SkillHostRequirements | null
  activeContext?: {
    runStatePath?: string | null
    outputDir?: string | null
  } | null
}

interface DeclaredConfigFile {
  id: string
  path: string
  resolvedPath: string
  format: 'json'
}

interface ValidationResult {
  ok: boolean
  issues: string[]
  warnings: string[]
  checkedModels: string[]
}

interface StaleBlockerClearResult {
  cleared: boolean
  runStatePath: string
  previousStatus: string | null
  previousError: string | null
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2))
  return resolve(input)
}

function declaredFiles(hostRequirements?: SkillHostRequirements | null): DeclaredConfigFile[] {
  return (hostRequirements?.config_repair?.files || []).map((file) => ({
    id: file.id,
    path: file.path,
    resolvedPath: expandHome(file.path),
    format: file.format,
  }))
}

function selectTarget(target: string, files: DeclaredConfigFile[]): DeclaredConfigFile {
  const normalized = target.trim()
  const resolvedTarget = normalized.startsWith('~') || normalized.startsWith('/')
    ? expandHome(normalized)
    : null
  const match = files.find((file) =>
    file.id === normalized
    || basename(file.resolvedPath) === normalized
    || file.resolvedPath === resolvedTarget,
  )
  if (!match) {
    throw new ToolDomainError(
      'config_target_not_declared',
      `Config target "${normalized}" is not declared by this skill manifest.`,
      {
        target: normalized,
        declaredTargets: files.map((file) => file.id),
      },
    )
  }
  return match
}

function parseJsonFile(path: string): unknown {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ToolDomainError(
      'config_json_parse_failed',
      `Config file is not valid JSON: ${path}`,
      {
        path,
        detail: error instanceof Error ? error.message : String(error),
      },
    )
  }
}

function pointerSegments(pointer: string): string[] {
  if (!pointer.startsWith('/')) {
    throw new ToolDomainError(
      'config_patch_invalid_pointer',
      `JSON pointer must start with "/": ${pointer}`,
      { path: pointer },
    )
  }
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ensureParent(root: unknown, pointer: string): { parent: Record<string, unknown> | unknown[]; key: string } {
  if (!isRecord(root) && !Array.isArray(root)) {
    throw new ToolDomainError(
      'config_patch_invalid_root',
      'JSON config root must be an object or array.',
      { path: pointer },
    )
  }
  const parts = pointerSegments(pointer)
  if (parts.length === 0) {
    throw new ToolDomainError(
      'config_patch_invalid_pointer',
      'JSON pointer must address a child value.',
      { path: pointer },
    )
  }
  let cursor: Record<string, unknown> | unknown[] = root as Record<string, unknown> | unknown[]
  for (const segment of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0) {
        throw new ToolDomainError('config_patch_invalid_pointer', `Invalid array index in JSON pointer: ${segment}`, { path: pointer })
      }
      if (!isRecord(cursor[index]) && !Array.isArray(cursor[index])) cursor[index] = {}
      cursor = cursor[index] as Record<string, unknown> | unknown[]
      continue
    }
    if (!isRecord(cursor[segment]) && !Array.isArray(cursor[segment])) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown> | unknown[]
  }
  return { parent: cursor, key: parts[parts.length - 1] }
}

function applyOperation(root: unknown, operation: PatchConfigOperation): void {
  const { parent, key } = ensureParent(root, operation.path)
  if (Array.isArray(parent)) {
    const index = key === '-' ? parent.length : Number(key)
    if (!Number.isInteger(index) || index < 0 || index > parent.length) {
      throw new ToolDomainError('config_patch_invalid_pointer', `Invalid array index in JSON pointer: ${key}`, { path: operation.path })
    }
    if (operation.op === 'delete') {
      if (index < parent.length) parent.splice(index, 1)
      return
    }
    parent[index] = operation.value
    return
  }
  if (operation.op === 'delete') {
    delete parent[key]
    return
  }
  parent[key] = operation.value
}

function getObjectAtPath(root: unknown, path: string[]): Record<string, unknown> | null {
  let cursor = root
  for (const segment of path) {
    if (!isRecord(cursor)) return null
    cursor = cursor[segment]
  }
  return isRecord(cursor) ? cursor : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function collectModelRefs(config: unknown): { preferred: string | null; fallback: string[] } {
  const autoScoring = getObjectAtPath(config, ['auto_scoring'])
  const preferred = asString(autoScoring?.preferred_model) || asString((config as Record<string, unknown> | null)?.preferred_model)
  const rawFallback: unknown[] = Array.isArray(autoScoring?.fallback_models)
    ? autoScoring.fallback_models
    : Array.isArray((config as Record<string, unknown> | null)?.fallback_models)
      ? (config as Record<string, unknown>).fallback_models as unknown[]
      : []
  return {
    preferred: preferred || null,
    fallback: rawFallback.map(asString).filter(Boolean),
  }
}

function findDeclaredFile(files: DeclaredConfigFile[], id: string): DeclaredConfigFile | null {
  return files.find((file) => file.id === id) || null
}

function loadModelsCatalog(config: unknown, files: DeclaredConfigFile[]): Record<string, unknown> | null {
  const autoScoring = getObjectAtPath(config, ['auto_scoring'])
  const configuredPath = asString(autoScoring?.models_json_path)
  const candidates = [
    configuredPath ? expandHome(configuredPath) : null,
    findDeclaredFile(files, 'models')?.resolvedPath || null,
  ].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const parsed = parseJsonFile(candidate)
    if (isRecord(parsed)) return parsed
  }
  return null
}

function providerApiKey(provider: Record<string, unknown>): string {
  return asString(provider.apiKey) || asString(provider.api_key) || asString(provider.key)
}

function modelExists(provider: Record<string, unknown>, modelId: string): boolean {
  const models = Array.isArray(provider.models) ? provider.models : []
  return models.some((model) => isRecord(model) && asString(model.id) === modelId)
}

function validateModelRef(
  modelRef: string,
  providers: Record<string, unknown>,
  kind: 'preferred' | 'fallback',
  validation: ValidationResult,
): void {
  validation.checkedModels.push(modelRef)
  const slash = modelRef.indexOf('/')
  if (slash <= 0 || slash === modelRef.length - 1) {
    validation.issues.push(`${kind} model "${modelRef}" is not provider/model form.`)
    return
  }
  const providerName = modelRef.slice(0, slash)
  const modelId = modelRef.slice(slash + 1)
  const provider = providers[providerName]
  if (!isRecord(provider)) {
    validation.issues.push(`${kind} model "${modelRef}" references missing provider "${providerName}".`)
    return
  }
  if (!modelExists(provider, modelId)) {
    validation.issues.push(`${kind} model "${modelRef}" is not in provider "${providerName}" catalog.`)
  }
  const key = providerApiKey(provider)
  if (key.length < 8) {
    validation.issues.push(`${kind} model "${modelRef}" provider key is missing or too short.`)
  }
}

function validateVideoExpertAnalyzerConfig(files: DeclaredConfigFile[]): ValidationResult {
  const validation: ValidationResult = {
    ok: true,
    issues: [],
    warnings: [],
    checkedModels: [],
  }
  const configFile = findDeclaredFile(files, 'config')
  if (!configFile || !existsSync(configFile.resolvedPath)) {
    validation.issues.push('Declared config file is missing.')
    validation.ok = false
    return validation
  }
  const config = parseJsonFile(configFile.resolvedPath)
  const catalog = loadModelsCatalog(config, files)
  const providers = isRecord(catalog) && isRecord(catalog.providers) ? catalog.providers : null
  if (!providers) {
    validation.issues.push('Provider catalog is missing or has no providers object.')
    validation.ok = false
    return validation
  }
  const refs = collectModelRefs(config)
  if (!refs.preferred) {
    validation.issues.push('auto_scoring.preferred_model is missing.')
  } else {
    validateModelRef(refs.preferred, providers, 'preferred', validation)
  }
  refs.fallback.forEach((ref) => validateModelRef(ref, providers, 'fallback', validation))
  validation.ok = validation.issues.length === 0
  return validation
}

function validateConfig(skillId: string, files: DeclaredConfigFile[]): ValidationResult {
  if (skillId === 'video-expert-analyzer') {
    return validateVideoExpertAnalyzerConfig(files)
  }
  return {
    ok: true,
    issues: [],
    warnings: ['No skill-specific config validator is registered.'],
    checkedModels: [],
  }
}

function isConfigBlockerText(text: string): boolean {
  return /(zai|GLM-5V-Turbo|provider|fallback|models\.json|preferred_model|模型|配置)/i.test(text)
}

function resolveRunStatePathFromContext(deps: PatchConfigDeps): string | null {
  const direct = asString(deps.activeContext?.runStatePath)
  if (direct) return resolve(direct)
  const outputDir = asString(deps.activeContext?.outputDir)
  return outputDir ? join(resolve(outputDir), 'run_state.json') : null
}

function clearStaleConfigBlockerAfterValidation(
  deps: PatchConfigDeps,
  validation: ValidationResult,
): StaleBlockerClearResult | null {
  if (deps.skillId !== 'video-expert-analyzer' || !validation.ok) return null
  const runStatePath = resolveRunStatePathFromContext(deps)
  if (!runStatePath || !existsSync(runStatePath)) return null
  const state = parseJsonFile(runStatePath)
  if (!isRecord(state)) return null
  const previousError = asString(state.last_error)
  const previousStatus = asString(state.status)
  if (!previousError || !isConfigBlockerText(previousError)) return null
  state.last_error = ''
  if (previousStatus === 'blocked' || previousStatus === 'failed' || previousStatus === 'paused') {
    state.status = 'running'
  }
  state.updated_at = new Date().toISOString()
  atomicWriteJson(runStatePath, state)
  return {
    cleared: true,
    runStatePath,
    previousStatus: previousStatus || null,
    previousError,
  }
}

function maskOperation(operation: PatchConfigOperation): Record<string, unknown> {
  return {
    op: operation.op,
    path: operation.path,
    value: operation.op === 'set' ? '[masked]' : undefined,
  }
}

export async function executePatchConfig(
  args: PatchConfigArgs,
  deps: PatchConfigDeps,
): Promise<ToolExecutionOutput> {
  const files = declaredFiles(deps.hostRequirements)
  if (files.length === 0) {
    throw new ToolDomainError(
      'config_repair_not_declared',
      `Skill "${deps.skillId}" does not declare repairable config files.`,
      { skillId: deps.skillId },
    )
  }
  const target = selectTarget(args.target, files)
  if (target.format !== 'json') {
    throw new ToolDomainError(
      'config_format_not_supported',
      `Config target "${target.id}" is ${target.format}; only json is supported.`,
      { target: target.id, format: target.format },
    )
  }
  const operations = Array.isArray(args.operations) ? args.operations : []
  if (operations.length === 0) {
    throw new ToolDomainError('input_validation', 'At least one config patch operation is required.', {})
  }
  const document = parseJsonFile(target.resolvedPath)
  operations.forEach((operation) => applyOperation(document, operation))
  atomicWriteJson(target.resolvedPath, document)
  parseJsonFile(target.resolvedPath)
  const validation = validateConfig(deps.skillId, files)
  const staleBlocker = clearStaleConfigBlockerAfterValidation(deps, validation)

  // Stage D5 — emit framePatch.configValidation so the next iteration's
  // frame sees the validation outcome without re-reading the config file.
  // On success, also clear the contract blocker via a runContract partial so
  // steering does not keep showing the run as `blocked`. On failure, surface
  // the first issue as the blocker reason so the frame stays blocked.
  const framePatch: TurnFramePatch = {
    configValidation: {
      valid: validation.ok,
      reason: validation.ok ? undefined : (validation.issues[0] || 'config_validation_failed'),
      message: validation.ok
        ? `Config "${target.id}" validated successfully.`
        : validation.issues.join('; ') || 'Config validation failed.',
    },
  }
  if (validation.ok) {
    framePatch.runContract = {
      blocker: { reason: null, stale: false },
      ...(deps.skillId ? { skillId: deps.skillId } : {}),
    }
    if (staleBlocker?.cleared) {
      framePatch.skillStatusUpdates = {
        ...(framePatch.skillStatusUpdates || {}),
        staleBlockerReason: null,
        status: 'running',
      }
    }
  } else {
    framePatch.runContract = {
      blocker: {
        reason: validation.issues[0] || 'config_validation_failed',
        stale: false,
      },
      status: 'blocked',
      ...(deps.skillId ? { skillId: deps.skillId } : {}),
    }
  }

  return createToolExecutionOutput(
    `Patched config "${target.id}" (${operations.length} operation${operations.length === 1 ? '' : 's'}). Validation ${validation.ok ? 'passed' : 'blocked'}${staleBlocker?.cleared ? '; stale blocker cleared' : ''}.`,
    {
      shape: 'json',
      data: {
        ok: validation.ok,
        target: {
          id: target.id,
          path: target.resolvedPath,
        },
        operations: operations.map(maskOperation),
        validation,
        staleBlocker,
      },
      framePatch,
    },
  )
}
