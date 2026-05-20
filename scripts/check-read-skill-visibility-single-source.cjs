#!/usr/bin/env node
/**
 * Stage U PR U1.5 — `read_skill` visibility single-source gate.
 *
 * CLAUDE.md §3 requires reference/advisory `read_skill` actions to be
 * normalized to `visibility: 'internal'`. Before U1.5 the rule was
 * copy-pasted into two helper functions plus a third inline branch in
 * `custom-skill-registry.ts`. This gate enforces that the only file in
 * `src/main/modules/skills-runtime/` that may co-locate the `read_skill`
 * literal (identifier or string) with the `visibility: 'internal'`
 * literal is the helper itself (`read-skill-visibility.ts`). Any new
 * reintroduction in a sibling source file is rejected.
 *
 * Co-occurrence window: 5 lines (a single decision block).
 *
 * Whitelist: helper file, this gate, and any `SKILL.md` (manifest docs).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOT = 'src/main/modules/skills-runtime'
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs'])
const WINDOW = 5

const FILE_ALLOWLIST = [
  /^src\/main\/modules\/skills-runtime\/read-skill-visibility\.ts$/,
  /^scripts\/check-read-skill-visibility-single-source\.cjs$/,
  /\/SKILL\.md$/,
]

const READ_SKILL_RE = /\bread_skill\b/
const INTERNAL_VISIBILITY_RE = /visibility\s*:\s*['"`]internal['"`]/

function listFiles(rootDir) {
  const out = []
  const stack = [rootDir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile() && SCAN_EXT.has(path.extname(ent.name))) out.push(p)
    }
  }
  return out
}

function relposix(root, p) { return path.relative(root, p).split(path.sep).join('/') }

function checkReadSkillVisibilitySingleSource({ root = REPO } = {}) {
  const violations = []
  const abs = path.join(root, SCAN_ROOT)
  if (!fs.existsSync(abs)) return { ok: true, violations }
  for (const file of listFiles(abs)) {
    const relPath = relposix(root, file)
    if (FILE_ALLOWLIST.some((re) => re.test(relPath))) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!READ_SKILL_RE.test(lines[i])) continue
      const start = Math.max(0, i - WINDOW)
      const end = Math.min(lines.length, i + WINDOW + 1)
      for (let j = start; j < end; j++) {
        if (INTERNAL_VISIBILITY_RE.test(lines[j])) {
          violations.push({
            file: relPath,
            line: i + 1,
            internalLine: j + 1,
            code: lines[i].trim(),
            internalCode: lines[j].trim(),
          })
          break
        }
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkReadSkillVisibilitySingleSource()
  if (ok) { console.log('[check-read-skill-visibility-single-source] OK'); return 0 }
  console.error('[check-read-skill-visibility-single-source] FAIL — `read_skill` + `visibility: \'internal\'` co-located outside the helper (CLAUDE.md §3, U1.5).')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — \`read_skill\` co-located with \`visibility: 'internal'\` at line ${v.internalLine}`)
    console.error(`    read_skill: ${v.code}`)
    console.error(`    visibility: ${v.internalCode}`)
    console.error('    fix: call normalizeReadSkillVisibility() from src/main/modules/skills-runtime/read-skill-visibility.ts')
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkReadSkillVisibilitySingleSource }
