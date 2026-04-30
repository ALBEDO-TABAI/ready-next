import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  TOOL_CALL_TEXT_PATTERN,
  buildBudgetWarningMessage,
  pushAssistantTextSafely,
  sanitizeAssistantText,
} from '../main/modules/agent-control/turn-engine'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tool-error-metrics'

// Phase 3 — output safety net.
//
// Audit findings these tests pin:
//   D1 — `:::tool_call` parser missed `<tool_call>` XML, leaking markers
//        into chat. Tested in tool-bridge.test.ts (extracts XML calls).
//   D2 — assistant text was pushed to session.messages without checking
//        for residual tool-call markers; this test exercises the helper.
//   D3 — 70% nudge text told the model to stop and ask user even on long
//        skill flows; helper now branches on `isLongSkillContext`.
//   D4 — same for the 90% converge nudge.

const TURN_ENGINE_PATH = new URL('../main/modules/agent-control/turn-engine.ts', import.meta.url)
const TOOL_BRIDGE_PATH = new URL('../main/modules/claude-bridge/tool-bridge.ts', import.meta.url)

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

// --- D2 — pushAssistantTextSafely / sanitizeAssistantText -------------------

test('Phase 3.2 — TOOL_CALL_TEXT_PATTERN catches both legacy and XML markers', () => {
  assert.equal(TOOL_CALL_TEXT_PATTERN.test('hello world'), false)
  assert.equal(TOOL_CALL_TEXT_PATTERN.test('I will call <tool_call>'), true)
  assert.equal(TOOL_CALL_TEXT_PATTERN.test('see <function=skill_run_shell>'), true)
  assert.equal(TOOL_CALL_TEXT_PATTERN.test('<parameter=command>ls</parameter>'), true)
  assert.equal(TOOL_CALL_TEXT_PATTERN.test('using :::tool_call block'), true)
})

test('Phase 3.2 — sanitizeAssistantText returns input unchanged when no markers present', () => {
  const text = '我看完文件后发现这是一个普通段落，没有任何工具标记。'
  const cleaned = sanitizeAssistantText(text, { sessionId: 's1', iteration: 3 })
  assert.equal(cleaned, text, 'identity on the common path — no allocation overhead')
})

test('Phase 3.2 — sanitizeAssistantText strips XML tool_call blocks and keeps surrounding prose', () => {
  const dirty = [
    '我先看当前状态。',
    '<tool_call>',
    '<function=skill_run_shell>',
    '<parameter=command>ls /tmp</parameter>',
    '</function>',
    '</tool_call>',
    '完成后我会继续。',
  ].join('\n')
  const cleaned = sanitizeAssistantText(dirty, {
    sessionId: 'sess-1',
    iteration: 7,
    toolTransport: 'native',
  })
  // The audit's primary user-visible damage: a chat bubble like
  // "我先看当前状态。\n<tool_call>...</tool_call>\n完成后我会继续。"
  // The cleaned form must NOT contain the markers anymore.
  assert.equal(TOOL_CALL_TEXT_PATTERN.test(cleaned), false, 'no markers leak through')
  assert.match(cleaned, /我先看当前状态。/)
  assert.match(cleaned, /完成后我会继续。/)
})

test('Phase 3.2 — pushAssistantTextSafely pushes clean text and skips empty', () => {
  const session = { messages: [] as Array<{ role: string; content: unknown }> }

  // Common path — no markers, push as-is.
  const r1 = pushAssistantTextSafely(session, '我已经完成了。')
  assert.equal(r1.pushed, true)
  assert.equal(r1.intercepted, false)
  assert.equal(session.messages.length, 1)
  assert.equal((session.messages[0] as { content: string }).content, '我已经完成了。')

  // Marker path — interception, but visibleText non-empty so still push.
  const dirty = '前面正文。\n<tool_call><function=x><parameter=y>z</parameter></function></tool_call>\n后面正文。'
  const r2 = pushAssistantTextSafely(session, dirty)
  assert.equal(r2.pushed, true)
  assert.equal(r2.intercepted, true)
  assert.equal(session.messages.length, 2)
  assert.equal(TOOL_CALL_TEXT_PATTERN.test((session.messages[1] as { content: string }).content), false)

  // Marker-only path — visibleText empty after strip → don't push to avoid
  // an empty assistant bubble.
  const onlyMarkers = '<tool_call><function=x></function></tool_call>'
  const r3 = pushAssistantTextSafely(session, onlyMarkers)
  assert.equal(r3.pushed, false)
  assert.equal(r3.intercepted, true)
  assert.equal(session.messages.length, 2, 'no empty-text bubble pushed')

  // Empty input — no-op.
  const r4 = pushAssistantTextSafely(session, '')
  assert.equal(r4.pushed, false)
  assert.equal(r4.intercepted, false)
})

test('Phase 3.2 — toolCallTextIntercepted metric is registered in TOOL_ERROR_METRICS', () => {
  assert.equal(TOOL_ERROR_METRICS.toolCallTextIntercepted, 'tool_call_text_intercepted')
})

// --- D3/D4 — buildBudgetWarningMessage --------------------------------------

test('Phase 3.3 — non-skill 70% nudge keeps the historical "ask user if continue" text', () => {
  const msg = buildBudgetWarningMessage({
    iterations: 7,
    effectiveMaxIterations: 10,
    level: 'warning',
    isLongSkillContext: false,
  })
  assert.match(msg, /已用 7\/10/)
  assert.match(msg, /询问用户是否继续/, 'non-skill flow keeps the original ask-user nudge')
})

test('Phase 3.3 — non-skill 90% converge nudge keeps the historical text', () => {
  const msg = buildBudgetWarningMessage({
    iterations: 9,
    effectiveMaxIterations: 10,
    level: 'converge',
    isLongSkillContext: false,
  })
  assert.match(msg, /当前预算已接近上限/)
  assert.match(msg, /剩余轮次内收敛/)
})

test('Phase 3.3 — long-skill 70% nudge tells the model to keep going without typed-action guidance', () => {
  const msg = buildBudgetWarningMessage({
    iterations: 50,
    effectiveMaxIterations: 80,
    level: 'warning',
    isLongSkillContext: true,
  })
  assert.match(msg, /50\/80/)
  // Audit Phase 3 §D3 — the long-skill copy must NOT include "ask user" or
  // "summarize" instructions; that was the reverse-instruction bug.
  assert.doesNotMatch(msg, /询问用户是否继续/)
  assert.doesNotMatch(msg, /总结当前进度/)
  // Child-loop owned flows must not nudge the parent model toward typed
  // action dispatch anymore; observation primitives remain the recovery cue.
  assert.doesNotMatch(msg, /typed skill action/)
  assert.match(msg, /skill_read_artifact/)
})

test('Phase 3.3 — long-skill 90% converge nudge tells the model to keep going, only ask on real blockers', () => {
  const msg = buildBudgetWarningMessage({
    iterations: 70,
    effectiveMaxIterations: 80,
    level: 'converge',
    isLongSkillContext: true,
  })
  assert.match(msg, /70\/80/)
  assert.doesNotMatch(msg, /优先给出可交付结果/, 'no premature wrap-up signal')
  assert.match(msg, /真实 blocker/, 'only true blockers warrant ask_user')
  assert.match(msg, /skill_ask_user/)
})

// --- Wiring checks ----------------------------------------------------------

test('Phase 3 wiring — turn-engine push sites all go through pushAssistantTextSafely', () => {
  const source = readSource(TURN_ENGINE_PATH)
  // Find every `session.messages.push({ role: 'assistant', content: ...})`
  // in turn-engine. The ONLY allowed survivors after Phase 3.2 are:
  //   1. The two inside the helper itself (lines 88, 105 in current file)
  //   2. The multimodal-array push (uses sanitizeAssistantText inline)
  const directPushes = source.match(/session\.messages\.push\(\{\s*role:\s*'assistant'/g) || []
  // 2 inside the helper + 1 array-content push = 3 max acceptable
  assert.ok(
    directPushes.length <= 3,
    `expected ≤3 direct assistant pushes (helper internals + array path), got ${directPushes.length}`,
  )

  // Must use pushAssistantTextSafely or sanitizeAssistantText at every other
  // site. Spot-check by counting helper invocations — should be ≥10
  // (the audit identified 13 string-content sites).
  const helperCalls = source.match(/pushAssistantTextSafely\(session,/g) || []
  assert.ok(helperCalls.length >= 10, `expected ≥10 pushAssistantTextSafely calls, got ${helperCalls.length}`)

  // The Anthropic protocol path uses sanitizeAssistantText for the inline
  // text block.
  assert.match(source, /sanitizeAssistantText\(response\.text/)
})

test('Phase 3 wiring — both budget nudges go through buildBudgetWarningMessage', () => {
  const source = readSource(TURN_ENGINE_PATH)
  // Both call sites must pass `isLongSkillContext` derived from the
  // long-skill resume flag OR an active skill-tool list.
  const callMatches = source.match(/buildBudgetWarningMessage\(\s*\{[\s\S]*?isLongSkillContext:\s*shouldUseLongSkillResumeBudget\s*\|\|\s*\(preferredSkillToolNames\?\.length\s*\|\|\s*0\)\s*>\s*0/g) || []
  assert.equal(callMatches.length, 2, 'both nudges (70% and 90%) must compute isLongSkillContext the same way')

  // The old hardcoded inline nudges at the CALL SITES must be gone. The same
  // text still exists inside buildBudgetWarningMessage as the non-skill
  // fallback (intentional — preserves historical behavior for non-skill
  // flows), so we assert against the call-site shape, not the literal copy.
  // Old call site shape: `content: '系统提醒：当前预算已接近上限...'`.
  assert.doesNotMatch(
    source,
    /content:\s*'系统提醒：当前预算已接近上限，请在剩余轮次内收敛并优先给出可交付结果。',/,
    'old direct-string 90% converge call site must be gone',
  )
  // Old 70% call site: a backtick template literal pushed directly.
  assert.doesNotMatch(
    source,
    /content:\s*`系统提醒：已用 \$\{iterations\}\/\$\{effectiveMaxToolIterations\} 次工具调用。请总结当前进度并询问用户是否继续/,
    'old direct-template 70% ask-user call site must be gone',
  )
})

test('Phase 3.1 wiring — tool-bridge.ts XML regexes are present and exported through parseTextToolBridgeResponse', () => {
  const source = readSource(TOOL_BRIDGE_PATH)
  assert.match(source, /XML_TOOL_CALL_REGEX/)
  assert.match(source, /XML_FUNCTION_REGEX/)
  assert.match(source, /XML_PARAMETER_REGEX/)
  // The new helper that does the per-block extraction.
  assert.match(source, /function extractXmlToolCall\(blockBody: string\):/)
  // parseTextToolBridgeResponse must invoke BOTH regexes (legacy + XML).
  const parserBlock = source.match(/export function parseTextToolBridgeResponse[\s\S]*?return \{ visibleText, toolCalls \}\s*\}/)
  assert.ok(parserBlock)
  assert.match(parserBlock![0], /TOOL_CALL_BLOCK_REGEX/)
  assert.match(parserBlock![0], /XML_TOOL_CALL_REGEX/)
})
