/**
 * Stage U PR U3.1 — InputBoundaryResult contract for renderer input edges.
 *
 * Audit §1.1 / §3 — Ready's renderer-side input boundaries (file drag/drop,
 * external drop, local HTML open, URL parse, chat input bridge, calendar
 * grid render) each used to wrap their work in `try { … } catch {}` and
 * silently degrade. The user-visible symptoms ("drag did nothing", "local
 * HTML didn't open", "downloaded but never appeared") all came from this
 * pattern, and each catch was invisible to forensic logs.
 *
 * `InputBoundaryResult<T>` is the canonical replacement: callers return a
 * tagged union the UI layer can switch on, with a `reason` machine code
 * and an optional human-readable `userMessage` that goes straight into a
 * toast / inline error. UI layers do NOT invent failure text — `reason`
 * and `userMessage` ARE the contract.
 *
 * Helpers:
 *   - `asBoundary` / `asAsyncBoundary` — wrap a thunk so its throw becomes
 *     `{ ok: false, … }`. The fallback function decides reason/userMessage
 *     from the unknown error.
 *   - `okResult` / `failResult` — explicit constructors for hand-written
 *     boundary code paths.
 *
 * The runtime CI gate `scripts/check-input-boundary-coverage.cjs` enforces
 * that renderer paths in src/renderer/{components/layout,modules/browser,
 * modules/agent,components/calendar}/ use this helper OR carry an explicit
 * `// silent-catch:` annotation explaining why the swallow is harmless.
 */

export type InputBoundaryReason = string

export type InputBoundaryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: InputBoundaryReason; userMessage?: string; cause?: unknown }

export interface InputBoundaryFailureSpec {
  reason: InputBoundaryReason
  userMessage?: string
}

export function okResult<T>(value: T): InputBoundaryResult<T> {
  return { ok: true, value }
}

export function failResult<T = never>(
  spec: InputBoundaryFailureSpec,
  cause?: unknown,
): InputBoundaryResult<T> {
  return {
    ok: false,
    reason: spec.reason,
    userMessage: spec.userMessage,
    cause,
  }
}

/**
 * Synchronous boundary helper. Catches anything thrown and turns it into
 * `{ ok: false, … }` via the caller-provided fallback.
 */
export function asBoundary<T>(
  fn: () => T,
  fallback: (err: unknown) => InputBoundaryFailureSpec,
): InputBoundaryResult<T> {
  try {
    return okResult(fn())
  } catch (err) {
    return failResult(fallback(err), err)
  }
}

/**
 * Async boundary helper. Same contract as `asBoundary` for Promise-returning
 * thunks. Rejection becomes a `failResult`.
 */
export async function asAsyncBoundary<T>(
  fn: () => Promise<T>,
  fallback: (err: unknown) => InputBoundaryFailureSpec,
): Promise<InputBoundaryResult<T>> {
  try {
    return okResult(await fn())
  } catch (err) {
    return failResult(fallback(err), err)
  }
}

/**
 * Convenience helper for matching on the result without re-checking `ok`
 * at each callsite. Returns the value or the fallback computed from the
 * failure.
 */
export function unwrapBoundaryOr<T>(
  result: InputBoundaryResult<T>,
  fallback: (failure: { reason: InputBoundaryReason; userMessage?: string; cause?: unknown }) => T,
): T {
  if (result.ok) return result.value
  return fallback(result)
}
