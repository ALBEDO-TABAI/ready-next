import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'
import {
  compactAgentInputItems,
  normalizeSessionSnapshotForSeed,
} from '../main/modules/agent-control/compaction/compact-agent-input'
import { buildSkillCatalogText } from '../main/modules/agent-control/system-reminders/skill-catalog-reminder'

test('compactAgentInputItems keeps complete call/result pairs in the retained tail', async () => {
  const result = await compactAgentInputItems([
    userMessage('start'),
    userMessage('middle '.repeat(400)),
    functionCall('call-a'),
    functionResult('call-a', 'ok'),
    userMessage('tail'),
  ], {
    windowTokens: 100,
    keepHeadCount: 1,
    keepTailCount: 3,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.report.summarized, true)
  assert.deepEqual(itemTypes(result.items), ['message', 'message', 'function_call', 'function_call_result', 'message'])
})

test('compactAgentInputItems drops a reverse orphan result when its call falls outside the retained slice', async () => {
  const result = await compactAgentInputItems([
    userMessage('start'),
    functionCall('call-a'),
    userMessage('middle '.repeat(400)),
    functionResult('call-a', 'ok'),
    userMessage('tail'),
  ], {
    windowTokens: 100,
    keepHeadCount: 1,
    keepTailCount: 2,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.items.some((item) => getType(item) === 'function_call'), false)
  assert.equal(result.items.some((item) => getType(item) === 'function_call_result'), false)
})

test('normalizeSessionSnapshotForSeed keeps tool_search call_id pairs and removes orphan calls/results', () => {
  const normalized = normalizeSessionSnapshotForSeed([
    { type: 'tool_search_call', call_id: 'search-1', arguments: { query: 'docs' } } as AgentInputItem,
    { type: 'tool_search_output', call_id: 'search-1', tools: [{ name: 'read_docs' }] } as AgentInputItem,
    functionCall('orphan-call'),
    functionResult('orphan-result', 'late output'),
    userMessage('after'),
  ])

  assert.deepEqual(itemTypes(normalized), ['tool_search_call', 'tool_search_output', 'message'])
})

test('dropped tool calls remove immediately preceding reasoning items', async () => {
  const result = await compactAgentInputItems([
    { role: 'system', content: 'system' } as AgentInputItem,
    { type: 'reasoning', content: [{ type: 'input_text', text: 'about to call' }] } as AgentInputItem,
    functionCall('lost-call'),
    userMessage('tail '.repeat(200)),
  ], {
    windowTokens: 80,
    keepHeadCount: 2,
    keepTailCount: 1,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.items.some((item) => getType(item) === 'reasoning'), false)
  assert.equal(result.items.some((item) => getType(item) === 'function_call'), false)
})

test('oversized tool results are truncated without breaking their call/result pair (under real pressure)', async () => {
  const result = await compactAgentInputItems([
    functionCall('big-call'),
    functionResult('big-call', 'x'.repeat(2_000)),
  ], {
    // 2026-07-03 R1 合同修正：截断只在超过软线后发生 —— 这里把窗口压小到
    // 让 2000 字符结果真实越线，截断语义（保 call/result 对）保持不变。
    windowTokens: 600,
    maxToolResultTokens: 100,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.report.truncatedToolResults, 1)
  assert.deepEqual(itemTypes(result.items), ['function_call', 'function_call_result'])
  assert.match(String((result.items[1] as { output?: unknown }).output), /tool-result-truncated/)
})

test('R1 回归：低于软线时超限工具结果原样保留（动作后的读回执不得被无压力截断）', async () => {
  const bigMapResult = 'x'.repeat(2_000)
  const result = await compactAgentInputItems([
    functionCall('map-read'),
    functionResult('map-read', bigMapResult),
  ], {
    // 2000 字符 ≈ 数百 token，远低于 100k 窗口的 0.8 软线 —— 必须原样通过。
    windowTokens: 100_000,
    maxToolResultTokens: 100,
  })

  assert.equal(result.compacted, false)
  assert.equal(result.report.truncatedToolResults, 0)
  assert.equal(String((result.items[1] as { output?: unknown }).output), bigMapResult)
})

test('compactAgentInputItems keeps the latest user request with retained tail context', async () => {
  const latestRequest = 'LATEST_USER_REQUEST_KEEP_ME'
  const result = await compactAgentInputItems([
    userMessage('system seed'),
    userMessage('older context '.repeat(500)),
    functionCall('tail-call'),
    functionResult('tail-call', 'tail result'),
    userMessage(latestRequest),
  ], {
    windowTokens: 80,
    keepHeadCount: 1,
    keepTailCount: 3,
  })

  assert.equal(result.compacted, true)
  assert.ok(JSON.stringify(result.items).includes(latestRequest))
  assert.deepEqual(itemTypes(result.items).slice(-3), ['function_call', 'function_call_result', 'message'])
})

test('normalizeSessionSnapshotForSeed preserves retained request text while dropping orphan tool items', () => {
  const latestRequest = 'RESTORED_LATEST_USER_REQUEST'
  const normalized = normalizeSessionSnapshotForSeed([
    userMessage('head'),
    functionCall('complete'),
    functionResult('complete', 'ok'),
    functionCall('orphan'),
    userMessage(latestRequest),
  ])

  assert.deepEqual(itemTypes(normalized), ['message', 'function_call', 'function_call_result', 'message'])
  assert.ok(JSON.stringify(normalized).includes(latestRequest))
})

test('legacy skill catalogs are removed below the soft limit and from restored snapshot seeds', async () => {
  const catalog = systemMessage(
    buildSkillCatalogText([{ id: 'retired', name: 'Retired', description: 'no longer installed' }]),
  )
  const user = userMessage('keep the current request')

  const compacted = await compactAgentInputItems([catalog, user], { windowTokens: 200_000 })
  assert.equal(compacted.compacted, true)
  assert.equal(compacted.report.droppedItems, 1)
  assert.deepEqual(compacted.items, [user])
  assert.deepEqual(normalizeSessionSnapshotForSeed([catalog, user]), [user])
})

test('forced compaction persists legacy catalog removal even when every remaining item is retained', async () => {
  const catalog = systemMessage(
    buildSkillCatalogText([{ id: 'retired', name: 'Retired', description: 'no longer installed' }]),
  )
  const user = userMessage('keep the current request')

  const compacted = await compactAgentInputItems([catalog, user], {
    windowTokens: 200_000,
    keepTailCount: 8,
    force: true,
  })
  assert.equal(compacted.compacted, true)
  assert.equal(compacted.report.droppedItems, 1)
  assert.deepEqual(compacted.items, [user])
})

test('2026-07-23 失忆回归：压缩摘要携带确定性操作台账（搜索/写入/计划/助手摘录）', async () => {
  const filler = 'x'.repeat(400)
  const result = await compactAgentInputItems([
    userMessage('采集 18 个关键词'),
    namedCall('s1', 'browser_search', { query: 'vlog调色 高级感' }),
    functionResult('s1', filler),
    namedCall('s2', 'browser_search', { query: '剪映 进阶教程' }),
    functionResult('s2', filler),
    namedCall('r1', 'browser_research', { action: 'start', work_items: new Array(18).fill({ query: 'q' }) }),
    functionResult('r1', filler),
    namedCall('w1', 'file_write', { path: '/tmp/lib-a/样本库.md', content: filler }),
    functionResult('w1', 'ok'),
    namedCall('o1', 'browser_read', { target: 'page' }),
    functionResult('o1', filler),
    assistantMessage('第 2 个关键词已完成，继续第 3 个'),
    userMessage(`tail ${filler}`),
  ], {
    windowTokens: 400,
    keepHeadCount: 1,
    keepTailCount: 1,
  })

  assert.equal(result.report.summarized, true)
  const summary = String(
    (result.items.find((item) => JSON.stringify(item).includes('[ready:context-compacted]')) as {
      content?: unknown
    })?.content ?? '',
  )
  assert.match(summary, /确定性操作台账/)
  assert.match(summary, /已执行搜索（按序）：1\.vlog调色 高级感 2\.剪映 进阶教程/)
  assert.match(summary, /文件写入\/修改：file_write \/tmp\/lib-a\/样本库\.md/)
  assert.match(summary, /研究计划操作：start\(18 items\)/)
  assert.match(summary, /其余工具调用统计：browser_read×1/)
  assert.match(summary, /最近助手输出摘录：「第 2 个关键词已完成，继续第 3 个」/)
})

test('截断 stub 保留原文开头摘录，不再制造零内容信息真空', async () => {
  const result = await compactAgentInputItems([
    functionCall('big-call'),
    functionResult('big-call', `RESEARCH_PLAN_RECEIPT_HEAD ${'x'.repeat(2_000)}`),
  ], {
    windowTokens: 600,
    maxToolResultTokens: 100,
  })

  assert.equal(result.report.truncatedToolResults, 1)
  const output = String((result.items[1] as { output?: unknown }).output)
  assert.match(output, /tool-result-truncated/)
  assert.match(output, /截断前开头 600 字符/)
  assert.match(output, /RESEARCH_PLAN_RECEIPT_HEAD/)
})

test('2026-07-23 K3 400 回归：工具结果中的历史截图无条件驱逐，仅保留最新一张', async () => {
  // 复现真实数字：一张 1.4M 字符 base64 截图在语义估算里只计 1600 tokens，
  // 远低于软线，但按文本计 token 的 provider 会收全量字符 → HTTP 400。
  const bigImage = `data:image/png;base64,${'A'.repeat(1_400_000)}`
  const result = await compactAgentInputItems([
    userMessage('任务'),
    namedCall('shot-1', 'browser_status', {}),
    imageResult('shot-1', '第一次截图状态', bigImage),
    namedCall('shot-2', 'browser_status', {}),
    imageResult('shot-2', '第二次截图状态', bigImage),
    userMessage('tail'),
  ], {
    windowTokens: 272_000,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.report.truncatedToolResults, 1, '两张图驱逐旧的一张')
  const serialized = JSON.stringify(result.items)
  assert.equal(
    (serialized.match(/AAAAAAAAAA/g) || []).length > 0,
    true,
    '最新截图必须保留',
  )
  const firstOutput = JSON.stringify(result.items[2])
  assert.match(firstOutput, /stale-screenshot-evicted/, '旧截图被替换为占位符')
  assert.doesNotMatch(firstOutput, /AAAAAAAAAA/, '旧截图的 base64 必须被移除')
  const secondOutput = JSON.stringify(result.items[4])
  assert.match(secondOutput, /AAAAAAAAAA/, '最新截图原样保留')
  // 文本部分不受影响
  assert.match(firstOutput, /第一次截图状态/)
})

test('截图驱逐不动用户消息里的图片附件', async () => {
  const userImage = {
    role: 'user',
    content: [
      { type: 'input_text', text: '看这张图' },
      { type: 'input_image', image: `data:image/png;base64,${'B'.repeat(5_000)}` },
    ],
  } as AgentInputItem
  const result = await compactAgentInputItems([
    userImage,
    namedCall('shot-1', 'browser_status', {}),
    imageResult('shot-1', '状态', `data:image/png;base64,${'C'.repeat(5_000)}`),
  ], {
    windowTokens: 272_000,
  })

  assert.equal(result.report.truncatedToolResults, 0, '唯一一张工具截图是最新的，保留')
  assert.match(JSON.stringify(result.items[0]), /BBBBBBBBBB/, '用户附件图片不驱逐')
})

function imageResult(callId: string, text: string, imageDataUrl: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'browser_status',
    status: 'completed',
    output: [
      { type: 'input_text', text },
      { type: 'input_image', detail: 'auto', image: imageDataUrl },
    ],
  } as AgentInputItem
}

function userMessage(content: string): AgentInputItem {
  return { role: 'user', content } as AgentInputItem
}

function assistantMessage(content: string): AgentInputItem {
  return { role: 'assistant', content } as AgentInputItem
}

function namedCall(callId: string, name: string, args: Record<string, unknown>): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
  } as AgentInputItem
}

function systemMessage(content: string): AgentInputItem {
  return { role: 'system', content } as AgentInputItem
}

function functionCall(callId: string): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name: 'lookup',
    arguments: '{}',
  } as AgentInputItem
}

function functionResult(callId: string, output: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'lookup',
    status: 'completed',
    output,
  } as AgentInputItem
}

function itemTypes(items: AgentInputItem[]): string[] {
  return items.map((item) => getType(item) ?? 'message')
}

function getType(item: AgentInputItem): string | undefined {
  const type = (item as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}
