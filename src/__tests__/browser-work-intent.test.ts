import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveBrowserWorkIntent } from '../shared/browser-work-intent'

const INCIDENT_QUERIES = [
  'vlog调色 高级感',
  '剪映 进阶教程',
  '自媒体视频 质感提升',
  'vlog转场 创意',
  '短视频 字幕排版 高级',
  '视频拍出来和博主差距大',
  'vlog怎么剪才有网感',
  '剪映调色 没质感',
  '达芬奇调色 vlog',
  '商业剪辑师 技巧',
  'AI做视频 教程',
  'AI视频制作 博主',
  'AI生成视频 自媒体',
  'vlog美颜 高级感',
  '视频画质 美颜 剪辑',
  '博主美颜参数 分享',
  '视频封面 设计 自媒体',
  '小红书封面 制作教程',
]

const INCIDENT_TEXT = `再试一次，帮我在小红书这里搜索下面这些关键词，找找其中的爆款笔记整理下来标题和内容，然后再筛选出适合这个账号的选题有哪些：${INCIDENT_QUERIES.join('\n')}
这是只读研究任务，不发布、不点赞、不评论、不关注。请完整处理全部18个关键词；如遇登录或人机验证，明确停在等待人工处理，不要把部分结果说成已完成。`

test('production incident is current-site research, not persistent batch collection', () => {
  const intent = resolveBrowserWorkIntent(INCIDENT_TEXT)
  assert.equal(intent.kind, 'site_research')
  assert.equal(intent.siteSurface, 'current_site')
  assert.equal(intent.persistenceRequested, false)
  assert.equal(intent.batchScope, 'none')
  assert.deepEqual(intent.queries, INCIDENT_QUERIES)
  assert.deepEqual(intent.roles.evaluationTargets, ['current_account'])
})

test('requested evidence metadata is not mistaken for a persistence action', () => {
  const intent = resolveBrowserWorkIntent(`请在当前打开且已登录的小红书中做只读站内研究。目标账号是当前页面，它只用于账号适配判断，不是批量保存来源。请分别搜索以下关键词，保留每个关键词的状态，整理页面可见、可核验的高互动笔记标题、作者、链接、互动指标与抓取时间；对最终选中的候选再读取详情正文。只读：不要下载、发布、点赞、评论、关注或修改任何账号状态。关键词按以下顺序：
1. 甲
2. 乙`)
  assert.equal(intent.kind, 'site_research')
  assert.equal(intent.persistenceRequested, false)
  assert.equal(intent.batchScope, 'none')
  assert.deepEqual(intent.queries, ['甲', '乙'])
})

test('negated transaction wording does not override a read-only research request', () => {
  assert.equal(resolveBrowserWorkIntent('搜索关键词：\n甲\n不要发布，只整理结果').kind, 'site_research')
  assert.equal(resolveBrowserWorkIntent('不要发布这篇笔记').kind, 'observe')
  assert.equal(resolveBrowserWorkIntent('发布这篇笔记').kind, 'transact')
})

test('negation is bound to its own action segment', () => {
  assert.equal(resolveBrowserWorkIntent('不保存，只分析这个账号').kind, 'observe')
  const persist = resolveBrowserWorkIntent('不要下载，只保存全部笔记')
  assert.equal(persist.kind, 'persist_collection')
  assert.equal(persist.batchScope, 'explicit_all_items')
  assert.equal(resolveBrowserWorkIntent('不要发布，只上传文件').kind, 'transact')
})

test('account analysis without executable queries remains read-only observation', () => {
  const intent = resolveBrowserWorkIntent('帮我分析一下这个小红书账号，然后列一些选题给我')
  assert.equal(intent.kind, 'observe')
  assert.deepEqual(intent.roles.evaluationTargets, ['current_account'])
})

test('negated account analysis ends the query list and does not create an evaluation target', () => {
  const inline = resolveBrowserWorkIntent('在当前站点搜索关键词：甲、乙；不需要分析这个账号')
  assert.deepEqual(inline.queries, ['甲', '乙'])
  assert.deepEqual(inline.roles.evaluationTargets, [])
  const multiline = resolveBrowserWorkIntent('在当前站点搜索关键词：\n甲\n乙\n无需评估当前主页')
  assert.deepEqual(multiline.queries, ['甲', '乙'])
  assert.deepEqual(multiline.roles.evaluationTargets, [])
})

test('explicit persistence and all-items scope must occur in the same action clause', () => {
  assert.equal(resolveBrowserWorkIntent('把这个博主的每篇笔记都保存图片').batchScope, 'explicit_all_items')
  assert.equal(resolveBrowserWorkIntent('整理爆款笔记，再筛选适合这个账号的选题').persistenceRequested, false)
  assert.equal(resolveBrowserWorkIntent('不要采集，只分析这个账号并给选题').persistenceRequested, false)
})

test('query extraction preserves order and removes exact duplicates', () => {
  const intent = resolveBrowserWorkIntent('在当前站点搜索关键词：\n甲\n乙\n甲\n 丙 ')
  assert.deepEqual(intent.queries, ['甲', '乙', '丙'])
})

test('common inline current-site search wording extracts comma-separated queries', () => {
  const cases: Array<[string, string[]]> = [
    ['在小红书搜索：甲、乙', ['甲', '乙']],
    ['在小红书搜索甲、乙', ['甲', '乙']],
    ['在小红书搜一下护肤、防晒', ['护肤', '防晒']],
    ['帮我在小红书找找护肤和防晒的爆款', ['护肤', '防晒']],
    ['在当前页面查找猫粮', ['猫粮']],
    ['在小红书搜索甲、乙，然后分析当前账号', ['甲', '乙']],
    ['在小红书搜索甲、乙，并分析当前账号', ['甲', '乙']],
  ]
  for (const [message, queries] of cases) {
    const intent = resolveBrowserWorkIntent(message)
    assert.equal(intent.kind, 'site_research', message)
    assert.equal(intent.siteSurface, 'current_site', message)
    assert.deepEqual(intent.queries, queries, message)
  }
})

test('search action extraction rejects negated or instruction-only tails', () => {
  assert.equal(resolveBrowserWorkIntent('不要在小红书搜索甲、乙').kind, 'observe')
  assert.equal(resolveBrowserWorkIntent('在小红书搜索后分析当前账号').kind, 'observe')
  assert.equal(resolveBrowserWorkIntent('打开网页搜索资料，点击并输入内容，同时回复飞书').kind, 'observe')
})

test('only/just persistence is affirmative and trailing instructions are not queries', () => {
  assert.equal(resolveBrowserWorkIntent('只保存这些笔记').persistenceRequested, true)
  assert.equal(resolveBrowserWorkIntent('仅下载这些图片').persistenceRequested, true)
  const intent = resolveBrowserWorkIntent('在当前站点搜索关键词：\n甲\n乙\n然后分析这个账号')
  assert.deepEqual(intent.queries, ['甲', '乙'])
  assert.deepEqual(intent.roles.evaluationTargets, ['current_account'])
})

test('explicit URL research is a URL set unless the user binds the current page', () => {
  const supplied = resolveBrowserWorkIntent('用浏览器研究这些网址：https://example.com/a https://example.com/b')
  assert.equal(supplied.kind, 'site_research')
  assert.equal(supplied.siteSurface, 'supplied_urls')
  assert.deepEqual(supplied.roles.evidenceSources, ['https://example.com/a', 'https://example.com/b'])

  const current = resolveBrowserWorkIntent('研究当前页面 https://example.com/a')
  assert.equal(current.siteSurface, 'current_site')
})
