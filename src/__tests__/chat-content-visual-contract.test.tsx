import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ThinkingIndicator } from '../renderer/components/agent/chat-panel/ThinkingIndicator'
import { MarkdownContent } from '../renderer/components/agent/chat-panel/markdown'
import { TaskCard } from '../renderer/components/agent/chat-panel/task/TaskCard'
import {
  resolveToolActivityPresentation,
  ToolTimeline,
} from '../renderer/components/agent/chat-panel/task/ToolTimeline'
import { taskProjectionToTaskCardRun } from '../renderer/components/agent/task-card-from-projection'
import {
  isTaskPlaceholderOnly,
  isTaskVisible,
} from '../renderer/components/agent/chat-panel/helpers/badges'
import {
  shouldRenderPendingTaskCard,
  terminalGeneratedImageArtifacts,
} from '../renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot'

test('thinking indicator is a compact live status without an assistant avatar', () => {
  const html = renderToStaticMarkup(createElement(ThinkingIndicator))

  assert.match(html, /data-ready-thinking-state="true"/)
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, />思考中</)
  assert.doesNotMatch(html, />R</)
})

test('streaming prose exposes a steady caret while completed prose does not', () => {
  const streaming = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '正在整理结果',
    streaming: true,
  }))
  const complete = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '结果已经整理完成',
  }))

  assert.match(streaming, /data-ready-stream-caret="true"/)
  assert.match(streaming, /data-ready-streaming="true"/)
  assert.doesNotMatch(complete, /data-ready-stream-caret/)
})

test('fenced code renders as an operable code block with language, lines, and copy action', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: ['```ts', 'const ready = true', 'console.log(ready)', '```'].join('\n'),
  }))

  assert.match(html, /data-ready-code-block="true"/)
  assert.match(html, /data-ready-code-language="true">ts</)
  assert.match(html, /data-ready-code-line="1"/)
  assert.match(html, /data-ready-code-line="2"/)
  assert.match(html, /aria-label="复制代码"/)
})

test('real diff blocks and numbered links receive their adapted presentation', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: [
      '参考 [1](https://example.com/source)',
      '',
      '```diff',
      '-旧内容',
      '+新内容',
      '```',
    ].join('\n'),
  }))

  assert.match(html, /data-ready-agent-citation="true"/)
  assert.match(html, /data-ready-agent-citation-sources="true"/)
  assert.match(html, /data-ready-agent-citation-source="1"/)
  assert.match(html, />example\.com</)
  assert.match(html, /data-ready-code-kind="diff"/)
  assert.match(html, /data-ready-diff-line="remove"/)
  assert.match(html, /data-ready-diff-line="add"/)
})

test('tool activity presentation uses typed, truthful labels from existing trace data', () => {
  const search = resolveToolActivityPresentation({
    id: 'search',
    callText: 'web_search(query, topK)',
    resultText: null,
    status: 'running',
    toolName: 'web_search',
    callDetail: JSON.stringify({ query: 'Ready Electron 42' }),
  })
  const image = resolveToolActivityPresentation({
    id: 'image',
    callText: 'generate_image(prompt)',
    resultText: 'generate_image: 已生成',
    status: 'done',
    toolName: 'generate_image',
    callDetail: JSON.stringify({ prompt: '安静的桌面工作台' }),
  })

  assert.deepEqual(search, {
    kind: 'research',
    title: '搜索网页 · Ready Electron 42',
  })
  assert.deepEqual(image, {
    kind: 'image',
    title: '图片已生成 · 安静的桌面工作台',
  })

  const html = renderToStaticMarkup(createElement(ToolTimeline, {
    items: [{
      id: 'search',
      callText: 'web_search(query, topK)',
      resultText: null,
      status: 'running' as const,
      toolName: 'web_search',
      callDetail: JSON.stringify({ query: 'Ready Electron 42' }),
    }],
  }))
  assert.match(html, /data-ready-tool-activity-kind="research"/)
  assert.match(html, /ready-task-todo-label/)
  assert.match(html, /搜索网页 · Ready Electron 42/)
})

test('placeholder-only progress yields to thinking while terminal direct answers hide the stale card', () => {
  const placeholder = {
    scopeId: 'scope-1',
    taskId: 'task-1',
    phase: 'planning',
    status: 'running',
    taskTitle: '正在理解需求',
    taskSummary: '正在整理任务边界、上下文与可用能力',
    steps: [],
    toolTrace: [],
    recentArtifacts: [],
  } as any

  assert.equal(isTaskPlaceholderOnly(placeholder), true)
  assert.equal(isTaskVisible(placeholder), true)
  assert.equal(isTaskVisible({ ...placeholder, phase: 'done', status: 'completed' }), true)
  const placeholderWithTrace = {
    ...placeholder,
    toolTrace: [{ id: 'tool-1', kind: 'call', text: 'web_search()', timestamp: new Date() }],
  }
  assert.equal(isTaskPlaceholderOnly(placeholderWithTrace), true)
  assert.equal(isTaskVisible({ ...placeholderWithTrace, phase: 'done', status: 'completed' }), true)
  assert.equal(shouldRenderPendingTaskCard(placeholder, 0), false)
  assert.equal(shouldRenderPendingTaskCard(placeholder, 1), true)
})

test('terminal duration replaces the stale planning title without removing the disclosure', () => {
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-duration',
    taskId: 'task-duration',
    phase: 'done',
    status: 'completed',
    title: '原始会话标题',
    taskTitle: '正在理解需求',
    taskSummary: '正在整理任务边界、上下文与可用能力',
    steps: [],
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    memoryCapture: null,
    taskType: 'short_task',
    interactionState: 'suspended',
    canResume: false,
    updatedAt: '2026-07-23T00:00:05.000Z',
    toolTrace: [],
  })
  const html = renderToStaticMarkup(createElement(TaskCard, {
    run,
    terminalDuration: '00:05',
    expanded: true,
  }))

  assert.match(html, />本轮用时</)
  assert.match(html, /data-ready-task-terminal-duration="true"[^>]*>00:05</)
  assert.doesNotMatch(html, />正在理解需求</)
  assert.match(html, /<button/)
  assert.match(html, /class="ready-task-content-line flex items-end justify-between"/)
  assert.match(html, /data-ready-task-kind-badge="true"[^>]*>短任务</)
})

test('task activity and multiline user messages share stable text columns', () => {
  const taskCardSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/agent/chat-panel/task/TaskCard.tsx'),
    'utf8',
  )
  const chatMessagesSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/agent/ChatMessages.tsx'),
    'utf8',
  )
  const chatUtilities = readFileSync(
    resolve(process.cwd(), 'src/renderer/styles/chat-utilities.css'),
    'utf8',
  )

  assert.match(taskCardSource, /const TASK_CARD_HEADER_STYLE:[\s\S]*?padding: '7px 0'/)
  assert.match(taskCardSource, /ready-task-content-line t-meta/)
  assert.match(chatUtilities, /\.ready-task-content-line\s*\{\s*padding-left: 20px;/)
  assert.match(chatUtilities, /\.ready-thinking-reasoning\s*\{[\s\S]*?padding-left: 20px;/)
  assert.match(chatUtilities, /\.ready-thinking-reasoning::before\s*\{[\s\S]*?left: 5px;/)
  assert.match(chatMessagesSource, /className="ready-chat-user-message max-w-\[85%\] t-body"/)
  assert.match(chatMessagesSource, /className="ready-chat-user-message-content"/)
  assert.match(chatUtilities, /\.ready-chat-user-message-content\s*\{[\s\S]*?width: 100%;[\s\S]*?text-align: left;/)
})

test('a running follow-up cannot borrow a generated image from the previous turn', () => {
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-image-follow-up',
    taskId: 'task-image-follow-up',
    phase: 'tool_running',
    status: 'running',
    title: '生成下一张图片',
    recentArtifacts: [{
      id: 'stale-image',
      module: 'system',
      kind: 'generated_image',
      label: 'previous.jpg',
      path: '/tmp/previous.jpg',
      createdAt: '2026-07-23T00:00:00.000Z',
    }],
    updatedAt: '2026-07-23T00:00:01.000Z',
  })

  assert.equal(terminalGeneratedImageArtifacts(run).length, 0)
  assert.equal(terminalGeneratedImageArtifacts(taskProjectionToTaskCardRun({
    ...run,
    phase: 'done',
    status: 'completed',
  })).length, 0)
  assert.equal(terminalGeneratedImageArtifacts(taskProjectionToTaskCardRun({
    ...run,
    phase: 'done',
    status: 'completed',
    taskTitle: 'AI 生图',
  })).length, 1)
})

test('Ready tool names map to their actual product activity instead of reference-library names', () => {
  const cases = [
    { name: 'web_fetch', kind: 'research', title: '读取网页' },
    { name: 'document_read_section', kind: 'document', title: '处理文档' },
    { name: 'file_read_excerpt', kind: 'file', title: '处理文件' },
    { name: 'skill_run_shell', kind: 'command', title: '运行本地命令' },
    { name: 'use_skill', kind: 'skill', title: '运行技能' },
    { name: 'browser_read', kind: 'browser', title: '操作网页' },
  ] as const

  for (const item of cases) {
    const presentation = resolveToolActivityPresentation({
      id: item.name,
      callText: `${item.name}()`,
      resultText: null,
      status: 'running',
      toolName: item.name,
    })
    assert.equal(presentation.kind, item.kind, item.name)
    assert.equal(presentation.title, item.title, item.name)
  }
})

test('task steps expose distinct semantic states without relying on colored bullets alone', () => {
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-visual',
    taskId: 'task-visual',
    phase: 'tool_running',
    title: '整理资料',
    steps: [
      { id: 'done', title: '读取资料', status: 'done', updatedAt: '2026-07-23T00:00:00.000Z' },
      { id: 'running', title: '提炼重点', status: 'running', updatedAt: '2026-07-23T00:00:01.000Z' },
      { id: 'pending', title: '写入文档', status: 'pending', updatedAt: '2026-07-23T00:00:02.000Z' },
    ],
    currentStepId: 'running',
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    memoryCapture: null,
    taskType: 'multi_step_task',
    interactionState: 'running',
    canResume: false,
    updatedAt: '2026-07-23T00:00:02.000Z',
    toolTrace: [],
  })
  const html = renderToStaticMarkup(createElement(TaskCard, {
    run,
    expanded: true,
  }))

  assert.match(html, /data-ready-task-step-status="done"/)
  assert.match(html, /data-ready-task-step-status="running"/)
  assert.match(html, /data-ready-task-step-status="pending"/)
  assert.match(html, /aria-label="步骤已完成"/)
  assert.match(html, /aria-label="步骤进行中"/)
  assert.match(html, /aria-label="步骤待执行"/)
})
