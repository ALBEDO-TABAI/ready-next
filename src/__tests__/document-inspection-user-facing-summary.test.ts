import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseListWidgetsToolOutput,
  buildUserFacingInspectionSummary,
  type DocumentWidgetSummary,
} from '../shared/document-widget-parse'

function summary(partial: Partial<DocumentWidgetSummary> & { title: string }): DocumentWidgetSummary {
  return {
    id: partial.id ?? 'widget_xxx',
    index: partial.index ?? 1,
    title: partial.title,
    mode: partial.mode ?? 'static-html',
    componentHint: partial.componentHint ?? null,
    preview: partial.preview ?? '',
    hasState: partial.hasState ?? false,
    hasComponentSpec: partial.hasComponentSpec ?? false,
    canPatch: partial.canPatch ?? false,
    canReplace: partial.canReplace ?? true,
  }
}

function buildListRaw(summaries: DocumentWidgetSummary[], tabTitle: string): string {
  const header = summaries.length === 0
    ? `当前文档没有 widget（${tabTitle}）`
    : `当前文档共有 ${summaries.length} 个 widget（${tabTitle}）：`
  const bullets = summaries.map((item, index) => {
    const patch = item.canPatch ? ' · 可 patch' : ' · 仅整卡替换'
    return `${index + 1}. ${item.title} [${item.mode}] · id=${item.id}${patch}`
  })
  return [header, ...bullets, '', '```json', JSON.stringify(summaries), '```'].join('\n')
}

describe('parseListWidgetsToolOutput', () => {
  it('parses fence JSON and extracts tabTitle from header', () => {
    const summaries: DocumentWidgetSummary[] = [
      summary({ title: '指引', id: 'widget_abc', canPatch: true }),
      summary({ title: '进度卡', id: 'widget_def' }),
    ]
    const raw = buildListRaw(summaries, 'my-notes.md')

    const parsed = parseListWidgetsToolOutput(raw)

    assert.equal(parsed.summaries.length, 2)
    assert.equal(parsed.summaries[0]?.title, '指引')
    assert.equal(parsed.summaries[1]?.title, '进度卡')
    assert.equal(parsed.tabTitle, 'my-notes.md')
  })

  it('extracts tabTitle from empty-document header', () => {
    const raw = '当前文档没有 widget（empty.md）'
    const parsed = parseListWidgetsToolOutput(raw)
    assert.deepEqual(parsed.summaries, [])
    assert.equal(parsed.tabTitle, 'empty.md')
  })

  it('returns empty summaries when fence is missing', () => {
    const raw = '随便一段不含 fence 的文本'
    const parsed = parseListWidgetsToolOutput(raw)
    assert.deepEqual(parsed.summaries, [])
    assert.equal(parsed.tabTitle, null)
  })

  it('returns empty summaries when fence JSON is not an array', () => {
    const raw = '```json\n{"not": "an array"}\n```'
    const parsed = parseListWidgetsToolOutput(raw)
    assert.deepEqual(parsed.summaries, [])
  })

  it('returns empty summaries when fence JSON is malformed', () => {
    const raw = '```json\n[ broken json \n```'
    const parsed = parseListWidgetsToolOutput(raw)
    assert.deepEqual(parsed.summaries, [])
  })

  it('filters out fence entries without title field', () => {
    const raw = '```json\n[{"id":"widget_a"},{"id":"widget_b","title":"ok"}]\n```'
    const parsed = parseListWidgetsToolOutput(raw)
    assert.equal(parsed.summaries.length, 1)
    assert.equal(parsed.summaries[0]?.title, 'ok')
  })
})

describe('buildUserFacingInspectionSummary', () => {
  it('returns fallback sentence for empty/null/undefined input', () => {
    const fallback = '已查询当前文档的 widget 列表。请告诉我你想修改的 widget 标题或序号。'
    assert.equal(buildUserFacingInspectionSummary(''), fallback)
    assert.equal(buildUserFacingInspectionSummary(null), fallback)
    assert.equal(buildUserFacingInspectionSummary(undefined), fallback)
  })

  it('returns 0-widget user-facing sentence for empty document raw', () => {
    const raw = '当前文档没有 widget（empty.md）'
    const text = buildUserFacingInspectionSummary(raw)
    assert.match(text, /「empty\.md」/)
    assert.match(text, /暂无 widget/)
    // no debug leakage
    assert.equal(text.includes('id=widget_'), false)
    assert.equal(text.includes('```json'), false)
  })

  it('returns short sentence with example titles for 1-3 widgets', () => {
    const summaries: DocumentWidgetSummary[] = [
      summary({ title: '指引', id: 'widget_abc', canPatch: true }),
      summary({ title: '进度卡', id: 'widget_def' }),
    ]
    const raw = buildListRaw(summaries, 'my-notes.md')

    const text = buildUserFacingInspectionSummary(raw)

    assert.match(text, /「my-notes\.md」/)
    assert.match(text, /「指引」/)
    assert.match(text, /「进度卡」/)
    // no debug leakage
    assert.equal(text.includes('id=widget_'), false)
    assert.equal(text.includes('```json'), false)
    assert.equal(text.includes('· 可 patch'), false)
    assert.equal(text.includes('· 仅整卡替换'), false)
  })

  it('returns sentence with "示例" suffix when >3 widgets', () => {
    const summaries: DocumentWidgetSummary[] = Array.from({ length: 6 }, (_, index) =>
      summary({ title: `卡片${index + 1}`, id: `widget_${index}` }),
    )
    const raw = buildListRaw(summaries, 'big.md')

    const text = buildUserFacingInspectionSummary(raw)

    assert.match(text, /6 个 widget/)
    assert.match(text, /示例/)
    assert.equal(text.includes('id=widget_'), false)
    assert.equal(text.includes('```json'), false)
  })

  it('falls back to generic sentence when raw has no fence and no empty-doc header', () => {
    const text = buildUserFacingInspectionSummary('意义不明的一段文字')
    assert.equal(text, '已查询当前文档的 widget 列表。请告诉我你想修改的 widget 标题或序号。')
  })

  it('omits tabTitle gracefully when fence parsed but header missing', () => {
    const summaries: DocumentWidgetSummary[] = [summary({ title: '指引' })]
    const raw = `\`\`\`json\n${JSON.stringify(summaries)}\n\`\`\``
    const text = buildUserFacingInspectionSummary(raw)
    assert.match(text, /当前文档/) // docLabel fallback
    assert.match(text, /「指引」/)
  })
})
