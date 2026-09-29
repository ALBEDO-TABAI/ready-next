#!/usr/bin/env node
/**
 * S1-3 run-finalize funnel gate.
 *
 * Terminal run_meta writes must go through runtime-core/run-finalizer.ts.
 * Terminal projection patch construction must also live in that finalizer; other
 * modules may import and apply the constructor, but must not build the terminal
 * object locally.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_META_TERMINAL_STATUS_REL = 'src/shared/run-meta-terminal-status.ts'
const RUN_FINALIZER_REL = 'src/main/modules/agent-control/runtime-core/run-finalizer.ts'
const AGENT_SDK_RUNTIME_REL = 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts'
// V3 Phase 5-B: sendMessage owns the finalizer closures in the orchestrator;
// deterministic preparation, input, execution and closeout sections live in
// bounded leaf modules. C03 checks pin each contract to its live owner.
const RUN_META_REPOSITORY_REL =
  'src/main/modules/agent-control/task-projection/run-meta-repository.ts'
const WORKFLOW_UNIT_OF_WORK_REPOSITORY_REL =
  'src/main/modules/repositories/agent-session-checkpoint-repository.ts'
const WORKFLOW_UNIT_OF_WORK_LEAF_REPOSITORIES = new Set([
  'src/main/modules/repositories/agent-session-checkpoint-closeout.ts',
  'src/main/modules/repositories/agent-session-checkpoint-resume.ts',
  'src/main/modules/repositories/agent-session-checkpoint-store.ts',
  'src/main/modules/repositories/agent-session-checkpoint-takeover.ts',
  'src/main/modules/repositories/agent-session-checkpoint-owner-recovery.ts',
  'src/main/modules/repositories/agent-session-checkpoint-typed-resume.ts',
])
const RUN_FINALIZER_PROJECTION_REL =
  'src/main/modules/agent-control/runtime-core/run-finalizer-projection.ts'
const DIRECT_ANSWER_HISTORY_MIGRATION_REL =
  'src/main/modules/agent-control/task-projection/direct-answer-history-migration.ts'
const DIRECT_ANSWER_HISTORY_MIGRATION_MARKER =
  'run-finalizer-exempt: migration-077 repairs persisted legacy false failures only'
const STARTUP_RUN_RECONCILER_REL = 'src/main/modules/app-control/startup-run-reconciler.ts'
const STARTUP_RECONCILER_EXEMPT_MARKER =
  'run-finalizer-exempt: startup-recovery-only active-owner->interrupted'
const CODEX_BINDING_SCHEMA_REL =
  'src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts'
const CODEX_STARTUP_OWNER_HANDOFF_MARKER =
  'run-finalizer-exempt: migration-101 restores only exact interrupted Codex owners'
const MIGRATIONS_REL = 'src/main/modules/migrations.ts'
const WORKFLOW_STATUS_MIGRATION_MARKER =
  'run-finalizer-exempt: migration-083 normalizes legacy working owners into the running workflow state'
const SCAN_DIRS = ['src/main/modules/']

function readConstArray(rel, name) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) {
    throw new Error(`${rel} missing; ${name} must be the shared terminal status source`)
  }
  const text = fs.readFileSync(file, 'utf8')
  const match = text.match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const`)
  )
  if (!match) {
    throw new Error(`${rel} missing export const ${name} = [...] as const`)
  }
  return [...match[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((m) => m[1])
}

const TERMINAL_RUN_META_STATUSES = readConstArray(
  RUN_META_TERMINAL_STATUS_REL,
  'RUN_META_TERMINAL_STATUSES'
)
const TERMINAL_STATUS_ALT = TERMINAL_RUN_META_STATUSES.join('|')

function listFiles(dirAbs) {
  const out = []
  const stack = [dirAbs]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        stack.push(p)
      } else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx'))) {
        out.push(p)
      }
    }
  }
  return out
}

function relposix(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

function isAllowedRunMetaWriter(rel, text) {
  return rel === RUN_FINALIZER_REL
    || rel === RUN_META_REPOSITORY_REL
    || rel === WORKFLOW_UNIT_OF_WORK_REPOSITORY_REL
    || WORKFLOW_UNIT_OF_WORK_LEAF_REPOSITORIES.has(rel)
    || (
      rel === DIRECT_ANSWER_HISTORY_MIGRATION_REL
      && text.includes(DIRECT_ANSWER_HISTORY_MIGRATION_MARKER)
    )
}

function sourceForRunMetaRules(rel, text) {
  let source = text
  if (rel === MIGRATIONS_REL && text.includes(WORKFLOW_STATUS_MIGRATION_MARKER)) {
    const normalized = /UPDATE\s+run_meta\s+SET\s+status\s*=\s*['"]running['"]\s+WHERE\s+status\s*=\s*['"]working['"]/i
    source = source.replace(normalized, (match) => match.replace(/[^\r\n]/g, ' '))
  }
  if (rel === CODEX_BINDING_SCHEMA_REL && text.includes(CODEX_STARTUP_OWNER_HANDOFF_MARKER)) {
    const exactOwnerRestore = /UPDATE\s+run_meta\s+SET\s+status\s*=\s*['"]running['"]\s*,\s*initiator\s*=\s*NULL\s*,\s*terminal_reason\s*=\s*NULL\s*,\s*duration_ms\s*=\s*NULL\s+WHERE\s+status\s*=\s*['"]interrupted['"]\s+AND\s+initiator\s*=\s*['"]process_exit['"]\s+AND\s+terminal_reason\s*=\s*['"]main_process_restarted['"][\s\S]*?AND\s+codex\.host_failure_product_terminal_digest\s+IS\s+NULL\s*\);/i
    source = source.replace(exactOwnerRestore, (match) => match.replace(/[^\r\n]/g, ' '))
  }
  if (rel === STARTUP_RUN_RECONCILER_REL && text.includes(STARTUP_RECONCILER_EXEMPT_MARKER)) {
    const startupRecoverySql = /UPDATE\s+run_meta\s+SET\s+status\s*=\s*['"]interrupted['"]\s*,\s*initiator\s*=\s*['"]process_exit['"]\s*,\s*terminal_reason\s*=\s*['"]main_process_restarted['"]\s*,\s*updated_at\s*=\s*\?\s*WHERE\s+status\s+IN\s*\(\s*['"]working['"]\s*,\s*['"]running['"]\s*\)/i
    source = source.replace(startupRecoverySql, (match) => match.replace(/[^\r\n]/g, ' '))
  }
  return source
}

function isAllowedProjectionPatchConstructor(rel) {
  return rel === RUN_FINALIZER_REL || rel === RUN_FINALIZER_PROJECTION_REL
}

function pushRegexViolations(violations, rel, text, rules) {
  for (const rule of rules) {
    const re = new RegExp(
      rule.re.source,
      rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`
    )
    let m
    while ((m = re.exec(text))) {
      violations.push({
        file: rel,
        line: lineOf(text, m.index),
        kind: rule.kind,
        detail: rule.detail
      })
    }
  }
}

function main() {
  const violations = []
  const files = []
  for (const dirRel of SCAN_DIRS) {
    const dir = path.join(ROOT, dirRel)
    if (!fs.existsSync(dir)) continue
    files.push(...listFiles(dir))
  }

  const runMetaRules = [
    {
      kind: 'run_meta_terminal_update',
      detail: 'terminal run_meta update must be routed through run-finalizer.ts',
      re: new RegExp(
        `\\brunMeta(?:Repository|Repo)?\\.update\\s*\\([^,]+,\\s*\\{[\\s\\S]{0,900}?\\bstatus\\s*:\\s*['"](?:${TERMINAL_STATUS_ALT})['"]`,
        'g'
      )
    },
    {
      kind: 'run_meta_terminal_create',
      detail: 'terminal run_meta create must be routed through run-finalizer.ts',
      re: new RegExp(
        `\\brunMeta(?:Repository|Repo)?\\.create\\s*\\(\\s*\\{[\\s\\S]{0,900}?\\bstatus\\s*:\\s*['"](?:${TERMINAL_STATUS_ALT})['"]`,
        'g'
      )
    },
    {
      kind: 'run_meta_terminal_sql',
      detail:
        'direct run_meta SQL with status writes must stay behind the repository/finalizer funnel',
      re: /\b(?:INSERT\s+INTO|UPDATE)\s+run_meta\b[\s\S]{0,700}\bstatus\b/gi
    }
  ]

  const projectionPatchRules = [
    {
      kind: 'terminal_projection_patch_constructor',
      detail: 'terminal projection patch constructors may only be defined in run-finalizer.ts',
      re: /\b(?:export\s+)?function\s+buildTerminalProjectionPatch\s*\(/g
    },
    {
      kind: 'terminal_projection_patch_constructor',
      detail: 'terminal projection patch constructors may only be defined in run-finalizer.ts',
      re: /\b(?:const|let|var)\s+buildTerminalProjectionPatch\s*=/g
    },
    {
      kind: 'terminal_projection_patch_literal',
      detail:
        'sibling takeover terminal projection patches must be constructed by run-finalizer.ts',
      re: /status\s*:\s*['"]killed['"][\s\S]{0,700}?(?:taskSummary|blockedReason)\s*:\s*['"]已被新消息接管['"]/g
    },
    {
      kind: 'terminal_projection_patch_literal',
      detail: 'superseded continuation terminal patches must be constructed by run-finalizer.ts',
      re: /blockerType\s*:\s*['"]superseded['"]/g
    }
  ]

  // Review batch-1 hardening: renamed-variable writes (`repository.update(...)`)
  // slip past the identifier-prefix rules above. Pin the funnel at the ACCESS
  // point instead: getRunMetaRepository may only be referenced by
  // run-finalizer.ts or by a file that carries the funnel-exempt marker AND
  // the no-downgrade guard the marker promises.
  const EXEMPT_MARKER = 'funnel-exempt: diagnostics-only (no terminal downgrade)'
  const NO_DOWNGRADE_GUARD = 'terminalStatuses.has(existingStatus)'
  const accessRule = /\bgetRunMetaRepository\b/g

  for (const file of files) {
    const rel = relposix(file)
    const text = fs.readFileSync(file, 'utf8')
    if (!isAllowedRunMetaWriter(rel, text)) {
      pushRegexViolations(violations, rel, sourceForRunMetaRules(rel, text), runMetaRules)
      if (accessRule.test(text)) {
        accessRule.lastIndex = 0
        const exemptSnapshot = text.includes(EXEMPT_MARKER) && text.includes(NO_DOWNGRADE_GUARD)
        // provider definition (the runtime method itself) and finalizer-deps
        // accessors (acquire only to hand into finalizeRunOutcome) are the
        // two structurally-compliant access shapes besides the snapshot.
        const providerDefinition = /getRunMetaRepository\s*\(\)\s*:\s*RunMetaRepository/.test(text)
        const finalizeAccessor = rel === AGENT_SDK_RUNTIME_REL
          && text.includes('getRunMetaRepositoryForFinalize: () => self.getRunMetaRepositoryForFinalize()')
          && /private\s+getRunMetaRepositoryForFinalize\(\):\s*RunMetaRepositoryLike\s*\|\s*null\s*\{[\s\S]*?wrapRunMetaRepositoryWithCloseoutSnapshot\(/.test(text)
          && (text.match(/runtime\?\.getRunMetaRepository\?\.\(\)/g) || []).length === 1
        const exempt = exemptSnapshot || providerDefinition || finalizeAccessor
        if (!exempt) {
          violations.push({
            file: rel,
            line: 1,
            kind: 'run_meta_repository_access',
            detail:
              'getRunMetaRepository may only be used by run-finalizer.ts or a funnel-exempt (no-downgrade) snapshot writer'
          })
        }
      }
    }
    if (!isAllowedProjectionPatchConstructor(rel)) {
      pushRegexViolations(violations, rel, text, projectionPatchRules)
    }
  }

  if (violations.length === 0) {
    console.log('check-run-finalize-funnel: ok')
    return
  }

  console.error('check-run-finalize-funnel: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
