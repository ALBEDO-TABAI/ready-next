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
const AGENT_SDK_TURN_ORCHESTRATOR_REL =
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts'
const AGENT_SDK_TURN_PREPARATION_REL =
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-preparation.ts'
const AGENT_SDK_TURN_INPUT_ASSEMBLY_REL =
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-input-assembly.ts'
const AGENT_SDK_TURN_EXECUTION_REL =
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-execution.ts'
const AGENT_SDK_TURN_CLOSEOUT_REL =
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-closeout.ts'
const AGENT_SDK_TURN_GUARDS_REL =
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-guards.ts'
const AGENT_SDK_TURN_COMPLETION_REL =
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-completion.ts'
const RUN_META_REPOSITORY_REL =
  'src/main/modules/agent-control/task-projection/run-meta-repository.ts'
const DIRECT_ANSWER_HISTORY_MIGRATION_REL =
  'src/main/modules/agent-control/task-projection/direct-answer-history-migration.ts'
const DIRECT_ANSWER_HISTORY_MIGRATION_MARKER =
  'run-finalizer-exempt: migration-077 repairs persisted legacy false failures only'
const STARTUP_RUN_RECONCILER_REL = 'src/main/modules/app-control/startup-run-reconciler.ts'
const STARTUP_RECONCILER_EXEMPT_MARKER =
  'run-finalizer-exempt: startup-recovery-only working->interrupted'
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
    || (
      rel === DIRECT_ANSWER_HISTORY_MIGRATION_REL
      && text.includes(DIRECT_ANSWER_HISTORY_MIGRATION_MARKER)
    )
}

function sourceForRunMetaRules(rel, text) {
  if (rel !== STARTUP_RUN_RECONCILER_REL || !text.includes(STARTUP_RECONCILER_EXEMPT_MARKER)) {
    return text
  }
  const startupRecoverySql = /UPDATE\s+run_meta\s+SET\s+status\s*=\s*['"]interrupted['"]\s*,\s*initiator\s*=\s*['"]process_exit['"]\s*,\s*terminal_reason\s*=\s*['"]main_process_restarted['"]\s*,\s*updated_at\s*=\s*\?\s*WHERE\s+status\s*=\s*['"]working['"]/i
  return text.replace(startupRecoverySql, (match) => match.replace(/[^\r\n]/g, ' '))
}

function isAllowedProjectionPatchConstructor(rel) {
  return rel === RUN_FINALIZER_REL
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

function sliceBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle)
  if (start < 0) return ''
  const end = text.indexOf(endNeedle, start + startNeedle.length)
  return end < 0 ? text.slice(start) : text.slice(start, end)
}

function pushAgentSdkC03Violations(violations, text) {
  const rel = AGENT_SDK_TURN_ORCHESTRATOR_REL
  if (!text.includes('const finalizeEarlyReturn = async')) {
    violations.push({
      file: rel,
      line: 1,
      kind: 'agent_sdk_c03_early_return',
      detail: 'P1b-1b-C03 early-return families must use finalizeEarlyReturn'
    })
  }
  if (!text.includes('return await handleAgentSdkTurnError({')) {
    violations.push({
      file: AGENT_SDK_TURN_ORCHESTRATOR_REL,
      line: 1,
      kind: 'agent_sdk_async_error_closeout',
      detail: 'error closeout must be awaited before lifecycle finally persists terminal state'
    })
  }

  const sections = [
    {
      name: 'config_pre_model',
      rel: AGENT_SDK_TURN_ORCHESTRATOR_REL,
      start: 'const configDetail = this.host.loadAIConfig()',
      end: 'const normalizedConfig = normalizeAIConfig',
      required: [
        "terminalReason: configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed'",
        "terminalReason: 'blocked_config'"
      ],
      forbidden: [
        /emitStatus\('error',\s*configDetail\.reason/,
        /emitStatus\('error',\s*'blocked_config'\)/
      ]
    },
    {
      name: 'child_resume_close',
      rel: AGENT_SDK_TURN_ORCHESTRATOR_REL,
      start: 'const resumeChildRunId = continuationChildRunId',
      end: 'const preparedTurn = prepareAgentSdkTurn',
      required: ['status: outcome.status', "continuationHandle: outcome.status === 'checkpoint'"],
      forbidden: [/emitStatus\(outcome\.status,\s*outcome\.terminalReason\)/]
    },
    {
      name: 'restored_tool_surface_missing',
      rel: AGENT_SDK_TURN_PREPARATION_REL,
      start: 'if (restoredToolSurface.missingToolNames.length > 0)',
      end: 'return {\n    terminalResult: null',
      required: ["terminalReason: 'blocked_tool_error'"],
      forbidden: [/emitStatus\('error',\s*'blocked_tool_error'\)/]
    },
    {
      name: 'current_message_capability_block',
      rel: AGENT_SDK_TURN_INPUT_ASSEMBLY_REL,
      start: 'assertCurrentMessageCapability(blocksForCheck',
      end: 'let nextInput = toSdkInput',
      required: ["terminalReason: 'blocked_config'"],
      forbidden: [/emitStatus\('error',\s*'blocked_config'\)/]
    },
    {
      name: 'budget_checkpoint_helper',
      rel: AGENT_SDK_TURN_EXECUTION_REL,
      start: 'const finishBudgetCheckpointIfNeeded = async',
      end: 'const { maybeHandleSkillClarificationGuard',
      required: [
        "terminalReason: 'checkpoint_budget'",
        'continuationHandle: checkpoint.runStatePath'
      ],
      forbidden: [/emitStatus\('checkpoint',\s*'checkpoint_budget'\)/]
    },
    {
      name: 'max_turn_saved_document_done',
      rel: AGENT_SDK_TURN_CLOSEOUT_REL,
      start:
        'const contentIssue = await inspectDocumentTargetContent(ctx.documentTargetGuardForRecovery',
      end: '&& !ctx.hasSuccessfulDocumentTargetMutation',
      required: ["status: 'done'", "terminalReason: 'done'", 'finalText: fallbackText'],
      forbidden: [/emitStatus\('done',\s*'done'\)/]
    },
    {
      name: 'skill_clarification_guard_checkpoint',
      rel: AGENT_SDK_TURN_GUARDS_REL,
      start: 'const maybeHandleSkillClarificationGuard = async',
      end: 'const maybeHandleActionAnnouncementGuard = async',
      funnel: 'finalizeRunOutcome(',
      required: ["terminalReason: 'checkpoint_steered'", 'finalText: state.finalText'],
      forbidden: []
    },
    {
      name: 'action_announcement_guard_checkpoint',
      rel: AGENT_SDK_TURN_GUARDS_REL,
      start: 'const maybeHandleActionAnnouncementGuard = async',
      end: 'return { maybeHandleSkillClarificationGuard',
      funnel: 'finalizeRunOutcome(',
      required: ["terminalReason: 'checkpoint_steered'", 'finalText: state.finalText'],
      forbidden: []
    },
    {
      name: 'prepared_turn_completion_done',
      rel: AGENT_SDK_TURN_COMPLETION_REL,
      start: 'const finalProjectionPatch = mergeProjectionPatches',
      end: 'const finalizedTerminalReason =',
      funnel: 'finalizeRunOutcome(',
      required: ["kind: 'done'", 'finalText'],
      forbidden: []
    }
  ]

  for (const section of sections) {
    const sectionAbs = path.join(ROOT, section.rel)
    const sectionText = fs.existsSync(sectionAbs) ? fs.readFileSync(sectionAbs, 'utf8') : ''
    const body = sliceBetween(sectionText, section.start, section.end)
    if (!body) {
      violations.push({
        file: section.rel,
        line: 1,
        kind: 'agent_sdk_c03_early_return',
        detail: `P1b-1b-C03 section not found: ${section.name}`
      })
      continue
    }
    const funnel = section.funnel || 'finalizeEarlyReturn('
    if (!body.includes(funnel)) {
      violations.push({
        file: section.rel,
        line: lineOf(sectionText, sectionText.indexOf(section.start)),
        kind: 'agent_sdk_c03_early_return',
        detail: `P1b-1b-C03 ${section.name} must call ${funnel}`
      })
    }
    const compactBody = body.replace(/\s+/g, ' ')
    for (const required of section.required) {
      if (!compactBody.includes(required.replace(/\s+/g, ' '))) {
        violations.push({
          file: section.rel,
          line: lineOf(sectionText, sectionText.indexOf(section.start)),
          kind: 'agent_sdk_c03_early_return',
          detail: `P1b-1b-C03 ${section.name} is missing required finalizer field: ${required}`
        })
      }
    }
    for (const forbidden of section.forbidden) {
      if (forbidden.test(body)) {
        violations.push({
          file: section.rel,
          line: lineOf(sectionText, sectionText.indexOf(section.start)),
          kind: 'agent_sdk_c03_early_return',
          detail: `P1b-1b-C03 ${section.name} still emits terminal status before returning`
        })
      }
    }
  }
}

function terminalReasonFromEmitStatusCall(callText) {
  const args = callText.slice(callText.indexOf('(') + 1, callText.lastIndexOf(')'))
  const firstArg = args
    .split(',')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
  if (TERMINAL_RUN_META_STATUSES.includes(firstArg)) return firstArg
  return null
}

function pushAgentSdkStructuralFinalizerViolations(violations, text) {
  const rel = AGENT_SDK_TURN_ORCHESTRATOR_REL
  const start = text.indexOf('async sendMessage(')
  const end = text.indexOf('\n  private async persistRunMetaSnapshot', start)
  const body = start >= 0 && end > start ? text.slice(start, end) : text
  const bodyLineOffset = start >= 0 ? lineOf(text, start) - 1 : 0
  const emitStatusRe = /\bemitStatus\s*\([^)]*\)/g
  let emitMatch
  while ((emitMatch = emitStatusRe.exec(body))) {
    const call = emitMatch[0]
    const terminalStatus = terminalReasonFromEmitStatusCall(call)
    const secondArgTerminal =
      /,\s*(?:['"](?:done|error|cancelled|checkpoint|blocked_[a-z_]+|checkpoint_[a-z_]+|persistence_failed|failed_skill|cancelled_[a-z_]+)['"]|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.test(
        call
      )
    if (!terminalStatus && !secondArgTerminal) continue
    const nextReturn = body.indexOf('return this.buildResult', emitMatch.index)
    if (nextReturn < 0) continue
    const nextFinalize = Math.min(
      ...[
        body.indexOf('finalizeEarlyReturn', emitMatch.index),
        body.indexOf('finalizeRunOutcome', emitMatch.index),
        body.indexOf('recordAdmissionRejection', emitMatch.index)
      ].filter((idx) => idx >= 0)
    )
    if (Number.isFinite(nextFinalize) && nextFinalize < nextReturn) continue
    violations.push({
      file: rel,
      line: bodyLineOffset + lineOf(body, emitMatch.index),
      kind: 'agent_sdk_structural_terminal_return',
      detail:
        'terminal emitStatus before return buildResult must route through finalizeEarlyReturn/finalizeRunOutcome'
    })
  }

  const returnRe = /return\s+this\.buildResult\s*\(\s*\{/g
  let returnMatch
  while ((returnMatch = returnRe.exec(body))) {
    const window = body.slice(returnMatch.index, Math.min(body.length, returnMatch.index + 900))
    if (!/\bterminalReason\s*:/.test(window)) continue
    const prefix = body.slice(Math.max(0, returnMatch.index - 5000), returnMatch.index)
    const allowed = /finalizeEarlyReturn|finalizeRunOutcome|recordAdmissionRejection/.test(prefix)
    const manualSuspend = /abortInitiator\s*===\s*['"]manual_suspend['"][\s\S]{0,900}$/.test(prefix)
    if (allowed || manualSuspend) continue
    violations.push({
      file: rel,
      line: bodyLineOffset + lineOf(body, returnMatch.index),
      kind: 'agent_sdk_structural_terminal_return',
      detail:
        'return buildResult with terminalReason must be preceded by finalizeEarlyReturn/finalizeRunOutcome or the admission finalizer'
    })
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
        const finalizeAccessor = text.includes('ForFinalize') && text.includes('finalizeRunOutcome')
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

  const turnOrchestratorPath = path.join(ROOT, AGENT_SDK_TURN_ORCHESTRATOR_REL)
  if (fs.existsSync(turnOrchestratorPath)) {
    const turnOrchestratorText = fs.readFileSync(turnOrchestratorPath, 'utf8')
    pushAgentSdkC03Violations(violations, turnOrchestratorText)
    pushAgentSdkStructuralFinalizerViolations(violations, turnOrchestratorText)
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
