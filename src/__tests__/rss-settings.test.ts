import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS,
  getRSSRefreshRisk,
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
})
