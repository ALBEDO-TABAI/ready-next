import assert from 'node:assert/strict'
import test from 'node:test'

import { RSSSubagentRunner } from '../main/modules/rss-engine/subagent-runner'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('rss-subagent-runner declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'rss-subagent-runner transitive sqlite guard')
})

type CompletionRequest = {
  system: string
  user: string
  maxTokens: number
  timeoutMs?: number
}

const COMPLETE_COPY_REPORT = [
  '## 一、TextContent Analysis 视角',
  '- 叙事结构分析：完整。',
  '- 叙事声音分析：完整。',
  '- 修辞手法识别：完整。',
  '- 词库提取：凉感、速干。',
  '',
  '## 二、Viral-Abstract-Script 视角',
  '- Viral-5D 诊断：完整。',
  '- 风格定位：完整。',
  '- 爆款潜力评估：完整。',
  '- 优化建议：完整。',
  '',
  '## 三、Brainstorming 视角',
  '- 核心价值拆解：完整。',
  '- 创意方向探索：完整。',
  '- 增量验证点：完整。',
].join('\n')

function patchComplete(
  runner: RSSSubagentRunner,
  handler: (request: CompletionRequest) => Promise<string>,
): CompletionRequest[] {
  const calls: CompletionRequest[] = []
  const mutable = runner as unknown as {
    complete: (request: CompletionRequest) => Promise<string>
  }
  mutable.complete = async (request) => {
    calls.push(request)
    return handler(request)
  }
  return calls
}

function copyInput() {
  return {
    title: '热到红温又怎样',
    link: 'https://www.bilibili.com/video/BV1h9Ln6DEJE/',
    source: 'browser-tab',
    extractedText: '身温不用慌 凉拌2.0 已经为你准备好了 速干防闷防晒 79元一件 朋友们快来试试吧',
  }
}

test('summarizeCopy retries when the model returns a truncated partial report', async () => {
  const runner = new RSSSubagentRunner()
  let attempt = 0
  const calls = patchComplete(runner, async () => {
    attempt += 1
    if (attempt === 1) {
      return [
        '## 一、TextContent Analysis 视角',
        '- 叙事结构分析：只写了第一章。',
      ].join('\n')
    }
    return COMPLETE_COPY_REPORT
  })

  const report = await runner.summarizeCopy(copyInput())

  assert.equal(calls.length, 2, 'partial reports should be retried once')
  assert.equal(calls[0].maxTokens, 2_400)
  assert.equal(calls[1].maxTokens, 3_200)
  assert.match(calls[1].user, /上一次输出不完整/)
  assert.match(report, /## 二、Viral-Abstract-Script 视角/)
  assert.match(report, /## 三、Brainstorming 视角/)
})

test('summarizeCopy retries when the first model request returns no text', async () => {
  const runner = new RSSSubagentRunner()
  let attempt = 0
  const calls = patchComplete(runner, async () => {
    attempt += 1
    return attempt === 1 ? '' : COMPLETE_COPY_REPORT
  })

  const report = await runner.summarizeCopy(copyInput())

  assert.equal(calls.length, 2, 'empty first responses should be retried once')
  assert.equal(calls[1].timeoutMs, 240_000)
  assert.match(calls[1].user, /没有返回完整内容/)
  assert.match(report, /## 三、Brainstorming 视角/)
})

test('summarizeCopy returns a transcript-grounded fallback when analysis retries stay incomplete', async () => {
  const runner = new RSSSubagentRunner()
  patchComplete(runner, async () => '## 一、TextContent Analysis 视角\n- 仍然只有第一章。')

  const report = await runner.summarizeCopy(copyInput())

  assert.match(report, /AI 深度分析未返回完整结果/)
  assert.match(report, /## 二、Viral-Abstract-Script 视角/)
  assert.match(report, /## 三、Brainstorming 视角/)
  assert.match(report, /凉拌/)
})

test('buildCopyDeliverables creates corrected transcript, report, and structured transcript', async () => {
  const runner = new RSSSubagentRunner()
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return '# 热到红温又怎样 校正文稿\n\n## 完整文稿\n\n体温不用慌，凉感T恤2.0已经为你准备好了。'
    }
    if (request.user.includes('分析报告:')) {
      return [
        '# 热到红温又怎样 结构化文字稿',
        '',
        '## 一、痛点开场',
        '',
        '体温不用慌，凉感T恤2.0已经为你准备好了。',
        '',
        '## 二、产品承诺',
        '',
        '凉感、速干、防闷、防晒，79元一件，朋友们快来试试吧。',
      ].join('\n')
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables(copyInput())

  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => (call.timeoutMs || 0) >= 120_000))
  assert.match(deliverables.correctedTranscript, /校正文稿/)
  assert.match(deliverables.report, /## 二、Viral-Abstract-Script 视角/)
  assert.match(deliverables.structuredTranscript, /结构化文字稿/)
})

test('buildCopyDeliverables reports stage progress between model calls', async () => {
  const runner = new RSSSubagentRunner()
  patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return '# 热到红温又怎样 校正文稿\n\n## 完整文稿\n\n体温不用慌，凉感T恤2.0已经为你准备好了。'
    }
    if (request.user.includes('分析报告:')) {
      return '# 热到红温又怎样 结构化文字稿\n\n## 一、完整口播\n\n体温不用慌，凉感T恤2.0已经为你准备好了。'
    }
    return COMPLETE_COPY_REPORT
  })
  const progress: number[] = []

  await runner.buildCopyDeliverables(copyInput(), {
    onProgress: (item) => progress.push(item.completed),
  })

  assert.deepEqual(progress, [2, 3, 4, 5])
})

test('buildCopyDeliverables wraps complete plain corrected transcript output', async () => {
  const runner = new RSSSubagentRunner()
  patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return '体温不用慌，凉感T恤2.0已经为你准备好了。速干防闷防晒，79元一件，朋友们快来试试吧。'
    }
    if (request.user.includes('分析报告:')) {
      return [
        '# 热到红温又怎样 结构化文字稿',
        '',
        '## 一、痛点开场',
        '',
        '体温不用慌，凉感T恤2.0已经为你准备好了。',
        '',
        '## 二、产品承诺',
        '',
        '速干防闷防晒，79元一件，朋友们快来试试吧。',
      ].join('\n')
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables(copyInput())

  assert.match(deliverables.correctedTranscript, /^# 热到红温又怎样 校正文稿/)
  assert.match(deliverables.correctedTranscript, /## 完整文稿/)
})

test('buildCopyDeliverables falls back to raw transcript when correction is incomplete', async () => {
  const runner = new RSSSubagentRunner()
  patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return ''
    }
    if (request.user.includes('分析报告:')) {
      return '# 热到红温又怎样 结构化文字稿\n\n## 一、完整口播\n\n身温不用慌 凉拌2.0 已经为你准备好了'
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables(copyInput())

  assert.match(deliverables.correctedTranscript, /^# 热到红温又怎样 校正文稿/)
  assert.match(deliverables.correctedTranscript, /身温不用慌/)
  assert.match(deliverables.report, /## 三、Brainstorming 视角/)
})

test('buildCopyDeliverables falls back when structured transcript is truncated', async () => {
  const runner = new RSSSubagentRunner()
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return [
        '# 热到红温又怎样 校正文稿',
        '',
        '## 完整文稿',
        '',
        '体温不用慌，凉感2.0已经为你准备好了。作为我们的王牌产品，凉感抗菌、速干、防螨、防晒、不易皱，全都给大家安排上。79元一件，朋友们快来试试吧。',
      ].join('\n')
    }
    if (request.user.includes('分析报告:')) {
      return '# 热到红温又怎样 结构化文字稿\n\n## 一、痛点引入\n\n体温不用慌，凉感2.0已经'
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables(copyInput())

  const structuredCalls = calls.filter((call) => call.user.includes('分析报告:'))
  assert.equal(structuredCalls.length, 2, 'truncated structured transcripts should be retried once')
  assert.match(structuredCalls[1].user, /上一次输出不完整/)
  assert.match(deliverables.structuredTranscript, /# 热到红温又怎样 结构化文字稿/)
  assert.match(deliverables.structuredTranscript, /## 一、完整口播/)
  assert.match(deliverables.structuredTranscript, /凉感2\.0/)
})
