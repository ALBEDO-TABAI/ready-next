#!/usr/bin/env node
/**
 * R-CTX (P2) gate — provider_request_bill instrumentation (red-first).
 *
 * The incident showed 22 compactions with beforeTokens 565–633K (≈3× the 200K
 * window), but the existing `context_bill` only records the prompt-assembly
 * segment (~31K), so the actual per-turn provider-request composition was
 * un-attributed. P2 adds `provider_request_bill` — a per-provider-call section
 * breakdown (vision / history / tool_results / skill_inline / reminders) — so
 * "is the same image re-sent every turn?" is answerable from the ledger. This
 * gate pins that the metric exists, carries the section fields, is emitted on
 * EVERY provider call (not only when compaction fires), and is NOT a rename of
 * context_bill. Behavior is unchanged (instrumentation only).
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const BUDGET_FILE = 'src/shared/context-budget-types.ts'
const PROVIDER_FILE = 'src/main/modules/agent-control/runtime-core/agent-sdk-provider-runner.ts'
const INSTRUMENTATION_FILE =
  'src/main/modules/agent-control/runtime-core/agent-sdk-provider-request-instrumentation.ts'
const SECTIONS = ['vision', 'history', 'tool_results', 'tool_schema', 'skill_inline', 'reminders']

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []

  const budget = read(BUDGET_FILE)
  if (!budget) {
    violations.push({ file: BUDGET_FILE, reason: 'missing file' })
  } else {
    if (!/export function billProviderRequestSections/.test(budget)) {
      violations.push({
        file: BUDGET_FILE,
        reason: 'must export billProviderRequestSections (pure section classifier)'
      })
    }
    // the ProviderRequestBill.sections must carry all named sections
    const sectionsBlock = budget.match(/sections:\s*\{([\s\S]*?)\}/)
    if (!sectionsBlock) {
      violations.push({
        file: BUDGET_FILE,
        reason: 'ProviderRequestBill must declare a sections object'
      })
    } else {
      for (const section of SECTIONS) {
        if (!new RegExp(`\\b${section}\\b`).test(sectionsBlock[1])) {
          violations.push({ file: BUDGET_FILE, reason: `sections must include '${section}'` })
        }
      }
    }
    // Image detection MUST match the REAL @openai/agents shape ({type:'input_image',
    // image:…} + computer_screenshot), not a fabricated url/image_url shape — else
    // real images silently mis-bill into history and the metric misleads.
    if (
      !/'input_image'[\s\S]{0,40}'image' in record/.test(budget) &&
      !/type === 'input_image'[\s\S]{0,60}image/.test(budget)
    ) {
      violations.push({
        file: BUDGET_FILE,
        reason:
          "image detection must match the real {type:'input_image', image:…} shape (key is `image`, not url)"
      })
    }
    if (!/'computer_screenshot'/.test(budget)) {
      violations.push({
        file: BUDGET_FILE,
        reason: 'image detection must cover computer_screenshot payloads'
      })
    }
  }

  const provider = read(PROVIDER_FILE)
  const instrumentation = read(INSTRUMENTATION_FILE)
  if (!provider) {
    violations.push({ file: PROVIDER_FILE, reason: 'missing file' })
  } else {
    if (
      !/recordProviderDiagnosticRequestBill\(\s*\{[\s\S]{0,300}?beforeInput:\s*modelData\.input[\s\S]{0,120}?instructions:\s*modelData\.instructions/.test(
        provider
      )
    ) {
      violations.push({
        file: PROVIDER_FILE,
        reason:
          'must record the diagnostic bill over modelData.instructions + modelData.input + params.tools'
      })
    }
    if (!/beforeInput:\s*modelData\.input[\s\S]{0,180}?tools:\s*params\.tools/.test(provider)) {
      violations.push({
        file: PROVIDER_FILE,
        reason: 'diagnostic bill must include the exact tool schemas supplied to the Agent'
      })
    }
    // The diagnostic bill must be emitted BEFORE compaction so a failed
    // compaction cannot erase the pre-compaction evidence.
    const billIdx = provider.indexOf('recordProviderDiagnosticRequestBill(')
    const compactIdx = provider.indexOf('compactAgentInputItems(modelData.input')
    if (billIdx === -1 || compactIdx === -1 || billIdx > compactIdx) {
      violations.push({
        file: PROVIDER_FILE,
        reason:
          'provider_request_bill must be emitted before compactAgentInputItems (every call, not only on compaction)'
      })
    }
    if (
      !/recordProviderWireRequestBill\(\s*\{[\s\S]{0,260}?diagnostic,[\s\S]{0,160}?wireInput,[\s\S]{0,120}?instructions:\s*modelData\.instructions/.test(
        provider
      )
    ) {
      violations.push({
        file: PROVIDER_FILE,
        reason:
          'must record the true wire bill after compaction and bind it to the diagnostic bill'
      })
    }
    if (!/wireInput,[\s\S]{0,180}?tools:\s*params\.tools/.test(provider)) {
      violations.push({
        file: PROVIDER_FILE,
        reason: 'wire bill must include the exact tool schemas supplied to the Agent'
      })
    }
  }

  if (!instrumentation) {
    violations.push({ file: INSTRUMENTATION_FILE, reason: 'missing file' })
  } else {
    if (!/billModelInput\(params\.beforeInput,\s*params\.instructions,\s*params\.tools\)/.test(instrumentation)) {
      violations.push({
        file: INSTRUMENTATION_FILE,
        reason: 'diagnostic bill must classify beforeInput'
      })
    }
    if (!/billModelInput\(params\.wireInput,\s*params\.instructions,\s*params\.tools\)/.test(instrumentation)) {
      violations.push({ file: INSTRUMENTATION_FILE, reason: 'wire bill must classify wireInput' })
    }
    for (const metric of ['provider_request_bill', 'provider_wire_request_bill']) {
      if (!new RegExp(`logAgentMetric\\(\\s*['"]${metric}['"]`).test(instrumentation)) {
        violations.push({ file: INSTRUMENTATION_FILE, reason: `must emit ${metric}` })
      }
    }
    if (/provider_request_bill[\s\S]{0,80}context_bill/.test(instrumentation)) {
      violations.push({
        file: INSTRUMENTATION_FILE,
        reason: 'provider_request_bill must be its own metric, not derived from context_bill'
      })
    }
  }

  if (violations.length === 0) {
    console.log('[check-provider-request-bill-sections] OK')
    process.exit(0)
  }
  console.error('[check-provider-request-bill-sections] FAIL:')
  for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`)
  process.exit(1)
}

main()
