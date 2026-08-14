import { ipcMain } from 'electron'
import { CalendarRepository } from '../repositories/calendar-repository'
import { parseRemindersInput } from './reminder-codec'
import { expandEventList } from './rrule-engine'
import { parseIcsString } from './ics-importer'
import {
  detectTimeExpressions,
  type DetectedTimeExpression,
} from './time-expression-detector'
import type { SyncResult, SyncScheduler } from './sync-scheduler'
import type { EventOverride, ImportedEvent } from '../database'
import type { Reminder } from '../../../shared/calendar-types'
import { serializeEventToWire, serializeSourceToWire } from '../../../shared/calendar-wire'
import { detectRemoteChannelEventSuggestions } from './remote-channel-event-detector'
import { listRemoteChannelEntries } from './remote-channel-registry'
import type {
  RemoteChannelMessage,
  RemoteCalendarEventSuggestion,
} from '../../../shared/calendar-remote-channel'

/**
 * Upper bound on the input text length for `calendar:detectTimeExpressions`.
 * chrono-node is linear-ish in input size but RSS bodies can be tens of KB
 * after HTML stripping; 8 KB covers a typical headline + summary + author
 * with margin without making the IPC reply path noticeable.
 */
const TIME_DETECTION_MAX_INPUT_CHARS = 8192

// --- Unified Response Helpers ---

interface CalendarResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

function createSuccessResponse<T>(data: T, isMock: boolean): CalendarResponse<T> {
  return { success: true, mock: isMock, data }
}

function createErrorResponse(error: string): CalendarResponse<never> {
  return { success: false, mock: false, error }
}

// --- Mock Data ---

const mockSources = [
  { id: 'work', name: '工作日程', color: '#5B8DEF', type: 'local', enabled: true },
  { id: 'content', name: '内容创作', color: '#E97A2B', type: 'local', enabled: true },
  { id: 'holiday', name: '节假日', color: '#34D399', type: 'local', enabled: true },
  { id: 'personal', name: '个人', color: '#8B5CF6', type: 'local', enabled: true }
]

const mockEvents = [
  {
    id: '1',
    calendarId: 'work',
    title: '团队周会',
    description: '每周进度同步',
    startTime: new Date(Date.now() + 3600000).toISOString(),
    endTime: new Date(Date.now() + 7200000).toISOString(),
    allDay: false
  },
  {
    id: '2',
    calendarId: 'content',
    title: '视频发布',
    description: '本周短视频发布',
    startTime: new Date(Date.now() + 86400000).toISOString(),
    endTime: new Date(Date.now() + 90000000).toISOString(),
    allDay: false
  },
  {
    id: '3',
    calendarId: 'work',
    title: '内容策划',
    description: '下月选题规划',
    startTime: new Date(Date.now() - 3600000).toISOString(),
    endTime: new Date(Date.now()).toISOString(),
    allDay: false
  }
]

// --- Helper: convert incoming date (string | number | Date) to Unix seconds ---

function toUnixSeconds(value: unknown): number {
  if (typeof value === 'number') {
    // If already in seconds range (< year 10000 in ms), use as-is;
    // otherwise assume milliseconds
    return value > 1e12 ? Math.floor(value / 1000) : value
  }
  if (typeof value === 'string') {
    const d = new Date(value)
    if (isNaN(d.getTime())) throw new Error(`Invalid date string: ${value}`)
    return Math.floor(d.getTime() / 1000)
  }
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000)
  }
  throw new Error(`Cannot convert to date: ${String(value)}`)
}

/**
 * Optional dependency injected at setup time by main/index.ts so the
 * reminder scheduler is notified after each successful event mutation.
 *
 * This is plumbed via an `options.onEventChanged` callback instead of a
 * direct import to keep the IPC handler decoupled from the scheduler module
 * (one-way: scheduler depends on DB read methods, not on this file).
 */
export interface CalendarIPCOptions {
  onEventChanged?: (eventId: string) => void
  /**
   * L4-B — optional sync scheduler. The IPC layer uses it to:
   *   - trigger an immediate sync after `calendar:subscribeUrl`,
   *   - drive `calendar:syncSourceNow`,
   *   - register a periodic timer on every new URL-bearing source.
   * Caller is responsible for lifecycle (start / stop). Missing
   * scheduler is treated as "subscriptions are still allowed; they
   * just won't auto-sync on a timer" — useful for tests / mock mode.
   */
  syncScheduler?: SyncScheduler
}

// --- Reminder validation: keep IPC boundary the only place that runs zod
// against untrusted preload input. Errors are propagated as the standard
// CalendarResponse error string; no exceptions cross IPC. ---

function maybeParseReminders(value: unknown): Reminder[] | null | undefined {
  if (value === undefined) return undefined  // "not in payload" → don't touch
  if (value === null) return null            // explicit null → clear reminders
  return parseRemindersInput(value)          // throws ZodError on shape mismatch
}

/**
 * L3-B — translate a camelCase patch object from the renderer / IPC
 * boundary into the snake_case shape `EventOverride.patch` expects.
 *
 * Only the documented fields survive translation; any unknown keys are
 * silently dropped (the read side in `decodeEventOverride` filters
 * unknown keys anyway, but we don't want to encode them either).
 *
 * Date-like inputs (`startTime` / `endTime`) are converted via the same
 * `toUnixSeconds` helper that `createEvent` / `updateEvent` use, so the
 * IPC handler stays consistent on time-shape acceptance (number ms or
 * sec, ISO string, or Date).
 *
 * Reminders go through `maybeParseReminders` to enforce the L2-A zod
 * contract — bad shapes throw ZodError, which the dispatch try/catch
 * turns into a CalendarResponse error string.
 */
function buildOverridePatch(
  patch: {
    title?: string
    description?: string | null
    location?: string | null
    startTime?: unknown
    endTime?: unknown
    allDay?: boolean
    reminders?: unknown
    /** L4-A — explicit null clears (= local); string sets per-occurrence tz. */
    startTz?: string | null
    /** L4-A — explicit null clears (= local); string sets per-occurrence tz. */
    endTz?: string | null
  } | undefined,
): NonNullable<EventOverride['patch']> {
  const out: NonNullable<EventOverride['patch']> = {}
  if (!patch) return out
  if (patch.title !== undefined) out.title = patch.title
  if (patch.description !== undefined) out.description = patch.description
  if (patch.location !== undefined) out.location = patch.location
  if (patch.startTime !== undefined) out.start_time = toUnixSeconds(patch.startTime)
  if (patch.endTime !== undefined) out.end_time = toUnixSeconds(patch.endTime)
  if (patch.allDay !== undefined) out.all_day = patch.allDay ? 1 : 0
  if (patch.reminders !== undefined) {
    // Same null / array semantics as updateEvent: null clears, array
    // replaces. `undefined` is filtered out by the outer guard.
    out.reminders = maybeParseReminders(patch.reminders) ?? null
  }
  // L4-A — only forward explicit input. Empty string is normalized to
  // null so the override row never persists ''.
  if (patch.startTz !== undefined) {
    out.start_tz =
      patch.startTz === null || patch.startTz.trim().length === 0
        ? null
        : patch.startTz
  }
  if (patch.endTz !== undefined) {
    out.end_tz =
      patch.endTz === null || patch.endTz.trim().length === 0
        ? null
        : patch.endTz
  }
  return out
}

/**
 * L3-B — format a Date as RFC 5545 UTC basic-format `YYYYMMDDTHHMMSSZ`
 * for an RRULE UNTIL clause. Mirrors `formatUtcRruleDate` in
 * `rrule-engine.ts` but kept inline here so the IPC layer doesn't
 * pull a value import from the engine (we already type-import
 * `EventOverride`). Source of truth is the engine's normalizer; this
 * helper produces the same string format on the write side.
 */
function formatRruleUntil(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number): string => (n < 10 ? '0' + n : '' + n)
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  )
}

/**
 * L3-B — mutate a raw RRULE string so its terminating clause is
 * `UNTIL=<formatRruleUntil(occurrenceStart - 1)>`. We strip any
 * existing `UNTIL=...` or `COUNT=...` clause (the two ways RRULE can
 * declare a stop condition) before appending the new UNTIL, since
 * RRULE forbids both being present.
 *
 * If the input already includes `RRULE:` prefix or full DTSTART+RRULE
 * lines we operate on the rule body only and keep the wrapper intact.
 * The new UNTIL is computed in UTC seconds; the engine's normalizer
 * will accept the result without re-parsing the wrapper.
 */
function truncateRruleWithUntil(rawRule: string, occurrenceStartUnix: number): string {
  const untilToken = `UNTIL=${formatRruleUntil(occurrenceStartUnix - 1)}`
  const lines = rawRule.split(/\r?\n/)
  const transformed = lines.map((line) => {
    if (/^DTSTART/i.test(line)) return line
    let body = line.replace(/^RRULE:/i, '')
    const hasRrulePrefix = /^RRULE:/i.test(line)
    // Strip COUNT=... and UNTIL=... pairs (case-insensitive). Each is
    // a single `;`-delimited token in the rule body.
    body = body
      .split(';')
      .filter((tok) => !/^COUNT=/i.test(tok) && !/^UNTIL=/i.test(tok))
      .filter((tok) => tok.length > 0)
      .join(';')
    if (body.length === 0) return hasRrulePrefix ? `RRULE:${untilToken}` : untilToken
    const next = `${body};${untilToken}`
    return hasRrulePrefix ? `RRULE:${next}` : next
  })
  return transformed.join('\n')
}

let calendarEventChangedNotifier: ((eventId: string) => void) | null = null

export function notifyCalendarEventChanged(eventId: string): void {
  try {
    calendarEventChangedNotifier?.(eventId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[calendar-ipc] onEventChanged(${eventId}) threw:`, message)
  }
}

// --- IPC Setup ---

export function setupCalendarIPC(useMock = false, options: CalendarIPCOptions = {}): void {
  const repository = new CalendarRepository()
  const notifyEventChanged = (eventId: string): void => {
    notifyCalendarEventChanged(eventId)
  }
  calendarEventChangedNotifier = (eventId: string): void => {
    try {
      options.onEventChanged?.(eventId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[calendar-ipc] onEventChanged(${eventId}) threw:`, message)
    }
  }

  // Get all calendar sources
  ipcMain.handle('calendar:getSources', async () => {
    if (useMock) {
      return createSuccessResponse(mockSources, true)
    }

    try {
      const sources = repository.getSources()
      // Boundary helper: snake_case row → wire camelCase. Even though sources
      // were historically returned with mixed casing, the renderer now
      // consumes a frozen CalendarSourceWire shape.
      return createSuccessResponse(sources.map(serializeSourceToWire), false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Get events in date range
  ipcMain.handle('calendar:getEvents', async (_, { start, end }: { start: unknown; end: unknown }) => {
    if (useMock) {
      // Mocks are already in camelCase + ISO strings; serialize routes them
      // through the same wire shape so renderer code never has to fork.
      return createSuccessResponse(
        mockEvents.map((m) =>
          serializeEventToWire({
            id: m.id,
            calendarId: m.calendarId,
            title: m.title,
            description: m.description ?? null,
            startTime: typeof m.startTime === 'string' ? Math.floor(new Date(m.startTime).getTime() / 1000) : 0,
            endTime: typeof m.endTime === 'string' ? Math.floor(new Date(m.endTime).getTime() / 1000) : 0,
            allDay: m.allDay ?? false,
          }),
        ),
        true,
      )
    }

    try {
      const startTs = toUnixSeconds(start)
      const endTs = toUnixSeconds(end)

      // L3-A: getCalendarEvents returns BOTH non-recurring and recurring
      // parent rows that fall in the window. We must (1) drop recurring
      // parents from that list (they would otherwise show up only at their
      // DTSTART), (2) pull every recurring event regardless of window,
      // (3) expand each recurring event into its in-window EventInstance[]
      // applying any per-occurrence overrides. The renderer treats parents
      // and instances uniformly via the EventInstance shape.
      const rawEvents = repository.getEvents(startTs, endTs)
      const nonRecurring = rawEvents.filter((e) => e.recurrence_rule === null)
      const { events: recurringParents, overridesByParent } =
        repository.getRecurringEventsAndOverrides(startTs, endTs)
      const expandedInstances = expandEventList(
        recurringParents,
        startTs,
        endTs,
        overridesByParent,
      )
      // Single boundary serialization point — snake_case DB row + camelCase
      // EventInstance both pass through `serializeEventToWire` and emerge as
      // a stable `CalendarEventWire[]` for the renderer. This is the fix
      // for the "1970 events on refresh" bug.
      const wire = [
        ...nonRecurring.map(serializeEventToWire),
        ...expandedInstances.map(serializeEventToWire),
      ]
      return createSuccessResponse(wire, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Create event
  ipcMain.handle('calendar:createEvent', async (_, event: {
    calendarId: string
    title: string
    description?: string
    location?: string
    startTime: unknown
    endTime: unknown
    allDay?: boolean
    reminders?: unknown
    /**
     * L3-B — optional RFC 5545 RRULE body (e.g. 'FREQ=WEEKLY;COUNT=10').
     * When present and non-empty the event becomes a recurring parent
     * and is expanded by the rrule engine on read. Empty string or
     * null clears recurrence; absent field is treated the same as null
     * for create.
     */
    recurrenceRule?: string | null
    /**
     * L4-A — IANA timezone for the start wall-clock (e.g. 'Asia/Shanghai').
     * null / undefined means "use the local timezone" (back-compat for
     * pre-039 events); the DB stores null in that case.
     */
    startTz?: string | null
    /** L4-A — IANA timezone for the end wall-clock. */
    endTz?: string | null
  }) => {
    if (useMock) {
      return createSuccessResponse({ id: `event-${Date.now()}` }, true)
    }

    try {
      const reminders = maybeParseReminders(event.reminders)
      const id = repository.createEvent({
        calendar_id: event.calendarId,
        title: event.title,
        description: event.description || null,
        location: event.location || null,
        start_time: toUnixSeconds(event.startTime),
        end_time: toUnixSeconds(event.endTime),
        all_day: event.allDay ? 1 : 0,
        // reminders === undefined means "not in payload" → repository
        // defaults to null; explicit null means "clear". Either way pass
        // through unchanged.
        reminders: reminders ?? null,
        // L3-B — repository normalizes empty strings to null at the DB
        // layer so we just forward the raw value here.
        recurrence_rule: event.recurrenceRule ?? null,
        // L4-A — undefined → null at DB; explicit non-empty string is
        // stored as-is. The DB validator (in createCalendarEvent) trims
        // empty strings to null, so we don't normalize again here.
        start_tz: event.startTz ?? null,
        end_tz: event.endTz ?? null,
      })
      notifyEventChanged(id)
      return createSuccessResponse({ id }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Update event — supports partial updates for all fields
  ipcMain.handle('calendar:updateEvent', async (_, { id, event }: { id: string; event: Record<string, unknown> }) => {
    if (useMock) {
      return createSuccessResponse({ updated: true }, true)
    }

    try {
      // Build the update object, converting field names from camelCase to snake_case
      const updates: Record<string, unknown> = {}
      if (event.title !== undefined) updates.title = event.title
      if (event.description !== undefined) updates.description = event.description
      if (event.location !== undefined) updates.location = event.location
      if (event.calendarId !== undefined) updates.calendar_id = event.calendarId
      if (event.allDay !== undefined) updates.all_day = event.allDay ? 1 : 0
      if (event.startTime !== undefined) updates.start_time = toUnixSeconds(event.startTime)
      if (event.endTime !== undefined) updates.end_time = toUnixSeconds(event.endTime)
      if (event.reminders !== undefined) {
        // Explicit null = "clear"; array = "replace whole list"; absent = no-op.
        updates.reminders = maybeParseReminders(event.reminders)
      }
      // L3-B — RRULE update follows the same explicit-undefined contract.
      // `null` clears the rule (event becomes non-recurring); an empty
      // string is normalized to null by `updateCalendarEvent`.
      if (event.recurrenceRule !== undefined) {
        updates.recurrence_rule = event.recurrenceRule
      }
      // L4-A — explicit-undefined contract. `null` clears the tz (row
      // reverts to "local"); a non-empty string sets it. Empty strings
      // are normalized to null by `updateCalendarEvent`.
      if (event.startTz !== undefined) {
        updates.start_tz = event.startTz
      }
      if (event.endTz !== undefined) {
        updates.end_tz = event.endTz
      }

      repository.updateEvent(id, updates)
      notifyEventChanged(id)
      return createSuccessResponse({ updated: true }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Delete event
  ipcMain.handle('calendar:deleteEvent', async (_, id: string) => {
    if (useMock) {
      return createSuccessResponse({ deleted: true }, true)
    }

    try {
      repository.deleteEvent(id)
      notifyEventChanged(id)
      return createSuccessResponse({ deleted: true }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // L3-B — upsert per-occurrence override.
  //
  // Renderer payload uses camelCase + Date-flexible time fields (`startTime`
  // / `endTime` accept ISO / ms / sec / Date). `buildOverridePatch` does
  // the translation to the DB-shape `EventOverride.patch` (snake_case +
  // Unix seconds + numeric all_day). Reminders are run through the same
  // zod validator as createEvent/updateEvent so a bad shape is caught
  // here instead of being smuggled into JSON.
  //
  // After write we notify the scheduler about the PARENT id — the
  // scheduler reads from `getCalendarEventsWithReminders` which already
  // expands recurring + overrides, so passing the parent is what
  // triggers a re-evaluation of every instance of that series.
  ipcMain.handle('calendar:upsertEventOverride', async (_, payload: {
    parentEventId: string
    occurrenceStart: unknown
    kind: 'single' | 'cancelled'
    patch?: {
      title?: string
      description?: string | null
      location?: string | null
      startTime?: unknown
      endTime?: unknown
      allDay?: boolean
      reminders?: unknown
      /** L4-A — per-occurrence start tz; null clears, string sets. */
      startTz?: string | null
      /** L4-A — per-occurrence end tz. */
      endTz?: string | null
    }
  }) => {
    if (useMock) {
      return createSuccessResponse({ id: `ovr-mock-${Date.now()}` }, true)
    }

    try {
      if (!payload?.parentEventId || typeof payload.parentEventId !== 'string') {
        return createErrorResponse('parentEventId is required')
      }
      if (payload.kind !== 'single' && payload.kind !== 'cancelled') {
        return createErrorResponse(`invalid override kind: ${String(payload.kind)}`)
      }
      const occurrenceStart = toUnixSeconds(payload.occurrenceStart)
      // For 'single' overrides the patch is required and at least one
      // field must be specified — an empty patch is treated as a no-op
      // (caller should call deleteEventOverride instead). For
      // 'cancelled' overrides the patch is forced to null at the DB
      // layer regardless of what the caller passed.
      const patch =
        payload.kind === 'cancelled'
          ? null
          : buildOverridePatch(payload.patch)

      const result = repository.upsertEventOverride({
        parentEventId: payload.parentEventId,
        occurrenceStart,
        kind: payload.kind,
        patch,
      })
      notifyEventChanged(payload.parentEventId)
      return createSuccessResponse({ id: result.id }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // L3-B — delete a per-occurrence override; the parent's RRULE then
  // re-takes effect for that occurrence. Idempotent: missing rows
  // resolve to `{ deleted: false }` without erroring (this lets the UI
  // "reset to default" gesture be a no-op when there was nothing to
  // reset).
  ipcMain.handle('calendar:deleteEventOverride', async (_, payload: {
    parentEventId: string
    occurrenceStart: unknown
  }) => {
    if (useMock) {
      return createSuccessResponse({ deleted: false }, true)
    }

    try {
      if (!payload?.parentEventId || typeof payload.parentEventId !== 'string') {
        return createErrorResponse('parentEventId is required')
      }
      const occurrenceStart = toUnixSeconds(payload.occurrenceStart)
      const result = repository.deleteEventOverride(payload.parentEventId, occurrenceStart)
      notifyEventChanged(payload.parentEventId)
      return createSuccessResponse({ deleted: result.deleted }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // L3-B — "modify this and all future" gesture for a recurring series.
  //
  // Operation:
  //   1. Read the parent event row.
  //   2. Truncate the parent: rewrite its recurrence_rule so the new
  //      UNTIL clause is `occurrenceStart - 1 second` (so the last
  //      kept occurrence is strictly before the split point).
  //   3. Create a new event with the patch applied: `start_time =
  //      patch.startTime ?? occurrenceStart`, `end_time` shifts to
  //      preserve the parent's duration unless the caller overrode it,
  //      and `recurrence_rule = patch.recurrenceRule ?? <parent's
  //      original rule, without UNTIL clause>` so the new series picks
  //      up where the old one stopped.
  //
  // Both writes are wrapped in a single repository transaction so a
  // partial split (parent truncated but new series not inserted, or
  // vice versa) cannot happen. On success we notify the scheduler
  // about both the parent id (existing reminders should re-bind to
  // the shorter range) and the new id.
  //
  // This is "delete this and forward" if the caller passes an empty
  // patch and explicitly clears the recurrence rule — the new series
  // simply never gets a useful rule. For the standard "this and
  // future = move start time forward 1 hour starting this Wednesday"
  // gesture the caller passes `{ patch: { startTime: <new dt> } }`
  // and the rest follows.
  ipcMain.handle('calendar:splitRecurringSeries', async (_, payload: {
    parentEventId: string
    occurrenceStart: unknown
    patch: {
      title?: string
      description?: string | null
      location?: string | null
      startTime?: unknown
      endTime?: unknown
      allDay?: boolean
      reminders?: unknown
      recurrenceRule?: string | null
      calendarId?: string
      /** L4-A — override start tz for the NEW series (null clears). */
      startTz?: string | null
      /** L4-A — override end tz for the NEW series (null clears). */
      endTz?: string | null
    }
  }) => {
    if (useMock) {
      return createSuccessResponse({ newEventId: `event-mock-${Date.now()}` }, true)
    }

    try {
      if (!payload?.parentEventId || typeof payload.parentEventId !== 'string') {
        return createErrorResponse('parentEventId is required')
      }
      const occurrenceStartSec = toUnixSeconds(payload.occurrenceStart)
      const patchInput = payload.patch ?? {}
      // Translate the patch's wire fields into resolved values. We do
      // this OUTSIDE the transaction so an invalid date / reminder
      // payload aborts before any DB write happens.
      const remindersForNew = maybeParseReminders(patchInput.reminders)
      const newStartTime =
        patchInput.startTime !== undefined
          ? toUnixSeconds(patchInput.startTime)
          : occurrenceStartSec

      const newEventId = repository.withTransaction((): string => {
        const parent = repository.getEventById(payload.parentEventId)
        if (!parent) {
          throw new Error(`parent event not found: ${payload.parentEventId}`)
        }
        if (parent.recurrence_rule == null || parent.recurrence_rule.trim().length === 0) {
          throw new Error(`event ${payload.parentEventId} is not recurring`)
        }

        // Step 1: truncate the parent series. Re-write its
        // recurrence_rule with the new UNTIL clause.
        const truncatedRule = truncateRruleWithUntil(parent.recurrence_rule, occurrenceStartSec)
        repository.updateEvent(payload.parentEventId, {
          recurrence_rule: truncatedRule,
        })

        // Step 2: build the new series. Preserve the parent's
        // duration unless the patch explicitly overrode end_time.
        const parentDuration = parent.end_time - parent.start_time
        const newEndTime =
          patchInput.endTime !== undefined
            ? toUnixSeconds(patchInput.endTime)
            : newStartTime + parentDuration

        // New series' RRULE: explicit patch wins, otherwise inherit
        // the parent's ORIGINAL rule (the un-truncated one) so the
        // new series carries the same cadence forward. `null` in
        // the patch clears recurrence; an empty string is normalized
        // to null by createCalendarEvent.
        const nextRule =
          patchInput.recurrenceRule !== undefined
            ? patchInput.recurrenceRule
            : parent.recurrence_rule

        // L4-A — propagate timezone from parent unless explicitly
        // overridden. Mirrors the description / location / reminders
        // contract above: `undefined` = inherit parent; explicit `null`
        // = clear (revert to "local"); explicit string sets tz.
        const nextStartTz =
          patchInput.startTz !== undefined ? patchInput.startTz : parent.start_tz
        const nextEndTz =
          patchInput.endTz !== undefined ? patchInput.endTz : parent.end_tz

        const id = repository.createEvent({
          calendar_id: patchInput.calendarId ?? parent.calendar_id,
          title: patchInput.title ?? parent.title,
          description:
            patchInput.description !== undefined
              ? patchInput.description
              : parent.description,
          location:
            patchInput.location !== undefined
              ? patchInput.location
              : parent.location,
          start_time: newStartTime,
          end_time: newEndTime,
          all_day:
            patchInput.allDay !== undefined
              ? (patchInput.allDay ? 1 : 0)
              : parent.all_day,
          reminders:
            remindersForNew !== undefined
              ? remindersForNew
              : parent.reminders,
          recurrence_rule: nextRule,
          start_tz: nextStartTz,
          end_tz: nextEndTz,
        })
        return id
      })

      // Notify scheduler about both rows. Parent reminders / instances
      // must re-evaluate against the shorter range; the new series is
      // a fresh row with its own instances.
      notifyEventChanged(payload.parentEventId)
      notifyEventChanged(newEventId)
      return createSuccessResponse({ newEventId }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // ============== L4-B-External-Sync ===============

  /**
   * L4-B — import a raw ICS body string into a calendar source.
   *
   * Wire shape:
   *   - `rawIcs`: full .ics file contents (the renderer reads the file
   *     and ships the text; we don't accept file paths because the
   *     renderer doesn't get filesystem access).
   *   - `calendarSourceId`: optional. When present, the parsed events
   *     are written into that existing source. When absent, the IPC
   *     handler auto-creates a new source named `sourceName` (or
   *     `'导入的日历'` if also absent) with a deterministic-ish id so
   *     re-importing the same file lands on the same bucket.
   *
   * Response shape:
   *   - `sourceId`: id of the source the events landed in (echo'd back
   *     so the renderer can refresh its source list immediately).
   *   - `created` / `updated`: counts derived from the upsert action.
   *   - `skipped`: number of malformed VEVENTs the parser dropped via
   *     `console.warn` (we don't surface them as errors; partial
   *     success is preferable).
   *
   * After-write hook: `notifyEventChanged` is called once with the
   * sourceId so the reminder scheduler re-evaluates timers for newly
   * imported events that happen to fall inside its 24h window.
   */
  ipcMain.handle('calendar:importIcsString', async (_, payload: {
    rawIcs: string
    calendarSourceId?: string
    sourceName?: string
  }) => {
    if (useMock) {
      return createSuccessResponse(
        { sourceId: 'mock-source', created: 0, updated: 0, skipped: 0 },
        true,
      )
    }

    try {
      if (typeof payload?.rawIcs !== 'string' || payload.rawIcs.length === 0) {
        return createErrorResponse('rawIcs is required')
      }
      let imported: ImportedEvent[]
      try {
        imported = parseIcsString(payload.rawIcs)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return createErrorResponse(`ICS parse failed: ${message}`)
      }

      // Resolve the target source. Caller-supplied id wins; otherwise
      // mint a deterministic-ish id seeded by `sourceName` + Date.now()
      // so concurrent imports don't collide.
      let sourceId: string
      if (typeof payload.calendarSourceId === 'string' && payload.calendarSourceId.length > 0) {
        sourceId = payload.calendarSourceId
      } else {
        const baseName = payload.sourceName?.trim() || '导入的日历'
        sourceId = `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        repository.upsertCalendarSource({
          id: sourceId,
          name: baseName,
          type: 'imported',
          syncUrl: null,
          enabled: true,
        })
      }

      let created = 0
      let updated = 0
      let skipped = 0
      for (const ev of imported) {
        try {
          const result = repository.upsertImportedEvent(sourceId, ev)
          if (result.action === 'created') created += 1
          else updated += 1
        } catch (error) {
          // Individual row failures shouldn't fail the whole import.
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[calendar-ipc] upsertImportedEvent failed for uid=${ev.uid}: ${message}`)
          skipped += 1
        }
      }

      // Reminder scheduler is keyed by event id, but since imported
      // events default to no reminders (see DB layer), the only thing
      // the scheduler needs to do is observe that this source's rows
      // changed. We notify via the source id; the scheduler treats
      // unknown ids as no-ops which is what we want.
      notifyEventChanged(sourceId)

      return createSuccessResponse({ sourceId, created, updated, skipped }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  /**
   * L4-B — subscribe to an ICS URL. Creates a new `calendar_sources`
   * row, runs an immediate first sync (so the user sees events without
   * waiting for the periodic timer), then registers a periodic timer
   * via the injected sync scheduler.
   *
   * Response:
   *   - `sourceId`: id of the newly-created source.
   *   - `initialEvents`: created + updated counts from the first sync;
   *     0 when the sync scheduler is missing (no DI in mock mode) or
   *     when the first sync failed (scheduler logs the error; the IPC
   *     reply stays success because the subscription itself was
   *     created successfully).
   */
  ipcMain.handle('calendar:subscribeUrl', async (_, payload: {
    url: string
    name: string
    color?: string
    syncIntervalMinutes?: number
  }) => {
    if (useMock) {
      return createSuccessResponse({ sourceId: 'mock-subscription', initialEvents: 0 }, true)
    }

    try {
      if (typeof payload?.url !== 'string' || payload.url.trim().length === 0) {
        return createErrorResponse('url is required')
      }
      if (typeof payload?.name !== 'string' || payload.name.trim().length === 0) {
        return createErrorResponse('name is required')
      }

      const sourceId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      repository.upsertCalendarSource({
        id: sourceId,
        name: payload.name.trim(),
        color: payload.color,
        type: 'subscription',
        syncUrl: payload.url.trim(),
        syncInterval: payload.syncIntervalMinutes,
        enabled: true,
      })

      let initialEvents = 0
      const scheduler = options.syncScheduler
      if (scheduler) {
        try {
          const result = await scheduler.syncOne(sourceId)
          if (result.ok) {
            initialEvents = result.eventsCreated + result.eventsUpdated
          } else {
            // Log but don't fail the subscription. The user can retry
            // via the "立即同步" button; the source row already exists
            // so future periodic syncs will catch up.
            console.warn(`[calendar-ipc] initial sync for ${sourceId} failed: ${result.error}`)
          }
          // Re-arm the periodic timer set for this new source. We re-
          // invoke startPeriodic (which is idempotent — it cancels and
          // re-arms every source's timer) rather than maintaining a
          // separate "arm one" API; simpler and the cost is trivial.
          scheduler.startPeriodic()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[calendar-ipc] sync scheduler threw on subscribe: ${message}`)
        }
      }

      notifyEventChanged(sourceId)
      return createSuccessResponse({ sourceId, initialEvents }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  /**
   * L4-B — unsubscribe / delete a calendar source. The FK on
   * `calendar_events.calendar_id` is `ON DELETE CASCADE` (migration
   * 002), so all rows owned by the source are dropped atomically.
   *
   * Returns `{ removed: false }` when the source didn't exist (the
   * idempotent semantic mirrors deleteEventOverride). The sync
   * scheduler is also told to re-arm so it forgets the timer for
   * this source.
   */
  ipcMain.handle('calendar:unsubscribeSource', async (_, sourceId: string) => {
    if (useMock) {
      return createSuccessResponse({ removed: true }, true)
    }

    try {
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return createErrorResponse('sourceId is required')
      }
      const result = repository.deleteCalendarSource(sourceId)
      // Even if no row matched, re-arm the scheduler so any straggling
      // in-memory timer for the (now-missing) source is dropped.
      if (options.syncScheduler) {
        try {
          options.syncScheduler.startPeriodic()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[calendar-ipc] sync scheduler re-arm on unsubscribe threw: ${message}`)
        }
      }
      notifyEventChanged(sourceId)
      return createSuccessResponse({ removed: result.deleted }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  /**
   * L4-B — manually trigger a sync for one source. Used by the
   * "立即同步" button in the renderer's source list. The reply
   * carries the full SyncResult so the UI can show created /
   * updated / removed counts inline.
   *
   * When no sync scheduler is wired the request resolves with a
   * synthetic failure result rather than an error, so the renderer
   * can still surface a sensible message.
   */
  ipcMain.handle('calendar:syncSourceNow', async (_, sourceId: string) => {
    if (useMock) {
      const result: SyncResult = {
        sourceId,
        ok: true,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: null,
      }
      return createSuccessResponse(result, true)
    }

    try {
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return createErrorResponse('sourceId is required')
      }
      if (!options.syncScheduler) {
        const result: SyncResult = {
          sourceId,
          ok: false,
          eventsCreated: 0,
          eventsUpdated: 0,
          eventsRemoved: 0,
          error: 'sync scheduler not initialized',
        }
        return createSuccessResponse(result, false)
      }
      const result = await options.syncScheduler.syncOne(sourceId)
      notifyEventChanged(sourceId)
      return createSuccessResponse(result, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  /**
   * L5-B — natural-language time-expression detection for the RSS
   * reader's "create calendar event from article" hint. Pure read-only;
   * runs the chrono-node detector against the supplied plain-text body
   * (the renderer is responsible for HTML stripping). Truncates the
   * input to {@link TIME_DETECTION_MAX_INPUT_CHARS} before parsing —
   * RSS bodies after HTML stripping can be tens of KB and chrono's
   * dictionary scan grows roughly linearly. The renderer should send
   * `title + summary + author` rather than the full article body.
   *
   * NOT a live-info path: per CLAUDE.md §6.9 the live-info intent
   * classifier reads only the user's primary instruction, never
   * third-party article bodies. This handler is a pure UI hint surface
   * — its only consumer is the RSS detail banner; the result never
   * feeds the intent classifier, browser-task planner, or chat scope.
   *
   * Mock mode returns an empty list — there is no synthetic body to
   * scan and the UX in mock is "show 3 fake events" anyway.
   */
  ipcMain.handle(
    'calendar:detectTimeExpressions',
    async (
      _,
      payload: { text?: unknown; referenceDate?: unknown },
    ): Promise<CalendarResponse<DetectedTimeExpression[]>> => {
      if (useMock) {
        return createSuccessResponse([] as DetectedTimeExpression[], true)
      }
      try {
        const rawText = payload?.text
        if (typeof rawText !== 'string' || rawText.length === 0) {
          return createSuccessResponse([] as DetectedTimeExpression[], false)
        }
        let refDate: Date = new Date()
        const rawRef = payload?.referenceDate
        if (typeof rawRef === 'string' && rawRef.length > 0) {
          const parsed = new Date(rawRef)
          if (!Number.isNaN(parsed.getTime())) refDate = parsed
        } else if (typeof rawRef === 'number' && Number.isFinite(rawRef)) {
          const parsed = new Date(rawRef)
          if (!Number.isNaN(parsed.getTime())) refDate = parsed
        }
        const truncated = rawText.length > TIME_DETECTION_MAX_INPUT_CHARS
          ? rawText.slice(0, TIME_DETECTION_MAX_INPUT_CHARS)
          : rawText
        const expressions = detectTimeExpressions(truncated, refDate)
        return createSuccessResponse(expressions, false)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return createErrorResponse(errorMessage)
      }
    },
  )

  /**
   * L5-C-Universal — channel-agnostic remote-message → calendar-event
   * detection. Channel adapters (feishu / telegram / imessage / discord
   * / wechat / slack / generic-webhook / future) call this with one
   * `RemoteChannelMessage`; the main side applies per-channel policy
   * (registry default OR per-channel user override) plus confidence
   * filtering, and returns suggestions.
   *
   * The renderer subscribes to `calendar:remoteEventSuggested` for
   * pushes originating in the inbound-channel pipeline (see runtime.ts
   * hook). Renderer-driven detection — e.g. "user pasted a message,
   * scan it" — also routes through this same handler so policy stays
   * single-sourced.
   */
  ipcMain.handle(
    'calendar:detectRemoteChannelEvent',
    async (
      _,
      payload: {
        message?: unknown
        autoDetectOverride?: boolean | null
        minConfidence?: 'high' | 'medium' | 'low'
      },
    ): Promise<CalendarResponse<RemoteCalendarEventSuggestion[]>> => {
      if (useMock) {
        return createSuccessResponse([] as RemoteCalendarEventSuggestion[], true)
      }
      try {
        const msg = payload?.message as RemoteChannelMessage | undefined
        if (!msg || typeof msg.text !== 'string' || typeof msg.channelKind !== 'string') {
          return createErrorResponse(
            'detectRemoteChannelEvent: payload.message missing required fields (channelKind / text)',
          )
        }
        const suggestions = detectRemoteChannelEventSuggestions(
          msg,
          {
            autoDetectOverride: payload?.autoDetectOverride ?? null,
            minConfidence: payload?.minConfidence,
          },
        )
        return createSuccessResponse(suggestions, false)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return createErrorResponse(errorMessage)
      }
    },
  )

  /**
   * Enumerate registry entries for the settings UI. Returns the static
   * built-in list (one entry per known `RemoteChannelKind`); custom
   * channel kinds added by adapters at runtime fall back to neutral
   * metadata and are not surfaced here.
   */
  ipcMain.handle('calendar:listRemoteChannelEntries', async () => {
    if (useMock) {
      return createSuccessResponse([], true)
    }
    try {
      const entries = listRemoteChannelEntries().map((entry) => ({
        kind: entry.kind,
        displayName: entry.displayName,
        iconKey: entry.iconKey,
        autoDetectByDefault: entry.autoDetectByDefault,
      }))
      return createSuccessResponse(entries, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })
}
