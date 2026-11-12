import { createHash } from 'node:crypto'
import { getMcpClient } from '../../../mcp/client'
import { getMcpServerRegistration } from '../../../mcp/registry'
import type { resolveCodexExplicitResources } from '../codex-explicit-resources'

/** Resolve an explicitly selected MCP resource against its frozen catalog and content digests. */
export const resolveIngressMcpResource: NonNullable<Parameters<typeof resolveCodexExplicitResources>[0]['resolveMcpResource']> = async (selection) => {
  const registration = getMcpServerRegistration(selection.serverId)
  if (!registration
    || registration.catalogGeneration !== selection.catalogGeneration
    || registration.catalogDigest !== selection.catalogDigest
    || !registration.resources?.some((resource) => resource.uri === selection.uri)) return null
  const client = getMcpClient(selection.serverId)
  if (!client) return null
  const content = await client.readResource(selection.uri)
  const serialized = JSON.stringify(content)
  const digest = createHash('sha256').update(serialized).digest('hex')
  if (digest !== selection.contentDigest) return null
  const resource = registration.resources.find((candidate) => candidate.uri === selection.uri)
  return {
    name: resource?.name || selection.name,
    path: selection.uri,
    text: [
      `用户明确选中的 MCP 只读资源（server: ${selection.serverId}，uri: ${selection.uri}）：`,
      serialized.slice(0, 30_000),
    ].join('\n\n'),
    digest,
  }
}
