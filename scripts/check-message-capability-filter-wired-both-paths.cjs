#!/usr/bin/env node
/**
 * Stage U (PR 2) — both the SDK runtime AND the legacy DirectChatEngine
 * clients MUST wire `message-capability-filter` for the historical-image
 * carryover fix to be complete. If a future refactor accidentally drops
 * the call on either side, the bug returns:
 *   - SDK path (modelInputToOpenAIChatMessages /
 *     modelInputToOpenAIResponsesInput / modelInputToAnthropicMessages)
 *     must funnel through `sanitizeMessagesForModelClient`
 *     (or directly `applyCapabilityFilterForRoute` /
 *     `sanitizeHistoricalMessagesByCapability`).
 *   - Legacy openai-execution-client: every `this.serializeMessages(` and
 *     `this.serializeMessagesForResponses(` call must be wrapped with
 *     `this.applyCapability(...)`.
 *   - Legacy anthropic-execution-client: every `this.deps.serializeMessages(`
 *     call must be wrapped with `this.applyCapability(...)`.
 *   - direct-chat.ts entry: the current-turn multimodal block array must be
 *     checked via `assertCurrentMessageCapability(...)` before pushing.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const HELPER_FILE = 'src/main/modules/agent-control/domain-adapters/message-capability-filter.ts'
const SDK_FILE = 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts'
const OPENAI_CLIENT_FILE = 'src/main/modules/claude-bridge/openai-execution-client.ts'
const ANTHROPIC_CLIENT_FILE = 'src/main/modules/claude-bridge/anthropic-execution-client.ts'
const DIRECT_CHAT_FILE = 'src/main/modules/claude-bridge/direct-chat.ts'

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

function countMatches(src, regex) {
  let count = 0
  let m
  // Reset lastIndex by re-creating regex with g flag if needed.
  const re = regex.global ? regex : new RegExp(regex.source, 'g')
  while ((m = re.exec(src)) !== null) {
    count += 1
    if (m.index === re.lastIndex) re.lastIndex += 1
  }
  return count
}

function main() {
  const violations = []

  if (!read(HELPER_FILE)) {
    console.error(`MISSING HELPER: ${HELPER_FILE}`)
    process.exit(1)
  }

  // --- SDK runtime ---
  const sdkSrcRaw = read(SDK_FILE)
  if (!sdkSrcRaw) {
    violations.push({ file: SDK_FILE, reason: 'missing file' })
  } else {
    const sdkSrc = stripComments(sdkSrcRaw)
    if (!/from\s+['"]\.\/message-capability-filter['"]/.test(sdkSrc)) {
      violations.push({
        file: SDK_FILE,
        reason: 'must import from ./message-capability-filter',
      })
    }
    if (!/assertCurrentMessageCapability\s*\(/.test(sdkSrc)) {
      violations.push({
        file: SDK_FILE,
        reason: 'must call assertCurrentMessageCapability(...) at SDK entry (first segment)',
      })
    }
    // Each of the 3 builder sites must pass its message array through the
    // sanitize wrapper. We assert by name presence; tests cover the actual
    // behavior. The wrapper name `sanitizeMessagesForModelClient` is local
    // to agent-sdk-runtime.ts.
    const sanitizeCalls = countMatches(sdkSrc, /sanitizeMessagesForModelClient\s*\(/g)
    if (sanitizeCalls < 3) {
      violations.push({
        file: SDK_FILE,
        reason: `sanitizeMessagesForModelClient must be invoked at all 3 model build sites (chat/responses/anthropic); found ${sanitizeCalls}`,
      })
    }
  }

  // --- Legacy openai-execution-client ---
  const oaiSrcRaw = read(OPENAI_CLIENT_FILE)
  if (!oaiSrcRaw) {
    violations.push({ file: OPENAI_CLIENT_FILE, reason: 'missing file' })
  } else {
    const oaiSrc = stripComments(oaiSrcRaw)
    if (!/from\s+['"]\.\.\/agent-control\/message-capability-filter['"]/.test(oaiSrc)) {
      violations.push({
        file: OPENAI_CLIENT_FILE,
        reason: 'must import from ../agent-control/message-capability-filter',
      })
    }
    if (!/private\s+applyCapability\s*\(/.test(oaiSrc)) {
      violations.push({
        file: OPENAI_CLIENT_FILE,
        reason: 'must declare private applyCapability(...) helper',
      })
    }
    // Bare `this.serializeMessages(` / `this.serializeMessagesForResponses(`
    // calls must always appear as `this.applyCapability(this.serialize…(…), …)`.
    // We assert: count of `this.applyCapability(this.serializeMessages` +
    // `this.applyCapability(this.serializeMessagesForResponses` ≥ count of
    // `this.serializeMessages(` / `this.serializeMessagesForResponses(`
    // OUTSIDE the method definition lines.
    const allSerializeCalls = countMatches(oaiSrc, /this\.serializeMessages(?:ForResponses)?\s*\(/g)
    const wrappedCalls = countMatches(oaiSrc, /this\.applyCapability\s*\(\s*this\.serializeMessages(?:ForResponses)?\s*\(/g)
    // The method body `private serializeMessages(...)` itself does NOT
    // start with `this.serializeMessages(`, so it doesn't count.
    if (allSerializeCalls > wrappedCalls) {
      violations.push({
        file: OPENAI_CLIENT_FILE,
        reason: `${allSerializeCalls} this.serializeMessages*(...) calls but only ${wrappedCalls} wrapped with this.applyCapability(...). Every call site must wrap.`,
      })
    }
  }

  // --- Legacy anthropic-execution-client ---
  const anthSrcRaw = read(ANTHROPIC_CLIENT_FILE)
  if (!anthSrcRaw) {
    violations.push({ file: ANTHROPIC_CLIENT_FILE, reason: 'missing file' })
  } else {
    const anthSrc = stripComments(anthSrcRaw)
    if (!/from\s+['"]\.\.\/agent-control\/message-capability-filter['"]/.test(anthSrc)) {
      violations.push({
        file: ANTHROPIC_CLIENT_FILE,
        reason: 'must import from ../agent-control/message-capability-filter',
      })
    }
    if (!/private\s+applyCapability\s*\(/.test(anthSrc)) {
      violations.push({
        file: ANTHROPIC_CLIENT_FILE,
        reason: 'must declare private applyCapability(...) helper',
      })
    }
    const allSerializeCalls = countMatches(anthSrc, /this\.deps\.serializeMessages\s*\(/g)
    const wrappedCalls = countMatches(anthSrc, /this\.applyCapability\s*\(\s*this\.deps\.serializeMessages\s*\(/g)
    if (allSerializeCalls > wrappedCalls) {
      violations.push({
        file: ANTHROPIC_CLIENT_FILE,
        reason: `${allSerializeCalls} this.deps.serializeMessages(...) calls but only ${wrappedCalls} wrapped with this.applyCapability(...). Every call site must wrap.`,
      })
    }
  }

  // --- direct-chat current-turn intake ---
  const dcSrcRaw = read(DIRECT_CHAT_FILE)
  if (!dcSrcRaw) {
    violations.push({ file: DIRECT_CHAT_FILE, reason: 'missing file' })
  } else {
    const dcSrc = stripComments(dcSrcRaw)
    if (!/from\s+['"]\.\.\/agent-control\/message-capability-filter['"]/.test(dcSrc)) {
      violations.push({
        file: DIRECT_CHAT_FILE,
        reason: 'must import from ../agent-control/message-capability-filter',
      })
    }
    if (!/assertCurrentMessageCapability\s*\(/.test(dcSrc)) {
      violations.push({
        file: DIRECT_CHAT_FILE,
        reason: 'must call assertCurrentMessageCapability(...) on the current-turn multimodal block array',
      })
    }
  }

  if (violations.length > 0) {
    console.error('check-message-capability-filter-wired-both-paths: VIOLATIONS\n')
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.reason}`)
    }
    console.error('\nBoth SDK and legacy DirectChatEngine paths must wire the capability filter — partial coverage leaves the original bug (image residue contaminating vision-off model requests) intact on one path.')
    process.exit(1)
  }
  console.log('check-message-capability-filter-wired-both-paths: OK')
}

main()
