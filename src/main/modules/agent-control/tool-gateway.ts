import type { CapabilityGroupDefinition, CapabilityGroupId } from '../../../shared/ai-capability-groups'
import { CAPABILITY_GROUPS } from '../../../shared/ai-capability-groups'
import { logAgentMetric } from './metrics'
import type { ToolDefinition } from './tool-definition'
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

interface ToolGatewayOptions extends ToolRegistryOptions {}

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

  private resolveGroupToolDefinitions(groupId: CapabilityGroupId, sessionId?: string): ToolDefinition[] {
    return this.registry.getToolDefinitionsForGroup(groupId, sessionId)
  }

  private resolveGroupToolSchemasDetailed(
    groupId: CapabilityGroupId,
    format: ToolSchemaFormat,
    sessionId?: string,
  ): ToolSchemaResolution {
    const errorKey = this.resolutionErrorKey(groupId, format)
    this.lastSchemaResolutionErrors.delete(errorKey)
    try {
      const resolution = this.registry.getToolSchemasResolutionForGroup(groupId, format, sessionId)
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
    sessionId?: string,
  ): Array<Record<string, unknown>> {
    return this.resolveGroupToolSchemasDetailed(groupId, format, sessionId).tools
  }

  private resolveGroupToolNames(groupId: CapabilityGroupId, sessionId?: string): string[] {
    return this.resolveGroupToolDefinitions(groupId, sessionId).map((tool) => tool.name)
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
    sessionId?: string,
  ): Array<Record<string, unknown>> {
    return this.resolveGroupToolSchemas(groupId, format, sessionId)
  }

  getLastSchemaResolutionError(groupId: CapabilityGroupId, format: ToolSchemaFormat): string | null {
    return this.lastSchemaResolutionErrors.get(this.resolutionErrorKey(groupId, format)) || null
  }

  getToolSchemaResolutionForGroups(
    groupIds: CapabilityGroupId[],
    format: ToolSchemaFormat,
    sessionId?: string,
  ): ToolGroupResolutionResult {
    const tools = new Map<string, Record<string, unknown>>()
    const groupResolutions: ToolGroupResolutionEntry[] = []
    for (const groupId of groupIds) {
      const resolution = this.resolveGroupToolSchemasDetailed(groupId, format, sessionId)
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
    sessionId?: string,
  ): Array<Record<string, unknown>> {
    return this.getToolSchemaResolutionForGroups(groupIds, 'anthropic', sessionId).tools
  }

  getOpenAIToolsForGroups(
    groupIds: CapabilityGroupId[],
    sessionId?: string,
  ): Array<Record<string, unknown>> {
    return this.getToolSchemaResolutionForGroups(groupIds, 'openai', sessionId).tools
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
