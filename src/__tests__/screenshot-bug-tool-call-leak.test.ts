import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TurnTranscript } from '../main/modules/agent-control/runtime-core/turn-transcript'
import {
  buildToolCallOnlyFallbackText,
  TOOL_CALL_TEXT_PATTERN,
  sanitizeAssistantText,
} from '../main/modules/agent-control/tools-runtime/tool-call-text-guard'
import {
  selectContinuationProjection,
} from '../main/modules/agent-control/contracts/continuation-state'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

// Screenshot-bug regression suite — reproduces the exact failure the user
// sent in: "再从头重新跑一次看看" → assistant turn output `<tool_call>...
// </tool_call>` XML literal as visible chat text instead of dispatching.
// Phase 3.2's `pushAssistantTextSafely` only protected `session.messages.push`
// (history fed back to the LLM), but the visible chat panel + chat_messages
// DB persistence flowed through OTHER paths (TurnTranscript.emitOutput,
// chat:saveMessage IPC) that were untouched.

const TURN_TRANSCRIPT_PATH = new URL('../main/modules/agent-control/runtime-core/turn-transcript.ts', import.meta.url)
const CHAT_PERSISTENCE_GROUP_PATH = new URL('../main/modules/claude-bridge/ipc/chat-persistence-group.ts', import.meta.url)
const CONTINUATION_STATE_PATH = new URL('../main/modules/agent-control/contracts/continuation-state.ts', import.meta.url)

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

// The exact text from the user's screenshot (lightly trimmed for fixture use).
const SCREENSHOT_LEAK_TEXT = [
  '好，从头来。先看当前状态和配置，然后清理重跑。<tool_call>',
  '<function=skill_run_shell>',
  '<parameter=command>ls -la /Users/user/Documents/实验田/测试/</parameter>',
  '</function>',
  '</tool_call><tool_call>',
  '<function=skill_run_shell>',
  '<parameter=command>cat /Users/user/Documents/实验田/测试/vnext_config.json 2>/dev/null || echo "No config"</parameter>',
  '</function>',
  '</tool_call>',
].join('\n')

const MALFORMED_PLURAL_TOOL_CALLS_TEXT = [
  '好，文档标签页写入受限。我直接用 artifact 输出处理后的完整文档。',
  '<tool_calls>',
  '<function=skill_write_artifact>',
  '<parameter=content># 视听剖析报告',
  '',
  '## aespa LEMONADE Complexity Trailer',
  '',
  '这段内容不应该进入聊天正文。',
].join('\n')

const BRACKET_TOOL_CALL_LEAK_TEXT = [
  '我将先加载参考文件。',
  '[tool_call]',
  '{',
  '  "tool": "skill_read_artifact",',
  '  "input": {',
  '    "path": "references/proposal-template.md"',
  '  }',
  '}',
  '</tool_call>',
  '加载完继续。',
].join('\n')

function makeTranscript() {
  const emittedChunks: Array<{ chunk: string; type: string }> = []
  const transcript = new TurnTranscript(
    {
      emitOutput: (chunk: string, type: string) => {
        emittedChunks.push({ chunk, type })
      },
      emitStatus: () => {},
      emitRuntimeError: () => {},
      emitToolAction: () => {},
    },
    { sessionId: 'sess-screenshot' },
  )
  return { transcript, emittedChunks }
}

// ---------------------------------------------------------------------------
// PRIMARY FIX — TurnTranscript.emitOutput sanitizes 'text' chunks before the
// renderer can ever see them.
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG — TurnTranscript.emitOutput strips tool_call XML before reaching renderer', () => {
  const { transcript, emittedChunks } = makeTranscript()
  transcript.emitOutput(SCREENSHOT_LEAK_TEXT, 'text')

  assert.equal(emittedChunks.length, 1, 'one emit fires (no duplicate)')
  const emitted = emittedChunks[0]
  assert.equal(emitted.type, 'text')
  assert.equal(
    TOOL_CALL_TEXT_PATTERN.test(emitted.chunk),
    false,
    'emitted chunk no longer contains tool_call markers — this was the screenshot bug',
  )
  // Useful prose around the leaked markup must survive.
  assert.match(emitted.chunk, /好，从头来/)
  assert.match(emitted.chunk, /先看当前状态和配置/)
})

test('SCREENSHOT BUG — finalChunks accumulator stores the cleaned text, not the leaked one', () => {
  const { transcript } = makeTranscript()
  transcript.emitOutput(SCREENSHOT_LEAK_TEXT, 'text')
  // getFinalText concatenates `finalChunks` — used by callers that need to
  // persist the assembled assistant message server-side.
  const finalText = transcript.getFinalText()
  assert.equal(TOOL_CALL_TEXT_PATTERN.test(finalText), false)
  assert.match(finalText, /好，从头来/)
})

test('SCREENSHOT BUG — bracket tool_call blocks are stripped before renderer emit', () => {
  const { transcript, emittedChunks } = makeTranscript()
  transcript.emitOutput(BRACKET_TOOL_CALL_LEAK_TEXT, 'text')

  assert.equal(emittedChunks.length, 1)
  assert.equal(TOOL_CALL_TEXT_PATTERN.test(emittedChunks[0].chunk), false)
  assert.match(emittedChunks[0].chunk, /我将先加载参考文件/)
  assert.match(emittedChunks[0].chunk, /加载完继续/)
})

test('SCREENSHOT BUG — non-text emits (tool_use, tool_result, done) are NOT sanitized', () => {
  const { transcript, emittedChunks } = makeTranscript()
  // Some legitimate non-text emits use angle brackets (e.g. tool_use payload
  // strings, structured payloads). Sanitization is gated on type==='text'
  // so these pass through untouched.
  const toolUseText = '<tool_call>raw payload from upstream tool result</tool_call>'
  transcript.emitOutput(toolUseText, 'tool_result')
  const result = emittedChunks.find((entry) => entry.type === 'tool_result')
  assert.ok(result)
  assert.equal(result!.chunk, toolUseText, 'non-text types pass through unchanged')
})

test('SCREENSHOT BUG — clean text passes through with zero allocation overhead (identity)', () => {
  const { transcript, emittedChunks } = makeTranscript()
  const clean = '我已经检查完毕，结果如下：\n- 步骤 1 完成\n- 步骤 2 完成'
  transcript.emitOutput(clean, 'text')
  assert.equal(emittedChunks[0].chunk, clean, 'text without markers is the same string instance')
})

// ---------------------------------------------------------------------------
// SECONDARY FIX — chat:saveMessage IPC sanitation (defense-in-depth)
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG — sanitizeAssistantText alone correctly strips the screenshot text', () => {
  const cleaned = sanitizeAssistantText(SCREENSHOT_LEAK_TEXT, {
    sessionId: 'sess-x',
    source: 'chat_save_message',
  })
  assert.equal(TOOL_CALL_TEXT_PATTERN.test(cleaned), false)
  assert.match(cleaned, /好，从头来/)
})

test('SCREENSHOT BUG — malformed plural tool_calls block does not leak parameter body', () => {
  const cleaned = sanitizeAssistantText(MALFORMED_PLURAL_TOOL_CALLS_TEXT, {
    sessionId: 'sess-malformed',
    source: 'chat_save_message',
  })

  assert.equal(TOOL_CALL_TEXT_PATTERN.test(cleaned), false)
  assert.match(cleaned, /文档标签页写入受限/)
  assert.doesNotMatch(cleaned, /# 视听剖析报告/)
  assert.doesNotMatch(cleaned, /这段内容不应该进入聊天正文/)
})

test('SCREENSHOT BUG — TurnTranscript strips malformed plural tool_calls before renderer emit', () => {
  const { transcript, emittedChunks } = makeTranscript()
  transcript.emitOutput(MALFORMED_PLURAL_TOOL_CALLS_TEXT, 'text')

  assert.equal(emittedChunks.length, 1)
  const emitted = emittedChunks[0]
  assert.equal(emitted.type, 'text')
  assert.equal(TOOL_CALL_TEXT_PATTERN.test(emitted.chunk), false)
  assert.match(emitted.chunk, /文档标签页写入受限/)
  assert.doesNotMatch(emitted.chunk, /# 视听剖析报告/)
})

test('DIRECT PATH GUARD — tool-call-only text gets a visible fallback instead of empty success', () => {
  const fallback = buildToolCallOnlyFallbackText([
    '<tool_call>',
    '<function=browser_search>',
    '<parameter=query>youtube aespa most viewed video</parameter>',
    '</function>',
    '</tool_call>',
  ].join('\n'))

  assert.ok(fallback)
  assert.deepEqual(fallback!.toolNames, ['browser_search'])
  assert.match(fallback!.text, /网页查询/)
})

test('SCREENSHOT BUG wiring — chat:saveMessage IPC uses sanitizeAssistantText for assistant rows', () => {
  const source = readSource(CHAT_PERSISTENCE_GROUP_PATH)
  // Find the chat:saveMessage handler block. The handler spans the IPC body
  // including both the sanitization branch and the hint-persist hook, so we
  // grab a wide enough window (up to next IPC handler registration).
  const block = source.match(/'chat:saveMessage'[\s\S]*?ipcMain\.handle\('chat:createConversation'/)
  assert.ok(block, 'chat:saveMessage handler block exists (bounded by next handler)')
  assert.match(block![0], /sanitizeAssistantText\(data\.content/)
  // Non-assistant content must NOT be sanitized (user prose may legitimately
  // discuss tool_call XML in support chats).
  assert.match(block![0], /data\.role\s*===\s*'assistant'/)
  // The hint persistence hook must still fire AFTER the sanitized save.
  assert.match(block![0], /persistReferenceHintAfterAssistantMessage/)
})

// ---------------------------------------------------------------------------
// SECONDARY FIX — failed tasks must remain resumable (Phase 2.5 was over-tight)
// ---------------------------------------------------------------------------

function makeProjection(overrides: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: 'task-id',
    scopeId: 'scope-x',
    runId: 'run-id',
    taskType: 'multi_step_task',
    module: 'skill',
    taskTitle: 'Video Expert pipeline',
    taskSummary: '',
    status: 'failed',
    interactionState: 'awaiting_confirmation',
    steps: [],
    currentStepId: null,
    budget: null,
    budgetUsagePercent: 0,
    budgetWarningLevel: 'none',
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: null,
    resumableActions: [],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
    ...overrides,
  }
}

test('SCREENSHOT BUG — failed VEA task IS resumable on "再从头重新跑一次看看"', () => {
  // Reproduces the exact user case: the previous skill task failed, the user
  // says "再从头重新跑一次看看", continuation lookup must surface the failed
  // task so the orchestrator can re-arm the reference skill instead of
  // routing as a fresh direct_answer turn (which is what produced the
  // `<tool_call>` XML leak in the screenshot).
  const failed = makeProjection({
    taskId: 'task-vea-failed',
    status: 'failed',
    updatedAt: '2026-04-27T05:00:00.000Z',
  })
  const selected = selectContinuationProjection({
    projections: [failed],
    userText: '再从头重新跑一次看看',
  })
  assert.equal(selected?.taskId, 'task-vea-failed', 'failed task must be selectable')
})

test('SCREENSHOT BUG — done tasks STILL excluded from implicit lookup (audit B4 not regressed)', () => {
  // The "理解需求 shadowing" risk Phase 2.5 fixed must not come back. A
  // recently-touched `done` task should NOT be the implicit continuation
  // target when the user says "继续".
  const done = makeProjection({ taskId: 'task-understand-done', status: 'done' })
  const selected = selectContinuationProjection({
    projections: [done],
    userText: '继续',
  })
  assert.equal(selected, null, 'done tasks remain excluded from implicit resume')
})

test('SCREENSHOT BUG — explicit Task ID still resolves done/cancelled tasks', () => {
  const done = makeProjection({ taskId: 'task-done', status: 'done' })
  const cancelled = makeProjection({ taskId: 'task-cancelled', status: 'cancelled' })
  for (const target of [done, cancelled]) {
    const selected = selectContinuationProjection({
      projections: [target],
      userText: 'Task ID: ' + target.taskId,
      explicitTaskId: target.taskId,
    })
    assert.equal(selected?.taskId, target.taskId, 'explicit override always wins')
  }
})

test('SCREENSHOT BUG — blocked task still preferred over failed when both exist', () => {
  // A still-blocked task is the better implicit-resume target than a failed
  // task; Phase 2.5's preference for live candidates must survive the
  // hotfix that re-admits failed.
  const blocked = makeProjection({
    taskId: 'task-blocked',
    status: 'blocked',
    updatedAt: '2026-04-27T01:00:00.000Z',
    continuationRef: {
      taskId: 'task-blocked',
      executionId: 'exec-blocked',
      blockerType: 'need_confirmation',
    },
  })
  const failed = makeProjection({
    taskId: 'task-failed',
    status: 'failed',
    updatedAt: '2026-04-27T05:00:00.000Z', // newer than blocked
  })
  const selected = selectContinuationProjection({
    projections: [failed, blocked],
    userText: '继续',
  })
  // isContinuationProjectionCandidate prefers blocked; failed only wins
  // when no live candidate exists.
  assert.equal(selected?.taskId, 'task-blocked')
})

test('SCREENSHOT BUG wiring — isTerminalProjection only blocks completed + killed, NOT failed', () => {
  const source = readSource(CONTINUATION_STATE_PATH)
  const block = source.match(/function isTerminalProjection[\s\S]*?\n\}/)
  assert.ok(block)
  assert.match(block![0], /projection\.status\s*===\s*'completed'/)
  assert.match(block![0], /projection\.status\s*===\s*'killed'/)
  // The previous version's `failed` membership must be gone.
  assert.doesNotMatch(block![0], /projection\.status\s*===\s*'failed'/)
})

// ---------------------------------------------------------------------------
// PRIMARY wiring contracts
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG wiring — TurnTranscript.emitOutput calls sanitizeAssistantText for text type', () => {
  const source = readSource(TURN_TRANSCRIPT_PATH)
  const block = source.match(/\n\s{2}emitOutput\([\s\S]*?this\.emitters\.emitOutput\(/)
  assert.ok(block)
  assert.match(block![0], /sanitizeAssistantText\(chunk,/)
  assert.match(block![0], /type\s*===\s*'text'/)
  assert.match(block![0], /source:\s*'transcript_emit'/)
})
