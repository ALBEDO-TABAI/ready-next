import type { CapabilityGroupDefinition, CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import { CAPABILITY_GROUPS } from '../../../../shared/ai-capability-groups'
import { logAgentMetric } from '../metrics'
import type { ToolDefinition } from './tool-definition'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { CapabilityResolution } from '../domain-adapters/capability-resolver'

/**
 * Stage S (PR-S6 / W4.2) — vision tool capability gating.
 *
 * Tool names that require image-input capability on the model side.
 * Resolved at load-time (when the gateway hands the model its tool
 * list). When `capabilityResolution.supportsVision === false`, these
 * tools must NOT be exposed to the model.
 *
 * Today the catalogue is empty (no `view_image` tool ships yet); this
 * helper exists so the future `view_image` (and any other vision tools)
 * can be added in one place. The gate `check-vision-tool-capability-
 * gated.cjs` only requires the helper + a `capabilityResolution.
 * supportsVision` check to be wired here.
 */
export const VISION_REQUIRING_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
  // The `view_image` tool is the canonical vision-bearing tool name. It
  // does not yet ship as a registered tool; listing it here pre-arms the
  // allowlist so the gateway is ready the moment the handler lands. The
  // filter is a no-op for non-vision models even with this entry, since
  // `view_image` won't appear in the input `tools` array until then.
  'view_image',
])

export function filterToolsByVisionCapability(
  tools: Array<Record<string, unknown>>,
  capabilityResolution: Pick<CapabilityResolution, 'supportsVision'>,
): Array<Record<string, unknown>> {
  if (capabilityResolution.supportsVision === true) return tools
  if (VISION_REQUIRING_TOOL_NAMES.length === 0) return tools
  return tools.filter((tool) => {
    const name = typeof (tool as { name?: unknown }).name === 'string'
      ? (tool as { name: string }).name
      : (typeof (tool as { function?: { name?: unknown } }).function?.name === 'string'
        ? (tool as { function: { name: string } }).function.name
        : null)
    if (!name) return true
    return !VISION_REQUIRING_TOOL_NAMES.includes(name)
  })
}

/**
 * Stage S (PR-S12 / W11.1 followup) — manifest `allowed_tools` runtime
 * filter. When a skill manifest declares `allowed_tools: string[]`, the
 * compiler attaches the normalised array onto `SkillDefinition.allowedTools`
 * (see `skill-compiler.validateAllowedTools`). This helper applies that
 * allowlist at the gateway boundary so future integration into
 * `getToolDefinitionsForGroup`'s skills branch is a single call site.
 *
 * Contract:
 *   - `null` / `undefined` / empty array → identity (no filtering)
 *   - otherwise → tools whose `name` (or `function.name`) is in the set
 *   - tools without a resolvable name pass through (defensive)
 */
export function filterToolsByAllowedTools<T extends { name?: string; function?: { name?: string } }>(
  tools: ReadonlyArray<T>,
  allowedTools: ReadonlyArray<string> | null | undefined,
): T[] {
  if (!allowedTools || allowedTools.length === 0) return tools.slice()
  const allowed = new Set(allowedTools)
  return tools.filter((tool) => {
    const name = (typeof tool.name === 'string' && tool.name)
      || (tool.function && typeof tool.function.name === 'string' ? tool.function.name : null)
    return name ? allowed.has(name) : true
  })
}

import {
  ToolRegistry,
  type ToolSchemaResolution,
  type ToolRegistryOptions,
  type ToolSchemaFormat,
} from './tool-registry'

export interface ToolDescriptor {
  id: string
  group: string
  description: string
  module?: string
  executionKind?: 'deterministic' | 'interactive' | 'job' | 'pipeline'
  family?: string
  domain?: ToolDefinition['domain']
  kind?: ToolDefinition['kind']
  concurrency?: ToolDefinition['concurrency']
  interruptBehavior?: ToolDefinition['interruptBehavior']
  timeoutProfile?: ToolDefinition['timeoutProfile']
  supportsTextBridge?: ToolDefinition['supportsTextBridge']
  projectionHint?: ToolDefinition['projectionHint']
  resultShape?: ToolDefinition['resultShape']
}

export interface CapabilityGroupRegistryEntry extends CapabilityGroupDefinition {
  toolNames: string[]
  hasDynamicSource: boolean
}

export interface ToolGroupResolutionEntry {
  groupId: CapabilityGroupId
  visible: boolean
  toolCount: number
  schemaError?: string | null
  usedStaticFallback: boolean
}

export interface ToolGroupResolutionResult {
  tools: Array<Record<string, unknown>>
  groupResolutions: ToolGroupResolutionEntry[]
}

type ToolGatewayOptions = ToolRegistryOptions

export class ToolGateway {
  private readonly capabilityGroupMeta = new Map<CapabilityGroupId, CapabilityGroupDefinition>(
    CAPABILITY_GROUPS.map((group) => [group.id, group]),
  )
  private readonly registry: ToolRegistry
  private readonly lastSchemaResolutionErrors = new Map<string, string>()

  constructor(options?: ToolGatewayOptions) {
    this.registry = new ToolRegistry(options)
  }

  private resolutionErrorKey(groupId: CapabilityGroupId, format: ToolSchemaFormat): string {
    return `${groupId}:${format}`
  }

  private resolveGroupToolDefinitions(
    groupId: CapabilityGroupId,
    sessionId: string | undefined,
    authorization: SkillToolAuthorization,
    scopeId?: string,
  ): ToolDefinition[] {
    return this.registry.getToolDefinitionsForGroup(groupId, sessionId, authorization, scopeId)
  }

  private resolveGroupToolSchemasDetailed(
    groupId: CapabilityGroupId,
    format: ToolSchemaFormat,
    sessionId: string | undefined,
    authorization: SkillToolAuthorization,
    scopeId?: string,
  ): ToolSchemaResolution {
    const errorKey = this.resolutionErrorKey(groupId, format)
    this.lastSchemaResolutionErrors.delete(errorKey)
    try {
      const resolution = this.registry.getToolSchemasResolutionForGroup(groupId, format, sessionId, authorization, scopeId)
      const errorMessage = resolution.error || null
      if (errorMessage) {
        this.lastSchemaResolutionErrors.set(errorKey, errorMessage)
        logAgentMetric('tool_group_blocked_rate', {
          groupId,
          format,
          reason: errorMessage,
        })
      }
      return resolution
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastSchemaResolutionErrors.set(errorKey, message)
      logAgentMetric('tool_group_blocked_rate', {
        groupId,
        format,
        reason: message,
      })
      return {
        tools: [],
        error: message,
      }
    }
  }

  private resolveGroupToolSchemas(
    groupId: CapabilityGroupId,
    format: ToolSchemaFormat,
    sessionId: string | undefined,
    authorization: SkillToolAuthorization,
    scopeId?: string,
  ): Array<Record<string, unknown>> {
    return this.resolveGroupToolSchemasDetailed(groupId, format, sessionId, authorization, scopeId).tools
  }

  // Stage 10 (P) Phase B'-1 — capability metadata path. The previous
  // implementation accepted `authorization` and routed through the
  // model-visible `resolveGroupToolDefinitions` wrapper, but every
  // in-class caller (`buildCapabilityGroupEntry`, `collectToolNamesForGroups`)
  // already passes no authorization. Tool-name aggregation for capability
  // metadata must see ALL tools (not the model-visible filtered subset),
  // so this method now routes through the registry's unfiltered
  // internal-lookup resolver.
  private resolveGroupToolNames(
    groupId: CapabilityGroupId,
    sessionId?: string,
  ): string[] {
    return this.registry
      .getToolDefinitionsResolutionForGroupForInternalLookup(groupId, sessionId)
      .definitions.map((tool) => tool.name)
  }

  private buildCapabilityGroupEntry(groupId: CapabilityGroupId): CapabilityGroupRegistryEntry {
    const group = this.capabilityGroupMeta.get(groupId)
    if (!group) {
      throw new Error(`Unknown capability group: ${groupId}`)
    }
    return {
      ...group,
      toolNames: this.resolveGroupToolNames(groupId),
      hasDynamicSource: this.registry.hasDynamicSource(groupId),
    }
  }

  private listResolvedToolDescriptors(): ToolDescriptor[] {
    return this.listCapabilityGroups().flatMap((group) =>
      group.toolNames.map((toolName) => {
        const definition = this.getToolDefinition(toolName)
        return {
          id: toolName,
          group: group.id,
          description: definition?.description || group.description,
          module: group.id,
          executionKind: group.executionKinds[0] === 'job'
            ? 'job'
            : group.executionKinds[0] === 'pipeline'
              ? 'pipeline'
              : group.executionKinds[0] === 'interactive'
                ? 'interactive'
                : 'deterministic',
          family: `${group.id}_*`,
          domain: definition?.domain,
          kind: definition?.kind,
          concurrency: definition?.concurrency,
          interruptBehavior: definition?.interruptBehavior,
          timeoutProfile: definition?.timeoutProfile,
          supportsTextBridge: definition?.supportsTextBridge,
          projectionHint: definition?.projectionHint,
          resultShape: definition?.resultShape,
        }
      }),
    )
  }

  listCapabilityGroups(): CapabilityGroupRegistryEntry[] {
    return CAPABILITY_GROUPS.map((group) => this.buildCapabilityGroupEntry(group.id))
  }

  getCapabilityGroup(id: CapabilityGroupId): CapabilityGroupRegistryEntry | null {
    return this.capabilityGroupMeta.has(id) ? this.buildCapabilityGroupEntry(id) : null
  }

  collectToolNamesForGroups(groupIds: CapabilityGroupId[]): string[] {
    const names = new Set<string>()
    for (const groupId of groupIds) {
      for (const toolName of this.resolveGroupToolNames(groupId)) {
        names.add(toolName)
      }
    }
    return Array.from(names)
  }

  getToolSchemasForGroup(
    groupId: CapabilityGroupId,
    format: ToolSchemaFormat,
    sessionId: string | undefined,
    authorization: SkillToolAuthorization,
    scopeId?: string,
  ): Array<Record<string, unknown>> {
    return this.resolveGroupToolSchemas(groupId, format, sessionId, authorization, scopeId)
  }

  getLastSchemaResolutionError(groupId: CapabilityGroupId, format: ToolSchemaFormat): string | null {
    return this.lastSchemaResolutionErrors.get(this.resolutionErrorKey(groupId, format)) || null
  }

  getToolSchemaResolutionForGroups(
    groupIds: CapabilityGroupId[],
    format: ToolSchemaFormat,
    sessionId: string | undefined,
    authorization: SkillToolAuthorization,
    scopeId?: string,
  ): ToolGroupResolutionResult {
    const tools = new Map<string, Record<string, unknown>>()
    const groupResolutions: ToolGroupResolutionEntry[] = []
    for (const groupId of groupIds) {
      const resolution = this.resolveGroupToolSchemasDetailed(groupId, format, sessionId, authorization, scopeId)
      for (const tool of resolution.tools) {
        const name = format === 'anthropic'
          ? (typeof tool.name === 'string' ? tool.name : null)
          : (typeof (tool.function as { name?: unknown } | undefined)?.name === 'string'
              ? (tool.function as { name: string }).name
              : null)
        if (name && !tools.has(name)) {
          tools.set(name, tool)
        }
      }
      groupResolutions.push({
        groupId,
        visible: true,
        toolCount: resolution.tools.length,
        schemaError: resolution.error || null,
        usedStaticFallback: Boolean(resolution.usedStaticFallback),
      })
    }
    return {
      tools: Array.from(tools.values()),
      groupResolutions,
    }
  }

  getAnthropicToolsForGroups(
    groupIds: CapabilityGroupId[],
    sessionId: string | undefined,
    authorization: SkillToolAuthorization,
    scopeId?: string,
  ): Array<Record<string, unknown>> {
    return this.getToolSchemaResolutionForGroups(groupIds, 'anthropic', sessionId, authorization, scopeId).tools
  }

  getOpenAIToolsForGroups(
    groupIds: CapabilityGroupId[],
    sessionId: string | undefined,
    authorization: SkillToolAuthorization,
    scopeId?: string,
  ): Array<Record<string, unknown>> {
    return this.getToolSchemaResolutionForGroups(groupIds, 'openai', sessionId, authorization, scopeId).tools
  }

  getToolDefinition(id: string): ToolDefinition | null {
    return this.registry.getToolDefinition(id)
  }

  listToolDefinitions(): ToolDefinition[] {
    return this.registry.listToolDefinitions()
  }

  listTools(): ToolDescriptor[] {
    return this.listResolvedToolDescriptors()
  }

  count(): number {
    return this.listResolvedToolDescriptors().length
  }

  listToolGroups(): string[] {
    return CAPABILITY_GROUPS.map((group) => group.id)
  }

  getTool(id: string): ToolDescriptor | null {
    return this.listResolvedToolDescriptors().find((tool) => tool.id === id) || null
  }

  hasTool(id: string): boolean {
    return this.getTool(id) !== null
  }

  listByModule(module: string): ToolDescriptor[] {
    return this.listResolvedToolDescriptors().filter((tool) => tool.module === module)
  }
}

export const defaultToolGateway = new ToolGateway()
