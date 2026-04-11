import { describe, it } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import type { ConversationScope } from '../main/modules/agent-control/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-test-1',
    agent: 'butler',
    title: '测试 Scope',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'thread-test-1',
    meta: {},
    createdAt: '2026-03-08T10:00:00.000Z',
    updatedAt: '2026-03-08T10:00:00.000Z',
    lastMessageAt: '2026-03-08T10:00:00.000Z',
  }
}

function createChannelScope(): ConversationScope {
  return {
    id: 'scope-channel-1',
    agent: 'butler',
    title: '飞书线程',
    sourceKind: 'channel',
    sourceId: 'feishu',
    threadKey: 'thread-channel-1',
    meta: {},
    createdAt: '2026-03-08T10:00:00.000Z',
    updatedAt: '2026-03-08T10:00:00.000Z',
    lastMessageAt: '2026-03-08T10:00:00.000Z',
  }
}

describe('PromptAssemblyService', () => {
  it('builds l0/l1 context and keeps generic runs free of l2 trigger payloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-assembly-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'memory', '2026-03-08.md'), '## daily\n- drafted a script', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [
        { role: 'user', content: '请帮我整理今天的选题' },
        { role: 'assistant', content: '我先给你一版提纲。' },
      ],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '帮我整理一版内容提纲',
    })

    assert.match(result.systemPrompt, /L0 常驻记忆/)
    assert.strictEqual(result.triggerHits.length, 0)
    assert.ok(result.memoryRefs.some((item) => item.layer === 'l0'))
    assert.ok(result.memoryRefs.some((item) => item.layer === 'l1'))
    assert.ok(result.bootstrapMessages.some((item) => item.includes('L1 会话上下文')))

    rmSync(root, { recursive: true, force: true })
  })

  it('loads blocking l2 refs when feishu doc trigger is hit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-feishu-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'feishu-rules.md'), '# Feishu\n必须先确认目标空间。', 'utf8')
    writeFileSync(join(root, 'docs', 'accounts.md'), '# Accounts\n租户映射仅按需读取。', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请创建飞书文档并插入一张图片',
    })

    assert.ok(result.triggerHits.some((item) => item.id === 'feishu-doc' && item.blocking))
    assert.ok(result.triggerHits.some((item) => item.id === 'feishu-image' && item.blocking))
    assert.ok(result.memoryRefs.some((item) => item.layer === 'l2' && item.title.includes('飞书')))
    assert.ok(result.bootstrapMessages.some((item) => item.includes('L2 按需规则')))

    rmSync(root, { recursive: true, force: true })
  })

  it('drops low-priority l2 refs when trigger payload exceeds budget and records writebacks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-budget-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })

    const largeBlock = `${'规则段落 '.repeat(1200)}\n`
    writeFileSync(join(root, 'docs', 'feishu-rules.md'), largeBlock, 'utf8')
    writeFileSync(join(root, 'docs', 'accounts.md'), largeBlock, 'utf8')
    writeFileSync(join(root, 'docs', 'browser-rules.md'), largeBlock, 'utf8')
    writeFileSync(join(root, 'docs', 'document-rules.md'), largeBlock, 'utf8')
    writeFileSync(join(root, 'docs', 'video-rules.md'), largeBlock, 'utf8')
    writeFileSync(join(root, 'docs', 'rss-rules.md'), largeBlock, 'utf8')
    writeFileSync(join(root, 'docs', 'calendar-rules.md'), largeBlock, 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请创建飞书文档并上传图片，然后在浏览器提交内容、保存文档、渲染视频、分析 RSS，并创建日程',
    })

    assert.ok(result.contextBudget.totalChars <= 16000)
    assert.ok(result.contextBudget.droppedRefs.length > 0)

    service.recordRunOutcome({
      scope: createScope(),
      finalText: '完成了跨模块动作，保留诊断信息。',
      usedTools: ['feishu.doc', 'browser.upload', 'calendar.create'],
      success: true,
    })

    const outcomePath = join(root, 'memory', '2026-03-08.md')
    const content = readFileSync(outcomePath, 'utf8')
    assert.match(content, /scope: 测试 Scope/)
    assert.match(content, /feishu\.doc/)

    rmSync(root, { recursive: true, force: true })
  })

  it('creates memory directory on demand and keeps writebacks non-blocking', () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-writeback-'))
    mkdirSync(join(root, 'docs'), { recursive: true })

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    service.recordRunOutcome({
      scope: createScope(),
      finalText: '第一次写回仍应成功。',
      usedTools: ['design.composeSocialCover'],
      success: true,
    })

    const outcomePath = join(root, 'memory', '2026-03-08.md')
    const content = readFileSync(outcomePath, 'utf8')
    assert.match(content, /design\.composeSocialCover/)

    rmSync(root, { recursive: true, force: true })
  })

  it('reports prompt-side history compression without changing the bootstrap contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-compression-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [
        { role: 'user', content: '用户消息 '.repeat(80) },
        { role: 'assistant', content: '助手回复 '.repeat(80) },
        { role: 'user', content: '继续补充 '.repeat(80) },
        { role: 'assistant', content: '继续处理 '.repeat(80) },
      ],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '继续整理',
    })

    assert.equal(result.compression?.historyCompressed, true)
    assert.equal(result.compression?.toolTraceCompressed, false)
    assert.equal(result.compression?.artifactSummaryUsed, false)
    assert.ok(result.bootstrapMessages.some((item) => item.includes('L1 会话上下文')))

    rmSync(root, { recursive: true, force: true })
  })

  it('ensures custom memory roots materialize daily memory files and expose them as local scope refs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-custom-root-'))

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '帮我继续整理今天的设计思路',
    })

    assert.ok(result.memoryRefs.some((item) => item.path === 'memory/2026-03-08.md'))
    assert.ok(result.memoryRefs.some((item) => item.path === 'memory/2026-03-07.md'))
    assert.equal(existsSync(join(root, 'docs')), true)
    assert.equal(existsSync(join(root, 'memory')), true)
    assert.equal(existsSync(join(root, 'memory', '2026-03-08.md')), true)
    assert.equal(existsSync(join(root, 'memory', '2026-03-07.md')), true)

    rmSync(root, { recursive: true, force: true })
  })

  it('keeps same-day global logs available for fresh local scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-local-isolation-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'memory', '2026-03-08.md'), '## daily\n- 上一轮对话在讨论广州天气', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '新开会话，帮我写标题',
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n')
    assert.match(joinedBootstrap, /广州天气/)
    assert.ok(result.memoryRefs.some((item) => item.path === 'memory/2026-03-08.md'))

    rmSync(root, { recursive: true, force: true })
  })

  it('keeps same-day global logs available for channel scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-channel-memory-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'memory', '2026-03-08.md'), '## daily\n- 渠道线程的上下文摘要', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createChannelScope(),
      message: '继续处理渠道消息',
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n')
    assert.match(joinedBootstrap, /渠道线程的上下文摘要/)
    assert.ok(result.memoryRefs.some((item) => item.path === 'memory/2026-03-08.md'))

    rmSync(root, { recursive: true, force: true })
  })
})
