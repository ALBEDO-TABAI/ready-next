import type { DocumentWidgetComponentSpecSummary } from './document-widget-parse'

export function mergeComponentSpecPatch(
  base: DocumentWidgetComponentSpecSummary,
  patch: Record<string, unknown>,
): DocumentWidgetComponentSpecSummary {
  const nextComponent = typeof patch.component === 'string' && patch.component.trim().length > 0
    ? patch.component.trim()
    : base.component
  return {
    component: nextComponent,
    props: mergeRecordPatch(base.props, patch.props),
    dataSource: mergeRecordPatch(base.dataSource, patch.dataSource),
  }
}

export function mergeRecordPatch(
  base: Record<string, unknown> | undefined,
  patch: unknown,
): Record<string, unknown> | undefined {
  if (patch === undefined) return base
  if (patch === null) return undefined
  if (typeof patch !== 'object' || Array.isArray(patch)) return base
  const baseRecord = base && typeof base === 'object' && !Array.isArray(base) ? base : {}
  const next: Record<string, unknown> = { ...baseRecord }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete next[key]
      continue
    }
    if (Array.isArray(value)) {
      next[key] = value
      continue
    }
    if (value && typeof value === 'object') {
      const existing = next[key]
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        next[key] = mergeRecordPatch(existing as Record<string, unknown>, value)
      } else {
        next[key] = mergeRecordPatch(undefined, value) ?? (value as Record<string, unknown>)
      }
      continue
    }
    next[key] = value
  }
  return next
}
