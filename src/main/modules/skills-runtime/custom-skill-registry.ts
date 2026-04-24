import { basename, join } from 'path'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import type {
  SkillActionDefinition,
  SkillActionVisibility,
  SkillExecutionMode,
  SkillParamDefinition,
  SkillRuntimeKind,
  SkillSource,
} from '../../../shared/skill-execution-types'

export interface CustomSkillExecutionConfig {
  mode: Exclude<SkillExecutionMode, 'direct'>
  workflowFile?: string
  resultContractVersion?: number
  autoAdvance?: boolean
}

export interface CustomSkillManifest {
  id: string
  name: string
  description: string
  version: string
  source: 'custom'
  runtime: SkillRuntimeKind
  defaultAction: string
  requirementsFile?: string
  sourcePath: string
  importedAt: string
  updatedAt: string
  actions: SkillActionDefinition[]
  execution?: CustomSkillExecutionConfig
}

export interface RegisteredCustomSkill extends CustomSkillManifest {
  managedPath: string
  manifestPath: string
}

const MANAGED_MANIFEST_FILENAME = 'ready-skill.json'
const SOURCE_MANIFEST_CANDIDATES = [
  MANAGED_MANIFEST_FILENAME,
  '.ready-skill.json',
  'skill.json',
  'manifest.json',
]
const DOCUMENT_CANDIDATES = ['SKILL.md', 'README.md', 'README.zh-CN.md']

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'custom-skill'
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => asString(item)).filter((item): item is string => Boolean(item))
}

function coerceRuntime(value: unknown, fallback: SkillRuntimeKind = 'reference'): SkillRuntimeKind {
  const raw = asString(value)?.toLowerCase()
  if (raw === 'python' || raw === 'node' || raw === 'shell' || raw === 'reference') return raw
  return fallback
}

function coerceTimeout(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.max(1000, Math.round(parsed))
}

function parseMarkdownFrontmatter(text: string): { body: string; metadata: Record<string, string> } {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) {
    return {
      body: normalized,
      metadata: {},
    }
  }

  const metadata: Record<string, string> = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (!entry) continue
    metadata[entry[1].toLowerCase()] = entry[2].trim().replace(/^['"]|['"]$/g, '')
  }

  return {
    body: normalized.slice(match[0].length),
    metadata,
  }
}

function normalizeDescriptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function isWeakDescription(value: unknown, fallbackName?: string, fallbackId?: string): boolean {
  const text = asString(value) || ''
  if (!text) return true
  if (/^(name|description|id)\s*:/i.test(text)) return true

  const normalized = text.trim().toLowerCase()
  const aliases = [fallbackName, fallbackId]
    .map((item) => asString(item)?.trim().toLowerCase())
    .filter((item): item is string => Boolean(item))

  if (aliases.some((alias) => alias === normalized)) return true
  return text.trim().length < 4
}

function guessDescriptionFromMarkdown(path: string, fallbackName?: string, fallbackId?: string): string {
  try {
    const text = readFileSync(path, 'utf-8')
    const { body, metadata } = parseMarkdownFrontmatter(text)
    const frontmatterDescription = normalizeDescriptionText(metadata.description || '')
    if (!isWeakDescription(frontmatterDescription, fallbackName, fallbackId)) {
      return frontmatterDescription
    }

    const lines = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('#')) continue
      if (line.startsWith('- ') || line.startsWith('* ')) continue
      if (line.startsWith('|')) continue
      if (/^(name|description|id|version|author|tags?)\s*:/i.test(line)) continue
      if (line.length < 8) continue
      return normalizeDescriptionText(line)
    }
  } catch {
    // ignore
  }
  return fallbackName ? `${fallbackName} 自定义技能` : '导入的自定义技能'
}

function normalizeParams(raw: unknown): SkillParamDefinition[] {
  if (Array.isArray(raw)) {
    const params: SkillParamDefinition[] = []
    for (const item of raw) {
      const obj = asObject(item)
      if (!obj) continue
      const name = asString(obj.name)
      if (!name) continue
      params.push({
        name,
        type: asString(obj.type) || 'string',
        description: asString(obj.description) || name,
        required: Boolean(obj.required),
        enum: Array.isArray(obj.enum) ? obj.enum.map((entry) => String(entry)) : undefined,
      })
    }
    return params
  }

  const obj = asObject(raw)
  if (!obj) return []
  const required = new Set(asStringArray(obj.required))
  const properties = asObject(obj.properties) || obj
  return Object.entries(properties).map(([name, value]) => {
    const def = asObject(value)
    return {
      name,
      type: asString(def?.type) || 'string',
      description: asString(def?.description) || name,
      required: required.has(name) || Boolean(def?.required),
      enum: Array.isArray(def?.enum) ? def?.enum.map((entry) => String(entry)) : undefined,
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
  const runtime = coerceRuntime(obj.runtime, inheritedRuntime)
  const entry =
    asString(obj.entry) ||
    asString(obj.script) ||
    asString(obj.path) ||
    asString(obj.file) ||
    ''

  if (!entry) return null

  return {
    name,
    description: asString(obj.description) || `执行 ${name}`,
    runtime,
    entry,
    timeoutMs: coerceTimeout(obj.timeoutMs ?? obj.timeout),
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
      if (normalized) actions.push(normalized)
    }
  } else {
    const obj = asObject(raw)
    if (obj) {
      for (const [name, value] of Object.entries(obj)) {
        const normalized = normalizeAction(name, value, runtime)
        if (normalized) actions.push(normalized)
      }
    }
  }

  if (actions.length === 0 && documentEntry) {
    // B Phase 1 PR2 T1-9: default the auto-generated `read_skill` action to
    // `internal` visibility so the LLM can't learn the
    // `skill_<id>_read_skill` tool name and keep invoking it in a loop.
    // The orchestrator inlines SKILL.md directly via `tryInlineReferenceSkillDoc`,
    // so the read_skill tool only needs to exist for the legacy tool-call
    // fallback, which runs in-process and does not consult visibility.
    // Authors can still publish it by declaring `visibility: 'public'` in the
    // manifest — the normalizer further up in this file respects explicit
    // declarations and `coerceVisibility` only defaults to 'public' when the
    // field is missing or unrecognized.
    actions.push({
      name: 'read_skill',
      description: '读取并应用该技能的说明与方法完成当前任务',
      runtime: 'reference',
      entry: documentEntry,
      params: [],
      inputMode: 'flags',
      visibility: 'internal',
    })
  }
  return actions
}

function coerceVisibility(value: unknown): SkillActionVisibility {
  return asString(value) === 'internal' ? 'internal' : 'public'
}

function coerceExecutionMode(value: unknown): Exclude<SkillExecutionMode, 'direct'> | null {
  const raw = asString(value)?.toLowerCase()
  if (raw === 'advisory' || raw === 'workflow') return raw
  return null
}

function detectDocumentEntry(folderPath: string): string | null {
  for (const candidate of DOCUMENT_CANDIDATES) {
    const resolved = join(folderPath, candidate)
    if (existsSync(resolved)) return candidate
  }
  return null
}

function resolveSourceManifestPath(folderPath: string): string | null {
  for (const candidate of SOURCE_MANIFEST_CANDIDATES) {
    const resolved = join(folderPath, candidate)
    if (existsSync(resolved)) return resolved
  }
  return null
}

export function loadCustomSkillManifestFromFolder(folderPath: string): CustomSkillManifest {
  const manifestPath = resolveSourceManifestPath(folderPath)
  const documentEntry = detectDocumentEntry(folderPath)

  if (!manifestPath && !documentEntry) {
    throw new Error('未找到 skill manifest 或 SKILL.md/README.md')
  }

  if (!manifestPath && documentEntry) {
    const folderName = basename(folderPath)
    return {
      id: slugify(folderName),
      name: folderName,
      description: guessDescriptionFromMarkdown(join(folderPath, documentEntry), folderName, slugify(folderName)),
      version: '1.0.0',
      source: 'custom',
      runtime: 'reference',
      defaultAction: 'read_skill',
      sourcePath: folderPath,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actions: normalizeActions(undefined, 'reference', documentEntry),
      execution: { mode: 'advisory', autoAdvance: false },
    }
  }

  const raw = readJson(manifestPath!)
  const obj = asObject(raw)
  if (!obj) {
    throw new Error('Skill manifest 不是合法对象')
  }

  const name = asString(obj.name) || basename(folderPath)
  const id = asString(obj.id) || slugify(name)
  const runtime = coerceRuntime(obj.runtime, documentEntry ? 'reference' : 'python')
  const actions = normalizeActions(obj.actions, runtime, documentEntry || undefined)
  if (actions.length === 0) {
    throw new Error('Skill manifest 未声明可用 actions')
  }
  const defaultAction =
    asString(obj.defaultAction) ||
    asString(obj.default_action) ||
    actions[0].name
  const executionObj = asObject(obj.execution)
  const executionMode = coerceExecutionMode(executionObj?.mode)

  return {
    id,
    name,
    description:
      asString(obj.description) ||
      (documentEntry ? guessDescriptionFromMarkdown(join(folderPath, documentEntry), name, id) : '导入的自定义技能'),
    version: asString(obj.version) || '1.0.0',
    source: 'custom',
    runtime,
    defaultAction,
    requirementsFile: asString(obj.requirementsFile) || asString(obj.requirements_file) || undefined,
    sourcePath: folderPath,
    importedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actions,
    execution: executionMode
      ? {
        mode: executionMode,
        workflowFile: asString(executionObj?.workflowFile) || asString(executionObj?.workflow_file) || undefined,
        resultContractVersion: Number.isFinite(Number(executionObj?.resultContractVersion ?? executionObj?.result_contract_version))
          ? Number(executionObj?.resultContractVersion ?? executionObj?.result_contract_version)
          : undefined,
        autoAdvance: typeof executionObj?.autoAdvance === 'boolean'
          ? executionObj.autoAdvance
          : (typeof executionObj?.auto_advance === 'boolean' ? executionObj.auto_advance : undefined),
      }
      : undefined,
  }
}

export function writeManagedCustomSkillManifest(managedPath: string, manifest: CustomSkillManifest): RegisteredCustomSkill {
  mkdirSync(managedPath, { recursive: true })
  const nextManifest: CustomSkillManifest = {
    ...manifest,
    importedAt: manifest.importedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const manifestPath = join(managedPath, MANAGED_MANIFEST_FILENAME)
  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf-8')
  return {
    ...nextManifest,
    managedPath,
    manifestPath,
  }
}

export function importCustomSkillFolder(sourcePath: string, customSkillsRoot: string): RegisteredCustomSkill {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new Error(`Skill 目录不存在：${sourcePath}`)
  }

  const manifest = loadCustomSkillManifestFromFolder(sourcePath)
  const managedPath = join(customSkillsRoot, manifest.id)
  rmSync(managedPath, { recursive: true, force: true })
  mkdirSync(customSkillsRoot, { recursive: true })
  cpSync(sourcePath, managedPath, { recursive: true, force: true })
  return writeManagedCustomSkillManifest(managedPath, {
    ...manifest,
    sourcePath,
  })
}

export function listManagedCustomSkills(customSkillsRoot: string): RegisteredCustomSkill[] {
  if (!existsSync(customSkillsRoot)) return []
  const entries = readdirSync(customSkillsRoot)
  const records: RegisteredCustomSkill[] = []
  for (const entry of entries) {
    const managedPath = join(customSkillsRoot, entry)
    try {
      if (!statSync(managedPath).isDirectory()) continue
      const manifestPath = join(managedPath, MANAGED_MANIFEST_FILENAME)
      if (!existsSync(manifestPath)) continue
      const manifest = readJson(manifestPath) as CustomSkillManifest
      if (!manifest || typeof manifest !== 'object' || !manifest.id) continue
      const fallbackName = asString(manifest.name) || entry
      const documentEntry = detectDocumentEntry(managedPath)
      const description = isWeakDescription(manifest.description, fallbackName, manifest.id)
        ? (documentEntry ? guessDescriptionFromMarkdown(join(managedPath, documentEntry), fallbackName, manifest.id) : (asString(manifest.description) || '导入的自定义技能'))
        : manifest.description
      const actions = (Array.isArray(manifest.actions) ? manifest.actions : []).map((action) =>
        action?.name === 'read_skill' && action?.runtime === 'reference' && (!asString(action.description) || /读取技能说明与执行流程/.test(String(action.description)))
          ? {
            ...action,
            description: '读取并应用该技能的说明与方法完成当前任务',
          }
          : action,
      )
      records.push({
        ...manifest,
        source: 'custom',
        name: fallbackName,
        description,
        actions,
        managedPath,
        manifestPath,
      })
    } catch {
      // skip invalid managed skills
    }
  }
  return records.sort((a, b) => a.name.localeCompare(b.name))
}

export function getManagedCustomSkill(customSkillsRoot: string, skillId: string): RegisteredCustomSkill | null {
  return listManagedCustomSkills(customSkillsRoot).find((item) => item.id === skillId) || null
}

export function removeManagedCustomSkill(customSkillsRoot: string, skillId: string): boolean {
  const managedPath = join(customSkillsRoot, skillId)
  if (!existsSync(managedPath)) return false
  rmSync(managedPath, { recursive: true, force: true })
  return true
}

export function updateManagedCustomSkillDescription(customSkillsRoot: string, skillId: string, description: string): RegisteredCustomSkill {
  const current = getManagedCustomSkill(customSkillsRoot, skillId)
  if (!current) {
    throw new Error(`Custom skill not found: ${skillId}`)
  }
  return writeManagedCustomSkillManifest(current.managedPath, {
    ...current,
    description: description.trim(),
  })
}
