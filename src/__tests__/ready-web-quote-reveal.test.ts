import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { buildWebQuoteRevealScript, textDirectiveFromUrl } from '../main/modules/library-engine/web-quote-reveal'

test('text directives parse prefix, quote and suffix, decoding each part', () => {
  const quote = (value: string) => encodeURIComponent(value).replace(/-/g, '%2D')
  assert.deepEqual(textDirectiveFromUrl(`https://a.test/p#:~:text=${quote('前面的上下文。')}-,${quote('乙丙丁戊己')},-${quote('庚辛-壬癸')}`),
    { prefix: '前面的上下文。', start: '乙丙丁戊己', end: '', suffix: '庚辛-壬癸' })
  assert.deepEqual(textDirectiveFromUrl('https://a.test/p#top:~:text=start,end'), { prefix: '', start: 'start', end: 'end', suffix: '' })
  assert.equal(textDirectiveFromUrl('https://a.test/p#top'), null)
  assert.equal(textDirectiveFromUrl('https://a.test/p#:~:other=1'), null)
})

test('the reveal script highlights the quote that its context points to, across text nodes and whitespace', () => {
  const dom = new JSDOM(`<body><p>甲乙丙丁戊己 首次出现。</p><p>前面的上下文。</p><p>甲<b>乙丙</b>丁戊己庚辛壬癸，
     来源页应保留这段文字。</p></body>`, { runScripts: 'outside-only' })
  const highlights = new Map<string, { ranges: Range[] }>()
  Object.assign(dom.window, {
    CSS: { highlights: { set: (name: string, value: { ranges: Range[] }) => highlights.set(name, value), delete: (name: string) => highlights.delete(name) } },
    Highlight: class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges } },
  })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  // The adapter writes the ~32 characters right before the selection as its prefix.
  const url = `https://a.test/p#:~:text=${encodeURIComponent('前面的上下文。甲')}-,${encodeURIComponent('乙丙丁戊己')},-${encodeURIComponent('庚辛壬癸， 来源页')}`
  const revealed = dom.window.eval(buildWebQuoteRevealScript(textDirectiveFromUrl(url)!))
  assert.equal(revealed, true)
  const range = highlights.get('ready-source-quote')!.ranges[0]
  assert.equal(range.toString(), '乙丙丁戊己', 'the second occurrence, after its prefix, is the one highlighted')
  assert.equal(dom.window.document.getElementById('ready-source-quote-style')?.textContent?.includes('::highlight(ready-source-quote)'), true)
  dom.window.dispatchEvent(new dom.window.Event('pointerdown'))
  assert.equal(highlights.has('ready-source-quote'), false, 'a click clears the highlight')
  // A quote that is not on the page leaves it alone.
  assert.equal(dom.window.eval(buildWebQuoteRevealScript({ prefix: '', start: '不存在', end: '', suffix: '' })), false)
  dom.window.close()
})
