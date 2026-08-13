#!/usr/bin/env node
/**
 * P6d/C32 shared status/errorKind drift gate.
 *
 * This gate keeps existing state machines distinct while preventing each one
 * from re-copying its vocabulary in local files.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

const RUN_META_STATUS_REL = 'src/shared/run-meta-terminal-status.ts'
const RUN_FINALIZE_GATE_REL = 'scripts/check-run-finalize-funnel.cjs'
const TASK_OPEN_STATUS_REL = 'src/main/modules/agent-control/contracts/task-open-status.ts'
const RUN_STATE_SCHEMA_REL = 'src/main/modules/agent-control/task-projection/run-state-schema.ts'
const DETACHED_TRACKER_REL = 'src/main/modules/agent-control/detached-skill-task-tracker.ts'
const ERROR_KINDS_REL = 'src/main/modules/agent-control/contracts/error-kinds.ts'
const TOOL_RESULT_ENVELOPE_REL = 'src/main/modules/tools/tool-result-envelope.ts'

const PROVIDER_ERROR_KIND_TARGETS = [
  'src/main/modules/claude-bridge/llm-resilience.ts',
  'src/main/modules/agent-control/domain-adapters/message-capability-filter.ts',
  'src/main/modules/agent-control/thinking-compatibility.ts',
  'src/main/modules/claude-bridge/error-contract.ts',
]

const PAUSED_PREDICATE_TARGETS = [
  'src/main/modules/agent-control/contracts/run-contracts.ts',
  'src/main/modules/agent-control/runtime-core/turn-frame-resolver.ts',
]

const DETACHED_ERROR_KIND_TARGETS = [
  'src/main/modules/tools/skills-tools.ts',
  'src/main/modules/agent-control/skills/skill-task-tracker.ts',
]

const SEND_IM_ERROR_KIND_TARGETS = [
  'src/main/modules/tools/send-im-skill-tool.ts',
]

const TARGET_DOCUMENT_ERROR_KIND_TARGETS = [
  'src/main/modules/agent-control/runtime-core/agent-sdk-document-utils.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts',
]

const BROWSER_TOOL_ERROR_KIND_TARGETS = [
  'src/main/modules/tools/browser-failure-output.ts',
  'src/main/modules/tools/tool-executor.ts',
]

const TOOL_ADMISSION_ERROR_KIND_TARGETS = [
  'src/main/modules/tools/tool-executor.ts',
  // B7 拆分后 tool-runtime.ts 是门面、admission 语义随拆分移出（2026-07-05
  // 重锚）；tools-runtime 内的真消费者是 tool-registry.ts（下一行）。
  'src/main/modules/agent-control/tools-runtime/tool-registry.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-model-loop.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-provider-utils.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-runtime-outcome-utils.ts',
  'src/main/modules/tools/tool-result-envelope.ts',
]

const MCP_TOOL_ERROR_KIND_TARGETS = [
  'src/main/modules/tools/mcp-tools.ts',
  'src/main/modules/tools/tool-result-envelope.ts',
]

const ACTION_CONFIRMATION_ERROR_KIND_TARGETS = [
  'src/main/modules/tools/tool-executor.ts',
  'src/main/modules/tools/tool-result-envelope.ts',
]

const WEB_RESEARCH_ERROR_KIND_TARGETS = [
  'src/main/modules/tools/builtins/web-search.ts',
  'src/main/modules/tools/builtins/web-fetch.ts',
  'src/main/modules/tools/tool-result-envelope.ts',
]

const REQUIRED_DETACHED_ERROR_KINDS = [
  'detached_task_failed',
  'detached_task_not_found',
  'detached_task_forbidden',
  'detached_task_runtime_unavailable',
  'detached_task_skill_action_unknown',
  'detached_task_skill_not_loaded',
  'detached_task_hint_required',
  'detached_task_visibility_internal',
  'detached_task_start_failed',
]

const REQUIRED_SEND_IM_ERROR_KINDS = [
  'blocked_external',
  'send_failed',
  'sidecar_unavailable',
  'channel_not_ready',
  'directory_not_supported',
  'file_not_found',
  'file_ambiguous',
  'intent_negated',
]

const REQUIRED_TARGET_DOCUMENT_ERROR_KINDS = [
  'target_document_preserved_content_missing',
  'target_document_open_unavailable',
  'target_document_open_failed',
  'target_document_save_unavailable',
  'target_document_save_failed',
  'target_document_required',
]

const REQUIRED_BROWSER_TOOL_ERROR_KINDS = [
  'browser_tool_failed',
]

const REQUIRED_TOOL_ADMISSION_ERROR_KINDS = [
  'tool_not_registered',
  'authorization_denied',
  'internal_tool_not_allowed',
  'tool_restricted_this_turn',
  'denied_by_user_negation',
]

const REQUIRED_PROVIDER_ERROR_KINDS = [
  'provider_request_failed',
  'provider_thinking_echo_required',
]

const REQUIRED_MCP_TOOL_ERROR_KINDS = [
  'mcp_tool_unregistered',
  'mcp_authorization_denied',
  'mcp_client_missing',
  'mcp_tool_failed',
]

const REQUIRED_ACTION_CONFIRMATION_ERROR_KINDS = [
  'denied_manual_only',
  'denied_pending_confirmation',
  'confirmation_denied_by_user',
  'confirmation_expired',
]

const REQUIRED_SPECIALIST_BLUEPRINT_ERROR_KINDS = [
  'verbatim_source_unavailable',
  'verbatim_mismatch',
  'confirmed_blueprint_immutable',
]

const REQUIRED_WEB_RESEARCH_ERROR_KINDS = [
  'web_search_failed',
  'web_fetch_failed',
]

const REQUIRED_DYNAMIC_DELIVERY_ERROR_KINDS = [
  'delivery_preflight_unknown',
  'delivery_plan_invalid',
  'delivery_profile_unavailable',
  'delivery_parent_projection_unavailable',
  'delivery_packet_tree_transaction_failed',
  'delivery_scheduler_capacity_exceeded',
  'delivery_worker_failed',
  'delivery_worker_report_invalid',
  'delivery_evidence_invalid',
  'delivery_required_package_unsettled',
  'delivery_budget_exhausted',
  'delivery_wall_clock_exceeded',
  'delivery_verifier_unavailable',
  'delivery_repair_exhausted',
  'delivery_restart_checkpointed',
]

function abs(rel) {
  return path.join(ROOT, rel)
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8')
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function readConstArray(rel, name) {
  const text = read(rel)
  const match = text.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const`))
  if (!match) {
    throw new Error(`${rel} missing export const ${name} = [...] as const`)
  }
  const values = [...match[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((m) => m[1])
  if (values.length === 0) {
    throw new Error(`${rel} ${name} has no values`)
  }
  return values
}

function push(violations, file, line, kind, detail) {
  violations.push({ file, line, kind, detail })
}

function assertRunMetaSharedSource(violations) {
  const statuses = readConstArray(RUN_META_STATUS_REL, 'RUN_META_TERMINAL_STATUSES')
  const duplicates = statuses.filter((status, index) => statuses.indexOf(status) !== index)
  if (duplicates.length > 0) {
    push(violations, RUN_META_STATUS_REL, 1, 'run_meta_duplicate_status', `duplicate statuses: ${duplicates.join(', ')}`)
  }

  const gate = read(RUN_FINALIZE_GATE_REL)
  if (!gate.includes(RUN_META_STATUS_REL) || !gate.includes('RUN_META_TERMINAL_STATUSES')) {
    push(
      violations,
      RUN_FINALIZE_GATE_REL,
      1,
      'run_finalize_gate_not_shared',
      'check-run-finalize-funnel must read RUN_META_TERMINAL_STATUSES from the shared source',
    )
  }
  const localArray = gate.match(/const\s+TERMINAL_RUN_META_STATUSES\s*=\s*\[/)
  if (localArray) {
    push(
      violations,
      RUN_FINALIZE_GATE_REL,
      lineOf(gate, localArray.index),
      'run_finalize_gate_local_array',
      'terminal run_meta statuses must not be copied into the gate',
    )
  }
}

function assertPausedPredicatesShared(violations) {
  const taskOpen = read(TASK_OPEN_STATUS_REL)
  if (!/export\s+function\s+isPausedTaskStatus\s*\(/.test(taskOpen)) {
    push(violations, TASK_OPEN_STATUS_REL, 1, 'paused_guard_missing', 'isPausedTaskStatus must be exported')
  }
  if (!/export\s+function\s+isDirectlyResumableTaskStatus\s*\(/.test(taskOpen)) {
    push(
      violations,
      TASK_OPEN_STATUS_REL,
      1,
      'direct_resume_guard_missing',
      'isDirectlyResumableTaskStatus must be exported so blocked is not treated as directly resumable',
    )
  }

  const inlinePaused = /===\s*['"]recoverable_paused['"]\s*\|\|\s*[^;\n]+===\s*['"]budget_paused['"]|===\s*['"]budget_paused['"]\s*\|\|\s*[^;\n]+===\s*['"]recoverable_paused['"]/g
  for (const rel of PAUSED_PREDICATE_TARGETS) {
    const text = stripComments(read(rel))
    let match
    while ((match = inlinePaused.exec(text))) {
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'inline_paused_predicate',
        'use isDirectlyResumableTaskStatus/isPausedTaskStatus instead of duplicating paused status checks',
      )
    }
  }
}

function assertDetachedStatusShared(violations) {
  const schema = read(RUN_STATE_SCHEMA_REL)
  if (!/export\s+const\s+NORMALIZED_RUN_STATE_STATUSES\s*=/.test(schema)) {
    push(violations, RUN_STATE_SCHEMA_REL, 1, 'normalized_status_const_missing', 'NORMALIZED_RUN_STATE_STATUSES must be exported')
  }
  if (!/export\s+function\s+isNormalizedRunStateStatus\s*\(/.test(schema)) {
    push(violations, RUN_STATE_SCHEMA_REL, 1, 'normalized_status_guard_missing', 'isNormalizedRunStateStatus must be exported')
  }

  const detached = stripComments(read(DETACHED_TRACKER_REL))
  const copiedUnion = detached.match(/export\s+type\s+DetachedSkillTaskStatus\s*=\s*['"][^=\n]+/)
  if (copiedUnion) {
    push(
      violations,
      DETACHED_TRACKER_REL,
      lineOf(detached, copiedUnion.index),
      'detached_status_copied_union',
      'DetachedSkillTaskStatus must alias NormalizedRunStateStatus instead of copying the union',
    )
  }
  if (!/type\s+DetachedSkillTaskStatus\s*=\s*NormalizedRunStateStatus\b/.test(detached)) {
    push(
      violations,
      DETACHED_TRACKER_REL,
      1,
      'detached_status_not_alias',
      'DetachedSkillTaskStatus must alias NormalizedRunStateStatus',
    )
  }
}

function registeredErrorKinds() {
  const registry = read(ERROR_KINDS_REL)
  return new Set([...registry.matchAll(/code:\s*['"]([a-z][a-z0-9_]+)['"]/g)].map((m) => m[1]))
}

function errorKindMemberCodeMap() {
  const registry = read(ERROR_KINDS_REL)
  const out = new Map()
  const familyRe = /export\s+const\s+(\w+_ERROR_KINDS)\s*=\s*\{([\s\S]*?)\n\}\s+as\s+const/g
  let familyMatch
  while ((familyMatch = familyRe.exec(registry))) {
    const familyName = familyMatch[1]
    const familyBody = familyMatch[2]
    const memberRe = /\n\s*(\w+):\s*\{[\s\S]*?code:\s*['"]([a-z][a-z0-9_]+)['"]/g
    let memberMatch
    while ((memberMatch = memberRe.exec(familyBody))) {
      out.set(`${familyName}.${memberMatch[1]}.code`, memberMatch[2])
    }
  }
  return out
}

function readConstObjectBlock(rel, name) {
  const text = read(rel)
  const declaration = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(text)
  if (!declaration) return null
  const open = text.indexOf('{', declaration.index)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, index)
    }
  }
  return null
}

function explicitEnvelopeMappedKinds() {
  const block = stripComments(readConstObjectBlock(TOOL_RESULT_ENVELOPE_REL, 'EXPLICIT_KIND_MAP') || '')
  const members = errorKindMemberCodeMap()
  const out = new Set()
  let match
  const literalKey = /(?:^|[\n,])\s*([a-z][a-z0-9_]+)\s*:/g
  while ((match = literalKey.exec(block))) {
    out.add(match[1])
  }
  const computedKey = /\[\s*([A-Z_]+_ERROR_KINDS\.\w+\.code)\s*\]\s*:/g
  while ((match = computedKey.exec(block))) {
    const code = members.get(match[1])
    if (code) out.add(code)
  }
  return out
}

function readExportedObjectBlock(rel, name) {
  const text = read(rel)
  const declaration = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{`).exec(text)
  if (!declaration) return null
  const afterDeclaration = text.slice(declaration.index)
  const end = /\n}\s*(?=as\s+const|\nexport\s+|$)/.exec(afterDeclaration)
  if (!end) return null
  return afterDeclaration.slice(0, end.index + 2)
}

function assertRequiredErrorKindFamily(violations, familyName, codes) {
  const block = readExportedObjectBlock(ERROR_KINDS_REL, familyName)
  if (!block) {
    push(violations, ERROR_KINDS_REL, 1, 'error_kind_family_missing', `${familyName} must be exported from error-kinds.ts`)
    return
  }
  const familyCodes = new Set([...block.matchAll(/code:\s*['"]([a-z][a-z0-9_]+)['"]/g)].map((m) => m[1]))
  for (const code of codes) {
    if (!familyCodes.has(code)) {
      push(
        violations,
        ERROR_KINDS_REL,
        1,
        'error_kind_family_missing_code',
        `${familyName} must own required errorKind ${code}`,
      )
    }
  }
}

function assertRequiredErrorKindsRegistered(violations) {
  const registered = registeredErrorKinds()
  for (const code of [
    ...REQUIRED_PROVIDER_ERROR_KINDS,
    ...REQUIRED_DETACHED_ERROR_KINDS,
    ...REQUIRED_SEND_IM_ERROR_KINDS,
    ...REQUIRED_TARGET_DOCUMENT_ERROR_KINDS,
    ...REQUIRED_BROWSER_TOOL_ERROR_KINDS,
    ...REQUIRED_TOOL_ADMISSION_ERROR_KINDS,
    ...REQUIRED_MCP_TOOL_ERROR_KINDS,
    ...REQUIRED_ACTION_CONFIRMATION_ERROR_KINDS,
    ...REQUIRED_SPECIALIST_BLUEPRINT_ERROR_KINDS,
    ...REQUIRED_WEB_RESEARCH_ERROR_KINDS,
    ...REQUIRED_DYNAMIC_DELIVERY_ERROR_KINDS,
  ]) {
    if (!registered.has(code)) {
      push(violations, ERROR_KINDS_REL, 1, 'required_error_kind_unregistered', `${code} must be registered in error-kinds.ts`)
    }
  }
  assertRequiredErrorKindFamily(
    violations,
    'PROVIDER_ERROR_KINDS',
    REQUIRED_PROVIDER_ERROR_KINDS,
  )
  assertRequiredErrorKindFamily(
    violations,
    'MCP_TOOL_ERROR_KINDS',
    REQUIRED_MCP_TOOL_ERROR_KINDS,
  )
  assertRequiredErrorKindFamily(
    violations,
    'ACTION_CONFIRMATION_ERROR_KINDS',
    REQUIRED_ACTION_CONFIRMATION_ERROR_KINDS,
  )
  assertRequiredErrorKindFamily(
    violations,
    'SPECIALIST_BLUEPRINT_ERROR_KINDS',
    REQUIRED_SPECIALIST_BLUEPRINT_ERROR_KINDS,
  )
  assertRequiredErrorKindFamily(
    violations,
    'WEB_RESEARCH_ERROR_KINDS',
    REQUIRED_WEB_RESEARCH_ERROR_KINDS,
  )
  assertRequiredErrorKindFamily(
    violations,
    'DYNAMIC_DELIVERY_ERROR_KINDS',
    REQUIRED_DYNAMIC_DELIVERY_ERROR_KINDS,
  )
}

function assertSharedEnumImport(violations, rel, text, constantName) {
  const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
  const registryAbs = abs(ERROR_KINDS_REL)
  const hasNamedImport = [...text.matchAll(importPattern)].some((match) => {
    const importSource = String(match[2])
    if (!importSource.startsWith('.')) return false
    const resolved = path.resolve(path.dirname(abs(rel)), importSource)
    const candidates = [
      resolved,
      `${resolved}.ts`,
      `${resolved}.tsx`,
      path.join(resolved, 'index.ts'),
    ].map((candidate) => path.normalize(candidate))
    return candidates.includes(path.normalize(registryAbs)) && new RegExp(`\\b${constantName}\\b`).test(match[1])
  })
  if (!hasNamedImport) {
    push(
      violations,
      rel,
      1,
      'error_kind_registry_not_imported',
      `${rel} must import ${constantName} from the error-kinds registry`,
    )
  }
}

function assertNoLocalErrorKindLiterals(violations, rels, codes, constantName) {
  const escapedCodes = codes
    .map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const literal = new RegExp(
    `\\b(?:errorKind|failureKind|terminalFailureErrorKind)\\b\\s*(?::|=)\\s*['"](${escapedCodes})['"]`,
    'g',
  )
  for (const rel of rels) {
    const text = stripComments(read(rel))
    if (!text.includes(constantName)) {
      push(violations, rel, 1, 'error_kind_registry_not_imported', `${rel} must consume ${constantName}`)
    }
    assertSharedEnumImport(violations, rel, text, constantName)
    let match
    while ((match = literal.exec(text))) {
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'local_error_kind_literal',
        `${match[1]} must be consumed from ${constantName}, not copied locally`,
      )
    }
  }
}

function assertNoBareLocalLiterals(violations, rels, codes, constantName) {
  const escapedCodes = codes
    .map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const literal = new RegExp(`['"](${escapedCodes})['"]`, 'g')
  const bareObjectKey = new RegExp(`(^|[{,]\\s*)(${escapedCodes})\\s*:`, 'gm')
  for (const rel of rels) {
    const text = stripComments(read(rel))
    if (!text.includes(constantName)) {
      push(violations, rel, 1, 'error_kind_registry_not_imported', `${rel} must consume ${constantName}`)
    }
    assertSharedEnumImport(violations, rel, text, constantName)
    let match
    while ((match = literal.exec(text))) {
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'local_error_kind_literal',
        `${match[1]} must be consumed from ${constantName}, not copied locally`,
      )
    }
    while ((match = bareObjectKey.exec(text))) {
      push(
        violations,
        rel,
        lineOf(text, match.index),
        'local_error_kind_literal',
        `${match[2]} must be consumed from ${constantName}, not copied as an object key`,
      )
    }
  }
}

function assertExplicitEnvelopeMappings(violations, familyName, mappings) {
  const rel = TOOL_RESULT_ENVELOPE_REL
  const text = stripComments(read(rel))
  for (const [member, expectedKind] of mappings) {
    const pattern = new RegExp(
      `\\[\\s*${familyName}\\.${member}\\.code\\s*\\]\\s*:\\s*['"]${expectedKind}['"]`,
    )
    if (!pattern.test(text)) {
      push(
        violations,
        rel,
        1,
        'error_kind_envelope_mapping_missing',
        `${familyName}.${member}.code must be explicitly mapped to ${expectedKind}`,
      )
    }
  }
}

function assertRegisteredErrorKindsEnvelopeMapped(violations) {
  const mapped = explicitEnvelopeMappedKinds()
  for (const code of registeredErrorKinds()) {
    if (!mapped.has(code)) {
      push(
        violations,
        TOOL_RESULT_ENVELOPE_REL,
        1,
        'error_kind_envelope_mapping_missing',
        `${code} is registered in error-kinds.ts but missing from EXPLICIT_KIND_MAP`,
      )
    }
  }
}

function main() {
  const violations = []
  try {
    assertRunMetaSharedSource(violations)
    assertPausedPredicatesShared(violations)
    assertDetachedStatusShared(violations)
    assertRequiredErrorKindsRegistered(violations)
    assertNoBareLocalLiterals(
      violations,
      PROVIDER_ERROR_KIND_TARGETS,
      REQUIRED_PROVIDER_ERROR_KINDS,
      'PROVIDER_ERROR_KINDS',
    )
    assertNoLocalErrorKindLiterals(
      violations,
      DETACHED_ERROR_KIND_TARGETS,
      REQUIRED_DETACHED_ERROR_KINDS,
      'DETACHED_TASK_ERROR_KINDS',
    )
    assertNoLocalErrorKindLiterals(
      violations,
      SEND_IM_ERROR_KIND_TARGETS,
      REQUIRED_SEND_IM_ERROR_KINDS,
      'SEND_IM_ERROR_KINDS',
    )
    assertNoLocalErrorKindLiterals(
      violations,
      TARGET_DOCUMENT_ERROR_KIND_TARGETS,
      REQUIRED_TARGET_DOCUMENT_ERROR_KINDS,
      'TARGET_DOCUMENT_ERROR_KINDS',
    )
    assertNoBareLocalLiterals(
      violations,
      BROWSER_TOOL_ERROR_KIND_TARGETS,
      REQUIRED_BROWSER_TOOL_ERROR_KINDS,
      'BROWSER_TOOL_ERROR_KINDS',
    )
    assertNoBareLocalLiterals(
      violations,
      TOOL_ADMISSION_ERROR_KIND_TARGETS,
      REQUIRED_TOOL_ADMISSION_ERROR_KINDS,
      'TOOL_ADMISSION_ERROR_KINDS',
    )
    assertNoBareLocalLiterals(
      violations,
      MCP_TOOL_ERROR_KIND_TARGETS,
      REQUIRED_MCP_TOOL_ERROR_KINDS,
      'MCP_TOOL_ERROR_KINDS',
    )
    assertNoBareLocalLiterals(
      violations,
      ACTION_CONFIRMATION_ERROR_KIND_TARGETS,
      REQUIRED_ACTION_CONFIRMATION_ERROR_KINDS,
      'ACTION_CONFIRMATION_ERROR_KINDS',
    )
    assertNoBareLocalLiterals(
      violations,
      WEB_RESEARCH_ERROR_KIND_TARGETS,
      REQUIRED_WEB_RESEARCH_ERROR_KINDS,
      'WEB_RESEARCH_ERROR_KINDS',
    )
    assertExplicitEnvelopeMappings(violations, 'WEB_RESEARCH_ERROR_KINDS', [
      ['webSearchFailed', 'upstream_error'],
      ['webFetchFailed', 'upstream_error'],
    ])
    assertExplicitEnvelopeMappings(violations, 'MCP_TOOL_ERROR_KINDS', [
      ['toolUnregistered', 'not_found'],
      ['authorizationDenied', 'denied_by_policy'],
      ['clientMissing', 'upstream_error'],
      ['toolFailed', 'upstream_error'],
    ])
    assertRegisteredErrorKindsEnvelopeMapped(violations)
  } catch (error) {
    console.error(`check-shared-enum-drift: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  if (violations.length === 0) {
    console.log('check-shared-enum-drift: ok')
    return
  }

  console.error('check-shared-enum-drift: violations:')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} [${violation.kind}] ${violation.detail}`)
  }
  process.exit(1)
}

main()
