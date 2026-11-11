import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { zhCN, setLocale, translate, type Key } from '../renderer/modules/calendar/workbench/i18n'
import { hourLabel, timeOf, timeOfFull, panelTime, rangeOf } from '../renderer/modules/calendar/workbench/fmt'
import { PALETTE } from '../shared/calendar/color'
import { withSystemTimeFormat } from '../main/modules/calendar-engine/time-format'

const dom = new JSDOM('<!doctype html><html></html>')
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
test.after(() => { dom.window.close(); Reflect.deleteProperty(globalThis, 'document') })

test('complete zhCN dictionary has no Traditional-only characters or untranslated English words', () => {
  // Traditional-only forms from zhTW plus common UI vocabulary. Ambiguous shared characters (后/里/台) are allowed.
  const traditionalOnly = /[數檢視顯週絕動無標題尋鍵選單換側邊欄曆匯這預設輸導覽關閉間縮淺開區刪複製個資觀於時隨統語長鐘顏參與點說訊連結閒見帳號線會議編輯稱郵為將對齊網舉後問隱啟儲腦貝訂復還過嗎許辦項來轉體簡臺灣應檔讀寫錯誤並從權變請認實際風險處據備]/
  // Only these product/format names may remain English; placeholders are runtime values, not UI words.
  const allowedWords = new Set(['ics', 'Mac'])
  for (const [key, value] of Object.entries(zhCN)) {
    assert.ok(!traditionalOnly.test(value), `${key}: ${value}`)
    const words = value.replace(/\{\w+\}/g, '').match(/[A-Za-z]+/g) ?? []
    assert.ok(words.every(word => allowedWords.has(word)), `${key}: ${words.join(', ')}`)
    assert.ok(!value.includes('活动'), `${key}: event must be 日程`)
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
    assert.deepEqual(placeholders(value), placeholders(translate('en', key as Key)), key)
  }
})

test('Chinese grid labels and time formatting respect 12 and 24 hours, including noon and midnight', () => {
  setLocale('zh-CN')
  assert.deepEqual([0, 1, 12, 15, 23].map(h => hourLabel(h, false)), ['上午 12 时', '上午 1 时', '下午 12 时', '下午 3 时', '下午 11 时'])
  assert.equal(hourLabel(1, true), '01:00')
  const morning = Date.parse('2026-11-11T09:30:00Z'), afternoon = Date.parse('2026-11-11T15:00:00Z')
  for (const format of [timeOf, timeOfFull, panelTime]) {
    assert.equal(format(morning, 'UTC', false), '上午 9:30')
    assert.equal(format(afternoon, 'UTC', false), '下午 3 时')
    assert.equal(format(morning, 'UTC', true), '09:30')
    assert.equal(format(afternoon, 'UTC', true), '15:00')
  }
  assert.equal(rangeOf(morning, afternoon, 'UTC', false), '上午 9:30\u200a–\u200a下午 3 时')
  assert.equal(rangeOf(morning, morning + 1800000, 'UTC', false), '上午 9:30\u200a–\u200a上午 10 时')
})

test('English time formatting remains unchanged and color names follow the selected calendar locale', () => {
  setLocale('zh-CN')
  assert.deepEqual(PALETTE.map(c => c.name), ['红', '珊瑚', '橙', '黄', '青柠', '草绿', '绿', '薄荷', '蓝', '宝石蓝', '靛蓝', '紫罗兰', '紫', '粉', '藕粉', '棕', '灰'])
  setLocale('en')
  const time = Date.parse('2026-11-11T15:00:00Z')
  assert.equal(hourLabel(1, false), '1\u2009AM'); assert.equal(timeOf(time, 'UTC', false), '3\u2009PM')
  assert.equal(timeOfFull(time, 'UTC', false), '3:00\u2009PM'); assert.equal(panelTime(time, 'UTC', false), '3 PM')
  assert.equal(PALETTE[0].name, 'Red'); assert.equal(PALETTE[1].name, 'Coral')
})

test('system time preference is response-only; explicit true and false always override it', () => {
  const snapshot = { calendars: [], events: [], prefs: { showWeekends: false } }
  assert.equal(withSystemTimeFormat(snapshot, () => true).prefs.format24HourTime, true)
  assert.equal(withSystemTimeFormat(snapshot, () => false).prefs.format24HourTime, false)
  assert.deepEqual(snapshot.prefs, { showWeekends: false })
  for (const chosen of [true, false]) {
    assert.equal(withSystemTimeFormat({ ...snapshot, prefs: { format24HourTime: chosen } }, () => { throw new Error('explicit choice must not read system') }).prefs.format24HourTime, chosen)
  }
})
