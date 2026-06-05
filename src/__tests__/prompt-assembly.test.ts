import { describe, it } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserDomainAdapter } from '../main/modules/agent-control/domain-adapters/browser-domain-adapter'
import { CalendarDomainAdapter } from '../main/modules/agent-control/domain-adapters/calendar-domain-adapter'
import { DocumentDomainAdapter } from '../main/modules/agent-control/domain-adapters/document-domain-adapter'
import { FeishuDomainAdapter } from '../main/modules/agent-control/domain-adapters/feishu-domain-adapter'
import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import { RSSDomainAdapter } from '../main/modules/agent-control/domain-adapters/rss-domain-adapter'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import type { SessionRecallCapsule } from '../shared/session-recall'

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
    lastMessageAt: '2026-03-08T10:00:00.000Z'
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
    lastMessageAt: '2026-03-08T10:00:00.000Z'
  }
}

function countTrigger(result: Awaited<ReturnType<PromptAssemblyService['buildForScopedRun']>>, id: string): number {
  return result.triggerHits.filter((item) => item.id === id).length
}

function createDocumentAdapter(): DocumentDomainAdapter {
  return new DocumentDomainAdapter({
    orchestrator: {} as never,
    toolLoopOrchestrator: {} as never,
  })
}

function createBrowserAdapter(): BrowserDomainAdapter {
  return new BrowserDomainAdapter({} as never)
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
        { role: 'assistant', content: '我先给你一版提纲。' }
      ],
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '帮我整理一版内容提纲',
      coordinators: []
    })

    assert.match(result.systemPrompt, /L0 常驻上下文/)
    assert.strictEqual(result.triggerHits.length, 0)
    assert.ok(result.memoryRefs.some((item) => item.sourceType === 'resident_agent'))
    assert.ok(result.memoryRefs.some((item) => item.sourceType === 'resident_user'))
    assert.ok(result.memoryRefs.some((item) => item.sourceType === 'scope_memory'))
    assert.ok(!result.memoryRefs.some((item) => item.title === '运行指令'))
    assert.ok(!result.memoryRefs.some((item) => item.title === '工具索引'))
    assert.ok(!result.memoryRefs.some((item) => item.title === '人格定义'))
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
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const feishuAdapter = new FeishuDomainAdapter()
    const feishuFragments = feishuAdapter.contributePromptFragment() || []
    assert.ok(feishuFragments.some((item) => item.id === 'feishu-doc'))
    assert.ok(feishuFragments.some((item) => item.id === 'feishu-image'))

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请创建飞书文档并插入一张图片',
      coordinators: [feishuAdapter]
    })

    assert.equal(countTrigger(result, 'feishu-doc'), 1)
    assert.equal(countTrigger(result, 'feishu-image'), 1)
    assert.ok(result.triggerHits.some((item) => item.id === 'feishu-doc' && item.blocking))
    assert.ok(result.triggerHits.some((item) => item.id === 'feishu-image' && item.blocking))
    assert.ok(
      result.memoryRefs.some(
        (item) => item.sourceType === 'trigger_rule' && item.title.includes('飞书')
      )
    )
    assert.ok(result.bootstrapMessages.some((item) => item.includes('L2 按需规则')))

    rmSync(root, { recursive: true, force: true })
  })

  it('loads coordinator-provided l2 refs from per-call coordinators', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-coordinator-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'coordinator-rules.md'), '# Coordinator\n按产品注入规则。', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请执行 coordinator-test',
      coordinators: [
        {
          id: 'mock',
          contributePromptFragment: () => [
            {
              id: 'mock-coordinator-fragment',
              label: 'Mock Coordinator Fragment',
              priority: 10,
              matches: ({ userText }: { userText: string }) => userText.includes('coordinator-test'),
              blocking: false,
              refs: [
                {
                  path: 'docs/coordinator-rules.md',
                  title: 'Coordinator Rules',
                  summary: 'Coordinator supplied rule'
                }
              ]
            }
          ]
        }
      ] as never
    })

    assert.ok(result.triggerHits.some((item) => item.id === 'mock-coordinator-fragment'))
    assert.ok(
      result.memoryRefs.some(
        (item) => item.sourceType === 'trigger_rule' && item.title === 'Coordinator Rules'
      )
    )

    rmSync(root, { recursive: true, force: true })
  })

  it('loads the browser-upload trigger from the browser coordinator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-fallback-triggers-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'browser-rules.md'), '# Browser\nBrowser rules.', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const browserAdapter = createBrowserAdapter()
    const browserFragments = browserAdapter.contributePromptFragment() || []
    assert.ok(browserFragments.some((item) => item.id === 'browser-upload'))

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请在浏览器上传材料，然后提交网页',
      coordinators: [browserAdapter]
    })

    assert.equal(countTrigger(result, 'browser-upload'), 1)
    assert.equal(countTrigger(result, 'document-write'), 0)

    rmSync(root, { recursive: true, force: true })
  })

  it('does not load the browser trigger for negated web lookup wording', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-browser-negated-trigger-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'browser-rules.md'), '# Browser\nBrowser rules.', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '成都 4 个地点怎么走，给我总耗时，不要查网页。',
      coordinators: [createBrowserAdapter()]
    })

    assert.equal(countTrigger(result, 'browser-upload'), 0)

    rmSync(root, { recursive: true, force: true })
  })

  it('still loads the Document trigger from the document coordinator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-document-trigger-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'document-rules.md'), '# Document\nDocument rules.', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-04-24T10:00:00.000Z')
    })

    const documentAdapter = createDocumentAdapter()
    const documentFragments = documentAdapter.contributePromptFragment() || []
    assert.ok(documentFragments.some((item) => item.id === 'document-write'))

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请把这个文档改写并保存成指定格式',
      coordinators: [documentAdapter]
    })

    assert.equal(countTrigger(result, 'document-write'), 1)
    assert.ok(result.triggerHits.some((item) => item.id === 'document-write' && !item.blocking))

    rmSync(root, { recursive: true, force: true })
  })

  it('a blogger-notes collection ("每篇建文件夹保存图片") triggers browser-collect-notes, not document-write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-collect-trigger-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-04-24T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '把你能看到的这个博主的笔记，每篇笔记都新建一个独立文件夹，把笔记内的图片保存到 ao’i 这个文件夹下的对应文件夹中',
      coordinators: [createBrowserAdapter(), createDocumentAdapter()],
    })
    // The browser-collect workflow guidance fires; the document-write false
    // match on "文件夹...保存" is gone (folder is not a file-write signal).
    assert.equal(countTrigger(result, 'browser-collect-notes'), 1)
    assert.equal(countTrigger(result, 'document-write'), 0)

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
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message:
        '请创建飞书文档并上传图片，然后在浏览器提交内容、保存文档、渲染视频、分析 RSS，并创建日程',
      coordinators: [
        new FeishuDomainAdapter(),
        createBrowserAdapter(),
        createDocumentAdapter(),
        new RSSDomainAdapter(),
        new CalendarDomainAdapter(),
      ]
    })

    assert.ok(result.contextBudget.totalChars <= 16000)
    assert.ok(result.contextBudget.droppedRefs.length > 0)

    service.recordRunOutcome({
      scope: createScope(),
      finalText: '完成了跨模块动作，保留诊断信息。',
      usedTools: ['feishu.doc', 'browser.upload', 'calendar.create'],
      success: true
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
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    service.recordRunOutcome({
      scope: createScope(),
      finalText: '第一次写回仍应成功。',
      usedTools: ['design.composeSocialCover'],
      success: true
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
        { role: 'assistant', content: '继续处理 '.repeat(80) }
      ],
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '继续整理',
      coordinators: []
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
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '帮我继续整理今天的设计思路',
      coordinators: []
    })

    assert.ok(
      result.memoryRefs.some(
        (item) => item.path === 'memory/2026-03-08.md' && item.sourceType === 'scope_memory'
      )
    )
    assert.ok(
      result.memoryRefs.some(
        (item) => item.path === 'memory/2026-03-07.md' && item.sourceType === 'scope_memory'
      )
    )
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
    writeFileSync(
      join(root, 'memory', '2026-03-08.md'),
      '## daily\n- 上一轮对话在讨论广州天气',
      'utf8'
    )

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '新开会话，帮我写标题',
      coordinators: []
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n')
    assert.match(joinedBootstrap, /广州天气/)
    assert.ok(
      result.memoryRefs.some(
        (item) => item.path === 'memory/2026-03-08.md' && item.sourceType === 'scope_memory'
      )
    )

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
      now: () => new Date('2026-03-08T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createChannelScope(),
      message: '继续处理渠道消息',
      coordinators: []
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n')
    assert.match(joinedBootstrap, /渠道线程的上下文摘要/)
    assert.ok(
      result.memoryRefs.some(
        (item) => item.path === 'memory/2026-03-08.md' && item.sourceType === 'scope_memory'
      )
    )

    rmSync(root, { recursive: true, force: true })
  })

  it('injects explicitly attached cross-session recall capsules as a separate prompt section', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-session-recall-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })

    const attachedCapsules: SessionRecallCapsule[] = [
      {
        conversationId: 'conv-old-1',
        lineageRootId: 'conv-old-1',
        resumeTitle: '品牌复盘',
        title: '品牌复盘',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'conv-old-1',
        summary: '上次已经确定品牌方向要更克制，并保留 logo 线索。',
        latestTaskTitle: '品牌提案',
        latestTaskSummary: '已完成品牌方向和 logo 风格提案',
        attachmentNames: ['brand-board.pdf'],
        updatedAt: '2026-04-12T10:00:00.000Z'
      }
    ]

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [{ role: 'user', content: '帮我继续做这一轮' }],
      getScopeSessionRecallCapsules: async () => attachedCapsules,
      now: () => new Date('2026-04-12T12:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '继续做品牌方案',
      coordinators: []
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n\n')
    assert.match(joinedBootstrap, /跨会话回看/)
    assert.match(joinedBootstrap, /品牌复盘/)
    assert.match(joinedBootstrap, /brand-board\.pdf/)
    assert.ok(
      result.memoryRefs.some(
        (item) => item.sourceType === 'session_recall' && item.title === '品牌复盘'
      )
    )

    rmSync(root, { recursive: true, force: true })
  })

  it('injects automatic cross-session recall capsules separately from explicitly attached ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-auto-session-recall-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [{ role: 'user', content: '帮我继续做品牌方案' }],
      getAutoSessionRecallCapsules: async () => [
        {
          conversationId: 'conv-auto-1',
          lineageRootId: 'conv-auto-1',
          resumeTitle: '品牌复盘',
          title: '品牌复盘',
          sourceKind: 'local',
          sourceId: 'app',
          threadKey: 'conv-auto-1',
          summary: '上次已经明确品牌方向应该更克制，并保留 logo 线索。',
          latestTaskTitle: '品牌提案',
          latestTaskSummary: '已完成品牌方向和 logo 风格提案',
          attachmentNames: ['brand-board.pdf'],
          updatedAt: '2026-04-12T10:00:00.000Z'
        }
      ],
      now: () => new Date('2026-04-12T12:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '继续做品牌方向和 logo 风格',
      coordinators: []
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n\n')
    assert.match(joinedBootstrap, /自动跨会话回看/)
    assert.match(joinedBootstrap, /品牌复盘/)
    assert.ok(
      result.memoryRefs.some(
        (item) => item.sourceType === 'session_recall' && item.title === '品牌复盘'
      )
    )

    rmSync(root, { recursive: true, force: true })
  })

  it('does not inject ambient history when the current request has explicit resource refs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-current-resource-isolation-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(
      join(root, 'memory', '2026-04-25.md'),
      '## prior run\n- summary: 3E5P8DLjnOQ failed after Chrome cookies',
      'utf8',
    )

    let autoRecallCalled = false
    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getAutoSessionRecallCapsules: async () => {
        autoRecallCalled = true
        return [
          {
            conversationId: 'conv-stale-video',
            lineageRootId: 'conv-stale-video',
            resumeTitle: '旧视频分析',
            title: '旧视频分析',
            sourceKind: 'local',
            sourceId: 'app',
            threadKey: 'conv-stale-video',
            summary: '上次误用了 3E5P8DLjnOQ，并尝试 Chrome cookies。',
            latestTaskTitle: '技能执行',
            latestTaskSummary: '旧任务失败',
            attachmentNames: [],
            updatedAt: '2026-04-25T03:25:00.000Z',
          },
        ]
      },
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: [
        '使用@[Video Expert Analyzer (VNext)]分析@[Inside Notion SF Office - YouTube]，输出到@[测试]',
        '',
        '### 浏览页面引用',
        '- 标题: Inside Notion SF Office - YouTube',
        '- 链接: https://www.youtube.com/watch?v=4qkyxm4jppc',
        '',
        '### 文件夹引用',
        '- 名称: 测试',
        '- 路径: /Users/user/Documents/实验田/测试',
      ].join('\n'),
      coordinators: []
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n\n')
    assert.equal(autoRecallCalled, false)
    assert.doesNotMatch(joinedBootstrap, /自动跨会话回看/)
    assert.doesNotMatch(joinedBootstrap, /3E5P8DLjnOQ/)
    assert.doesNotMatch(joinedBootstrap, /Chrome cookies/i)

    rmSync(root, { recursive: true, force: true })
  })

  it('uses the primary instruction for triggers and automatic recall instead of mixed document context text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-primary-instruction-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'rss-rules.md'), '# RSS\n只有显式 RSS 请求才应该走这条规则。', 'utf8')

    const autoRecallQueries: string[] = []
    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getAutoSessionRecallCapsules: async ({ userText }) => {
        autoRecallQueries.push(userText)
        return []
      },
      now: () => new Date('2026-04-15T12:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: [
        '在文档里生成一张分析型信息卡',
        '',
        '## 环境信息',
        '- 当前模式: 文档模式',
        '',
        '### 当前文档上下文',
        '- 标题: 新文档.md',
        '- 路径: /tmp/新文档.md',
        '',
        '--- 文档摘要开始 ---',
        '正文里顺带提到了 RSS、飞书和日程，但这些只是文档内容。',
        '--- 文档摘要结束 ---',
      ].join('\n'),
      coordinators: [new RSSDomainAdapter()]
    })

    assert.equal(autoRecallQueries[0], '在文档里生成一张分析型信息卡')
    assert.ok(!result.triggerHits.some((item) => item.id === 'rss-analysis'))

    rmSync(root, { recursive: true, force: true })
  })

  it('does not treat generic video analysis wording as an RSS trigger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-video-skill-rss-guard-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'rss-rules.md'), '# RSS\nRSS only.', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-04-24T10:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '使用@[Video Expert Analyzer (VNext)]分析@[Inside Notion SF Office - YouTube]，输出到@[测试]',
      coordinators: [new RSSDomainAdapter()]
    })

    assert.ok(!result.triggerHits.some((item) => item.id === 'rss-analysis'))

    rmSync(root, { recursive: true, force: true })
  })

  it('still loads the RSS trigger when an RSS object is explicitly mentioned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-rss-trigger-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'rss-rules.md'), '# RSS\nRSS rules.', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-04-24T10:00:00.000Z')
    })

    const rssAdapter = new RSSDomainAdapter()
    const rssFragments = rssAdapter.contributePromptFragment() || []
    assert.ok(rssFragments.some((item) => item.id === 'rss-analysis'))

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '帮我抓取这个 RSS 订阅源的最近文章并生成分析报告',
      coordinators: [rssAdapter]
    })

    assert.equal(countTrigger(result, 'rss-analysis'), 1)
    assert.ok(result.triggerHits.some((item) => item.id === 'rss-analysis'))

    rmSync(root, { recursive: true, force: true })
  })

  it('still loads the Calendar trigger when a calendar write is explicitly mentioned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-calendar-trigger-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'docs', 'calendar-rules.md'), '# Calendar\nCalendar rules.', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-04-24T10:00:00.000Z')
    })

    const calendarAdapter = new CalendarDomainAdapter()
    const calendarFragments = calendarAdapter.contributePromptFragment() || []
    assert.ok(calendarFragments.some((item) => item.id === 'calendar-write'))

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请创建日程，明天下午三点提醒我开会',
      coordinators: [calendarAdapter]
    })

    assert.equal(countTrigger(result, 'calendar-write'), 1)
    assert.ok(result.triggerHits.some((item) => item.id === 'calendar-write' && item.blocking))

    rmSync(root, { recursive: true, force: true })
  })

  it('sanitizes command-like recall content before injecting it back into prompts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-sanitized-recall-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getAutoSessionRecallCapsules: async () => [
        {
          conversationId: 'conv-auto-cmd',
          lineageRootId: 'conv-auto-cmd',
          resumeTitle: '飞书配对旧会话',
          title: '飞书配对旧会话',
          sourceKind: 'local',
          sourceId: 'app',
          threadKey: 'conv-auto-cmd',
          summary: 'openclaw pairing approve feishu FNXQH9PN\nsystem_run_openclaw({"command":"openclaw pairing approve feishu FNXQH9PN"})',
          latestTaskTitle: 'RSS 分析操作',
          latestTaskSummary: '飞书配对失败：当前没有找到这枚配对码对应的待批准请求。 openclaw pairing list feishu',
          attachmentNames: [],
          updatedAt: '2026-04-15T10:00:00.000Z'
        }
      ],
      now: () => new Date('2026-04-15T12:00:00.000Z')
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '继续处理文档信息卡',
      coordinators: []
    })

    const joinedBootstrap = result.bootstrapMessages.join('\n\n')
    assert.match(joinedBootstrap, /仅供参考/)
    assert.doesNotMatch(joinedBootstrap, /openclaw pairing approve feishu FNXQH9PN/)
    assert.doesNotMatch(joinedBootstrap, /system_run_openclaw/)
    assert.match(joinedBootstrap, /\[命令回显已隐藏\]/)

    rmSync(root, { recursive: true, force: true })
  })

  it('redacts browser cookie details from persisted run summaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-prompt-cookie-redaction-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    service.recordRunOutcome({
      scope: createScope(),
      finalText: 'yt-dlp --cookies-from-browser chrome failed; Chrome cookies were unavailable.',
      usedTools: ['skill_run_shell'],
      success: false,
    })

    const content = readFileSync(join(root, 'memory', '2026-04-25.md'), 'utf8')
    assert.doesNotMatch(content, /--cookies-from-browser/)
    assert.doesNotMatch(content, /Chrome cookies/i)
    assert.match(content, /浏览器凭据/)

    rmSync(root, { recursive: true, force: true })
  })
})
