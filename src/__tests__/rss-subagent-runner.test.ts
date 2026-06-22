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

test('buildCopyDeliverables rejects fallback copy analysis instead of producing a fake report', async () => {
  const runner = new RSSSubagentRunner()
  patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) return '体温不用慌，凉感T恤2.0已经为你准备好了。'
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({ sections: [{ title: '完整口播', anchor: '体温不用慌' }] })
    }
    return '## 一、TextContent Analysis 视角\n- 仍然只有第一章。'
  })

  await assert.rejects(
    () => runner.buildCopyDeliverables(copyInput()),
    /未能生成符合技能合同的三维度文案分析报告/,
  )
})

test('buildCopyDeliverables creates corrected transcript, report, and structured transcript', async () => {
  const runner = new RSSSubagentRunner()
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return '# 热到红温又怎样 校正文稿\n\n## 完整文稿\n\n体温不用慌，凉感T恤2.0已经为你准备好了。速干防闷防晒，79元一件，朋友们快来试试吧。'
    }
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({
        sections: [
          { title: '痛点开场', anchor: '体温不用慌' },
          { title: '产品承诺', anchor: '速干防闷防晒' },
        ],
      })
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables(copyInput())

  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => (call.timeoutMs || 0) >= 120_000))
  assert.match(calls.find((call) => call.user.includes('TextContent Analysis'))?.user || '', /阶段 4: 三维度综合分析/)
  assert.match(calls.find((call) => call.user.includes('请输出 JSON'))?.user || '', /阶段 5: 结构化文字稿/)
  assert.match(deliverables.correctedTranscript, /校正文稿/)
  assert.match(deliverables.report, /## 二、Viral-Abstract-Script 视角/)
  assert.match(deliverables.structuredTranscript, /结构化文字稿/)
})

test('buildCopyDeliverables strips transcript markdown wrapper before analysis prompts', async () => {
  const runner = new RSSSubagentRunner()
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) return ''
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({ sections: [{ title: '完整口播', anchor: '第一句' }] })
    }
    return COMPLETE_COPY_REPORT
  })

  await runner.buildCopyDeliverables({
    ...copyInput(),
    extractedText: '# 视频语音转录文字稿\n\n## 正文\n\n第一句，这是正文。\n第二句，继续正文。',
  })

  const summaryCall = calls.find((call) => call.user.includes('TextContent Analysis'))
  assert.ok(summaryCall, 'summary prompt should run')
  assert.doesNotMatch(summaryCall!.user, /# 视频语音转录文字稿/)
  assert.doesNotMatch(summaryCall!.user, /## 正文/)
  assert.match(summaryCall!.user, /第一句，这是正文。\s*第二句，继续正文。/)
})

test('buildCopyDeliverables reports stage progress between model calls', async () => {
  const runner = new RSSSubagentRunner()
  patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return '# 热到红温又怎样 校正文稿\n\n## 完整文稿\n\n体温不用慌，凉感T恤2.0已经为你准备好了。'
    }
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({ sections: [{ title: '完整口播', anchor: '体温不用慌' }] })
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
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({
        sections: [
          { title: '痛点开场', anchor: '体温不用慌' },
          { title: '产品承诺', anchor: '速干防闷防晒' },
        ],
      })
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
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({ sections: [{ title: '完整口播', anchor: '身温不用慌' }] })
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables(copyInput())

  assert.match(deliverables.correctedTranscript, /^# 热到红温又怎样 校正文稿/)
  assert.match(deliverables.correctedTranscript, /身温不用慌/)
  assert.match(deliverables.report, /## 三、Brainstorming 视角/)
})

test('buildCopyDeliverables keeps the full long transcript when a correction chunk is truncated', async () => {
  const runner = new RSSSubagentRunner()
  const longText = Array.from({ length: 90 }, (_, index) => `第${index + 1}句，这是一个用于模拟十五分钟视频文稿的长句子，里面保留连续信息和口播细节。`)
    .join(' ')
    + ' 最后一段必须保留，终点标记。'
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      const raw = request.user.match(/原始转录文本:\n([\s\S]*?)\n\n请只输出这个片段校正后的完整正文。/)?.[1] || ''
      return request.user.includes('片段: 1/')
        ? '第1句，这是一个过短的截断。'
        : raw
    }
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({
        sections: [
          { title: '长文开场', anchor: '第1句' },
          { title: '最终收束', anchor: '最后一段必须保留' },
        ],
      })
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables({
    ...copyInput(),
    extractedText: longText,
  })

  const correctionCalls = calls.filter((call) => call.user.includes('原始转录文本:'))
  assert.ok(correctionCalls.length > 1, 'long transcripts should be corrected in chunks')
  assert.match(deliverables.correctedTranscript, /第1句/)
  assert.match(deliverables.correctedTranscript, /终点标记/)
  assert.match(deliverables.structuredTranscript, /终点标记/)
})

test('buildCopyDeliverables retries then falls back for a short transcript when structured plan is truncated', async () => {
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
    if (request.user.includes('请输出 JSON')) {
      return '# 热到红温又怎样 结构化文字稿\n\n## 一、痛点引入\n\n体温不用慌，凉感2.0已经'
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables(copyInput())

  const structuredCalls = calls.filter((call) => call.user.includes('请输出 JSON'))
  assert.equal(structuredCalls.length, 2, 'invalid structure plans should be retried once')
  assert.match(structuredCalls[1].user, /上一次分段计划不可用/)
  assert.match(deliverables.structuredTranscript, /# 热到红温又怎样 结构化文字稿/)
  assert.match(deliverables.structuredTranscript, /## 一、完整口播/)
  assert.match(deliverables.structuredTranscript, /凉感2\.0/)
  assert.match(deliverables.structuredTranscript, /朋友们快来试试吧/)
})

test('buildCopyDeliverables retries correction when the first correction keeps an unpunctuated transcript', async () => {
  const runner = new RSSSubagentRunner()
  const raw = '去年我读了一本书叫你一生的故事但后来被改编成了电影降临今天想说的不是小说而是书里面提到的费马原理它让我开始相信命运这个事情如果命运已经确定了那我的选择还有意义答案是有而且选择更加重要'
  let correctionAttempts = 0
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      correctionAttempts += 1
      return correctionAttempts === 1
        ? raw
        : '去年我读了一本书，叫《你一生的故事》，后来被改编成了电影《降临》。今天想说的不是小说，而是书里面提到的费马原理。它让我开始相信命运这个事情。如果命运已经确定了，那我的选择还有意义吗？答案是有，而且选择更加重要。'
    }
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({ sections: [{ title: '命运开场', anchor: '去年我读了一本书' }] })
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables({
    ...copyInput(),
    extractedText: raw,
  })

  assert.equal(correctionAttempts, 2, 'punctuationless correction should be retried once')
  assert.match(calls[1].user, /缺少可靠标点/)
  assert.match(deliverables.correctedTranscript, /意义吗？答案是有/)
  assert.match(deliverables.structuredTranscript, /费马原理。/)
})

test('buildCopyDeliverables retries structure planning and uses model-provided content sections', async () => {
  const runner = new RSSSubagentRunner()
  const corrected = [
    '去年我读了一本书，叫《你一生的故事》。今天想说的不是小说，而是书里面提到的费马原理。它让我开始相信命运这个事情。我以前看待世界都是经典力学式的。读完之后，我感觉原因也有可能在未来。',
    '费马原理是什么呢？它说的是光线从A点经过水面抵达B点的时候会发生折射。这条路径一定是花费时间最短的路径。你会问，A、B之间直线才应该是吧？不，因为光线在水里的传播速度要更慢。',
    '当时我在飞机上读到这一段，感觉自己正在窥探宇宙的秘密。如果命运已经确定了，那我的选择还有意义吗？答案是有，而且选择更加重要。选择去哪儿本身并不重要，重要的是你自己选。因为如果你不选，别人就帮你选了。',
    '我希望在几年之后，在什么地方，做什么样的工作，你越具体越好。就跟你写AI的prompt一样，你提的需求越准，所生成的那个宇宙就会越清晰。可是现在来看的话，如果安排的人不是别人，而是未来的自己，那种命运的推背感，很有可能就是未来的你给现在的暗示。',
    '这种感受并不是让人躺平，而是提醒自己要认真选择。越清楚地看见想去的方向，越能听见未来的自己在提醒现在的自己。最后，作者把这一切收回到年终总结：命运也许不是外力安排，而是未来自我不断给出的微弱提示。这才是全文真正的收束点。',
  ].join('\n')
  let structureAttempts = 0
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return `# 命运与选择 校正文稿\n\n## 完整文稿\n\n${corrected}`
    }
    if (request.user.includes('请输出 JSON')) {
      structureAttempts += 1
      return structureAttempts === 1
        ? '{"sections":[]}'
        : JSON.stringify({
          sections: [
            { title: '书籍与命运引入', anchor: '去年我读了一本书' },
            { title: '费马原理的宿命感', anchor: '费马原理是什么呢' },
            { title: '选择与未来自我', anchor: '当时我在飞机上读到这一段' },
          ],
        })
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables({
    ...copyInput(),
    extractedText: corrected,
  })

  const structuredCalls = calls.filter((call) => call.user.includes('请输出 JSON'))
  assert.equal(structureAttempts, 2)
  assert.match(structuredCalls[1].user, /不要每个自然段都拆标题/)
  assert.doesNotMatch(deliverables.structuredTranscript, /## 一、完整口播/)
  assert.match(deliverables.structuredTranscript, /## 一、书籍与命运引入/)
  assert.match(deliverables.structuredTranscript, /## 二、费马原理的宿命感/)
  assert.match(deliverables.structuredTranscript, /## 三、选择与未来自我/)
  assert.doesNotMatch(deliverables.structuredTranscript, /## 四、/)
})

test('buildCopyDeliverables allows a content-specific single section without forcing extra headings', async () => {
  const runner = new RSSSubagentRunner()
  const corrected = [
    '这一期视频只有一个核心论证：人会因为试图抓住一个瞬间而错过这个瞬间。开头先讲自己在旅途中反复拍照，却越来越感到空心。',
    '中段继续解释这种感受。越想留下证明，越像是在替未来的自己表演，而不是正在真实地经历当下。作者把这种焦虑和日常生活联系起来，说明它不是旅行问题，而是看待生活的方式。',
    '最后，视频把观点收回到选择。真正重要的不是拍到多少画面，而是能不能允许那个瞬间自然过去。只有放下控制，人才可能重新回到生活里。',
  ].join('\n')
  const calls = patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return `# 抓住瞬间 校正文稿\n\n## 完整文稿\n\n${corrected}`
    }
    if (request.user.includes('请输出 JSON')) {
      return JSON.stringify({
        sections: [
          { title: '越想抓住，越会错过', anchor: '这一期视频只有一个核心论证' },
        ],
      })
    }
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables({
    ...copyInput(),
    extractedText: corrected,
  })

  const structuredCalls = calls.filter((call) => call.user.includes('请输出 JSON'))
  assert.equal(structuredCalls.length, 1)
  assert.match(structuredCalls[0].user, /sections 数量由内容决定/)
  assert.match(deliverables.structuredTranscript, /## 一、越想抓住，越会错过/)
  assert.doesNotMatch(deliverables.structuredTranscript, /## 二、/)
})

test('buildCopyDeliverables fails loudly when a long transcript never gets a usable structure plan', async () => {
  const runner = new RSSSubagentRunner()
  const corrected = [
    '去年我读了一本书，叫《你一生的故事》。今天想说的不是小说，而是书里面提到的费马原理。它让我开始相信命运这个事情。我以前看待世界都是经典力学式的。读完之后，我感觉原因也有可能在未来。',
    '费马原理是什么呢？它说的是光线从A点经过水面抵达B点的时候会发生折射。这条路径一定是花费时间最短的路径。你会问，A、B之间直线才应该是吧？不，因为光线在水里的传播速度要更慢。',
    '当时我在飞机上读到这一段，感觉自己正在窥探宇宙的秘密。如果命运已经确定了，那我的选择还有意义吗？答案是有，而且选择更加重要。选择去哪儿本身并不重要，重要的是你自己选。因为如果你不选，别人就帮你选了。',
    '我希望在几年之后，在什么地方，做什么样的工作，你越具体越好。就跟你写AI的prompt一样，你提的需求越准，所生成的那个宇宙就会越清晰。可是现在来看的话，如果安排的人不是别人，而是未来的自己，那种命运的推背感，很有可能就是未来的你给现在的暗示。',
    '这种感受并不是让人躺平，而是提醒自己要认真选择。越清楚地看见想去的方向，越能听见未来的自己在提醒现在的自己。最后，作者把这一切收回到年终总结：命运也许不是外力安排，而是未来自我不断给出的微弱提示。这才是全文真正的收束点。',
  ].join('\n')
  let structureAttempts = 0
  patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) {
      return `# 命运与选择 校正文稿\n\n## 完整文稿\n\n${corrected}`
    }
    if (request.user.includes('请输出 JSON')) {
      structureAttempts += 1
      return '{"sections":[]}'
    }
    return COMPLETE_COPY_REPORT
  })

  await assert.rejects(
    () => runner.buildCopyDeliverables({
      ...copyInput(),
      extractedText: corrected,
    }),
    /结构化分段计划/,
  )
  assert.equal(structureAttempts, 2)
})

test('buildCopyDeliverables fallback does not preserve line-per-sentence transcript spacing', async () => {
  const runner = new RSSSubagentRunner()
  patchComplete(runner, async (request) => {
    if (request.user.includes('原始转录文本:')) return ''
    if (request.user.includes('请输出 JSON')) return '{"sections":[]}'
    return COMPLETE_COPY_REPORT
  })

  const deliverables = await runner.buildCopyDeliverables({
    ...copyInput(),
    extractedText: [
      '第一句，这是视频转录的一句话。',
      '第二句，原本来自 SRT 的下一行。',
      '第三句，仍然属于同一个自然段。',
      '第四句，需要继续合并阅读。',
      '第五句，才应该自然收束。',
      '第六句，这是第二个段落的开始。',
      '第七句，继续补充语义。',
      '第八句，完成这一段。',
    ].join('\n'),
  })

  assert.match(deliverables.structuredTranscript, /## 一、完整口播/)
  assert.doesNotMatch(deliverables.structuredTranscript, /第一句，这是视频转录的一句话。\n\n第二句，原本来自 SRT 的下一行。/)
  assert.match(deliverables.structuredTranscript, /第一句，这是视频转录的一句话。第二句，原本来自 SRT 的下一行。第三句，仍然属于同一个自然段。/)
  assert.match(deliverables.structuredTranscript, /第五句，才应该自然收束。\n\n第六句，这是第二个段落的开始。/)
})
