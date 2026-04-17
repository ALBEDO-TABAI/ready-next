import type { RequestEnvelope } from './request-envelope'
import type { DocumentTaskJob } from './document-task-plan'

export interface DocumentInsightSourceMaterial {
  kind: 'attachment_body' | 'document_excerpt' | 'snapshot' | 'task_plan'
  text: string
  sourceDocumentTitle?: string
  sourceDocumentPath?: string | null
}

function normalizeChunkText(text: string): string {
  return String(text || '')
    .replace(/^---\s*(引用文件|附件):[^\n]*\n?/gm, '')
    .replace(/(?:^|\n)-\s*路径:\s*[^\n]+/g, '')
    .trim()
}

function buildJobSourceMaterial(job: DocumentTaskJob): DocumentInsightSourceMaterial | null {
  const sourceBindings = job.bindings.filter((binding) => (
    binding.role === 'primary_source' || binding.role === 'secondary_source'
  ))
  if (sourceBindings.length === 0) return null

  const primarySource = sourceBindings.find((binding) => binding.role === 'primary_source')?.resource || sourceBindings[0].resource
  const text = sourceBindings
    .map((binding) => {
      const body = normalizeChunkText(binding.resource.text)
      if (!body) return null
      return `--- 来源: ${binding.resource.name} ---\n${body}`
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!text) return null

  return {
    kind: 'task_plan',
    text,
    sourceDocumentTitle: primarySource.name,
    sourceDocumentPath: primarySource.path,
  }
}

export function buildDocumentInsightSourceMaterial(params: {
  requestEnvelope: RequestEnvelope
  snapshotContent: string
  job?: DocumentTaskJob | null
}): DocumentInsightSourceMaterial {
  const jobMaterial = params.job ? buildJobSourceMaterial(params.job) : null
  if (jobMaterial) return jobMaterial

  const attachmentBodies = params.requestEnvelope.chunks
    .filter((chunk) => chunk.source === 'attachment_body')
    .map((chunk) => normalizeChunkText(chunk.text))
    .filter(Boolean)
  if (attachmentBodies.length > 0) {
    return {
      kind: 'attachment_body',
      text: attachmentBodies.join('\n\n'),
    }
  }

  const documentExcerpts = params.requestEnvelope.chunks
    .filter((chunk) => chunk.source === 'document_excerpt')
    .map((chunk) => normalizeChunkText(chunk.text))
    .filter(Boolean)
  if (!params.snapshotContent.trim() && documentExcerpts.length > 0) {
    return {
      kind: 'document_excerpt',
      text: documentExcerpts.join('\n\n'),
    }
  }

  return {
    kind: 'snapshot',
    text: params.snapshotContent,
  }
}
