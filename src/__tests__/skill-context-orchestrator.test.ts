import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import {
  getLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import type { SkillState } from '../main/modules/skills-runtime/runtime-manager'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

before(() => {
  __setScopeContextEpochDatabaseForTests({ getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never })
})
after(() => __setScopeContextEpochDatabaseForTests(null))

test('skill context orchestrator declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill context orchestrator transitive sqlite load')
})

function createOrchestrator() {
  return new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-copy-analyzer',
        name: 'Video Copy Analyzer',
        description: 'analyze copy',
        defaultAction: 'video_copy_analyze',
        actions: [{ name: 'video_copy_analyze', visibility: 'public' }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
    executeTool: async (_tool, _args) => 'STDOUT:\n技能说明',
  })
}

test('SkillContextOrchestrator builds preferred skill tool names from explicit skills', () => {
  const orchestrator = createOrchestrator()

  const toolNames = orchestrator.buildPreferredSkillToolNames('使用 video copy analyzer skill', 'scope-1')

  for (const retired of [
    'skill_get_state',
    'skill_submit_input',
    'skill_submit_confirmation',
    'skill_submit_agent_result',
    'skill_restart_from_step',
    'skill_cancel_execution',
  ]) {
    assert.equal(toolNames.includes(retired), false, `${retired} must stay retired`)
  }
  assert.ok(toolNames.includes('skill_video_copy_analyze'))
  for (const primitive of [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_export_artifact',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
  ]) {
    assert.ok(toolNames.includes(primitive), `${primitive} should be preferred for explicit reference-skill turns`)
  }
  assert.equal(
    toolNames.includes('skill_compact_context'),
    false,
    'skill_compact_context must stay limited to the context-compact skill',
  )
})

test('SkillContextOrchestrator routes referenced local file sends to send-im', () => {
  const sendImSkill = {
    id: 'send-im',
    name: 'Send IM',
    description: 'send local file to remote IM',
    defaultAction: 'send_file',
    actions: [{ name: 'send_file', visibility: 'public' }],
  } as any
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      sendImSkill,
      {
        id: 'notes-organizer',
        name: 'Notes Organizer',
        description: '整理学习笔记',
        defaultAction: 'read_skill',
        actions: [{ name: 'read_skill', visibility: 'public' }],
      } as any,
    ],
    resolveSkillToolByAction: (skillId, action) => ({
      name: skillId === 'send-im' && action === 'send_file' ? 'skill_send_im_file' : `skill_${action}`,
      action,
    }) as any,
  })

  const matched = orchestrator.findExplicitlyRequestedSkills('把@[《置身钉内》学习笔记拷貝.md]这个文件发到我微信')
  assert.deepEqual(matched.map((skill) => skill.id), ['send-im'])
  assert.ok(
    orchestrator
      .buildPreferredSkillToolNames('把@[《置身钉内》学习笔记拷貝.md]这个文件发到我微信', 'scope-send-im')
      .includes('skill_send_im_file'),
  )

  const recentMediaMatched = orchestrator.findExplicitlyRequestedSkills('把这四张图发到我微信')
  assert.deepEqual(recentMediaMatched.map((skill) => skill.id), ['send-im'])
  assert.ok(
    orchestrator
      .buildPreferredSkillToolNames('把这四张图发到我微信', 'scope-send-im')
      .includes('skill_send_im_file'),
  )

  assert.equal(
    orchestrator
      .findExplicitlyRequestedSkills('帮我整理@[《置身钉内》学习笔记拷貝.md]这个学习笔记')
      .some((skill) => skill.id === 'send-im'),
    false,
  )
  assert.equal(
    orchestrator
      .findExplicitlyRequestedSkills('帮我找一些图片资料发到微信')
      .some((skill) => skill.id === 'send-im'),
    false,
  )
})

test('SkillContextOrchestrator leaves compact authorization to the selected skill manifest', () => {
  const contextCompactSkill: SkillState = {
    id: 'context-compact',
    name: 'Context Compact',
    description: '手动压缩当前 Agent 会话上下文，释放模型上下文窗口',
    version: 'test',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    defaultAction: 'read_skill',
    executionMode: 'advisory',
    actions: [{
      name: 'read_skill',
      description: 'Read skill instructions',
      visibility: 'internal',
      runtime: 'reference',
      entry: 'SKILL.md',
      params: [],
    }],
  }
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [contextCompactSkill],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }),
  })

  const toolNames = orchestrator.buildPreferredSkillToolNames('使用 context compact 压缩当前上下文', 'scope-compact')

  assert.equal(toolNames.includes('skill_compact_context'), false)
  assert.equal(toolNames.includes('skill_context_compact_read_skill'), false)
})

test('SkillContextOrchestrator does not prefer the legacy embedded-python runner for reference skills', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: 'video analysis',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const toolNames = orchestrator.buildPreferredSkillToolNames('再重试使用 Video Expert Analyzer (VNext)', 'scope-1')

  assert.equal(toolNames.includes('system_run_embedded_python'), false)
  assert.equal(toolNames.includes('skill_video_expert_analyzer_read_skill'), false)
  for (const primitive of [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_export_artifact',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
  ]) {
    assert.ok(toolNames.includes(primitive), `${primitive} should stay available for reference skills`)
  }
})

test('SkillContextOrchestrator also recognizes 用 xxx style explicit skill requests', () => {
  const orchestrator = createOrchestrator()

  const matched = orchestrator.findExplicitlyRequestedSkills('用 video copy analyzer 来做')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-copy-analyzer')
})

test('SkillContextOrchestrator treats only exact lark-cli / Lark CLI names as code selection', () => {
  const larkCli = {
    id: 'lark-cli',
    name: 'lark-cli',
    description: '读写飞书云文档',
    defaultAction: 'read_skill',
    executionMode: 'advisory',
    actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
    requiredBins: ['lark-cli'],
  } as any
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      larkCli,
      {
        ...larkCli,
        id: 'lark-doc',
        name: 'lark-doc',
      },
      {
        ...larkCli,
        id: 'lark-sheets',
        name: 'lark-sheets',
        description: '读写飞书电子表格',
      },
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })
  const request = '用飞书 cli 读一下我名为 测试 0807 的文档，随便新增一列内容并填写一些内容，然后再在我的 第二季度工作总结 文档里润色一下'

  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills(request).map((skill) => skill.id),
    [],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Use Feishu CLI to read and edit the document.').map((skill) => skill.id),
    [],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Use Lark CLI to read and edit the document.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Use "lark-cli" to read and edit the Feishu document.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills("Use 'Feishu CLI' to update the spreadsheet.").map((skill) => skill.id),
    [],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('请用“Lark CLI”读取并更新飞书文档').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Use `lark-cli` to read the Feishu document.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('帮我读一下飞书文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('用飞书 CLI 更新文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('请帮我查看飞书 CLI 有没有登录'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('用飞书 cli 查一下我这周还有哪些安排'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('用飞书 CLI 创建一个日程'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('用飞书 CLI 上传本地文件到云盘'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Use lark-cli to create a calendar event.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Use lark-cli to upload a local file to Drive.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('用飞书 CLI 更新本地文件'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Use lark-cli to read this local file').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('用 Lark CLI 创建一个日程').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('用 Lark CLI 上传本地文件到云盘').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('不要用飞书 CLI，直接读取这份飞书文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('我明确要求不要在这次任务中使用任何本地飞书 CLI，直接读取飞书文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('Feishu CLI 在这个任务里无论如何都不要用；直接读取文档'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Do not use lark-cli; read the Feishu document directly.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills("I don't want to use lark-cli; read the Feishu document directly.").map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Never use Lark CLI; read the Feishu document directly.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('我不想用飞书 CLI，直接读取飞书文档'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('not using lark-cli to update the document').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('不是用飞书 CLI 更新文档'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills("don't run lark-cli to update the document").map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('do not execute feishu-cli to update the document'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills("I don't want lark-cli to update the document").map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('我不是要用飞书 CLI 更新文档'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Read the document mentioning lark-cli.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills("Summarize the Feishu document titled 'lark-cli installation guide'.").map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('总结飞书文档《lark-cli 安装指南》').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('总结《飞书 CLI 更新说明》文档'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('读取《Lark CLI 更新指南》这份飞书文档').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Read the Feishu document with lark-cli examples.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('总结飞书文档《lark-cli 登录状态说明》').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills("Summarize the Feishu document titled 'lark-cli login status guide'.").map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('Summarize the Feishu document about lark-cli login status.').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('总结关于 lark-cli 登录状态的飞书文档').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('阅读标题为“lark-cli 更新文档”的表格').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('总结名为“飞书 CLI 登录状态说明”的文档'), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('用 `lark-cli` 看登录状态').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('请用 “lark-cli” 更新飞书文档').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('lark-cli login status').map((skill) => skill.id),
    ['lark-cli'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('用飞书 CLI 读取配置文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('用飞书 CLI 总结《安装配置指南》文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('不要安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('别更新 CLI，直接用飞书 CLI 读取文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('不要配置命令行，直接用现有的飞书 CLI 读取文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('不安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('帮我安装并配置飞书 CLI'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('帮我安装 lark-cli'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('给飞书 CLI 配置文档权限'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('帮我安装飞书 CLI，然后读取文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('帮我更新飞书 CLI，再编辑文档'), [])
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('帮我安装最新版且适合当前 Apple Silicon Mac 的飞书 CLI，然后读取文档'), [])
})

test('SkillContextOrchestrator still selects a SKILL.md-only skill by exact name', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'notes-helper',
        name: 'Notes Helper',
        description: '整理笔记',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('用 Notes Helper 整理这篇笔记').map((skill) => skill.id),
    ['notes-helper'],
  )
  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills('帮我整理这篇笔记'), [])
})

test('SkillContextOrchestrator recognizes 按 xxx 写 without explicit connector word', () => {
  const orchestrator = createOrchestrator()

  const matched = orchestrator.findExplicitlyRequestedSkills('按 video_copy_analyzer 为我写这段')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-copy-analyzer')
})

test('SkillContextOrchestrator recognizes bare skill id mentions without any connector', () => {
  const orchestrator = createOrchestrator()

  const matched = orchestrator.findExplicitlyRequestedSkills('video copy analyzer 续写这段')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-copy-analyzer')
})

test('SkillContextOrchestrator recognizes uppercase acronyms as skill aliases', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: 'video analysis',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const matched = orchestrator.findExplicitlyRequestedSkills('VEA 继续')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-expert-analyzer')
})

test('SkillContextOrchestrator prefers explicitly named skills over fuzzy description matches', () => {
  _resetLastReferenceSkillHintsForTests()
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: '长视频深度分析与场景评分',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      },
      {
        id: 'video-copy-analyzer',
        name: 'Video Copy Analyzer',
        description: '视频分析与文案拆解',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      },
    ] as any,
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })
  const sessionId = 'explicit-skill-outranks-fuzzy'
  const userText = '用 @[Video Expert Analyzer (VNext)]分析@[Inside Notion SF Office - YouTube]，输出到@[测试]'

  const matched = orchestrator.findExplicitlyRequestedSkills(userText)
  assert.deepEqual(matched.map((skill) => skill.id), ['video-expert-analyzer'])

  assert.equal(orchestrator.rememberExplicitReferenceSkillHint(userText, sessionId), true)
  assert.equal(getLastReferenceSkill(sessionId)?.id, 'video-expert-analyzer')
})

test('SkillContextOrchestrator leaves description-based selection to the model skill catalog', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'media-scene-review',
        name: 'Media Scene Review',
        description: '长视频深度分析与场景评分',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const matched = orchestrator.findExplicitlyRequestedSkills(
    '分析这个视频 https://www.youtube.com/watch?v=4qkyxm4jppc，输出到 /Users/me/测试',
  )

  assert.deepEqual(matched, [])
})

test('SkillContextOrchestrator does not mislabel generic brand research as an explicit GitHub or OKF skill request', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'github-deep-research',
        name: 'GitHub Deep Research',
        description: 'GitHub 项目调研方法论：仓库 + issue + 贡献者 + 依赖图',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      },
      {
        id: 'okf-bundle',
        name: 'OKF Bundle',
        description: '把指定范围的资料提炼成单个知识包并登记索引',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      },
      {
        id: 'deep-research',
        name: 'Deep Research',
        description: '系统化多源研究方法论：维度拆解、多查询、全文抓取、引用追踪',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      },
    ] as any,
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })
  const request = '帮我调研一下宝矿力的广告，从一开始出名到现在，梳理知名人物、作品、风格与项目，分别分析并整理为多份文件和索引，存到@[宝矿力]'

  assert.deepEqual(orchestrator.findExplicitlyRequestedSkills(request), [])
  assert.deepEqual(
    orchestrator.findExplicitlyRequestedSkills('用 github-deep-research 分析这个仓库').map((skill) => skill.id),
    ['github-deep-research'],
  )
})

test('SkillContextOrchestrator ignores generic helper terms in fuzzy skill description matches', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'image-analysis-router',
        name: 'image-analysis-router',
        description: 'Route image-heavy requests. Trigger on requests such as "帮我看这页PPT".',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const matched = orchestrator.findExplicitlyRequestedSkills(
    '再帮我新开一个文档把下面内容转为详细地分镜描述，每一行都是一个镜头：\n' +
      'a厕所前对镜自拍检查\n' +
      'a：完了，熬夜改PPT，脸垮的能拖到地上。',
  )

  assert.deepEqual(matched.map((skill) => skill.id), [])
})

test('SkillContextOrchestrator filters out short skill tokens below length threshold', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'rss',
        name: 'RSS',
        description: 'rss',
        defaultAction: 'run',
        actions: [{ name: 'run', visibility: 'public' }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
    executeTool: async () => 'STDOUT:\n技能说明',
  })

  const matched = orchestrator.findExplicitlyRequestedSkills('rss 是一种格式')
  assert.equal(matched.length, 0)
})
