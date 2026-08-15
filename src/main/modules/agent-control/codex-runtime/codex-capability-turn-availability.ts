import { digestCanonicalJson } from './codex-model-gateway-contract'
import {
  READY_CAPABILITY_GROUP_IDS,
  type ReadyCapabilityGroupId,
} from './codex-capability-catalog'
import type { TrustedBrowserPageRef } from './codex-browser-admission'

export type ReadyCapabilityTurnAvailability = {
  availableGroupIds: readonly ReadyCapabilityGroupId[]
  explicitFloorGroupIds: readonly ReadyCapabilityGroupId[]
  unavailableReasons: Readonly<Partial<Record<ReadyCapabilityGroupId, string>>>
  availabilityDigest: string
}

export type ReadyCapabilityTurnAvailabilityInput = {
  publicResearchProviderAvailable: boolean
  calendarHostAvailable: boolean
  calendarProductMapped: boolean
  workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar' | null
  currentBrowserPageRef?: TrustedBrowserPageRef | null
  explicitBrowserReadRefs?: readonly TrustedBrowserPageRef[]
  hasCalendarResource?: boolean
  tagForgeExclusive?: boolean
}

function uniqueSorted(values: readonly ReadyCapabilityGroupId[]): ReadyCapabilityGroupId[] {
  return [...new Set(values)].sort()
}

export function resolveReadyCapabilityTurnAvailability(
  input: ReadyCapabilityTurnAvailabilityInput,
): ReadyCapabilityTurnAvailability {
  const unavailableReasons: Partial<Record<ReadyCapabilityGroupId, string>> = {}
  const available: ReadyCapabilityGroupId[] = []
  const floors: ReadyCapabilityGroupId[] = []
  const hasExactCurrentPage = Boolean(input.currentBrowserPageRef)
  const hasTypedBrowserReference = (input.explicitBrowserReadRefs || []).length > 0

  if (input.tagForgeExclusive === true) {
    for (const id of READY_CAPABILITY_GROUP_IDS) {
      unavailableReasons[id] = 'tag_forge_exclusive'
    }
    const snapshot = {
      availableGroupIds: [] as ReadyCapabilityGroupId[],
      explicitFloorGroupIds: [] as ReadyCapabilityGroupId[],
      unavailableReasons,
    }
    return {
      ...snapshot,
      availabilityDigest: digestCanonicalJson(snapshot),
    }
  }

  if (input.publicResearchProviderAvailable) {
    available.push('public_research')
  } else {
    unavailableReasons.public_research = 'provider_unavailable'
  }

  if (hasExactCurrentPage || hasTypedBrowserReference) {
    available.push('browser_current_read')
    if (hasTypedBrowserReference) floors.push('browser_current_read')
  } else {
    unavailableReasons.browser_current_read = 'page_ref_missing'
  }

  if (hasExactCurrentPage) {
    available.push('browser_current_act')
  } else {
    unavailableReasons.browser_current_act = hasTypedBrowserReference
      ? 'typed_reference_is_read_only'
      : 'page_ref_missing'
  }

  if (input.calendarHostAvailable) {
    available.push('calendar_read')
    if (input.workbenchMode === 'calendar' || input.hasCalendarResource === true) {
      floors.push('calendar_read')
    }
  } else {
    unavailableReasons.calendar_read = 'calendar_host_unavailable'
  }

  if (input.calendarHostAvailable && input.calendarProductMapped) {
    available.push('calendar_write')
  } else {
    unavailableReasons.calendar_write = input.calendarHostAvailable
      ? 'calendar_product_unmapped'
      : 'calendar_host_unavailable'
  }

  const snapshot = {
    availableGroupIds: uniqueSorted(available),
    explicitFloorGroupIds: uniqueSorted(floors),
    unavailableReasons,
  }
  return {
    ...snapshot,
    availabilityDigest: digestCanonicalJson(snapshot),
  }
}

export function availabilityAllowsGroup(
  availability: ReadyCapabilityTurnAvailability,
  id: ReadyCapabilityGroupId,
): boolean {
  return availability.availableGroupIds.includes(id)
}
