/**
 * RRULE expansion engine — main-process only.
 *
 * Wired by team L3-A (RRULE-Engine). Takes a CalendarEvent row + a query
 * window and returns concrete `EventInstance[]` for that window, applying
 * any per-occurrence overrides from `calendar_event_overrides`.
 *
 * Field model note: the main-process `CalendarEvent` row uses snake_case
 * (`start_time`, `end_time`, `all_day`, `recurrence_rule`) — this is the
 * shape returned by `database.ts` and consumed by repositories /
 * scheduler / ipc handlers. We intentionally keep snake_case at this
 * layer so we don't need a translation hop; the renderer-side
 * `CalendarEvent` (camelCase, defined in `src/shared/calendar-types.ts`)
 * is a SEPARATE type used at the IPC boundary.
 *
 * Pure module: no DB / fs / electron / IPC calls. All inputs are
 * structured values, all outputs are structured values. Host wires the
 * DB read + override join.
 *
 * Behavior contract:
 *   - `event.recurrence_rule === null / ''` → returns a single instance
 *     with `instanceOf = event.id`, `occurrenceStart = event.start_time`,
 *     `overrideKind = null`. This makes the helper safe to call on every
 *     event uniformly.
 *   - Otherwise: parses the RRULE (auto-prepending DTSTART if missing /
 *     `RRULE:` prefix if missing) and yields every occurrence whose
 *     occurrence start falls in [windowStartUnix, windowEndUnix].
 *   - Each occurrence is matched against overrides; a `cancelled` override
 *     suppresses the instance, a `single` override patches the listed
 *     fields and tags `overrideKind = 'single'`.
 *   - Malformed RRULE → emits a `console.warn` and falls back to the
 *     single-instance shape so callers never lose the event entirely.
 *
 * Timezone — **KNOWN LIMITATION (not "future work")**:
 *   This engine treats `start_time` (Unix seconds) as a timezone-naive
 *   UTC instant. `rrule.js` operates on JS `Date` and uses the
 *   underlying UTC ms; we round occurrence times back to Unix seconds.
 *
 *   What that means for a recurring event whose parent carries a
 *   non-null `start_tz` (e.g. `Asia/Shanghai`): every occurrence we
 *   produce is at the SAME UTC instant offset from the parent's
 *   DTSTART regardless of DST transitions in the parent's tz. The
 *   renderer's `displayTimezone` only affects how the wall-clock label
 *   is FORMATTED; it does NOT shift `occurrenceStart` to honor the
 *   event's own tz.
 *
 *   Concretely: a 09:00 Asia/Shanghai weekly meeting that spans the
 *   spring-forward day in America/New_York will, in the NY view,
 *   appear to drift by 1 hour for occurrences after the transition.
 *   For viewers in the SAME tz as the parent there is no drift.
 *
 *   This is documented as the L4 "event-level timezone NOT complete"
 *   degradation. A full fix means replacing rrule.js's UTC-only
 *   expansion with a Temporal-based walker that honors `start_tz` for
 *   each occurrence — that is a dedicated follow-up project (L4-A.2),
 *   NOT something this engine should pretend to handle.
 *
 *   Until that follow-up lands, downstream callers should treat
 *   `EventInstance.startTime / endTime` as Unix seconds of the
 *   UTC-anchored occurrence; UI code may apply `displayTimezone` for
 *   formatting but must NOT promise DST-correct semantics on the
 *   recurring path.
 */

// rrule's package.json is CJS-only ("main" + "module" but no "exports"
// field). Under Node 22+ ESM-CJS interop, `import { rrulestr } from
// 'rrule'` typechecks but throws at module-load time ("does not provide
// an export named 'rrulestr'"). Even `import * as rrule from 'rrule'`
// returns a wrapper namespace with the real exports tucked under
// `.default`. Default import + destructure is the only portable form.
import rrulePkg from 'rrule'
const { RRule, rrulestr } = rrulePkg as unknown as {
  RRule: typeof import('rrule').RRule
  rrulestr: typeof import('rrule').rrulestr
}
type RRule = InstanceType<typeof RRule>
import type { CalendarEvent } from '../database'
import type { Reminder } from '../../../shared/calendar-types'

/**
 * Expanded occurrence of a (possibly recurring) calendar event.
 *
 * Inherits every column of the parent `CalendarEvent` row — including the
 * `recurrence_rule` and `reminders` fields — but the time fields point at
 * THIS occurrence, not the parent's first occurrence. Overrides are
 * already applied at construction time.
 *
 * For non-recurring single events the instance is still wrapped in this
 * shape so renderer / scheduler / agent tools can consume one uniform
 * type. `instanceOf === id`, `occurrenceStart === start_time`, and
 * `syntheticId === id` in that case.
 *
 * For recurring instances: `syntheticId = "${parentId}#${occurrenceStart}"`
 * — this is the primary key the renderer keys by (so React knows that
 * two instances of the same parent are different DOM rows) and what the
 * reminder scheduler dedupes timers by (so independent occurrences fire
 * independently).
 */
export interface EventInstance extends Omit<CalendarEvent, 'id'> {
  /** Synthetic id; equals parent id for non-recurring, `${parent}#${occ}` for recurring. */
  id: string
  /** Parent event id; equals `id` for non-recurring single events. */
  instanceOf: string
  /**
   * Unix seconds of the ORIGINAL recurrence start (PRE-override). This is
   * what override rows match against and what `id` is suffixed with for
   * recurring instances — applying a 'single' override that shifts
   * `start_time` does not change `occurrenceStart`.
   */
  occurrenceStart: number
  /**
   * Synthetic id for renderer keying. Equals `id` (we keep both names so
   * downstream code reads cleanly whether it cares about "id of the
   * persistable row" or "id of the visual instance").
   */
  syntheticId: string
  /** Non-null when this instance came from an override row. */
  overrideKind: 'single' | 'cancelled' | null
}

/**
 * Persistable override of a single recurrence occurrence.
 *
 * Stored in `calendar_event_overrides` (migration 038). The `kind`
 * discriminates two operations:
 *   - `single`: patch one occurrence (rename, reschedule, move, change
 *     reminders) WITHOUT touching the parent RRULE.
 *   - `cancelled`: hide one occurrence entirely (a "skip this one"
 *     gesture from the UI).
 *
 * `occurrenceStart` is the ORIGINAL Unix-seconds time of the occurrence
 * as the RRULE produces it — even after a `single` override moves
 * `start_time`, the override still keys by the original time. This means
 * a "move the Tuesday meeting to Wednesday" operation creates one
 * override row keyed by the Tuesday timestamp.
 */
export interface EventOverride {
  parentEventId: string
  /** Unix seconds of the ORIGINAL occurrence (pre-patch). */
  occurrenceStart: number
  kind: 'single' | 'cancelled'
  /**
   * Fields to patch when `kind === 'single'`. Always `null` when
   * `kind === 'cancelled'`. Only the listed CalendarEvent fields are
   * patchable — see L3-B plan for how UI exposes these.
   */
  patch: Partial<Pick<CalendarEvent, 'title' | 'description' | 'location' | 'start_time' | 'end_time' | 'all_day'>> & {
    /** Override reminder list (parsed). `null` clears reminders for this instance. */
    reminders?: Reminder[] | null
    /**
     * L4-A — Override start timezone. `null` clears (= local). When
     * absent the parent's `start_tz` carries through.
     */
    start_tz?: string | null
    /** L4-A — Override end timezone; null = local. */
    end_tz?: string | null
  } | null
}

// --- Internal helpers --------------------------------------------------

/**
 * Format a Date as `YYYYMMDDTHHMMSSZ` for RFC 5545 DTSTART.
 * Note: rrule expects UTC suffix `Z` when DTSTART has no TZID parameter.
 */
function formatUtcRruleDate(unixSeconds: number): string {
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
 * Normalize a user-supplied RRULE string into the form rrulestr accepts.
 *
 * Accepts these inputs:
 *   (a) `FREQ=DAILY;COUNT=10`                — bare rule body
 *   (b) `RRULE:FREQ=DAILY;COUNT=10`          — with RRULE: prefix
 *   (c) `DTSTART:...\nRRULE:FREQ=DAILY;...`  — fully-formed (caller wins)
 *   (d) `DTSTART:...\nFREQ=DAILY;...`        — DTSTART without RRULE: prefix
 *
 * Always returns DTSTART + RRULE prefix form so rrulestr can parse it.
 * If the input already contains DTSTART, we DON'T prepend ours — the
 * caller's DTSTART wins (e.g. ICS import keeps its original timestamp).
 */
function normalizeRruleString(rawRule: string, eventStartUnix: number): string {
  const trimmed = rawRule.trim()
  if (!trimmed) {
    throw new Error('empty RRULE string')
  }
  const hasDtstart = /(^|\n)DTSTART/i.test(trimmed)
  const hasRrulePrefix = /(^|\n)RRULE:/i.test(trimmed)

  let body = trimmed
  if (!hasRrulePrefix) {
    // If DTSTART is present without RRULE:, the part after DTSTART line(s)
    // is the rule body — add the RRULE: prefix to it. Otherwise the
    // whole string is the body.
    if (hasDtstart) {
      const lines = trimmed.split(/\r?\n/)
      body = lines
        .map((line) => {
          if (/^DTSTART/i.test(line)) return line
          if (/^RRULE:/i.test(line)) return line
          if (line.trim().length === 0) return line
          return 'RRULE:' + line.replace(/^RRULE:/i, '')
        })
        .join('\n')
    } else {
      body = 'RRULE:' + trimmed
    }
  }

  if (hasDtstart) return body
  return `DTSTART:${formatUtcRruleDate(eventStartUnix)}\n${body}`
}

function parseSimpleRruleBody(rawRule: string): {
  freq: 'DAILY' | 'WEEKLY'
  interval: number
  count: number | null
  until: number | null
} | null {
  const trimmed = rawRule.trim()
  if (!trimmed || /(^|\n)DTSTART/i.test(trimmed)) return null

  const lines = trimmed
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (lines.length !== 1) return null

  const line = lines[0]
  if (!line) return null

  const body = line.replace(/^RRULE:/i, '')
  const fields = new Map<string, string>()
  for (const token of body.split(';')) {
    const parts = token.split('=')
    if (parts.length !== 2) return null
    const [rawKey, rawValue] = parts
    const key = rawKey?.trim().toUpperCase()
    const value = rawValue?.trim()
    if (!key || value == null || value.length === 0 || fields.has(key)) return null
    fields.set(key, value)
  }

  for (const key of fields.keys()) {
    if (key !== 'FREQ' && key !== 'INTERVAL' && key !== 'COUNT' && key !== 'UNTIL') return null
  }

  const freq = fields.get('FREQ')?.toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return null

  const interval = fields.has('INTERVAL') ? Number(fields.get('INTERVAL')) : 1
  if (!Number.isSafeInteger(interval) || interval < 1) return null

  let count: number | null = null
  if (fields.has('COUNT')) {
    count = Number(fields.get('COUNT'))
    if (!Number.isSafeInteger(count) || count < 0) return null
  }

  let until: number | null = null
  const untilValue = fields.get('UNTIL')
  if (untilValue) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(untilValue)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6])
    const untilMs = Date.UTC(year, month - 1, day, hour, minute, second)
    const untilDate = new Date(untilMs)
    if (
      untilDate.getUTCFullYear() !== year ||
      untilDate.getUTCMonth() + 1 !== month ||
      untilDate.getUTCDate() !== day ||
      untilDate.getUTCHours() !== hour ||
      untilDate.getUTCMinutes() !== minute ||
      untilDate.getUTCSeconds() !== second
    ) {
      return null
    }
    until = Math.floor(untilMs / 1000)
  }

  return { freq, interval, count, until }
}

function expandSimpleRecurringEvent(
  event: CalendarEvent,
  windowStartUnix: number,
  windowEndUnix: number,
  overrideByOcc: Map<number, EventOverride>,
): EventInstance[] | null {
  if (event.recurrence_rule == null) return null
  const parsed = parseSimpleRruleBody(event.recurrence_rule)
  if (!parsed) return null

  const stepSeconds = (parsed.freq === 'DAILY' ? 24 * 3600 : 7 * 24 * 3600) * parsed.interval
  const seriesEnd = parsed.until == null ? windowEndUnix : Math.min(windowEndUnix, parsed.until)
  if (seriesEnd < event.start_time || windowEndUnix < event.start_time) return []

  const firstIndex = Math.max(0, Math.ceil((windowStartUnix - event.start_time) / stepSeconds))
  let lastIndex = Math.floor((seriesEnd - event.start_time) / stepSeconds)
  if (parsed.count != null) lastIndex = Math.min(lastIndex, parsed.count - 1)
  if (lastIndex < firstIndex) return []

  const out: EventInstance[] = []
  for (let index = firstIndex; index <= lastIndex; index++) {
    const occurrenceStart = event.start_time + index * stepSeconds
    const override = overrideByOcc.get(occurrenceStart) ?? null
    const inst = buildInstance(event, occurrenceStart, override)
    if (inst) out.push(inst)
  }
  return out
}

/** Build a fresh EventInstance from a parent event with the given occurrence start. */
function buildInstance(
  event: CalendarEvent,
  occurrenceStart: number,
  override: EventOverride | null,
): EventInstance | null {
  if (override && override.kind === 'cancelled') return null
  const duration = event.end_time - event.start_time
  // base instance fields — start from the parent row's snake_case fields.
  const base: EventInstance = {
    id: '',          // filled below
    calendar_id: event.calendar_id,
    title: event.title,
    description: event.description,
    location: event.location,
    start_time: occurrenceStart,
    end_time: occurrenceStart + duration,
    all_day: event.all_day,
    recurrence_rule: event.recurrence_rule,
    reminders: event.reminders,
    // L4-A — propagate parent's timezone to each instance; overrides
    // below may patch these per-occurrence.
    start_tz: event.start_tz,
    end_tz: event.end_tz,
    // L4-B — propagate parent's external-sync provenance. Instances
    // inherit the parent's `ics_uid / source_id` so a single recurring
    // imported event surfaces every occurrence as still belonging to
    // the source feed. Overrides do not patch these (the source-of-truth
    // for "which feed produced this row" is the parent, not the
    // instance).
    ics_uid: event.ics_uid,
    source_id: event.source_id,
    created_at: event.created_at,
    updated_at: event.updated_at,
    instanceOf: event.id,
    occurrenceStart,
    syntheticId: '', // filled below
    overrideKind: override?.kind ?? null,
  }
  if (override && override.kind === 'single' && override.patch) {
    const p = override.patch
    if (p.title !== undefined) base.title = p.title
    if (p.description !== undefined) base.description = p.description
    if (p.location !== undefined) base.location = p.location
    if (p.start_time !== undefined) base.start_time = p.start_time
    if (p.end_time !== undefined) base.end_time = p.end_time
    if (p.all_day !== undefined) base.all_day = p.all_day
    if (p.reminders !== undefined) base.reminders = p.reminders
    // L4-A — override may explicitly set per-occurrence tz; null clears
    // (instance reverts to "local"), string sets, undefined inherits.
    if (p.start_tz !== undefined) base.start_tz = p.start_tz
    if (p.end_tz !== undefined) base.end_tz = p.end_tz
  }
  // Synthetic id strategy: parent#occurrenceStart for recurring (whether or
  // not the parent had an override applied), bare id for non-recurring.
  const isRecurring = event.recurrence_rule != null && event.recurrence_rule.trim().length > 0
  const synthetic = isRecurring ? `${event.id}#${occurrenceStart}` : event.id
  base.id = synthetic
  base.syntheticId = synthetic
  return base
}

// --- Public API --------------------------------------------------------

/**
 * Expand one event into the occurrences that intersect a query window.
 *
 * For non-recurring events: returns 0-or-1 instances depending on whether
 * the event itself overlaps the window. The intersection rule is:
 * `event.end_time > windowStartUnix && event.start_time < windowEndUnix`
 * (this matches `getCalendarEvents`'s existing SQL).
 *
 * For recurring events: walks occurrences `event.start_time` -> ... and
 * yields any whose occurrence-start falls in [windowStartUnix,
 * windowEndUnix]. Note this filters by occurrence START, not occurrence
 * overlap — an occurrence whose end_time spills past windowEnd is
 * INCLUDED if its start fell inside the window. This matches rrule's
 * `between()` semantics and is what renderers / schedulers want
 * (occurrence-start aligned).
 */
export function expandRecurringEvent(
  event: CalendarEvent,
  windowStartUnix: number,
  windowEndUnix: number,
  overrides: ReadonlyArray<EventOverride>,
): EventInstance[] {
  // Build override lookup once (parent's overrides only).
  const overrideByOcc = new Map<number, EventOverride>()
  for (const o of overrides) {
    if (o.parentEventId === event.id) {
      overrideByOcc.set(o.occurrenceStart, o)
    }
  }

  if (event.recurrence_rule == null || event.recurrence_rule.trim().length === 0) {
    // Non-recurring: single occurrence at event.start_time. Apply override
    // matching that exact timestamp (rare for non-recurring but supported
    // for uniformity).
    const overlap = event.end_time > windowStartUnix && event.start_time < windowEndUnix
    if (!overlap) return []
    const override = overrideByOcc.get(event.start_time) ?? null
    const inst = buildInstance(event, event.start_time, override)
    return inst ? [inst] : []
  }

  const simpleInstances = expandSimpleRecurringEvent(
    event,
    windowStartUnix,
    windowEndUnix,
    overrideByOcc,
  )
  if (simpleInstances) return simpleInstances

  // Parse RRULE. On parse failure we degrade to a single instance + warn.
  let parsed: RRule | null = null
  try {
    const normalized = normalizeRruleString(event.recurrence_rule, event.start_time)
    const result = rrulestr(normalized, { forceset: false })
    // rrulestr can return RRule | RRuleSet; both have `between()`, but
    // typing them uniformly is easier as RRule. RRuleSet also implements
    // between() so duck-type cast is safe.
    parsed = result as RRule
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[rrule-engine] failed to parse recurrence_rule for event ${event.id}: ${message}; falling back to single instance`)
  }

  if (!parsed) {
    // Fallback: treat as a single non-recurring instance at event.start_time.
    const overlap = event.end_time > windowStartUnix && event.start_time < windowEndUnix
    if (!overlap) return []
    const override = overrideByOcc.get(event.start_time) ?? null
    const inst = buildInstance(event, event.start_time, override)
    return inst ? [inst] : []
  }

  const out: EventInstance[] = []
  let occurrences: Date[]
  try {
    // rrule.between(start, end, inc): inclusive when inc=true.
    occurrences = parsed.between(
      new Date(windowStartUnix * 1000),
      new Date(windowEndUnix * 1000),
      true,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[rrule-engine] between() threw for event ${event.id}: ${message}; returning empty list`)
    return []
  }

  for (const occ of occurrences) {
    const occurrenceStart = Math.floor(occ.getTime() / 1000)
    const override = overrideByOcc.get(occurrenceStart) ?? null
    const inst = buildInstance(event, occurrenceStart, override)
    if (inst) out.push(inst)
  }
  return out
}

/**
 * Expand a heterogeneous event list. Non-recurring rows pass through with
 * a single wrapped instance; recurring rows are expanded via
 * `expandRecurringEvent`. Caller is expected to have pre-filtered events
 * by window or by recurring-ness — this helper is happy to take both
 * shapes and behave uniformly.
 */
export function expandEventList(
  events: ReadonlyArray<CalendarEvent>,
  windowStartUnix: number,
  windowEndUnix: number,
  overridesByParent: Map<string, EventOverride[]>,
): EventInstance[] {
  const out: EventInstance[] = []
  for (const ev of events) {
    const ovs = overridesByParent.get(ev.id) ?? []
    const instances = expandRecurringEvent(ev, windowStartUnix, windowEndUnix, ovs)
    for (const inst of instances) out.push(inst)
  }
  // Stable sort by start_time then syntheticId so renderer / agent see
  // deterministic ordering.
  out.sort((a, b) => {
    if (a.start_time !== b.start_time) return a.start_time - b.start_time
    return a.syntheticId < b.syntheticId ? -1 : a.syntheticId > b.syntheticId ? 1 : 0
  })
  return out
}
