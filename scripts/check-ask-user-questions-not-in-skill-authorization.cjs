#!/usr/bin/env node
/**
 * `ask_user_questions` must NEVER be referenced from skill-tool-authorization
 * literals. The tool intentionally lives in the `agent_interaction` group,
 * not `skills`, so SkillToolAuthorization (§6.23) does not gate it. If the
 * literal name ever appears in that file, someone is regressing the
 * boundary — surface the regression at gate time, not at runtime when a
 * mode:'none' turn suddenly stops showing the tool.
 *
 * Scans:
 *   - src/main/modules/agent-control/skill-tool-authorization.ts
 *   - src/main/modules/agent-control/skill-turn-identity.ts
 *   - src/main/modules/tools/skill-tool-session-gate.ts
 *
 * Allowlisted comment references (lines starting with `//` that merely
 * mention the name) are tolerated; only "live code" references trigger
 * a violation.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const FROZEN_NAME = 'ask_user_questions'
const SCAN_FILES = [
  'src/main/modules/agent-control/skill-tool-authorization.ts',
  'src/main/modules/agent-control/skill-turn-identity.ts',
  'src/main/modules/tools/skill-tool-session-gate.ts',
]

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []
  for (const rel of SCAN_FILES) {
    const src = read(rel)
    if (src === null) continue
    const lines = src.split(/\r?\n/)
    lines.forEach((line, idx) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      if (line.includes(`'${FROZEN_NAME}'`) || line.includes(`"${FROZEN_NAME}"`)) {
        violations.push({
          file: rel,
          line: idx + 1,
          excerpt: trimmed.slice(0, 140),
        })
      }
    })
  }

  if (violations.length === 0) {
    console.log('[check-ask-user-questions-not-in-skill-authorization] OK')
    process.exit(0)
  }
  console.error('[check-ask-user-questions-not-in-skill-authorization] FAIL:')
  console.error('  ask_user_questions must NEVER appear in skill-tool-authorization-related code (it is main-agent only).')
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line}  ${v.excerpt}`)
  }
  process.exit(1)
}

main()
