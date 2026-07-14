import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS,
  getRSSRefreshRisk,
  getRSSAutoRefreshWarning,
  getRSSFetchAllResultWarning,
  parseRSSAutoRefreshInterval,
} from '../renderer/modules/rss/settings'

describe('RSS settings helpers', () => {
  it('keeps the existing 15 minute refresh as the default', () => {
    assert.equal(parseRSSAutoRefreshInterval(null), DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS)
    assert.equal(parseRSSAutoRefreshInterval('not-a-number'), DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS)
    assert.equal(parseRSSAutoRefreshInterval('-1'), DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS)
  })

  it('accepts supported refresh intervals including manual mode', () => {
    assert.equal(parseRSSAutoRefreshInterval('0'), 0)
    assert.equal(parseRSSAutoRefreshInterval(String(30 * 60 * 1000)), 30 * 60 * 1000)
    assert.equal(parseRSSAutoRefreshInterval(String(3 * 60 * 60 * 1000)), 3 * 60 * 60 * 1000)
  })

  it('warns more strongly for frequent social or RSSHub-backed sources', () => {
    const risk = getRSSRefreshRisk(15 * 60 * 1000, ['xiaohongshu'])
    assert.equal(risk.level, 'danger')
    assert.match(risk.message, /风控/)
  })

  it('treats one hour as the recommended daily interval', () => {
    const risk = getRSSRefreshRisk(60 * 60 * 1000, ['rss'])
    assert.equal(risk.level, 'notice')
    assert.match(risk.title, /推荐/)
  })

  it('keeps partial auto-refresh failures visible instead of treating them as success', () => {
    const warning = getRSSAutoRefreshWarning({
      running: false,
      intervalMs: 60_000,
      nextRunAt: '2026-07-13T04:01:00.000Z',
      completedAt: '2026-07-13T04:00:00.000Z',
      success: false,
      fetched: 3,
      message: 'Fetched 4 sources, 3 new items',
      errors: ['[Source A] HTTP 429'],
    })

    assert.equal(warning, 'RSS 自动刷新完成，但存在错误：[Source A] HTTP 429')
  })

  it('does not restore stale automatic failure warnings after switching to manual mode', () => {
    const warning = getRSSAutoRefreshWarning({
      running: false,
      intervalMs: 0,
      nextRunAt: null,
      completedAt: '2026-07-13T04:00:00.000Z',
      success: false,
      fetched: 0,
      message: 'old failure',
      errors: ['old failure'],
    })

    assert.equal(warning, null)
  })

  it('replaces stale auto warnings with the current manual fetchAll outcome', () => {
    assert.equal(
      getRSSFetchAllResultWarning({ success: true, data: { message: 'done' } }),
      null,
    )
    assert.equal(
      getRSSFetchAllResultWarning({
        success: true,
        data: { message: 'partial', errors: ['[Source B] verification required'] },
      }),
      'RSS 刷新完成，但存在错误：[Source B] verification required',
    )
    assert.equal(
      getRSSFetchAllResultWarning({ success: false, error: 'database unavailable' }),
      'RSS 刷新失败：database unavailable',
    )
  })
})
