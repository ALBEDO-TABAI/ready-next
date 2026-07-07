import { basename, join } from 'path'
import { createRequire } from 'module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { atomicWriteJson } from '../agent-control/atomic-write'
import type {
  SkillActionDefinition,
  SkillActionVisibility,
  SkillExecutionMode,
  SkillParamDefinition,
  SkillRuntimeKind,
  SkillSource,
} from '../../../shared/skill-execution-types'
import { normalizeReadSkillVisibility } from './read-skill-visibility'
import { parseSkillFrontmatter } from './skill-frontmatter'

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

// Slug for id-priority chains: returns null (instead of the 'custom-skill'
// fallback) when the input has no ASCII slug characters, so a degenerate value
// (e.g. a CJK-only frontmatter name) falls through to the next candidate rather
// than short-circuiting the whole chain to the generic default.
function safeSlug(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : null
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
    const { body, metadata } = parseSkillFrontmatter(text)
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
      if (normalized) actions.push(applyReadSkillVisibility(normalized))
    }
  } else {
    const obj = asObject(raw)
    if (obj) {
      for (const [name, value] of Object.entries(obj)) {
        const normalized = normalizeAction(name, value, runtime)
        if (normalized) actions.push(applyReadSkillVisibility(normalized))
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
    // Stage U mid-stage codex review — `visibility` is intentionally NOT
    // set here. `applyReadSkillVisibility` (via normalizeReadSkillVisibility)
    // is the single source of truth for read_skill visibility per CLAUDE.md
    // §3. Hand-setting it here lets a future PR drift the rule.
    actions.push(applyReadSkillVisibility({
      name: 'read_skill',
      description: '读取并应用该技能的说明与方法完成当前任务',
      runtime: 'reference',
      entry: documentEntry,
      params: [],
      inputMode: 'flags',
    }))
  }
  return actions
}

function coerceVisibility(value: unknown): SkillActionVisibility {
  return asString(value) === 'internal' ? 'internal' : 'public'
}

function applyReadSkillVisibility(action: SkillActionDefinition): SkillActionDefinition {
  if (action.name !== 'read_skill') return action
  const kind = action.runtime === 'reference' ? 'reference' : 'runtime'
  return { ...action, visibility: normalizeReadSkillVisibility(kind, action.visibility) }
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
    // Reference skills (SKILL.md, no JSON manifest) carry their canonical id in
    // the YAML frontmatter `name:` (kebab-case, e.g. `video-expert-analyzer`).
    // The folder basename is unreliable — the remote-install pipeline hands us a
    // staging dir named `extract`, `<repo>-<sha>`, or a UUID — so derive id/name
    // from the frontmatter first, only falling back to the folder when absent.
    const documentPath = join(folderPath, documentEntry)
    let frontmatter: Record<string, string> = {}
    try {
      frontmatter = parseSkillFrontmatter(readFileSync(documentPath, 'utf-8')).metadata
    } catch {
      // silent-catch: an unreadable SKILL.md just means no frontmatter id/name;
      // we fall back to the folder basename below, same as before this fix.
    }
    const name = asString(frontmatter.name) || folderName
    const id = asString(frontmatter.id) || safeSlug(frontmatter.name) || slugify(folderName)
    return {
      id,
      name,
      description: guessDescriptionFromMarkdown(documentPath, name, id),
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
  atomicWriteJson(manifestPath, nextManifest)
  return {
    ...nextManifest,
    managedPath,
    manifestPath,
  }
}

/** P2-4 — spec `allowed-tools` (any case/separator variant) is a downloaded-skill tool-authorization
 *  claim Ready deliberately does not honor; the tool surface is decided only by Ready's auth layer. */
function hasAllowedToolsKey(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === 'allowedtools')
}

const requireCjs = createRequire(import.meta.url)

/**
 * P3-3 — lint a source skill folder against the shared agentskills-spec rules (scripts/lint-skill-core.cjs).
 * Best-effort: the rule engine lives under scripts/ (present in dev/test/CI, may be absent in a packaged
 * build) — if it can't be loaded, returns no findings rather than blocking the import. `enforceIdMatchesDir`
 * is FALSE here: imported folders have arbitrary staging names, identity comes from the manifest/frontmatter.
 */
export function lintCustomSkillFolder(sourcePath: string): { errors: string[]; warnings: string[] } {
  let core: { lintSkillInputs: (i: Record<string, unknown>) => { errors: string[]; warnings: string[] } } | null = null
  try {
    core = requireCjs(join(process.cwd(), 'scripts', 'lint-skill-core.cjs'))
  } catch {
    return { errors: [], warnings: [] }
  }
  if (!core || typeof core.lintSkillInputs !== 'function') return { errors: [], warnings: [] }
  let json: unknown = null
  const manifestPath = resolveSourceManifestPath(sourcePath)
  if (manifestPath) {
    try {
      json = readJson(manifestPath)
    } catch {
      json = null
    }
  }
  let skillMd: string | null = null
  const documentEntry = detectDocumentEntry(sourcePath)
  if (documentEntry) {
    try {
      skillMd = readFileSync(join(sourcePath, documentEntry), 'utf-8')
    } catch {
      skillMd = null
    }
  }
  return core.lintSkillInputs({
    dirName: basename(sourcePath),
    json,
    skillMd,
    hasScripts: existsSync(join(sourcePath, 'scripts')),
    enforceIdMatchesDir: false,
  })
}

/**
 * P2-4 + P2-5 — non-blocking import metadata surfaced to the skills center. Reads the SOURCE
 * folder (independent of the copy): records `allowed-tools` as ignored (security policy) and warns
 * when a SKILL.md exceeds the L2 inline cap (activation-time truncation). Best-effort, never throws.
 */
export function collectCustomSkillImportMetadata(sourcePath: string): { ignoredFields: string[]; warnings: string[] } {
  const ignoredFields: string[] = []

  // allowed-tools policy (SKILL.md frontmatter + json manifest) → recorded as IGNORED, never honored.
  const documentEntry = detectDocumentEntry(sourcePath)
  if (documentEntry) {
    try {
      if (hasAllowedToolsKey(parseSkillFrontmatter(readFileSync(join(sourcePath, documentEntry), 'utf-8')).metadata)) {
        ignoredFields.push('allowed-tools')
      }
    } catch {
      // best-effort: an unreadable document just yields no metadata.
    }
  }
  const manifestPath = resolveSourceManifestPath(sourcePath)
  if (manifestPath) {
    try {
      const obj = asObject(readJson(manifestPath))
      if (obj && hasAllowedToolsKey(obj) && !ignoredFields.includes('allowed-tools')) ignoredFields.push('allowed-tools')
    } catch {
      // best-effort: an unreadable manifest is handled by loadCustomSkillManifestFromFolder.
    }
  }

  // P3-3 — author WARN set from the shared lint (oversized SKILL.md incl. the L2 cap, >500 lines,
  // scripts/ without $CLAUDE_SKILL_DIR). allowed-tools is already surfaced above as an ignoredField.
  const warnings = lintCustomSkillFolder(sourcePath).warnings.filter((line) => !/allowed-tools/.test(line))

  return { ignoredFields, warnings }
}

export function importCustomSkillFolder(sourcePath: string, customSkillsRoot: string): RegisteredCustomSkill {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new Error(`Skill 目录不存在：${sourcePath}`)
  }

  // P3-3 note — the strict agentskills-spec ERROR set is enforced by the CLI (scripts/lint-skill.cjs)
  // and the embedded-skills invariant test, NOT here: Ready's import is deliberately lenient (it derives
  // id via safeSlug and description via guessDescriptionFromMarkdown when the frontmatter omits them), and
  // blocking on recoverable spec ERRORs would reject skills Ready is designed to accept. Safety is still
  // guarded by the manifest-presence check below + the manager's scanSkillDirectory security scan; lint
  // findings surface as advisory WARNINGS through collectCustomSkillImportMetadata.
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
      const actions = (Array.isArray(manifest.actions) ? manifest.actions : []).map((action) => {
        const shouldRefreshDescription =
          action?.name === 'read_skill' &&
          action?.runtime === 'reference' &&
          (!asString(action.description) || /读取技能说明与执行流程/.test(String(action.description)))
        const withDescription = shouldRefreshDescription
          ? { ...action, description: '读取并应用该技能的说明与方法完成当前任务' }
          : action
        return applyReadSkillVisibility(withDescription)
      })
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

export function updateManagedCustomSkillDescription(
  customSkillsRoot: string,
  skillId: string,
  description: string,
  name?: string,
): RegisteredCustomSkill {
  const current = getManagedCustomSkill(customSkillsRoot, skillId)
  if (!current) {
    throw new Error(`Custom skill not found: ${skillId}`)
  }
  // Rename only touches the display `name`; the `id` (and therefore the managed
  // folder + `skill_<id>_*` tool names + any persisted refs) stays stable. A
  // blank name is treated as "no change" so clearing the field can't wipe it.
  const nextName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : current.name
  return writeManagedCustomSkillManifest(current.managedPath, {
    ...current,
    name: nextName,
    description: description.trim(),
  })
}
