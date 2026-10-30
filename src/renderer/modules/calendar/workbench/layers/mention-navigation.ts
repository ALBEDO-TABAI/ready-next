import { create } from 'zustand'
import type { DateMentionTarget } from '../../../../../shared/calendar/date-mentions'

/** A single pending source locator, consumed by the destination editor after its buffer is available. */
export const useMentionNavigation = create<{ target: DateMentionTarget | null }>(() => ({ target: null }))
