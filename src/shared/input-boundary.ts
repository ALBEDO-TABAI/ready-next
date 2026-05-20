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
 * Stage U PR U3.1 — current rollout: all 14 known renderer silent
 * catches were evaluated and turned out to be legitimate defensive
 * fallbacks (URL parse, JSON parse, redundant switchTab, already-
 * surfaced-via-callback) and are now annotated with `// silent-catch:`
 * reasons. The `scripts/check-silent-catch.cjs` gate (wired into
 * verify:e by U3.3) enforces that ALL future renderer/main silent
 * catches either gain such an annotation or surface a metric/log/throw.
 *
 * This helper is therefore reserved for the next renderer input edge
 * that genuinely has a user-visible failure path (e.g. a future remote
 * attachment dialog or a multi-step import wizard). When such an edge
 * lands it should use `asBoundary` / `asAsyncBoundary` instead of
 * inventing its own `{ ok, error }` shape.
 *
 * No standalone `check-input-boundary-coverage.cjs` gate exists yet —
 * the broader `check-silent-catch.cjs` already covers the actual
 * concern (no unobserved catches). A dedicated coverage gate is
 * deferred until at least one production callsite consumes this helper.
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
