#!/usr/bin/env node
/**
 * Stage 4 W1 — pure-read invariant for skill-turn-identity.ts.
 *
 * The SkillTurnIdentity resolver must derive its result from the frozen
 * SkillTurnIdentitySnapshot only. It MUST NOT import any function that
 * writes to the reference-hint store, the active-skill-context store, or
 * any other live state. Even read-only orchestrator helpers like
 * `getLastReferenceSkill` are forbidden because they bump TTL on every
 * call (skill-reference-hints.ts:124 — "skill-resume G8").
 *
 * The snapshot collector (skill-turn-identity-snapshot.ts) is allowed to
 * call orchestrator reads at most once per turn, accepting a single TTL
 * bump. The resolver consumes only the frozen result.
 *
 * If you need a new read in the resolver, add it to the snapshot collector
 * and propagate it through the SkillTurnIdentitySnapshot type.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const RESOLVER_FILE = 'src/main/modules/agent-control/skills/skill-turn-identity.ts'
// Module-relative-path → set of forbidden import names.
const FORBIDDEN_IMPORTS = {
  './skill-reference-hints': [
    'rememberLastReferenceSkill',
    'clearLastReferenceSkill',
    'clearAllReferenceSkillHints',
    'sweepExpiredReferenceSkillHints',
    'getLastReferenceSkill',
    'peekLastReferenceSkill',
    'restoreLastReferenceSkill',
    'snapshotLastReferenceSkill',
    'persistReferenceHintToScope',
    'setReferenceHintChangeEmitter',
  ],
  './active-skill-context': [
    'rememberActiveSkillContext',
    'clearActiveSkillContext',
    'resolveActiveSkillContext',
    'resolveActiveSkillContextReadOnly',
    'getRememberedActiveSkillContext',
    'hasActiveSkillContext',
  ],
  './skill-task-supervisor': [
    'inspectLatestSkillTask',
  ],
  './session-continuity': [
    'getLatestSkillRun',
    'resolveSkillRunForResume',
    'rememberContinuationState',
    'getContinuationState',
  ],
}

function main() {
  const root = resolve(__dirname, '..')
  const filePath = resolve(root, RESOLVER_FILE)
  if (!existsSync(filePath)) {
    console.error(`identity resolver pure-read check: missing ${RESOLVER_FILE}`)
    process.exit(1)
  }
  const source = readFileSync(filePath, 'utf8')
  const violations = findViolations(source)
  if (violations.length > 0) {
    console.error('identity resolver pure-read check FAILED:')
    for (const v of violations) {
      console.error(`- ${v.module} :: ${v.symbol} — ${v.reason}`)
    }
    console.error('')
    console.error('The resolver must consume only the frozen SkillTurnIdentitySnapshot.')
    console.error('If a new read is needed, add it to skill-turn-identity-snapshot.ts.')
    process.exit(1)
  }
  console.log('identity resolver pure-read check: ok')
}

function findViolations(source) {
  const violations = []
  // Strip block + line comments so we don't false-positive on documentation
  // mentions like the JSDoc list.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  for (const [moduleName, forbiddenSymbols] of Object.entries(FORBIDDEN_IMPORTS)) {
    // Match `import { ... } from '<moduleName>'` (multiline-safe).
    const importPattern = new RegExp(
      String.raw`import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*['"]${moduleName.replace(/[.\\/]/g, '\\$&')}['"]`,
      'g',
    )
    let match
    while ((match = importPattern.exec(stripped)) !== null) {
      const importedNames = match[1]
        .split(',')
        .map((entry) => entry.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, ''))
        .filter(Boolean)
      for (const name of importedNames) {
        if (forbiddenSymbols.includes(name)) {
          violations.push({
            module: moduleName,
            symbol: name,
            reason: 'forbidden — resolver must consume snapshot, not live read/mutator',
          })
        }
      }
    }
  }
  return violations
}

if (require.main === module) main()

module.exports = { findViolations }
