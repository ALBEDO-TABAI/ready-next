#!/usr/bin/env node
/**
 * Stage S (PR-S11 / W10.1) — migration numbering gate.
 *
 * Asserts that `src/main/modules/migrations.ts` defines every migration
 * with a `name` that begins with `0NN_` for `NN = 1..MAX`, with no gaps
 * and no out-of-order entries. PR-S11 specifically requires migrations
 * 034, 035, 036 to be present in that order at the tail.
 *
 * The gate is intentionally a regex+ordering scan (no TS parse) so it
 * stays cheap and runs on every verify:s invocation.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REL = 'src/main/modules/migrations.ts'

let src
try {
  src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
} catch (e) {
  console.error(`[check-migration-numbering-sequential] FAIL: cannot read ${REL}: ${e.message}`)
  process.exit(1)
}

// Pull every `name: '0NN_…'` literal in source order.
const NAME_RE = /name:\s*['"](\d{3})_[A-Za-z0-9_]+['"]/g
const numbers = []
let match
while ((match = NAME_RE.exec(src)) !== null) {
  numbers.push(parseInt(match[1], 10))
}

const errors = []

if (numbers.length === 0) {
  errors.push('no migration names matched the `0NN_<slug>` shape')
}

// Verify numbering is strictly sequential starting from 1 (or whatever the
// first observed number is — historically 001).
for (let i = 1; i < numbers.length; i++) {
  if (numbers[i] !== numbers[i - 1] + 1) {
    errors.push(
      `non-sequential migration numbers: ${numbers[i - 1]} → ${numbers[i]} ` +
        `(expected ${numbers[i - 1] + 1}); migrations must increase by 1 with no gaps`,
    )
  }
}

// PR-S11 invariant: 034, 035, 036 must be present and in order.
const REQUIRED = [34, 35, 36]
for (const n of REQUIRED) {
  if (!numbers.includes(n)) {
    errors.push(`migration ${String(n).padStart(3, '0')} is missing — PR-S11 requires it`)
  }
}

// Stronger ordering check: the tail of `numbers` ending at the highest of
// REQUIRED must match the REQUIRED sequence in order (i.e. the new ones
// were appended, not interleaved).
const maxRequired = Math.max(...REQUIRED)
const idx = numbers.indexOf(REQUIRED[0])
if (idx !== -1) {
  for (let k = 0; k < REQUIRED.length; k++) {
    if (numbers[idx + k] !== REQUIRED[k]) {
      errors.push(
        `migrations ${REQUIRED.map((n) => String(n).padStart(3, '0')).join(', ')} ` +
          `must appear in order; observed at index ${idx + k}: ${numbers[idx + k]}`,
      )
      break
    }
  }
  // And the highest required must be at or near the tail (no migrations
  // numbered LOWER than 34 may appear AFTER 36).
  const idxMax = numbers.lastIndexOf(maxRequired)
  for (let i = idxMax + 1; i < numbers.length; i++) {
    if (numbers[i] < maxRequired) {
      errors.push(
        `migration ${numbers[i]} appears AFTER ${maxRequired} — numbering must be monotonic`,
      )
    }
  }
}

if (errors.length > 0) {
  console.error('[check-migration-numbering-sequential] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log(
  `[check-migration-numbering-sequential] OK (${numbers.length} migrations, range ${numbers[0]}–${numbers[numbers.length - 1]})`,
)
