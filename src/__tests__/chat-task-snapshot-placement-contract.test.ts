import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: snapshot placement wiring crosses chat rendering and runtime projection surfaces
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat messages render work activity before the resulting agent reply', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /messageTaskSnapshots:\s*Record<string,/)
  assert.match(chatMessages, /messageGeneratedImageArtifacts:\s*Record<string,/)
  assert.match(chatMessages, /messageToolTraceSnapshots:\s*Record<string,/)
  assert.match(chatMessages, /msg\.type === 'agent'/)
  assert.match(chatMessages, /messageTaskSnapshots\[msg\.id\]/)
  assert.match(chatMessages, /messageGeneratedImageArtifacts\[msg\.id\]/)
  assert.match(chatMessages, /messageToolTraceSnapshots\[msg\.id\]/)
  assert.match(chatMessages, /data-chat-message-task-snapshot/)
  assert.match(chatMessages, /data-chat-message-tool-trace/)
  assert.match(chatMessages, /data-chat-message-task-snapshot=\{msg\.id\}[\s\S]*max-w-\[90%\]/)
  assert.match(chatMessages, /shouldRenderGlobalToolTraceCapsule/)
  assert.ok(
    chatMessages.indexOf('data-chat-message-task-snapshot={msg.id}')
      < chatMessages.indexOf('renderMarkdown(msg.content, isStreamingMessage)'),
    'task activity is shown before the answer it produced',
  )
  assert.ok(
    chatMessages.indexOf('data-chat-message-tool-trace={msg.id}')
      < chatMessages.indexOf('renderMarkdown(msg.content, isStreamingMessage)'),
    'tool activity is shown before the answer it produced',
  )
})

test('chat messages expose a temporary pending task block while the next reply is still empty', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /pendingTaskRun:/)
  assert.match(chatMessages, /pendingToolTrace:/)
  assert.match(chatMessages, /data-chat-pending-task-snapshot/)
  assert.match(chatMessages, /data-chat-pending-tool-trace/)
  assert.match(chatMessages, /data-chat-live-activity="true"/)
  assert.match(chatMessages, /data-chat-live-activity="true"[\s\S]*gap:\s*6/)
  assert.match(chatMessages, /streamMsg\.content\.length === 0/)

  const taskToolSnapshot = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot.tsx',
  )
  assert.match(taskToolSnapshot, /message\.id === streamingMessageId && !message\.content\.trim\(\)/)
})

test('ask-user cards share the assistant message width and right safety inset', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
  const askUserCard = readWorkspaceFile('src/renderer/components/agent/AskUserQuestionsCard.tsx')
  const chatUtilities = readWorkspaceFile('src/renderer/styles/chat-utilities.css')

  assert.match(chatMessages, /data-chat-message-ask-user=\{msg\.id\}/)
  assert.match(chatMessages, /data-chat-message-ask-user=\{msg\.id\}[\s\S]*max-w-\[90%\] w-full/)
  assert.match(chatMessages, /data-chat-message-ask-user=\{msg\.id\}[\s\S]*paddingRight:\s*18/)
  assert.match(chatMessages, /data-chat-message-ask-user=\{msg\.id\}[\s\S]*boxSizing:\s*'border-box'/)
  assert.match(askUserCard, /className="ready-ask-user-summary-list"/)
  assert.match(askUserCard, /padding:\s*'0 0 0 22px'/)
  assert.match(chatUtilities, /\.ready-ask-user-summary-list::before/)
  assert.match(chatUtilities, /left:\s*6\.5px/)
})

test('task and tool cards stay collapsed by default and only reveal the latest line until expanded', () => {
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')
  // 2026-07-10 行数健康度拆分 — L2/L3 时间线组件族独立成文件。
  const toolTimeline = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/ToolTimeline.tsx')

  // 2026-07-10 activity-capsule — 折叠头保留单行 summary 预览（标题/状态重复时抑制）。
  assert.match(taskCard, /const summaryPreview = formatSingleLinePreview\(vm\.summary\)/)
  assert.match(taskCard, /\{headerPreview\}/)
  // 运行态折叠时自动浮出最近工具条目（P0-2 语义延续），无近行时回退 latestEvent 单行预览。
  assert.match(taskCard, /pending && !expanded && !compact \? timelineItems\.slice\(-3\) : \[\]/)
  assert.match(taskCard, /!expanded && recentItems\.length === 0 && latestEvent/)
  assert.match(taskCard, /!expanded && recentItems\.length > 0/)
  assert.match(taskCard, /const latestPreview = formatToolTracePreview\(latestEvent\?\.text\)/)
  assert.match(taskCard, /expanded && vm\.currentStep/)
  // 展开态工具轨迹 = 结构化时间线（call/result 配对条目 + 逐条 L3 详情披露）。
  assert.match(taskCard, /<ToolTimeline items=\{timelineItems\} \/>/)
  assert.match(taskCard, /deriveToolTimelineItems/)
  assert.match(toolTimeline, /data-ready-tool-timeline-detail/)
  // L3 详情优先富事件字段（入参 JSON / 输出全文），瘦事件回退单行 text。
  assert.match(toolTimeline, /item\.callDetail \|\| item\.callText/)
  assert.match(toolTimeline, /item\.resultDetail \|\| item\.resultText/)
  assert.doesNotMatch(taskCard, /最近一步：/)
  assert.match(taskCard, /whiteSpace:\s*'nowrap'/)
  assert.match(taskCard, /flexShrink:\s*0/)
  assert.doesNotMatch(taskCard, />\s*停止\s*</)
})
