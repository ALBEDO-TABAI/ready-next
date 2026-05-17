/**
 * Reminder JSON codec — main-process only.
 *
 * The DB column `calendar_events.reminders` is a TEXT field that stores a JSON
 * array of {@link Reminder} entries. This module is the single place where we
 * (a) stringify a `Reminder[]` for INSERT/UPDATE, and (b) parse + zod-validate
 * the TEXT back into a typed `Reminder[]` for SELECT.
 *
 * Robustness rules (per task brief — DB layer must not blow up if a row
 * happens to carry malformed JSON, e.g. left behind by an older build or a
 * future schema team):
 *   - JSON.parse failure → return null (treat as "no reminders"), log warn.
 *   - Shape mismatch (zod fail) → return null, log warn.
 *   - Empty array → still return null (UI / scheduler treat null and [] the
 *     same — there's nothing to fire).
 *
 * Pure module: zod only. No electron / DB / fs imports.
 */

import { z } from 'zod'
import type { Reminder } from '../../../shared/calendar-types'

/**
 * Per the SSOT contract (`src/shared/calendar-types.ts`):
 *   - offsetMinutes is a finite integer (negative = before start).
 *   - method ∈ {'notification', 'sound'}.
 *
 * We do not bound offsetMinutes here — the SSOT does not constrain magnitude;
 * scheduler-side window filtering handles "too far in the past/future".
 */
const ReminderSchema = z.object({
  offsetMinutes: z.number().int().finite(),
  method: z.enum(['notification', 'sound']),
})

const ReminderArraySchema = z.array(ReminderSchema)

export interface ReminderCodecLogger {
  warn(message: string, detail?: Record<string, unknown>): void
}

/**
 * Default logger writes to console.warn. Tests can inject a recorder.
 * Intentionally NOT a `createRotatingLogger` instance — the codec is called
 * from hot read paths (every getEvents call) and we don't want every minor
 * malformed row to thrash a rotating log; console.warn is sufficient and
 * already surfaces in `ready-database.log` via the parent module's pipe.
 */
const defaultLogger: ReminderCodecLogger = {
  warn: (message, detail) => {
    if (detail) console.warn(`[reminder-codec] ${message}`, detail)
    else console.warn(`[reminder-codec] ${message}`)
  },
}

/**
 * Serialize a `Reminder[]` (or null) for storage in the `reminders` TEXT column.
 *
 * - null / undefined / empty array → return null (DB writes NULL — keeps the
 *   "no reminders" case consistent with how older rows were stored).
 * - Non-empty array → JSON.stringify. Zod validation is enforced at the IPC
 *   boundary; DB layer trusts inputs to be already typed `Reminder[]`.
 */
export function encodeReminders(value: Reminder[] | null | undefined): string | null {
  if (!value || value.length === 0) return null
  return JSON.stringify(value)
}

/**
 * Parse a TEXT column value back into `Reminder[] | null`.
 *
 * Returns null for: null/undefined input, empty string, JSON.parse failure,
 * non-array root, zod shape failure, empty array after parse.
 *
 * `eventId` is optional context for warn logs; pass it from the caller so
 * operators can find the offending row.
 */
export function decodeReminders(
  raw: string | null | undefined,
  options: { eventId?: string; logger?: ReminderCodecLogger } = {},
): Reminder[] | null {
  if (raw == null || raw === '') return null
  const logger = options.logger ?? defaultLogger

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn('reminders JSON.parse failed; treating as null', {
      eventId: options.eventId,
      errorMessage: error instanceof Error ? error.message : String(error),
      rawPreview: raw.slice(0, 80),
    })
    return null
  }

  const result = ReminderArraySchema.safeParse(parsed)
  if (!result.success) {
    logger.warn('reminders shape mismatch; treating as null', {
      eventId: options.eventId,
      issuePreview: result.error.issues.slice(0, 2).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
    return null
  }

  if (result.data.length === 0) return null
  return result.data
}

/**
 * Validate untrusted external input (e.g. coming over IPC from preload).
 * Returns the parsed array on success, throws ZodError on failure — handler
 * layer translates the throw into its standard `{success:false, error}`
 * response shape.
 */
export function parseRemindersInput(value: unknown): Reminder[] {
  return ReminderArraySchema.parse(value)
}
