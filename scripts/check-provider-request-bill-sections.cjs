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
const PROVIDER_FILE = 'src/main/modules/agent-control/runtime-core/agent-sdk-provider.ts'
const SECTIONS = ['vision', 'history', 'tool_results', 'skill_inline', 'reminders']

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
      violations.push({ file: BUDGET_FILE, reason: 'must export billProviderRequestSections (pure section classifier)' })
    }
    // the ProviderRequestBill.sections must carry all named sections
    const sectionsBlock = budget.match(/sections:\s*\{([\s\S]*?)\}/)
    if (!sectionsBlock) {
      violations.push({ file: BUDGET_FILE, reason: 'ProviderRequestBill must declare a sections object' })
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
    if (!/'input_image'[\s\S]{0,40}'image' in record/.test(budget) && !/type === 'input_image'[\s\S]{0,60}image/.test(budget)) {
      violations.push({ file: BUDGET_FILE, reason: "image detection must match the real {type:'input_image', image:…} shape (key is `image`, not url)" })
    }
    if (!/'computer_screenshot'/.test(budget)) {
      violations.push({ file: BUDGET_FILE, reason: 'image detection must cover computer_screenshot payloads' })
    }
  }

  const provider = read(PROVIDER_FILE)
  if (!provider) {
    violations.push({ file: PROVIDER_FILE, reason: 'missing file' })
  } else {
    if (!/logAgentMetric\(\s*['"]provider_request_bill['"]/.test(provider)) {
      violations.push({ file: PROVIDER_FILE, reason: "must emit logAgentMetric('provider_request_bill', ...)" })
    }
    if (!/billProviderRequestSections\(modelData\.input\)/.test(provider)) {
      violations.push({ file: PROVIDER_FILE, reason: 'bill must be computed over modelData.input (the actual request items)' })
    }
    // Must be emitted BEFORE the compaction call so it fires on EVERY provider
    // call, not only when compaction happens (the un-compacted turns still bloat).
    const billIdx = provider.indexOf("logAgentMetric('provider_request_bill'")
    const compactIdx = provider.indexOf('compactAgentInputItems(modelData.input')
    if (billIdx === -1 || compactIdx === -1 || billIdx > compactIdx) {
      violations.push({ file: PROVIDER_FILE, reason: 'provider_request_bill must be emitted before compactAgentInputItems (every call, not only on compaction)' })
    }
    // Must NOT be a rename of context_bill.
    if (/provider_request_bill[\s\S]{0,80}context_bill/.test(provider)) {
      violations.push({ file: PROVIDER_FILE, reason: 'provider_request_bill must be its own metric, not derived from context_bill' })
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
