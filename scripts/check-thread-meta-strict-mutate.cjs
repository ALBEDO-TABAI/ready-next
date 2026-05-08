#!/usr/bin/env node
/**
 * Stage S (PR-S11 / W10.2) — thread_meta strict-mutate gate.
 *
 * Asserts that `thread-meta-repository.ts` enforces the immutability of
 * `ownerKind` / `ownerId` (and supporting fields) on update:
 *
 *   - The `ThreadMetaUpdatePatch` type does not allow these fields.
 *   - `THREAD_META_IMMUTABLE_FIELDS` lists them as the runtime guard's
 *     source of truth, including 'ownerKind' and 'ownerId' literally.
 *   - `update()` runtime guard scans the patch object's keys against
 *     `THREAD_META_IMMUTABLE_FIELDS` and throws when one matches.
 *   - The UPDATE SQL statement does NOT touch `owner_kind` / `owner_id`.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REL = 'src/main/modules/agent-control/thread-meta-repository.ts'

let src
try {
  src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
} catch (e) {
  console.error(`[check-thread-meta-strict-mutate] FAIL: cannot read ${REL}: ${e.message}`)
  process.exit(1)
}

const errors = []

// 1. The exported immutable-fields constant must list ownerKind + ownerId.
const constMatch = /export\s+const\s+THREAD_META_IMMUTABLE_FIELDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/.exec(src)
if (!constMatch) {
  errors.push("missing `export const THREAD_META_IMMUTABLE_FIELDS = [...] as const`")
} else {
  const body = constMatch[1]
  for (const required of ['ownerKind', 'ownerId']) {
    if (!new RegExp(`['\"]${required}['\"]`).test(body)) {
      errors.push(`THREAD_META_IMMUTABLE_FIELDS must include '${required}'`)
    }
  }
}

// 2. Update patch type must explicitly NOT include ownerKind / ownerId /
//    scopeId. We grep for the patch type literal block and assert those
//    field names are absent inside it.
const patchTypeMatch = /export\s+type\s+ThreadMetaUpdatePatch\s*=\s*Partial<\s*\{([\s\S]*?)\}\s*>/.exec(src)
if (!patchTypeMatch) {
  errors.push('missing `export type ThreadMetaUpdatePatch = Partial<{ ... }>`')
} else {
  const patchBody = patchTypeMatch[1]
  for (const forbidden of ['ownerKind', 'ownerId', 'scopeId']) {
    if (new RegExp(`\\b${forbidden}\\s*:`).test(patchBody)) {
      errors.push(`ThreadMetaUpdatePatch must NOT declare a '${forbidden}' field`)
    }
  }
  // Allowed fields (defence-in-depth: at least one of these must remain
  // mutable, otherwise the patch type is empty and the contract becomes
  // trivially "no updates allowed" which is wrong).
  if (!/\bdisplayTitle\b/.test(patchBody) && !/\bpinned\b/.test(patchBody) && !/\barchived\b/.test(patchBody)) {
    errors.push('ThreadMetaUpdatePatch must allow at least one of displayTitle / pinned / archived')
  }
}

// 3. The runtime guard inside `update()` must iterate the immutable list
//    and throw when a forbidden key is present.
if (!/for\s*\(\s*const\s+\w+\s+of\s+THREAD_META_IMMUTABLE_FIELDS\s*\)/.test(src)) {
  errors.push("update() must iterate THREAD_META_IMMUTABLE_FIELDS at runtime")
}
if (!/throw\s+new\s+Error\(\s*[\s\S]{0,120}immutable/i.test(src)) {
  errors.push("update() runtime guard must throw with an 'immutable' error message")
}

// 4. The UPDATE SQL must NOT mention owner_kind / owner_id columns.
//    (We allow the column names to appear elsewhere in the file for
//     create() / SELECT, but the UPDATE statement specifically must omit
//     them.)
const updateSqlMatch = /UPDATE\s+thread_meta\s+SET([\s\S]*?)WHERE\s+thread_id\s*=\s*\?/i.exec(src)
if (!updateSqlMatch) {
  errors.push('missing `UPDATE thread_meta SET … WHERE thread_id = ?` statement')
} else {
  const setClause = updateSqlMatch[1]
  for (const forbidden of ['owner_kind', 'owner_id', 'scope_id']) {
    if (new RegExp(`\\b${forbidden}\\b`).test(setClause)) {
      errors.push(`UPDATE thread_meta must NOT touch column '${forbidden}'`)
    }
  }
}

if (errors.length > 0) {
  console.error('[check-thread-meta-strict-mutate] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-thread-meta-strict-mutate] OK')
