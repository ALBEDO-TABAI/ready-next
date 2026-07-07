#!/usr/bin/env node
/**
 * R-WRITE gate — skill-artifact write correction is actionable (red-first).
 *
 * The incident (2026-07-07) rejected the second document's `skill_write_artifact`
 * twice with `issueCount=2` (relativePath + content). The full issue enumeration
 * already rode in `data.issues`, so "enumerate the issues" was NOT the missing
 * lever — the model gave up anyway. The real lever is making the correction
 * actionable: name EVERY failed field with a canonical-form example, and widen
 * the relativePath alias so common source keys don't become spurious failures.
 *
 * This gate asserts the SOURCE carries those two levers. It is deliberately
 * red on the pre-fix code (none of the symbols existed), so it proves the
 * change rather than rubber-stamping the status quo. Behavior is pinned by
 * src/__tests__/tool-input-validator.test.ts (the R-WRITE cases).
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const VALIDATOR_FILE = 'src/main/modules/tools/tool-input-validator.ts'
const SCHEMA_FILE = 'src/main/modules/tools/skill-primitives/primitive-schemas.ts'

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []

  const src = read(VALIDATOR_FILE)
  if (!src) {
    violations.push({ file: VALIDATOR_FILE, reason: 'missing file' })
  } else {
    // (a) alias source-key whitelist widened beyond bare `path`. path/file/
    // filePath apply to all artifact tools; output_path/outputPath are write-only
    // (must not absorb an export destination) → a separate constant, gated on
    // skill_write_artifact.
    const baseAlias = src.match(/SKILL_ARTIFACT_PATH_ALIAS_SOURCE_KEYS\s*=\s*\[([^\]]*)\]/)
    if (!baseAlias) {
      violations.push({ file: VALIDATOR_FILE, reason: 'missing SKILL_ARTIFACT_PATH_ALIAS_SOURCE_KEYS (alias must iterate a widened source-key set)' })
    } else {
      for (const key of ['path', 'file', 'filePath']) {
        if (!new RegExp(`['"]${key}['"]`).test(baseAlias[1])) {
          violations.push({ file: VALIDATOR_FILE, reason: `alias source keys must include '${key}'` })
        }
      }
    }
    const writeAlias = src.match(/SKILL_WRITE_ONLY_PATH_ALIAS_SOURCE_KEYS\s*=\s*\[([^\]]*)\]/)
    if (!writeAlias) {
      violations.push({ file: VALIDATOR_FILE, reason: 'output_path/outputPath must be a write-only alias source set (not aliased for skill_export_artifact)' })
    } else {
      for (const key of ['output_path', 'outputPath']) {
        if (!new RegExp(`['"]${key}['"]`).test(writeAlias[1])) {
          violations.push({ file: VALIDATOR_FILE, reason: `write-only alias source keys must include '${key}'` })
        }
      }
    }
    if (!/toolName === 'skill_write_artifact'/.test(src)) {
      violations.push({ file: VALIDATOR_FILE, reason: 'write-only alias keys must be gated on skill_write_artifact (never absorb an export destination)' })
    }

    // (b) per-field canonical example guidance exists for the key fields.
    const guidanceMatch = src.match(/SKILL_ARTIFACT_FIELD_GUIDANCE\s*:\s*Record<[^>]*>\s*=\s*\{([\s\S]*?)\n\}/)
    if (!guidanceMatch) {
      violations.push({ file: VALIDATOR_FILE, reason: 'missing SKILL_ARTIFACT_FIELD_GUIDANCE (per-field canonical-form examples)' })
    } else {
      for (const field of ['relativePath', 'content', 'encoding', 'mode']) {
        if (!new RegExp(`\\b${field}\\s*:`).test(guidanceMatch[1])) {
          violations.push({ file: VALIDATOR_FILE, reason: `SKILL_ARTIFACT_FIELD_GUIDANCE must cover field '${field}'` })
        }
      }
    }

    // (c) the corrective names EVERY failed field, not just firstIssue.
    if (!/failedFields/.test(src) || !/buildInputValidationCorrective/.test(src)) {
      violations.push({ file: VALIDATOR_FILE, reason: 'corrective must enumerate all failedFields via buildInputValidationCorrective (not only firstIssue)' })
    }

    // (d) explicit write→export routing hint — anchored to the ACTUAL sentinel
    // string (not a bare `skill_export_artifact` token, which pre-existed in the
    // tool-name Set and made this check trivially green / not red-first).
    if (!/再用 skill_export_artifact 的 targetPath 导出/.test(src)) {
      violations.push({ file: VALIDATOR_FILE, reason: 'corrective must carry the write→export hint sentinel (先 write 再 export)' })
    }
  }

  const schemaSrc = read(SCHEMA_FILE)
  if (!schemaSrc) {
    violations.push({ file: SCHEMA_FILE, reason: 'missing file' })
  } else {
    // content stays a bare string (no min(1)); its describe must flag required.
    const contentMatch = schemaSrc.match(/content:\s*z\.string\(\)\.describe\(([^)]*)\)/)
    if (!contentMatch) {
      violations.push({ file: SCHEMA_FILE, reason: 'skill_write_artifact.content must stay bare z.string().describe(...) (no min(1))' })
    } else if (!/必填/.test(contentMatch[1])) {
      violations.push({ file: SCHEMA_FILE, reason: 'content .describe() must flag it as required (必填) so an omitted content is unambiguous' })
    }
  }

  if (violations.length === 0) {
    console.log('[check-skill-artifact-write-corrective] OK')
    process.exit(0)
  }
  console.error('[check-skill-artifact-write-corrective] FAIL:')
  for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`)
  process.exit(1)
}

main()
