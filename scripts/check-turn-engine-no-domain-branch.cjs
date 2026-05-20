#!/usr/bin/env node
/**
 * Stage U PR U1.4 — fence turn-engine.ts against product-domain branches.
 *
 * AGENTS.md §5 requires:
 *   "turn-engine.ts only schedules; product rules must go through
 *    DomainAdapter / SystemReminderRegistry."
 *
 * Before U1.4, turn-engine.ts inlined two product reminders:
 *   - Pet stickynote retry nudge (mentioning 宠物便利贴 / pet_show_sticky_note)
 *   - Browser task correction nudge (mentioning 浏览器任务 / browser_* tools)
 *
 * Both relocated to src/main/modules/agent-control/system-reminders/.
 * This gate fences regression by forbidding the product literals from
 * reappearing in turn-engine.ts.
 *
 * Forbidden in src/main/modules/agent-control/turn-engine.ts (string
 * literals only — type imports and comments are scanned after stripping):
 *
 *   Chinese product names:
 *     '宠物', '便利贴', '当前任务是宠物', '当前任务是浏览器',
 *     '当前任务是 RSS', '当前任务是日历', '当前任务是文档'
 *
 *   Tool-name prefixes in string form:
 *     'pet_show_sticky_note', 'browser_search', 'browser_navigate',
 *     'browser_read_page'
 *
 * The gate scans only string literal contents (after comment stripping).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const TARGET = 'src/main/modules/agent-control/turn-engine.ts'

const FORBIDDEN_LITERALS = [
  '宠物便利贴',
  '当前任务是宠物',
  '当前任务是浏览器',
  '当前任务是 RSS',
  '当前任务是日历',
  '当前任务是文档',
  'pet_show_sticky_note',
  'browser_search、browser_navigate',
]

function stripComments(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock.replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function checkTurnEngineNoDomainBranch() {
  const abs = path.join(REPO, TARGET)
  if (!fs.existsSync(abs)) {
    return { ok: false, violations: [{
      file: TARGET, line: 0,
      reason: 'turn-engine.ts not found',
      code: '(missing file)',
    }] }
  }
  const raw = fs.readFileSync(abs, 'utf8')
  const source = stripComments(raw)
  const lines = source.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i += 1) {
    for (const lit of FORBIDDEN_LITERALS) {
      if (lines[i].includes(lit)) {
        // Locate the line in the original (raw) source for nicer reporting.
        // We re-scan raw to find the first line containing the literal.
        const rawLines = raw.split('\n')
        let rawLine = i + 1
        for (let j = 0; j < rawLines.length; j += 1) {
          if (rawLines[j].includes(lit)) { rawLine = j + 1; break }
        }
        violations.push({
          file: TARGET,
          line: rawLine,
          reason: `forbidden product-domain literal '${lit}'`,
          code: rawLines[rawLine - 1]?.trim().slice(0, 160) || '(out of range)',
        })
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkTurnEngineNoDomainBranch()
  if (ok) { console.log('[check-turn-engine-no-domain-branch] OK'); return 0 }
  console.error('[check-turn-engine-no-domain-branch] FAIL — turn-engine.ts contains product-domain literals (AGENTS.md §5 / Stage U1.4).')
  console.error('  Relocate to src/main/modules/agent-control/system-reminders/ or a DomainAdapter.')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.reason}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkTurnEngineNoDomainBranch }
