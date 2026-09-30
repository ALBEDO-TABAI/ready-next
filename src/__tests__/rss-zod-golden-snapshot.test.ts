/**
 * Golden snapshot for RSS domain LLM-facing tool schemas (Phase 2.5 PR 3).
 *
 * Commit BEFORE swapping rss-tools.ts params from hand-rolled to Zod-derived;
 * the snapshot then locks the derivation swap to byte equivalence.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRSSAnthropicTools,
  getRSSOpenAITools,
} from '../main/modules/tools/rss-tools'

const READING_POINT = { type: 'object', properties: {
  run: { type: 'integer', minimum: 0, maximum: 9007199254740991, description: '阅读文字片段的来源位置标识' },
  offset: { type: 'integer', minimum: 0, maximum: 9007199254740991, description: '片段内字符位置' },
}, required: ['run', 'offset'], additionalProperties: false }
const EXPECTED_ANTHROPIC = [
  { name: 'rss_read_catalog', description: '完整分页读取已保存的来源、栏目、分析任务、历史判断和全部事件依据；来源含停用，依据含撤回与信息不足。success 不证明报告文件仍可用，须另调用 rss_read_analysis_report 核验。采集诊断是独立时点记录，不属于目录分页快照。', input_schema: { type: 'object', properties: {
    view: { type: 'string', enum: ['sources', 'definitions', 'analysis', 'judgments', 'evidence'], description: 'sources 全部来源含停用；definitions 栏目与规则；analysis 全部分析任务；judgments 历史分类判断；evidence 全部事件依据含撤回和信息不足' },
    itemId: { type: 'string', description: '仅 analysis、judgments、evidence 可按文章 ID 筛选' }, eventId: { type: 'string', description: '仅 evidence 可按当前事件归属筛选' },
    cursor: { type: 'string', description: '续页原样使用 nextCursor；资料变化须重新读取，不追加旧页' }, limit: { type: 'number', description: '每页 1–100 条，默认 30' },
  }, required: ['view'] } },
  { name: 'rss_read_analysis_report', description: '按任务 ID 分段读取已保存且可核验的分析报告；续读必须沿用 revision。不启动模型，不重新分析；旧报告归属不可核验时明确失败。', input_schema: { type: 'object', properties: {
    jobId: { type: 'string', description: '已保存的分析任务 ID' }, offset: { type: 'number', description: '首读为 0；续读使用 nextOffset' },
    length: { type: 'number', description: '每段字符数，最多 24000' }, expectedRevision: { type: 'string', description: '续读必须沿用首次返回的 revision' },
  }, required: ['jobId'] } },
  { name: 'rss_read_excerpt', description: '读取绑定文章版本的段落或选区；范围原样沿用引用，续读不会越过选区。可用返回的 citationUrl 定位。', input_schema: { type: 'object', properties: {
    format: { type: 'string', description: '阅读映射版本，必须原样沿用引用中的 reading-v1' }, itemId: { type: 'string', description: '已保存文章 ID' }, expectedRevision: { type: 'string', description: '引用绑定的完整文章版本' },
    range: { type: 'object', properties: { start: READING_POINT, end: READING_POINT }, required: ['start', 'end'], additionalProperties: false, description: '引用原样携带的阅读文字范围，不从相同句子猜位置' },
    offset: { type: 'number', description: '选区内续读位置，沿用 nextOffset' }, length: { type: 'number', description: '最多读取字符数；始终限制在选区内' },
  }, required: ['format', 'itemId', 'expectedRevision', 'range'] } },
  { name: 'rss_read_digests', description: '分页读取已保存日报或范围简报、原文依据与采集覆盖；仅查询，不生成、不重算、不标已读。', input_schema: { type: 'object', properties: {
    view: { type: 'string', description: 'editions 刊物目录；entries 条目；sources 某条全部依据；coverage 订阅覆盖；criteria 发布时的分类与精选标准', enum: ['editions', 'entries', 'sources', 'coverage', 'criteria'] },
    reportId: { type: 'string', description: '除目录外必填，已保存刊物 ID' }, groupKey: { type: 'string', description: 'sources 视图必填，沿用条目的 groupKey' },
    offset: { type: 'number', description: '续页使用返回的 nextOffset' }, limit: { type: 'number', description: '每页 1–50 条，默认 20' }, snapshot: { type: 'number', description: '刊物目录续页沿用首次返回的 snapshot' },
  }, required: [] } },
  { name: 'rss_read_events', description: '分页读取已保存事件、当前报道或事实进展及历史版本依据。历史摘句不代表当前原文仍有效；只读，不重新归组。', input_schema: { type: 'object', properties: {
    view: { type: 'string', description: 'list 事件目录；members 当前报道；facts 包含历史依据的事实与进展', enum: ['list', 'members', 'facts'] },
    eventId: { type: 'string', description: '读取成员或事实时必填' }, search: { type: 'string', description: '仅事件目录使用，搜索已保存标题或事实摘句' },
    expectedRevision: { type: 'number', description: '续页使用首次返回的 revision' }, offset: { type: 'number', description: '续页使用 nextOffset' },
    limit: { type: 'number', description: '每页 1–100 条，默认 20' },
  }, required: [] } },
  {
    name: 'rss_read_processing', description: '读取 RSS 自动分类与精选的设置、当日调用次数及分页任务记录。仅查询，不启动、重试或取消任务。',
    input_schema: { type: 'object', properties: {
      itemId: { type: 'string', description: '可选文章 ID' },
      offset: { type: 'number', description: '续页使用 nextOffset' },
      limit: { type: 'number', description: '每页 1–100 条，默认 30' },
      snapshot: { type: 'number', description: '续页沿用首次返回的 snapshot，避免新任务插入挤动分页' },
    }, required: [] },
  },
  {
    name: 'rss_add_source',
    description: '添加一个 RSS 订阅源。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '订阅源名称' },
        url: { type: 'string', description: '订阅源 URL' },
      },
      required: ['name', 'url'],
    },
  },
  {
    name: 'rss_fetch_updates',
    description: '刷新当前 RSS 订阅，拉取最新内容。',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'rss_select_item',
    description: '在 RSS 列表中按 itemId 或标题定位一个条目。',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '可选，条目 ID' },
        title: { type: 'string', description: '可选，条目标题关键词' },
      },
      required: [],
    },
  },
  {
    name: 'rss_analyze_item',
    description: '对指定 RSS 条目运行 copy 或 visual 分析流程。',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '可选，条目 ID' },
        title: { type: 'string', description: '可选，条目标题关键词' },
        analysisType: { type: 'string', description: 'copy 或 visual' },
      },
      required: ['analysisType'],
    },
  },
  {
    name: 'rss_capture_session',
    description: '读取当前 RSS 会话快照、选中条目和最近分析状态。',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'rss_read_reference',
    description: '读取本轮 RSS 引用：条件和版本由应用绑定，不能改写。查询按 nextCursor 续页，正文按 nextOffset 续读。旧引用已变化或删除时明确失败，不自动抓取或分析。',
    input_schema: { type: 'object', properties: {
      referenceId: { type: 'string', description: '本轮 RSS 资料引用的 id' },
      cursor: { type: 'string', description: '查询续页时使用返回的 nextCursor' },
      offset: { type: 'number', description: '正文、选区或刊物续页时原样使用返回的 nextOffset' },
    }, required: ['referenceId'] },
  },
  {
    name: 'rss_query_items',
    description: '查询已保存的 RSS 资讯；支持收件箱/历史底稿、筛选和连续分页，不打开界面、不抓取、不改已读。',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'inbox 当前收件箱；library 含历史底稿', enum: ['inbox', 'library'] },
        filter: { type: 'string', description: 'all、unread 或 starred', enum: ['all', 'unread', 'starred'] },
        collectionId: { type: 'string', description: '栏目定义 ID' },
        categoryId: { type: 'string', description: '主题定义 ID，与栏目及其他条件取交集' },
        eventId: { type: 'string', description: '可选事件 ID，保留其他筛选条件' },
        sourceId: { type: 'string', description: '可选订阅源 ID' },
        search: { type: 'string', description: '按字面关键词搜索，不触发网络获取' },
        searchIn: { type: 'string', description: 'title_summary 标题摘要；body 已保存正文', enum: ['title_summary', 'body'] },
        from: { type: 'number', description: '时间范围起点，Unix 毫秒，包含' },
        until: { type: 'number', description: '时间范围终点，Unix 毫秒，不包含' },
        sort: { type: 'string', description: 'newest 或 oldest', enum: ['newest', 'oldest'] },
        limit: { type: 'number', description: '每页 1–100 条，默认 50' },
        cursor: { type: 'string', description: '上一页返回的 nextCursor；其他查询条件保持相同' },
        expectedRevision: { type: 'number', description: '可选，固定当前界面或导出所引用的资料版本' },
      },
      required: [],
    },
  },
  {
    name: 'rss_read_article',
    description: '按文章 ID 分段读取已保存正文和来源，以及最近分析任务、报告路径与原文变化警告；不重新启动分析。沿 nextOffset 与 revision 续读；缺失正文明确返回来源摘要。',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '文章 ID' },
        expectedRevision: { type: 'string', description: '文章版本；连续读取时沿用首次返回版本' },
        offset: { type: 'number', description: '读取位置，使用上次返回的 nextOffset' },
        length: { type: 'number', description: '本次最多读取字符数，默认 12000、上限 24000' },
      },
      required: ['itemId'],
    },
  },
]

test('getRSSAnthropicTools matches the locked LLM-facing payload byte-for-byte', () => {
  assert.deepEqual(getRSSAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getRSSOpenAITools matches the locked LLM-facing payload byte-for-byte', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getRSSOpenAITools(), expected)
})
