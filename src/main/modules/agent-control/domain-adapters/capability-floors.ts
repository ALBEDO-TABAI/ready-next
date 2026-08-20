import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'

/**
 * P1-3 — 能力地板（capability floors）：显式技能引用 / 本地文档资源 / 当前文档上下文产生的
 *   代码级"必在"工具集。一切收窄过滤只做减法且不得移除地板项；裁决面与管线末端据此强制
 *   `surface ⊇ floors`。纯函数、零 IO：只读取 authorization 与两个布尔信号，不碰注册表/运行时。
 *   （只 import 类型，避免 domain-adapters ↔ runtime-core 运行时环依赖。）
 */
export interface CapabilityFloors {
  readonly toolNames: ReadonlySet<string>
  /** 地板来源，用于可观测日志，如 'skill_selected:ready-human-touch-ppt' / 'local_document_resource'。 */
  readonly reasons: ReadonlyArray<string>
}

/** 本地文档资源在场时的文档读取地板（提及≠授写：@文件只保证可读，不含任何写面）。 */
export const LOCAL_DOCUMENT_RESOURCE_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'file_locate',
  'file_read_excerpt',
]
/**
 * 当前文档无条件地板只有精确读取。Widget/replace/save 是明确写意图的条件地板，
 * 由 Codex 产品组合层并入，不能作为无条件 floor 再被后续过滤。
 */
export const CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'document_read_section',
]

export const CURRENT_DOCUMENT_WRITE_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'document_list_widgets',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_exact',
  'document_save_tab',
]

/** Typed folder keeps a frozen dormant delivery surface; receipts activate it later. */
export const FOLDER_EXPORT_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'declare_completion_criteria',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
]

export function computeCapabilityFloors(params: {
  authorization: SkillToolAuthorization
  hasLocalDocumentResource: boolean
  hasCurrentDocumentContext: boolean
  hasCurrentDocumentWriteIntent?: boolean
}): CapabilityFloors {
  const toolNames = new Set<string>()
  const reasons: string[] = []
  if (params.authorization.mode === 'selected') {
    for (const name of params.authorization.allowedTypedActions) toolNames.add(name)
    for (const name of params.authorization.allowedPrimitives) toolNames.add(name)
    reasons.push(`skill_selected:${params.authorization.skillId}`)
  }
  if (params.hasLocalDocumentResource) {
    for (const name of LOCAL_DOCUMENT_RESOURCE_FLOOR_TOOL_NAMES) toolNames.add(name)
    reasons.push('local_document_resource')
  }
  if (params.hasCurrentDocumentContext) {
    for (const name of CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAMES) toolNames.add(name)
    reasons.push('current_document_context')
    if (params.hasCurrentDocumentWriteIntent) {
      for (const name of CURRENT_DOCUMENT_WRITE_FLOOR_TOOL_NAMES) toolNames.add(name)
      reasons.push('current_document_write_intent')
    }
  }
  return { toolNames, reasons }
}

/**
 * P1-3 不变量执行器：断言 `surface ⊇ floors`；缺席的地板项从 `recoverFrom`（收窄前的面）补回。
 * 返回补回后的面与缺席清单（调用方据 missing 落 tool_surface_floor_violation 日志）。纯函数。
 */
export function enforceCapabilityFloors<T extends { name: string }>(
  surface: readonly T[],
  floors: CapabilityFloors,
  recoverFrom: readonly T[],
): { definitions: T[]; missing: string[] } {
  const present = new Set(surface.map((definition) => definition.name))
  const missing = [...floors.toolNames].filter((name) => !present.has(name))
  const definitions = [...surface]
  for (const name of missing) {
    const restored = recoverFrom.find((definition) => definition.name === name)
    if (restored && !present.has(name)) {
      definitions.push(restored)
      present.add(name)
    }
  }
  return { definitions, missing }
}

/**
 * P1-3 硬地板：地板工具即便被组不可见/意图压制而缺席（不在 definitions 里），也从注册表 resolve 补回。
 * resolve 取不到 → 记入 unavailable（调用方落 sdk_runtime_floor_tool_unavailable 日志）。纯函数（resolve 由调用方注入）。
 */
export function recoverAbsentFloorsFromRegistry<T extends { name: string }>(
  definitions: readonly T[],
  floors: CapabilityFloors,
  resolveDefinition: (name: string) => T | null,
): { definitions: T[]; unavailable: string[] } {
  const present = new Set(definitions.map((definition) => definition.name))
  const result = [...definitions]
  const unavailable: string[] = []
  for (const name of floors.toolNames) {
    if (present.has(name)) continue
    const resolved = resolveDefinition(name)
    if (!resolved) {
      unavailable.push(name)
      continue
    }
    result.push(resolved)
    present.add(name)
  }
  return { definitions: result, unavailable }
}
