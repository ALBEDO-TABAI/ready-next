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
import { SoftFailureCapsule } from '../renderer/components/agent/SoftFailureCapsule'
import {
  isTaskVisible,
} from '../renderer/components/agent/chat-panel/helpers/badges'
import {
  resolveTurnActivityPresentation,
  shouldRenderPendingTaskCard,
  terminalGeneratedImageArtifacts,
} from '../renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot'

test('recoverable failures show plain guidance without internal error or tool names', () => {
  const html = renderToStaticMarkup(createElement(SoftFailureCapsule, {
    softError: {
      message: 'codex_runtime_host_unbound',
      errorKind: 'host_unavailable',
      toolName: 'tag_forge_prepare_batch',
      friendlyMessage: '服务暂时不可用，稍后重试',
      technicalDetails: 'codex_runtime_host_unbound',
      receivedAt: '2026-08-19T00:00:00.000Z',
    },
    onDismiss: () => undefined,
  }))

  assert.match(html, /任务暂时失败/)
  assert.match(html, /服务暂时不可用，稍后重试/)
  assert.doesNotMatch(html, /host_unavailable|codex_runtime_host_unbound|tag_forge_prepare_batch/i)
})

test('thinking indicator is a compact live status without an assistant avatar', () => {
  const html = renderToStaticMarkup(createElement(ThinkingIndicator))

  assert.match(html, /data-ready-thinking-state="true"/)
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, />思考中</)
  assert.doesNotMatch(html, />R</)
})

test('thinking indicator can replace its fallback with a safe live narration', () => {
  const html = renderToStaticMarkup(createElement(ThinkingIndicator, {
    message: '正在核对 **天气来源** 与 `更新时间`',
  }))

  assert.match(html, /data-ready-thinking-summary="true"/)
  assert.match(html, />正在核对 <strong>天气来源<\/strong> 与 <code/)
  assert.match(html, />更新时间<\/code>/)
  const visibleLabel = html.match(/<span class="ready-thinking-state-label">[\s\S]*<\/span><\/div>$/)?.[0] || ''
  assert.doesNotMatch(visibleLabel, /\*\*|`更新时间`/)
  assert.doesNotMatch(html, />思考中</)
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

test('agent prose groups repeated authored ordinals into semantic ordered lists', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: [
      '1. 第一项',
      '   第一项说明。',
      '',
      '1. 第二项',
      '   第二项说明。',
      '',
      '1. 第三项',
      '   1) 嵌套项',
      '',
      '1. 第四项',
    ].join('\n'),
  }))

  assert.equal((html.match(/data-ready-ordered-list="true"/g) || []).length, 2)
  assert.match(html, /<ol start="1" data-ready-ordered-list="true" data-ready-list-delimiter="\."/)
  assert.match(html, /<li><span>第一项<\/span><div data-ready-list-continuation="true">第一项说明。<\/div><\/li>/)
  assert.match(html, /<ol start="1" data-ready-ordered-list="true" data-ready-list-delimiter="\)" data-ready-list-indent="3"/)
  assert.equal((html.match(/<li>/g) || []).length, 5)
  assert.doesNotMatch(html, /data-ready-numbered-marker/)
})

test('agent prose keeps the first start value and splits delimiter families', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: ['3. 第三项', '3. 第四项', '2) 新列表'].join('\n'),
  }))

  assert.match(html, /<ol start="3" data-ready-ordered-list="true" data-ready-list-delimiter="\."/)
  assert.match(html, /<ol start="2" data-ready-ordered-list="true" data-ready-list-delimiter="\)"/)
  assert.equal((html.match(/data-ready-ordered-list="true"/g) || []).length, 2)
})

test('agent prose ends a list at a real paragraph and keeps streaming caret in the final item', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: ['1. 第一项', '', '说明段落', '', '1. 新列表项'].join('\n'),
    streaming: true,
  }))

  assert.equal((html.match(/data-ready-ordered-list="true"/g) || []).length, 2)
  assert.match(html, />说明段落</)
  assert.equal((html.match(/data-ready-stream-caret="true"/g) || []).length, 1)
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

test('absolute file citations and @ mentions render as encapsulated chips', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '问题根因： /Users/user/实验田/idea-1/call_outcome.py (line 1) 与 @[工作内容]',
    mentions: { '工作内容': { path: '/Users/user/实验田/测试/lib-a/工作内容' } },
  }))
  assert.match(html, /data-ready-local-ref="file"/)
  assert.match(html, /call_outcome\.py \(line 1\)/)
  assert.match(html, /工作内容/)
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

test('turn activity presentation separates direct answers, tool activity, and real tasks', () => {
  const placeholder = taskProjectionToTaskCardRun({
    scopeId: 'scope-1',
    taskId: 'task-1',
    phase: 'planning',
    status: 'running',
    title: '测试会话',
    taskTitle: '正在理解需求',
    taskSummary: '正在整理任务边界、上下文与可用能力',
    steps: [],
    toolTrace: [],
    recentArtifacts: [],
    updatedAt: '2026-08-13T00:00:00.000Z',
  })

  assert.equal(isTaskVisible(placeholder), true)
  assert.equal(isTaskVisible({ ...placeholder, phase: 'done', status: 'completed' }), true)
  const placeholderWithTrace = {
    ...placeholder,
    toolTrace: [{ id: 'tool-1', kind: 'call', text: 'web_search()', timestamp: new Date() }],
  }
  assert.equal(isTaskVisible({ ...placeholderWithTrace, phase: 'done', status: 'completed' }), true)
  assert.equal(shouldRenderPendingTaskCard(placeholder, 0), false)
  assert.equal(shouldRenderPendingTaskCard(placeholder, 1), false)
  assert.equal(resolveTurnActivityPresentation(placeholder, 0), 'none')
  assert.equal(resolveTurnActivityPresentation(placeholder, 1), 'activity')
  assert.equal(resolveTurnActivityPresentation({
    ...placeholder,
    steps: [
      { id: 'codex-tool:one', title: '飞书查询', status: 'done', updatedAt: '2026-08-13T00:00:01.000Z' },
      { id: 'codex-tool:two', title: '飞书查询', status: 'running', updatedAt: '2026-08-13T00:00:02.000Z' },
    ],
  }, 2), 'activity', 'multiple tool calls are activity, not a model-authored plan')
  assert.equal(resolveTurnActivityPresentation({
    ...placeholder,
    taskType: 'multi_step_task',
    steps: [
      { id: 'one', title: '读取资料', status: 'done', updatedAt: '2026-08-13T00:00:01.000Z' },
      { id: 'two', title: '整理结果', status: 'running', updatedAt: '2026-08-13T00:00:02.000Z' },
    ],
  }, 1), 'task')
  assert.equal(resolveTurnActivityPresentation({
    ...placeholder,
    taskType: 'short_task',
    recentArtifacts: [{
      id: 'artifact-1',
      module: 'document',
      kind: 'document',
      label: '整理结果',
      path: '/tmp/result.md',
      createdAt: '2026-08-13T00:00:02.000Z',
    }],
  }, 1), 'task')
})

test('real task cards keep their useful title instead of becoming a generic duration card', () => {
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-duration',
    taskId: 'task-duration',
    phase: 'done',
    status: 'completed',
    title: '原始会话标题',
    taskTitle: '整理发布材料',
    taskSummary: '已整理并核对发布材料',
    steps: [
      { id: 'one', title: '整理材料', status: 'done', updatedAt: '2026-07-23T00:00:03.000Z' },
      { id: 'two', title: '核对结果', status: 'done', updatedAt: '2026-07-23T00:00:04.000Z' },
    ],
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    taskType: 'multi_step_task',
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

  assert.match(html, />整理发布材料</)
  assert.match(html, /data-ready-task-terminal-duration="true"[^>]*>用时 00:05</)
  assert.doesNotMatch(html, />本轮用时</)
  assert.match(html, /<button/)
  assert.match(html, /class="ready-task-content-line flex items-end justify-between"/)
  assert.match(html, /data-ready-task-kind-badge="true"[^>]*>多步任务</)
})

test('task activity and multiline user messages share stable text columns', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: CSS alignment crosses separately-rendered message and task surfaces
  const taskCardSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/agent/chat-panel/task/TaskCard.tsx'),
    'utf8',
  )
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: CSS alignment crosses separately-rendered message and task surfaces
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
  assert.match(chatUtilities, /\.ready-thinking-state\s*\{[\s\S]*?max-width: 72ch;/)
  assert.match(chatUtilities, /\.ready-thinking-state-label\s*\{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?white-space: normal;/)
  assert.doesNotMatch(chatUtilities, /\.ready-thinking-state-label\s*\{[\s\S]*?max-width: min\(68vw, 560px\);/)
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

test('history can classify an internal tool name without displaying it in expanded details', () => {
  const html = renderToStaticMarkup(createElement(ToolTimeline, {
    items: [{
      id: 'history-shell',
      callText: '运行本地命令',
      resultText: '本地命令完成',
      status: 'done',
      toolName: 'skill_run_shell',
      hideToolName: true,
    }],
  }))

  assert.match(html, /data-ready-tool-activity-kind="command"/)
  assert.match(html, /本地命令完成/)
  assert.doesNotMatch(html, /skill_run_shell/)
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
