import {
  defaultToolGateway,
  filterToolsByAllowedTools,
  filterToolsByVisionCapability,
  type ToolGroupResolutionEntry,
} from '../tools-runtime/tool-gateway'
import { normalizeOpenAIToolSchema } from '../../tools/tool-schema'
import type { CapabilityFloors } from '../domain-adapters/capability-floors'
import { buildTextToolBridgePrompt } from '../../claude-bridge/tool-bridge'
import { type DocumentWidgetTaskKind } from '../../claude-bridge/tool-policy-heuristics'
import {
  buildDocumentWidgetClarificationSnippet,
  buildDocumentWidgetGuidanceSnippet,
  buildDocumentWidgetOpenUIRulesSnippet,
  buildDocumentWidgetSkeletonRulesSnippet,
  inferDocumentWidgetProfile,
  type DocumentWidgetProfile,
} from '../../claude-bridge/widget-guidance'
import {
  describeApprovedWidgetProps,
  type DocumentWidgetComponentName,
} from '../../../../shared/document-widget-openui'
import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import type { ToolResolutionDiagnostics } from '../contracts/run-contracts'
import {
  filterPreferredSkillAnthropicTools as _filterPreferredSkillAnthropic,
  filterPreferredSkillOpenAITools as _filterPreferredSkillOpenAI,
  mergeForceDocumentAllowedNames as _mergeForceDocumentAllowedNames,
} from './execution-tool-skill-filters'
import {
  buildExplicitNoSkillAuthorization,
  type SkillToolAuthorization,
} from '../skills/skill-tool-authorization'

/**
 * Stage 10 — when caller has a `ToolPolicy` but no authorization, build
 * an explicit `mode:'none', reason:'no_skill_signal'` rather than `null`.
 * Model-visible tool list construction must always have a determinate
 * authorization to filter against.
 */
function resolvePolicyAuthorization(policy?: ToolPolicy): SkillToolAuthorization {
  return policy?.authorization ?? buildExplicitNoSkillAuthorization('no_skill_signal')
}

export interface ToolPolicy {
  forceDocumentTool: boolean
  allowDocumentTools: boolean
  forceDesignTool: boolean
  preferredDesignTool: string | null
  primaryDesignInstruction: string | null
  allowMultipleDesignArtifacts: boolean
  preferSectionRewrite: boolean
  preferFormatOnly: boolean
  documentWidgetTaskKind?: DocumentWidgetTaskKind
  documentWidgetProfile?: DocumentWidgetProfile | null
  documentWidgetSourceText?: string | null
  allowBrowserTools: boolean
  preferredSkillToolNames?: string[] | null
  visibleCapabilityGroupIds?: CapabilityGroupId[]
  hostOnlyCapabilityGroupIds?: CapabilityGroupId[]
  capabilityReasons?: Partial<Record<CapabilityGroupId, string>>
  // Optional — when set, the skills group will filter out workflow-control
  // tools (submit/restart/cancel) if this session has no active execution.
  // See skills-tools.ts::getSkillToolDefs (B plan Phase 0).
  sessionId?: string
  /**
   * Stage T PR-T5 — conversation scope id. Threaded from
   * `RequestEnvelope.scopeId` by `run-capability-controller`. The
   * tool policy keeps it as the per-turn product scope identity.
   */
  scopeId?: string
  /**
   * Stage 4 W3b.2 — per-turn skill tool authorization. When populated by
   * turn-engine (post-W3b.1 cutover), `getPolicyAnthropicTools` /
   * `getPolicyOpenAITools` / `getPolicyOpenAIToolBundle` thread it through
   * the gateway and registry's 4 model-visible list resolvers, where
   * `filterToolsByAuthorization` strips skill_* tools that aren't in the
   * allowed sets. Defense-in-depth alongside the existing
   * `preferredSkillToolNames` filter.
   */
  authorization?: SkillToolAuthorization | null
  /**
   * Stage S round 2 (Issue 3) — vision capability of the resolved
   * agent/provider/model for this turn. When `supportsVision === false`,
   * `getPolicyAnthropicTools` / `getPolicyOpenAIToolBundle` route the
   * tool list through `filterToolsByVisionCapability` so the model never
   * sees vision-bearing tools (e.g. `view_image`) it cannot use.
   * `null` / undefined means "treat as no-capability data" → conservative
   * deny path (matches the helper's `supportsVision !== true` branch).
   */
  capabilityResolution?: { readonly supportsVision?: boolean } | null
  /**
   * Stage S round 2 (Issue 5) — when an active skill is selected for
   * this turn (`authorization.mode === 'selected'`) and the skill's
   * manifest declares `allowed_tools: string[]`, the controller resolves
   * the normalised array onto the policy. The bundle path applies it
   * via `filterToolsByAllowedTools` so the model only sees the skill's
   * declared toolset. `null` / `undefined` / empty → identity filter.
   */
  activeSkillAllowedTools?: ReadonlyArray<string> | null
  /**
   * P1-4 — 能力地板：显式技能引用 / 本地文档资源产生的"必在"工具集，与 SDK executor 消费同一
   * `computeCapabilityFloors`。bundle 把地板并入 `activeSkillAllowedTools` 过滤集，保证技能收窄不
   * 移除地板项。诚实注记：当前 live 工具面权威计算点是 SDK executor（`listDefaultToolDefinitionsForTurn`）；
   * `resolveRunCapabilities`/controller 路径为 dormant parity（无生产调用方），其地板信号为 envelope-only
   * （`envelopeHasLocalDocumentResource`），与 executor 的 message∪envelope 信号在 path-present 资源上一致，
   * path-null-only 资源为已知 latent 分歧，controller 复活前需统一 doc-detection。
   */
  capabilityFloors?: CapabilityFloors | null
}

export interface PolicyOpenAIToolBundle {
  tools: Array<Record<string, unknown>>
  toolNames: string[]
  toolResolution: ToolResolutionDiagnostics
}

const PREFERRED_DESIGN_FALLBACK_TOOL_NAMES = new Set([
  'design_open_file',
  'design_capture_session',
  'design_get_editor_state',
  'design_get_style_guide',
  'design_snapshot_layout',
  'design_find_empty_space_on_canvas',
  'design_capture_canvas_screenshot',
  'design_verify_layout',
  'design_list_owned_nodes',
  'design_batch_design',
  'design_create_geo_shape',
  'design_save_project',
  'design_export_artifact',
])

// Skill-side filter primitives live in a dedicated pure module so that
// tests can exercise them without pulling in the electron-dependent
// tool registry chain. They are re-exported here for backward compat.
export {
  isSkillToolName,
  filterPreferredSkillAnthropicTools,
  filterPreferredSkillOpenAITools,
  mergeForceDocumentAllowedNames,
} from './execution-tool-skill-filters'

const CONTENT_MUTATING_DOCUMENT_TOOL_NAMES = new Set([
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
])

const FORCE_DOCUMENT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_rename_tab',
  'document_list_widgets',
  'document_read_section',
  ...CONTENT_MUTATING_DOCUMENT_TOOL_NAMES,
  'document_save_tab',
])

const FORMAT_SECTION_DOCUMENT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_read_section',
  'document_set_content',
  'document_append_content',
  'document_replace_text',
  'document_format_section',
  'document_save_tab',
])

const SECTION_REWRITE_DOCUMENT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_read_section',
  'document_rewrite_section',
  'document_save_tab',
])

const DOCUMENT_WIDGET_CREATE_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
  'document_read_section',
  'document_insert_widget',
  'document_update_widget',
  'document_save_tab',
])

const DOCUMENT_WIDGET_INSPECT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
  'document_read_section',
])

const DOCUMENT_WIDGET_UPDATE_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
  'document_read_section',
  'document_update_widget',
  'document_save_tab',
])

const DOCUMENT_WIDGET_REMOVE_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
  'document_read_section',
  'document_remove_widget',
  'document_save_tab',
])

function filterPreferredDesignAnthropicTools(
  tools: Array<Record<string, unknown>>,
  preferredDesignTool: string | null,
): Array<Record<string, unknown>> {
  if (!preferredDesignTool) return tools
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name : ''
    return name === preferredDesignTool || PREFERRED_DESIGN_FALLBACK_TOOL_NAMES.has(name)
  })
}

function filterPreferredDesignOpenAITools(
  tools: Array<Record<string, unknown>>,
  preferredDesignTool: string | null,
): Array<Record<string, unknown>> {
  if (!preferredDesignTool) return tools
  return tools.filter((tool) => {
    const fn = (tool.function as { name?: unknown } | undefined)?.name
    return typeof fn === 'string'
      ? fn === preferredDesignTool || PREFERRED_DESIGN_FALLBACK_TOOL_NAMES.has(fn)
      : false
  })
}

function filterAnthropicToolsByAllowedNames(
  tools: Array<Record<string, unknown>>,
  allowedNames: Set<string>,
): Array<Record<string, unknown>> {
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name : ''
    return allowedNames.has(name)
  })
}

function filterOpenAIToolsByAllowedNames(
  tools: Array<Record<string, unknown>>,
  allowedNames: Set<string>,
): Array<Record<string, unknown>> {
  return tools.filter((tool) => {
    const fn = (tool.function as { name?: unknown } | undefined)?.name
    return typeof fn === 'string' ? allowedNames.has(fn) : false
  })
}

/** 文档工具使用映射（唯一文案信源：buildToolGuidance 与 live 通道 buildDocumentSurfaceGuidance 共享）。 */
const DOCUMENT_TOOL_USAGE_RULES = `
## 工具使用建议

当前用户的请求可能涉及文档操作。如果用户明确要求编辑、修改或保存文档，请使用 document_* 工具。

**判断标准**:
- "修改第一段" → 使用 document_rewrite_section 或 document_replace_exact
- "读取第三部分/某章节内容" → 使用 document_read_section
- "把这段原文精准改掉" → 使用 document_replace_exact
- "在文档里做一个交互图表/组件" → 使用 document_insert_widget
- "插入/生成 信息卡、摘要卡、结论卡、对比卡、数据卡、指标卡、关系图、流程图、时间线、图表" → **必须**使用 document_insert_widget（componentSpec 结构化落地）；**禁止**用 document_replace_text / document_replace_exact / document_set_content / document_append_content 把 markdown 表格或手写 HTML 写进正文冒充卡片
- "在文档开头/顶部/标题下插入卡片" → document_insert_widget 配 position=prepend_start（不要用 append_end 落到文末再声称在开头）
- "看看文档里有哪些 widget" → 使用 document_list_widgets
- "更新这个 widget / 改图表内容" → 使用 document_update_widget，不要用 document_replace_text / document_replace_exact 修改 show-widget 围栏内部
- "删掉这个 widget" → 使用 document_remove_widget
- "保存文档" → 使用 document_save_tab
- "你是谁" → 直接回答，不使用工具
- "这篇文章怎么样" → 直接回答，不使用工具
`

export function buildToolGuidance(policy: ToolPolicy): string {
  const guidance: string[] = []

  if (policy.forceDocumentTool) {
    guidance.push(DOCUMENT_TOOL_USAGE_RULES)

    guidance.push(buildDocumentWidgetSkeletonRulesSnippet())
    guidance.push(buildDocumentWidgetOpenUIRulesSnippet())

    const widgetGuidance = buildDocumentWidgetGuidanceSnippet(policy.documentWidgetProfile || null)
    if (widgetGuidance) {
      guidance.push(widgetGuidance)
    } else {
      const widgetClarifier = buildDocumentWidgetClarificationSnippet(policy.documentWidgetSourceText || '')
      if (widgetClarifier) {
        guidance.push(widgetClarifier)
      }
    }
  }

  return guidance.join('\n\n')
}

/**
 * W10-F4 — 文档指引的 live 生产通道（SDK 前导词消费）。
 * 触发信号是"本轮最终工具面里有 document_insert_widget"这一事实，而非意图正则；
 * 注入内容 = 工具使用映射（与 buildToolGuidance 同源）+ OpenUI 组件目录（componentSpec
 * 组件名的唯一模型可见来源）+ 命中 widget 家族时的基线建议。骨架清单是编辑抽屉
 * 词汇，刻意不进自由工具循环轮。
 */
/** live 指引携带的核心组件字段结构：componentSpec 的 props 对模型必须可见，否则只能盲猜字段名。 */
const DOCUMENT_SURFACE_CORE_PROP_FAMILIES: ReadonlyArray<DocumentWidgetComponentName> = [
  'info_card',
  'callout_block',
  'stats_card',
  'bar_chart',
  'line_chart',
  'flow_diagram',
  'relationship_graph',
]

export function buildDocumentSurfaceGuidance(params: {
  toolNames: ReadonlySet<string>
  userText: string
}): string {
  if (!params.toolNames.has('document_insert_widget')) return ''
  const profile = inferDocumentWidgetProfile(params.userText || '')
  const propFamilies = new Set<DocumentWidgetComponentName>(DOCUMENT_SURFACE_CORE_PROP_FAMILIES)
  if (profile?.family) propFamilies.add(profile.family as DocumentWidgetComponentName)
  const propsBlock = [
    '### componentSpec 字段结构（!必填 ?可选）',
    describeApprovedWidgetProps(propFamilies),
  ].join('\n')
  return [
    DOCUMENT_TOOL_USAGE_RULES,
    buildDocumentWidgetOpenUIRulesSnippet(),
    propsBlock,
    profile ? buildDocumentWidgetGuidanceSnippet(profile) : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * P1-4 — 应用 skill allowed-tools 过滤前，把能力地板并入允许集：技能收窄只做减法、不移除地板项。
 * activeSkillAllowedTools 为空 → filterToolsByAllowedTools 本就是恒等，地板无需保护。
 */
function allowedToolNamesWithFloors(policy?: ToolPolicy): ReadonlyArray<string> | null {
  const allowed = policy?.activeSkillAllowedTools ?? null
  if (!allowed || allowed.length === 0) return allowed
  const floors = policy?.capabilityFloors?.toolNames
  if (!floors || floors.size === 0) return allowed
  return Array.from(new Set([...allowed, ...floors]))
}

export function getPolicyAnthropicTools(policy?: ToolPolicy): Array<Record<string, unknown>> {
  const visibleGroupIds = resolveVisibleGroupIds(policy)

  let tools = defaultToolGateway.getAnthropicToolsForGroups(
    visibleGroupIds,
    policy?.sessionId,
    resolvePolicyAuthorization(policy),
    policy?.scopeId,
  )
  if (policy?.forceDocumentTool) {
    const baseAllowed = policy.documentWidgetTaskKind === 'create'
      ? DOCUMENT_WIDGET_CREATE_TOOL_NAMES
      : policy.documentWidgetTaskKind === 'inspect'
        ? DOCUMENT_WIDGET_INSPECT_TOOL_NAMES
        : policy.documentWidgetTaskKind === 'update'
          ? DOCUMENT_WIDGET_UPDATE_TOOL_NAMES
          : policy.documentWidgetTaskKind === 'remove'
            ? DOCUMENT_WIDGET_REMOVE_TOOL_NAMES
            : policy.preferSectionRewrite
              ? SECTION_REWRITE_DOCUMENT_TOOL_NAMES
              : policy.preferFormatOnly
                ? FORMAT_SECTION_DOCUMENT_TOOL_NAMES
                : FORCE_DOCUMENT_TOOL_NAMES
    const allowedNames = _mergeForceDocumentAllowedNames(
      baseAllowed,
      policy.preferredSkillToolNames,
      resolvePolicyAuthorization(policy),
    )
    tools = filterAnthropicToolsByAllowedNames(tools, allowedNames)
  }
  if (policy?.allowDocumentTools === false) {
    tools = tools.filter((tool) => {
      const name = typeof tool.name === 'string' ? tool.name : ''
      return !name.startsWith('document_')
    })
  }
  if (policy?.forceDesignTool) {
    tools = filterPreferredDesignAnthropicTools(tools, policy.preferredDesignTool)
  }
  if (policy?.allowBrowserTools === false) {
    tools = tools.filter((tool) => {
      const name = typeof tool.name === 'string' ? tool.name : ''
      return !name.startsWith('browser_')
    })
  }
  tools = _filterPreferredSkillAnthropic(
    tools,
    policy?.preferredSkillToolNames || [],
    resolvePolicyAuthorization(policy),
  )
  // Stage S round 2 (Issue 3) — vision capability gate. When the
  // resolved capability says the model cannot accept image input, drop
  // any vision-bearing tool (currently `view_image`) before the model
  // ever sees the list. Conservative default: missing/undefined caps →
  // treated as `supportsVision: false` by the helper (deny).
  tools = filterToolsByVisionCapability(
    tools as Array<Record<string, unknown>>,
    { supportsVision: policy?.capabilityResolution?.supportsVision === true },
  )
  // Stage S round 2 (Issue 5) — active-skill manifest allowlist. When
  // a `mode:'selected'` authorization picked a skill whose manifest
  // declares `allowed_tools`, restrict the model-visible list to that
  // set. Empty / null → identity (no extra filtering on top of policy).
  tools = filterToolsByAllowedTools(tools, allowedToolNamesWithFloors(policy))
  return tools
}

export function getPolicyOpenAITools(policy?: ToolPolicy): Array<Record<string, unknown>> {
  return getPolicyOpenAIToolBundle(policy).tools
}

export function getPolicyOpenAIToolBundle(policy?: ToolPolicy): PolicyOpenAIToolBundle {
  const visibleGroupIds = resolveVisibleGroupIds(policy)
  const resolution = defaultToolGateway.getToolSchemaResolutionForGroups(
    visibleGroupIds,
    'openai',
    policy?.sessionId,
    resolvePolicyAuthorization(policy),
    policy?.scopeId,
  )
  let tools = resolution.tools
  if (policy?.forceDocumentTool) {
    const baseAllowed = policy.documentWidgetTaskKind === 'create'
      ? DOCUMENT_WIDGET_CREATE_TOOL_NAMES
      : policy.documentWidgetTaskKind === 'inspect'
        ? DOCUMENT_WIDGET_INSPECT_TOOL_NAMES
        : policy.documentWidgetTaskKind === 'update'
          ? DOCUMENT_WIDGET_UPDATE_TOOL_NAMES
          : policy.documentWidgetTaskKind === 'remove'
            ? DOCUMENT_WIDGET_REMOVE_TOOL_NAMES
            : policy.preferSectionRewrite
              ? SECTION_REWRITE_DOCUMENT_TOOL_NAMES
              : policy.preferFormatOnly
                ? FORMAT_SECTION_DOCUMENT_TOOL_NAMES
                : FORCE_DOCUMENT_TOOL_NAMES
    const allowedNames = _mergeForceDocumentAllowedNames(
      baseAllowed,
      policy.preferredSkillToolNames,
      resolvePolicyAuthorization(policy),
    )
    tools = filterOpenAIToolsByAllowedNames(tools, allowedNames)
  }
  if (policy?.allowDocumentTools === false) {
    tools = tools.filter((tool) => {
      const fn = (tool.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string' ? !fn.startsWith('document_') : true
    })
  }
  if (policy?.forceDesignTool) {
    tools = filterPreferredDesignOpenAITools(tools, policy.preferredDesignTool)
  }
  if (policy?.allowBrowserTools === false) {
    tools = tools.filter((tool) => {
      const fn = (tool.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string' ? !fn.startsWith('browser_') : true
    })
  }
  tools = _filterPreferredSkillOpenAI(
    tools,
    policy?.preferredSkillToolNames || [],
    resolvePolicyAuthorization(policy),
  )
  // Stage S round 2 (Issue 3) — vision capability gate. See the
  // anthropic path for rationale; OpenAI tools wrap the name under
  // `function.name`, the helper handles both shapes.
  tools = filterToolsByVisionCapability(
    tools,
    { supportsVision: policy?.capabilityResolution?.supportsVision === true },
  )
  // Stage S round 2 (Issue 5) — active-skill manifest allowlist filter.
  tools = filterToolsByAllowedTools(tools, allowedToolNamesWithFloors(policy))
  const normalizedTools = tools.map((tool) => normalizeOpenAIToolSchema(tool))
  const toolNames = collectToolNames(normalizedTools, 'openai')
  return {
    tools: normalizedTools,
    toolNames,
    toolResolution: buildToolResolutionDiagnostics({
      visibleGroupIds,
      groupResolutions: resolution.groupResolutions,
      toolNames,
      allowBrowserTools: Boolean(policy?.allowBrowserTools),
    }),
  }
}

export function collectToolNames(
  tools: Array<Record<string, unknown>>,
  format: 'anthropic' | 'openai',
): string[] {
  return tools
    .map((tool) => {
      if (format === 'anthropic') {
        return typeof tool.name === 'string' ? tool.name : ''
      }
      const fn = (tool.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string' ? fn : ''
    })
    .filter((name) => name.length > 0)
}

export function buildTextToolBridgeSystemPrompt(policy?: ToolPolicy): string {
  return buildTextToolBridgePrompt(getPolicyOpenAIToolBundle(policy).tools, {
    forceDocumentTool: !!policy?.forceDocumentTool,
  })
}

export function collectAllowedToolNames(policy?: ToolPolicy): string[] {
  return getPolicyOpenAIToolBundle(policy).toolNames
}

export function buildTextToolBridgeCorrectionMessage(policy?: ToolPolicy): string {
  const toolNames = getPolicyOpenAIToolBundle(policy).toolNames
  return [
    '系统纠正：当前会话已经启用文本工具桥接，下面这些 Ready 工具都可以真实执行。',
    `可用工具：${toolNames.join(', ') || '无'}`,
    '如果你需要浏览器/技能/文档/宠物操作，请直接输出 :::tool_call JSON ::: 块，不要再回答“当前通道没有工具”。',
    '如果你不确定该用哪个浏览器动作，优先先读页、定位输入框、定位按钮或读取 skill 说明，再继续。',
    '如果信息确实不足，可以提一个澄清问题，但不要伪造工具不可用。',
  ].join('\n')
}

function resolveVisibleGroupIds(policy?: ToolPolicy): CapabilityGroupId[] {
  return policy?.visibleCapabilityGroupIds
    && policy.visibleCapabilityGroupIds.length > 0
    ? policy.visibleCapabilityGroupIds
    : defaultToolGateway
      .listCapabilityGroups()
      .filter((group) => group.exposure === 'model_visible' && group.availability === 'active')
      .map((group) => group.id)
}

function buildToolResolutionDiagnostics(params: {
  visibleGroupIds: CapabilityGroupId[]
  groupResolutions: ToolGroupResolutionEntry[]
  toolNames: string[]
  allowBrowserTools: boolean
}): ToolResolutionDiagnostics {
  const visibleGroupToolCounts: Partial<Record<CapabilityGroupId, number>> = {}
  const groupSchemaErrors: Partial<Record<CapabilityGroupId, string>> = {}
  const usedStaticFallbackGroups = new Set<CapabilityGroupId>()

  for (const group of params.groupResolutions) {
    visibleGroupToolCounts[group.groupId] = group.toolCount
    if (group.schemaError) {
      groupSchemaErrors[group.groupId] = group.schemaError
    }
    if (group.usedStaticFallback) {
      usedStaticFallbackGroups.add(group.groupId)
    }
  }

  const browserGroupsVisible = params.visibleGroupIds.filter((groupId) =>
    groupId === 'browser_interaction' || groupId === 'browser_content_tasks')
  const invariantViolations: string[] = []
  if ((params.allowBrowserTools || browserGroupsVisible.length > 0) && !params.toolNames.some((name) => name.startsWith('browser_'))) {
    invariantViolations.push([
      'browser_tools_missing',
      `visibleGroups=${browserGroupsVisible.join('|') || 'none'}`,
      `allowBrowserTools=${params.allowBrowserTools}`,
    ].join(','))
  }

  return {
    visibleGroupToolCounts,
    groupSchemaErrors: Object.keys(groupSchemaErrors).length > 0 ? groupSchemaErrors : undefined,
    usedStaticFallbackGroups: Array.from(usedStaticFallbackGroups),
    invariantViolations: invariantViolations.length > 0 ? invariantViolations : undefined,
  }
}
