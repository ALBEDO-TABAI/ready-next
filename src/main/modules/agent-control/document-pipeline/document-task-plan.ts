import type { RequestEnvelope, RequestEnvelopeResource } from '../contracts/request-envelope'

export type DocumentTaskResourceRole =
  | 'primary_source'
  | 'secondary_source'
  | 'style_reference'
  | 'template_reference'
  | 'target_document'
  | 'target_location'
  | 'ambient_context'
  | 'intermediate_artifact'

export type DocumentTaskStep =
  | 'collect_materials'
  | 'build_insight'
  | 'compose_widget'
  | 'write_target'
  | 'save_target'
  | 'verify_result'

export interface DocumentTaskBinding {
  role: DocumentTaskResourceRole
  resource: RequestEnvelopeResource
}

export interface DocumentTaskJob {
  id: string
  instruction: string
  action: 'compose_widget'
  steps: DocumentTaskStep[]
  bindings: DocumentTaskBinding[]
}

export interface DocumentTaskPlan {
  requiresStructuredPlan: boolean
  jobs: DocumentTaskJob[]
  blockedReason: string | null
}

function extractMentions(text: string): string[] {
  return Array.from(text.matchAll(/@\[([^\]]+)\]/g))
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean)
}

function normalizeIdentity(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .replace(/^.*[\\/]/, '')
    .toLowerCase()
}

function dedupeResources(resources: RequestEnvelopeResource[]): RequestEnvelopeResource[] {
  const seen = new Set<string>()
  return resources.filter((resource) => {
    const key = `${resource.kind}::${resource.source}::${resource.path || ''}::${resource.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function scoreResourceCandidate(resource: RequestEnvelopeResource, preferredWritable: boolean): number {
  if (preferredWritable && resource.canWrite) {
    if (resource.source === 'explicit_reference') return 60
    if (resource.source === 'current_document') return 50
    if (resource.source === 'user_attachment') return 40
  }

  switch (resource.source) {
    case 'explicit_reference':
      return 40
    case 'user_attachment':
      return 30
    case 'document_quote':
      return 20
    case 'current_document':
      return 10
    default:
      return 0
  }
}

function resolveMentionResource(params: {
  mention: string
  resources: RequestEnvelopeResource[]
  preferredWritable?: boolean
}): RequestEnvelopeResource | null {
  const targetIdentity = normalizeIdentity(params.mention)
  const candidates = params.resources
    .filter((resource) => (
      normalizeIdentity(resource.name) === targetIdentity
      || normalizeIdentity(resource.path) === targetIdentity
      || String(resource.path || '').trim() === String(params.mention || '').trim()
    ))
    .sort((left, right) => (
      scoreResourceCandidate(right, Boolean(params.preferredWritable))
      - scoreResourceCandidate(left, Boolean(params.preferredWritable))
    ))

  if (params.preferredWritable) {
    const writable = candidates.find((resource) => resource.canWrite)
    if (writable) return writable
  }

  return candidates[0] || null
}

function findAmbientCurrentDocument(resources: RequestEnvelopeResource[]): RequestEnvelopeResource | null {
  return resources.find((resource) => resource.kind === 'document_context') || null
}

function detectCardLikeRequest(text: string): boolean {
  return /(信息卡|卡片|widget|show-widget|图表|摘要卡|对比卡|写到|写入|放到|加入)/i.test(text)
}

function splitInstructionIntoSegments(text: string): string[] {
  return String(text || '')
    .split(/(?:然后|接着|并且|再根据|再为|同时根据|同时为|；|;|\n)/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function extractTargetMentions(segment: string): string[] {
  const targetMentions: string[] = []
  const targetGroupPattern = /(?:在|写到|写入|放到|加入)\s*([^。；;\n]+)/g
  let match = targetGroupPattern.exec(segment)
  while (match) {
    targetMentions.push(...extractMentions(match[1] || ''))
    match = targetGroupPattern.exec(segment)
  }
  return targetMentions
}

function buildBindings(params: {
  segment: string
  resources: RequestEnvelopeResource[]
}): { bindings: DocumentTaskBinding[]; blockedReason: string | null } {
  const mentions = extractMentions(params.segment)
  const ambientContext = findAmbientCurrentDocument(params.resources)
  const targetMentions = extractTargetMentions(params.segment)

  if (targetMentions.length > 1) {
    return { bindings: [], blockedReason: '当前请求里有多个写入目标，系统还无法明确每份材料该写到哪里。' }
  }

  const targetMention = targetMentions[0] || null
  const targetResource = targetMention
    ? resolveMentionResource({
      mention: targetMention,
      resources: params.resources,
      preferredWritable: true,
    })
    : ambientContext

  const sourceMentions = mentions.filter((mention) => mention !== targetMention)
  const sourceResources = dedupeResources(sourceMentions
    .map((mention, index) => resolveMentionResource({
      mention,
      resources: params.resources,
      preferredWritable: index > 0 ? false : false,
    }))
    .filter(Boolean) as RequestEnvelopeResource[])

  if (sourceResources.length === 0 || !targetResource) {
    return { bindings: [], blockedReason: null }
  }

  const bindings: DocumentTaskBinding[] = [
    { role: 'primary_source', resource: sourceResources[0] },
    ...sourceResources.slice(1).map((resource) => ({
      role: 'secondary_source' as const,
      resource,
    })),
    { role: 'target_document', resource: targetResource },
  ]

  if (ambientContext && targetResource.id !== ambientContext.id) {
    bindings.push({ role: 'ambient_context', resource: ambientContext })
  }

  return { bindings, blockedReason: null }
}

function shouldUseStructuredPlan(params: {
  userInstructionText: string
  resources: RequestEnvelopeResource[]
  jobs: DocumentTaskJob[]
}): boolean {
  if (params.jobs.length > 1) return true
  if (params.jobs.length === 1) return true
  if (params.resources.filter((resource) => resource.kind === 'attachment').length > 1) return true
  return /根据|参考|基于|分别|写到|写入|放到/.test(params.userInstructionText)
}

export function buildDocumentTaskPlan(params: {
  requestEnvelope: RequestEnvelope
  userInstructionText: string
}): DocumentTaskPlan {
  const text = String(params.userInstructionText || '').trim()
  const resources = params.requestEnvelope.resources
  if (!text || !detectCardLikeRequest(text)) {
    return {
      requiresStructuredPlan: false,
      jobs: [],
      blockedReason: null,
    }
  }

  const segments = splitInstructionIntoSegments(text)
  const jobs: DocumentTaskJob[] = []

  for (const segment of segments) {
    const mentions = extractMentions(segment)
    if (mentions.length === 0) continue

    const targetMentions = extractTargetMentions(segment)
    if (targetMentions.length > 1) {
      return {
        requiresStructuredPlan: true,
        jobs: [],
        blockedReason: '当前请求里有多个写入目标，系统还无法明确每份材料该写到哪里。',
      }
    }

    const { bindings, blockedReason } = buildBindings({
      segment,
      resources,
    })

    if (blockedReason) {
      return {
        requiresStructuredPlan: true,
        jobs: [],
        blockedReason,
      }
    }

    if (bindings.length === 0) continue

    jobs.push({
      id: `document-task-job-${jobs.length + 1}`,
      instruction: segment,
      action: 'compose_widget',
      steps: [
        'collect_materials',
        'build_insight',
        'compose_widget',
        'write_target',
        'save_target',
        'verify_result',
      ],
      bindings,
    })
  }

  return {
    requiresStructuredPlan: shouldUseStructuredPlan({
      userInstructionText: text,
      resources,
      jobs,
    }),
    jobs,
    blockedReason: null,
  }
}
