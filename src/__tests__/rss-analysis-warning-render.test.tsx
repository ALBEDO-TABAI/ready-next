import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import RSSFeed from '../renderer/components/rss/RSSFeed'

test('a completed historical analysis renders its native source warning instead of a fresh-success badge', () => {
  const warning = '原文已更新或删除，此报告来自旧版本。'
  const noop = () => {}
  const markup = renderToStaticMarkup(<RSSFeed
    items={[{ id: 'a', sourceId: 's', title: 'Article', source: 'Source', author: '', summary: 'Body', publishedAt: '', link: 'https://example.test/a', read: false, starred: false }]}
    sources={[]} filter="all" selectedSource={null} selectedItemId={null} loading={false} refreshing={false}
    isMock={false} hasPreview={false} newItemIds={new Set()} analysisJobs={[]} settingsOpen={false}
    analysisProgressMap={{ a: { itemId: 'a', jobId: 'j', action: 'copy', status: 'success', progress: 100, sourceWarning: warning,
      message: '分析完成', error: null, outputDir: '/analysis', reportPath: '/analysis/report.md', updatedAt: '' } }}
    onFilterChange={noop} onSourceChange={noop} onItemClick={noop} onMarkItemRead={noop} onToggleStar={noop}
    onDeleteItem={noop} onOpenAnalysisOutput={noop} onRefresh={noop} onAddSource={noop} onDeleteSource={noop}
    onClearRead={noop} onOpenSettings={noop} onPauseAnalysisJob={noop} onResumeAnalysisJob={noop} onDeleteAnalysisJob={noop}
  />)
  assert.ok(markup.includes(`title="${warning}"`))
  assert.ok(markup.includes('lucide-triangle-alert'))
})
