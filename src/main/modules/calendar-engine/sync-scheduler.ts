/**
 * External-calendar sync scheduler — main-process only.
 *
 * Wired by team L4-B (External-Sync). Walks every `calendar_sources` row
 * that has a non-null `sync_url` and:
 *   - fetches the URL,
 *   - parses the body as ICS via `parseIcsString`,
 *   - upserts each VEVENT into `calendar_events` (keyed by source_id +
 *     ics_uid via the deterministic id formula in `database.upsertImportedEvent`),
 *   - deletes any existing event for this source whose UID is no longer
 *     in the latest fetch (this is what makes "subscribed calendar"
 *     mirror the upstream feed instead of accumulating stale rows).
 *
 * Pure-ish module: imports only the `ImportedEvent` type from the
 * importer. Every IO / DB / timer dependency is injected by the host so
 * tests can pin clock, fake-fetch, and run a real-time scheduler in
 * deterministic time. The host wires `fetchIcs` (Node fetch + headers),
 * `getSources` (DB read), `importedEventsFor` / `upsertImportedEvent` /
 * `deleteImportedEvent` (DB writes) and a `scheduleAt` adapter.
 *
 * Reuses the SchedulerHandle shape from `reminder-scheduler.ts` style
 * (return `{ cancel: () => void }`) so the host can share a single
 * setTimeout adapter helper without duplicating boilerplate.
 *
 * Non-responsibilities (explicit):
 *   - No notification surface — `onSourceSynced` is the only output hook.
 *   - No retry logic — a failed fetch / parse logs and is retried at the
 *     next interval. (Step-back: surface persistent failures via
 *     `onSourceSynced` so the host can decide; we don't crash.)
 *   - No cross-source dedup — two subscribed calendars carrying the same
 *     UID get two distinct rows because the deterministic id includes
 *     the source_id. That matches user expectation: each subscription is
 *     its own column in the calendar list.
 */

import type { ImportedEvent } from './ics-importer'

export interface SyncSummary {
  /** Sources that completed without error (events created/updated/deleted). */
  ok: number
  /** Sources that surfaced an error during fetch / parse / DB write. */
  failed: number
  /** Total events touched (created + updated) across all ok sources. */
  totalEvents: number
}

export interface SyncResult {
  sourceId: string
  ok: boolean
  eventsCreated: number
  eventsUpdated: number
  eventsRemoved: number
  /** Non-null when `ok === false`. Human-readable; surfaced via `onSourceSynced`. */
  error: string | null
}

export interface SyncSchedulerHandle {
  cancel(): void
}

export interface SyncSchedulerDeps {
  /**
   * Return every persisted calendar source. Only rows with non-null
   * `sync_url` will be considered for sync. `sync_interval` is in
   * MINUTES (DB column is INTEGER DEFAULT 60); the scheduler converts
   * to seconds internally.
   */
  getSources(): Array<{ id: string; sync_url: string | null; sync_interval: number }>
  /**
   * Fetch an ICS body from a URL. The host wires this with Node's
   * built-in fetch + a UA header; tests inject a fake. Errors should
   * throw — the scheduler converts them into `SyncResult.error`.
   */
  fetchIcs(url: string): Promise<string>
  /**
   * Return every event row currently persisted for `sourceId` (i.e.
   * `WHERE source_id = ?`). The scheduler uses this to compute the
   * "exists in DB but not in latest fetch → delete" set.
   */
  importedEventsFor(sourceId: string): Array<{ uid: string; id: string }>
  /**
   * Insert or update one event row. Implementation must derive a
   * deterministic id from `(sourceId, ev.uid)` so re-running the same
   * fetch lands on the same row.
   */
  upsertImportedEvent(
    sourceId: string,
    ev: ImportedEvent,
  ): { id: string; action: 'created' | 'updated' }
  /** Delete the row whose `(sourceId, uid)` matches. Idempotent. */
  deleteImportedEvent(sourceId: string, uid: string): void
  /**
   * Optional hook fired after each per-source sync (success or failure).
   * Host wires telemetry / log line; not used by the scheduler itself.
   */
  onSourceSynced?: (result: SyncResult) => void
  /** Unix seconds — injected so tests can pin the clock. */
  now(): number
  /**
   * Register a one-shot timer to call `fn` at the given Unix-seconds
   * instant. Same shape as the reminder scheduler; host shares a default
   * `setTimeout` adapter.
   */
  scheduleAt(epochSec: number, fn: () => void): SyncSchedulerHandle
}

export interface SyncScheduler {
  /** Run sync once for every URL-bearing source. */
  syncAll(): Promise<SyncSummary>
  /** Run sync once for a single source by id. */
  syncOne(sourceId: string): Promise<SyncResult>
  /**
   * Register a timer per URL-bearing source. Each timer fires at
   * `now + source.sync_interval * 60` seconds and on fire re-arms
   * itself by reading the current source list (so a source whose
   * interval was edited or which was unsubscribed is picked up by the
   * next tick — no need for the host to explicitly stop/start timers).
   */
  startPeriodic(): void
  /** Cancel every pending timer; subsequent calls are noops. */
  stop(): void
}

/**
 * Default minimum sync interval. If a source declares `sync_interval`
 * below this floor we widen it; rapid polling against an external URL
 * is rude and almost certainly a mis-config. Five minutes matches the
 * floor most CalDAV implementations use.
 */
const MIN_INTERVAL_MINUTES = 5

function computeIntervalSeconds(rawMinutes: number): number {
  const effective = Number.isFinite(rawMinutes) && rawMinutes >= MIN_INTERVAL_MINUTES
    ? rawMinutes
    : MIN_INTERVAL_MINUTES
  return Math.floor(effective * 60)
}

export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  // sourceId → pending timer handle. We allow only one timer per source;
  // re-arming inside the fire callback cancels the old handle before
  // installing the new one so we never accumulate ghosts.
  const timers = new Map<string, SyncSchedulerHandle>()
  let stopped = false

  function emitResult(result: SyncResult): void {
    try {
      deps.onSourceSynced?.(result)
    } catch (error) {
      // onSourceSynced is an external hook; a throw must NEVER break the
      // sync loop. Log and move on.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[sync-scheduler] onSourceSynced threw for ${result.sourceId}:`, message)
    }
  }

  async function syncOne(sourceId: string): Promise<SyncResult> {
    if (stopped) {
      // Stopped schedulers shouldn't drive fresh syncs; return a benign
      // soft-failure so callers know the answer is "scheduler stopped"
      // rather than "the fetch broke".
      return {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: 'sync-scheduler stopped',
      }
    }

    let sourceRow: { id: string; sync_url: string | null; sync_interval: number } | undefined
    try {
      sourceRow = deps.getSources().find((s) => s.id === sourceId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: SyncResult = {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: `getSources failed: ${message}`,
      }
      console.warn(`[sync-scheduler] ${result.error}`)
      emitResult(result)
      return result
    }

    if (!sourceRow) {
      const result: SyncResult = {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: `source not found: ${sourceId}`,
      }
      console.warn(`[sync-scheduler] ${result.error}`)
      emitResult(result)
      return result
    }

    if (!sourceRow.sync_url || sourceRow.sync_url.trim().length === 0) {
      const result: SyncResult = {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: 'source has no sync_url',
      }
      console.warn(`[sync-scheduler] ${result.error}`)
      emitResult(result)
      return result
    }

    // 1) Fetch.
    let body: string
    try {
      body = await deps.fetchIcs(sourceRow.sync_url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: SyncResult = {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: `fetch failed: ${message}`,
      }
      console.warn(`[sync-scheduler] ${result.error} (${sourceRow.sync_url})`)
      emitResult(result)
      return result
    }

    // 2) Parse. We use a dynamic import lazily to avoid pulling ical.js
    // into the scheduler module's static dependency graph (this matters
    // for test files that fake the importer). Resolution happens once on
    // first call and the module cache keeps it cheap thereafter.
    let parseFn: (raw: string) => ImportedEvent[]
    try {
      parseFn = (await import('./ics-importer')).parseIcsString
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: SyncResult = {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: `importer load failed: ${message}`,
      }
      console.warn(`[sync-scheduler] ${result.error}`)
      emitResult(result)
      return result
    }

    let imported: ImportedEvent[]
    try {
      imported = parseFn(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: SyncResult = {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: `parse failed: ${message}`,
      }
      console.warn(`[sync-scheduler] ${result.error}`)
      emitResult(result)
      return result
    }

    // 3) Diff against existing rows.
    let existing: Array<{ uid: string; id: string }>
    try {
      existing = deps.importedEventsFor(sourceId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: SyncResult = {
        sourceId,
        ok: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsRemoved: 0,
        error: `importedEventsFor failed: ${message}`,
      }
      console.warn(`[sync-scheduler] ${result.error}`)
      emitResult(result)
      return result
    }
    const existingUids = new Set(existing.map((r) => r.uid))
    const incomingUids = new Set(imported.map((r) => r.uid))

    let created = 0
    let updated = 0
    let removed = 0
    let writeError: string | null = null

    for (const ev of imported) {
      try {
        const out = deps.upsertImportedEvent(sourceId, ev)
        if (out.action === 'created') created += 1
        else updated += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeError = `upsert failed for uid=${ev.uid}: ${message}`
        console.warn(`[sync-scheduler] ${writeError}`)
        // We keep iterating: partial sync is preferable to losing every
        // future event because one row had a constraint violation.
      }
    }

    for (const row of existing) {
      if (incomingUids.has(row.uid)) continue
      try {
        deps.deleteImportedEvent(sourceId, row.uid)
        removed += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeError = `delete failed for uid=${row.uid}: ${message}`
        console.warn(`[sync-scheduler] ${writeError}`)
      }
    }

    // Mark as failure when any write threw. Created/updated/removed
    // counters reflect what DID succeed.
    const result: SyncResult = {
      sourceId,
      ok: writeError == null,
      eventsCreated: created,
      eventsUpdated: updated,
      eventsRemoved: removed,
      error: writeError,
    }
    emitResult(result)

    // Touch existingUids / incomingUids briefly so the local symbols are
    // consumed (helps tree-shakers + future maintenance who wonder why
    // we built them). We use them above but the const-vs-let dance of
    // `writeError` makes it look like dead code on first scan.
    void existingUids
    void incomingUids

    return result
  }

  async function syncAll(): Promise<SyncSummary> {
    if (stopped) return { ok: 0, failed: 0, totalEvents: 0 }
    let sources: Array<{ id: string; sync_url: string | null; sync_interval: number }>
    try {
      sources = deps.getSources()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[sync-scheduler] syncAll getSources failed: ${message}`)
      return { ok: 0, failed: 0, totalEvents: 0 }
    }
    const targets = sources.filter(
      (s) => typeof s.sync_url === 'string' && s.sync_url.trim().length > 0,
    )
    let ok = 0
    let failed = 0
    let totalEvents = 0
    // Run sequentially — most users have only a handful of subscriptions;
    // serial keeps log lines and rate-limit behavior predictable, and
    // makes write contention against the same source_id impossible.
    for (const source of targets) {
      const result = await syncOne(source.id)
      if (result.ok) {
        ok += 1
        totalEvents += result.eventsCreated + result.eventsUpdated
      } else {
        failed += 1
      }
    }
    return { ok, failed, totalEvents }
  }

  function cancelTimer(sourceId: string): void {
    const handle = timers.get(sourceId)
    if (!handle) return
    try { handle.cancel() } catch { /* swallow per-timer */ }
    timers.delete(sourceId)
  }

  function cancelAll(): void {
    for (const id of Array.from(timers.keys())) {
      cancelTimer(id)
    }
  }

  function armOne(sourceId: string, intervalSeconds: number): void {
    if (stopped) return
    cancelTimer(sourceId)
    const fireAt = deps.now() + intervalSeconds
    const handle = deps.scheduleAt(fireAt, () => {
      if (stopped) return
      // Fire: best-effort sync, then re-derive the interval from the
      // current source list and re-arm. If the source was deleted
      // between scheduling and now, syncOne returns a soft failure and
      // we simply don't re-arm.
      void syncOne(sourceId)
        .then(() => {
          if (stopped) return
          const fresh = deps.getSources().find((s) => s.id === sourceId)
          if (!fresh || !fresh.sync_url) {
            cancelTimer(sourceId)
            return
          }
          armOne(sourceId, computeIntervalSeconds(fresh.sync_interval))
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[sync-scheduler] timer fire for ${sourceId} threw:`, message)
        })
    })
    timers.set(sourceId, handle)
  }

  function startPeriodic(): void {
    if (stopped) return
    let sources: Array<{ id: string; sync_url: string | null; sync_interval: number }>
    try {
      sources = deps.getSources()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[sync-scheduler] startPeriodic getSources failed: ${message}`)
      return
    }
    for (const source of sources) {
      if (!source.sync_url || source.sync_url.trim().length === 0) continue
      armOne(source.id, computeIntervalSeconds(source.sync_interval))
    }
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    cancelAll()
  }

  return {
    syncAll,
    syncOne,
    startPeriodic,
    stop,
  }
}
