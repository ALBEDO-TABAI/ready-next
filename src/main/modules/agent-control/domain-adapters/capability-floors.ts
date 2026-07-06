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

/** 本地文档资源在场时的文档读取地板（不含 document_read_section —— 那是"当前文档上下文"地板）。 */
export const LOCAL_DOCUMENT_RESOURCE_FLOOR_TOOL_NAMES: ReadonlyArray<string> = ['file_locate', 'file_read_excerpt']
/** 当前编辑器文档上下文在场时的地板工具。 */
export const CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAME = 'document_read_section'

export function computeCapabilityFloors(params: {
  authorization: SkillToolAuthorization
  hasLocalDocumentResource: boolean
  hasCurrentDocumentContext: boolean
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
    toolNames.add(CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAME)
    reasons.push('current_document_context')
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
