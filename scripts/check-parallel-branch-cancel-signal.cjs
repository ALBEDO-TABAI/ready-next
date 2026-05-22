#!/usr/bin/env node
/**
 * Stage T (T-B, round 4) gate — `parallel-branch-orchestrator.ts` must
 * pass an `AbortSignal` into each branch function and the cancel(...)
 * path must call `AbortController.abort()`. Without this, cancel is
 * unreachable cooperative cancellation breaks.
 *
 * Enforced:
 *   1. spawn signature accepts `(signal: AbortSignal) => Promise<...>`.
 *   2. The orchestrator constructs `new AbortController()` per branch.
 *   3. A `cancel(...)` path invokes `.abort()` on a controller.
 */
const fs = require('fs')
const path = require('path')

const TARGET = path.join(
  __dirname,
  '..',
  'src',
  'main',
  'modules',
  'agent-control',
  'runtime-core',
  'parallel-branch-orchestrator.ts',
)

const errors = []

if (!fs.existsSync(TARGET)) {
  errors.push(`missing file: ${TARGET}`)
} else {
  const src = fs.readFileSync(TARGET, 'utf8')

  // (1) spawn signature must accept (signal: AbortSignal) => Promise<...>
  // Match either the interface declaration or the implementation function.
  const signalParamPattern = /\(\s*signal\s*:\s*AbortSignal\s*\)\s*=>\s*Promise/
  if (!signalParamPattern.test(src)) {
    errors.push(
      'spawn() must accept a branch function of shape '
        + '`(signal: AbortSignal) => Promise<unknown>` so branches can '
        + 'cooperatively check cancel.',
    )
  }

  // (2) per-branch AbortController construction
  const ctorPattern = /new\s+AbortController\s*\(/
  if (!ctorPattern.test(src)) {
    errors.push(
      'Each branch must own a `new AbortController()` so cancel(branchId) '
        + 'can abort it independently.',
    )
  }

  // (3) cancel path must invoke `.abort()` on the controller
  const abortCallPattern = /\.abort\s*\(\s*\)/
  if (!abortCallPattern.test(src)) {
    errors.push(
      'cancel(branchId) must call `controller.abort()` on the branch\'s '
        + 'AbortController; otherwise the signal never fires.',
    )
  }

  // Ensure the `cancel` function actually exists and is wired (sanity).
  const cancelFnPattern = /function\s+cancel\s*\(\s*branchId/
  if (!cancelFnPattern.test(src)) {
    errors.push(
      'Missing `function cancel(branchId: string)` — orchestrator must '
        + 'expose a cancel(branchId) entry point.',
    )
  }
}

if (errors.length > 0) {
  console.error('[check-parallel-branch-cancel-signal] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-parallel-branch-cancel-signal] OK')
