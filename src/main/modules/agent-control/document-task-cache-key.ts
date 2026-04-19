import { createHash } from 'crypto'

import type { DocumentTaskJob, DocumentTaskStep } from './document-task-plan'

function hashText(value: string): string {
  return createHash('sha1')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 12)
}

function normalizeQuestion(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

export function buildDocumentTaskStepCacheKey(params: {
  question: string
  step: Extract<DocumentTaskStep, 'build_insight' | 'compose_widget'>
  job: DocumentTaskJob
  targetSnapshot?: {
    title: string
    path: string | null
    tabId?: string | null
    content?: string
  } | null
}): string {
  const targetBinding = params.job.bindings.find((binding) => binding.role === 'target_document')?.resource || null
  const targetIdentity = params.targetSnapshot?.path
    || targetBinding?.path
    || params.targetSnapshot?.title
    || targetBinding?.name
    || 'unknown-target'
  const widgetId = targetBinding?.widgetId || 'no-widget'
  const tabId = params.targetSnapshot?.tabId || targetBinding?.tabId || 'no-tab'

  const bindingKey = params.job.bindings
    .map((binding) => {
      const identity = binding.resource.path || binding.resource.name
      const textHash = binding.role === 'target_document'
        ? hashText(params.targetSnapshot?.content ?? binding.resource.text ?? '')
        : hashText(binding.resource.text)
      return `${binding.role}:${identity}:${textHash}`
    })
    .sort()
    .join('|')

  return [
    params.step,
    targetIdentity,
    widgetId,
    tabId,
    normalizeQuestion(params.question),
    hashText(bindingKey),
  ].join('::')
}
