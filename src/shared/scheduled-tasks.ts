/** Historical migration shape for retired Agent schedules. */
export type ScheduleSpecV1 =
  | { kind: 'once'; localDate: string; localTime: string }
  | {
      kind: 'interval'
      every: number
      unit: 'minute' | 'hour' | 'day'
      anchorAt: string
    }
  | {
      kind: 'calendar'
      frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
      localTime: string
      weekdays?: number[]
      months?: number[]
      dayOfMonth?: number
      lastDayOfMonth?: boolean
      until?: string
      count?: number
    }
