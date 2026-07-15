import type { AgentArtifact, AgentMessage, ChatAttachment } from '../agent/types'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return asRecord(value)
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function normalizeGeneratedArtifact(value: unknown): AgentArtifact | null {
  const record = asRecord(value)
  if (!record || record.kind !== 'generated_image') return null
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (!path || !label) return null
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : `generated-image:${path}`,
    module: 'system',
    kind: 'generated_image',
    label,
    path,
    url: null,
    mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/png',
    sourceRunId: typeof record.sourceRunId === 'string' ? record.sourceRunId : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
    meta: asRecord(record.meta) || undefined,
  }
}

export function generatedImagesFromMessage(message: AgentMessage): AgentArtifact[] {
  if (message.type !== 'agent') return []
  const meta = asRecord(message.meta)
  const taskSnapshot = parseRecord(meta?.taskSnapshot)
  const inputs = [
    ...(Array.isArray(taskSnapshot?.recentArtifacts) ? taskSnapshot.recentArtifacts : []),
    ...(Array.isArray(meta?.recentArtifacts) ? meta.recentArtifacts : []),
  ]
  const deduped = new Map<string, AgentArtifact>()
  for (const input of inputs) {
    const artifact = normalizeGeneratedArtifact(input)
    if (artifact?.path) deduped.set(artifact.path, artifact)
  }
  return Array.from(deduped.values())
}

export function generatedImageArtifactToAttachment(artifact: AgentArtifact): ChatAttachment {
  const name = artifact.label || artifact.path?.split(/[\\/]/).pop() || 'generated-image.png'
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || 'png' : 'png'
  return {
    id: artifact.id,
    name,
    path: artifact.path || '',
    type: 'image',
    size: 0,
    ext,
    source: 'generated-image',
    contentType: artifact.mimeType || 'image/png',
  }
}
