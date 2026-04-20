import type {
  DocumentWidgetComponentSpecSummary,
  DocumentWidgetSkeletonSpecSummary,
} from './document-widget-parse'

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

export function mergeSkeletonSpecPatch(
  base: DocumentWidgetSkeletonSpecSummary | null | undefined,
  patch: Record<string, unknown>,
): DocumentWidgetSkeletonSpecSummary {
  const baseSkeleton = base?.skeleton ?? ''
  const nextSkeleton = typeof patch.skeleton === 'string' && patch.skeleton.trim().length > 0
    ? patch.skeleton.trim()
    : baseSkeleton
  const nextSize = typeof patch.size === 'string' && patch.size.trim().length > 0
    ? patch.size.trim()
    : base?.size
  const bgPatch = patch.background_mode ?? patch.backgroundMode
  const nextBackgroundMode: 'opaque' | 'transparent' | undefined =
    bgPatch === 'opaque' || bgPatch === 'transparent'
      ? bgPatch
      : base?.background_mode
  return {
    skeleton: nextSkeleton,
    size: nextSize,
    background_mode: nextBackgroundMode,
    props: mergeRecordPatch(base?.props, patch.props),
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
