import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JSDOM } from 'jsdom'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  buildPageMarkdownScript,
  readTabAsMarkdown,
  sliceReadContent,
} from '../main/modules/tools/browser-page-markdown'

interface PageResult { ok: boolean; url: string; title: string; markdown: string; hitHardLimit: boolean; reason?: string }

function convert(html: string, url = 'https://example.test/docs/page'): PageResult {
  const dom = new JSDOM(`<!doctype html><html><head><title>Page title</title><style>.x{}</style></head><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
  })
  // The result is built in the page's realm; a JSON round trip brings it into this one.
  return JSON.parse(JSON.stringify(dom.window.eval(buildPageMarkdownScript()))) as PageResult
}

const markdown = (html: string) => convert(html).markdown

describe('a page handed over as Markdown', () => {
  it('keeps headings, paragraphs and inline emphasis, and says where it was read', () => {
    const page = convert('<h1>Title</h1><p>First <strong>bold</strong> and <em>soft</em> text.</p><h2>Part  two</h2><p>Second\n  paragraph.</p>')
    assert.equal(page.markdown, '# Title\n\nFirst **bold** and *soft* text.\n\n## Part two\n\nSecond paragraph.')
    assert.deepEqual([page.ok, page.url, page.title, page.hitHardLimit], [true, 'https://example.test/docs/page', 'Page title', false])
  })

  it('carries link addresses, resolved against the page; a link that goes nowhere else is only its words', () => {
    assert.equal(
      markdown('<p>See <a href="/guide?a=1#top">the guide</a>, <a href="https://other.test/x">elsewhere</a>, <a href="javascript:void(0)">a button</a>, <a href="mailto:a@b.c">mail</a>, <a href="#notes">the notes below</a> and <a>a bare anchor</a>.</p>'),
      'See [the guide](https://example.test/guide?a=1#top), [elsewhere](https://other.test/x), a button, mail, the notes below and a bare anchor.',
    )
  })

  it('gives a card that is one whole link its own line, with its words kept apart', () => {
    assert.equal(
      markdown('<div><a href="/p/1"><div>Green tea</div><div>¥20</div></a><a href="/p/2"><h3>Black tea</h3><p>¥25</p></a>and <a href="/all">all teas</a></div>'),
      '[Green tea ¥20](https://example.test/p/1)\n\n[Black tea ¥25](https://example.test/p/2)\n\nand [all teas](https://example.test/all)',
    )
  })

  it('writes lists, nested lists and ordered lists', () => {
    assert.equal(
      markdown('<ul><li>One</li><li>Two<ul><li>Two a</li><li>Two b</li></ul></li></ul><ol><li>First</li><li>Second</li></ol>'),
      '- One\n- Two\n  - Two a\n  - Two b\n\n1. First\n2. Second',
    )
  })

  it('writes a table as a grid, with or without a header row', () => {
    assert.equal(
      markdown('<table><thead><tr><th>Name</th><th>Price</th></tr></thead><tbody><tr><td>Mug</td><td>¥30 | sale</td></tr></tbody></table>'),
      '| Name | Price |\n| --- | --- |\n| Mug | ¥30 \\| sale |',
    )
    assert.equal(markdown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'), '|  |  |\n| --- | --- |\n| a | b |\n| c |  |')
  })

  it('reads a table that only arranges the page cell by cell, and keeps the data table inside it', () => {
    assert.equal(
      markdown('<table><tr><td><h2>News</h2><ul><li><a href="/a">First story</a></li><li>Second</li></ul></td><td><p>Sidebar</p></td></tr></table>'),
      '## News\n\n- [First story](https://example.test/a)\n- Second\n\nSidebar',
    )
    assert.equal(
      markdown('<table><tr><td><table><tr><td>1.</td><td><a href="https://x.test/">Title one</a></td></tr><tr><td>2.</td><td><a href="/item?id=2">Title two</a></td></tr></table></td></tr></table>'),
      '|  |  |\n| --- | --- |\n| 1. | [Title one](https://x.test/) |\n| 2. | [Title two](https://example.test/item?id=2) |',
    )
    assert.equal(markdown('<table role="presentation"><tr><td>Left</td><td>Right</td></tr></table>'), 'Left\n\nRight')
    assert.equal(markdown('<table><tr><td>Only cell</td></tr></table>'), 'Only cell')
    assert.equal(
      markdown('<table><tr><th>Name</th><th>Size</th></tr><tr><td><div><a href="/f">file.ts</a></div></td><td><span>2 KB</span></td></tr></table>'),
      '| Name | Size |\n| --- | --- |\n| [file.ts](https://example.test/f) | 2 KB |',
    )
  })

  it('keeps the words drawn in a chart, without its hidden definitions', () => {
    assert.equal(
      markdown('<p>Share</p><svg><title>pie icon</title><defs><text>template label</text></defs><text>42%</text><text>58%</text></svg><p>after</p>'),
      'Share\n\n42% 58%\n\nafter',
    )
  })

  it('keeps code, quotes and rules', () => {
    assert.equal(
      markdown('<p>Run <code>npm test</code>.</p><pre>line 1\n  line 2\n</pre><blockquote>Quoted<br>twice</blockquote><hr>'),
      'Run `npm test`.\n\n```\nline 1\n  line 2\n```\n\n> Quoted\n> twice\n\n---',
    )
  })

  it('keeps what an image says and not where it is stored', () => {
    assert.equal(
      markdown('<p><img src="/a.png" alt="A diagram of the flow"> <img src="/dot.gif" alt=""> <img src="data:image/png;base64,AAAA" alt="Inline chart"></p>'),
      '![A diagram of the flow] ![Inline chart]',
    )
  })

  it('leaves out scripts, styles, parts that are not rendered and whatever was typed into fields', () => {
    assert.equal(markdown(`
      <script>window.secret = 'in a script'</script><style>.a{color:red}</style><noscript>enable js</noscript>
      <div hidden>hidden by attribute</div>
      <div style="display:none">hidden by style</div>
      <form><label>Password <input type="password" value="hunter2-secret"></label><input type="text" value="typed text"><textarea>draft</textarea>
        <select><option>Option one</option></select><button>Sign in</button></form>
      <p>Visible</p>`), 'Password Sign in\n\nVisible')
  })

  it('keeps a page that sits behind an open dialog: it is still on screen', () => {
    assert.equal(markdown('<main aria-hidden="true"><p>The article underneath.</p></main><div role="dialog"><p>Accept cookies?</p></div>'),
      'The article underneath.\n\nAccept cookies?')
  })

  it('reads pages that are not articles: text between blocks is not lost', () => {
    assert.equal(
      markdown('<div>Results for "tea" <span>(12)</span><div class="card"><a href="/p/1">Green tea</a> <span>¥20</span></div><div class="card"><a href="/p/2">Black tea</a> <span>¥25</span></div>End of list</div>'),
      'Results for "tea" (12)\n\n[Green tea](https://example.test/p/1) ¥20\n\n[Black tea](https://example.test/p/2) ¥25\n\nEnd of list',
    )
  })

  it('reads what an open shadow root renders', () => {
    const dom = new JSDOM('<!doctype html><html><body><p>Before</p><div id="host"></div></body></html>', { url: 'https://example.test/', runScripts: 'outside-only' })
    const host = dom.window.document.getElementById('host')!
    host.attachShadow({ mode: 'open' }).innerHTML = '<h2>Inside the component</h2><p>Shadow <a href="/more">text</a>.</p>'
    const page = JSON.parse(JSON.stringify(dom.window.eval(buildPageMarkdownScript()))) as PageResult
    assert.equal(page.markdown, 'Before\n\n## Inside the component\n\nShadow [text](https://example.test/more).')
  })

  it('an empty page is an empty result, not an error', () => {
    const empty = convert('')
    assert.deepEqual([empty.ok, empty.markdown], [true, ''])
  })
})

describe('reading a text in windows', () => {
  const text = Array.from({ length: 40 }, (_unused, index) => `Paragraph number ${index} with a [link](https://example.test/n/${index}).`).join('\n\n')

  it('windows of an unchanged text join up to the whole, and each says what is left', () => {
    let joined = ''
    let offset = 0
    let rounds = 0
    for (;;) {
      const part = sliceReadContent(text, offset, 300)
      assert.equal(part.totalChars, text.length)
      assert.equal(part.returnedChars, part.content.length)
      assert.ok(part.content.length <= 300)
      joined += part.content
      rounds += 1
      if (!part.truncated) {
        assert.equal(part.nextOffset, undefined)
        break
      }
      assert.equal(part.nextOffset, offset + part.content.length)
      offset = part.nextOffset!
    }
    assert.equal(joined, text)
    assert.equal(rounds, Math.ceil(text.length / 300))
  })

  it('a window that fits everything is not truncated; one past the end is empty', () => {
    assert.deepEqual(sliceReadContent('short', 0, 20_000), { content: 'short', totalChars: 5, returnedChars: 5, truncated: false })
    assert.deepEqual(sliceReadContent('short', 99, 10), { content: '', totalChars: 5, returnedChars: 0, truncated: false })
    assert.deepEqual(sliceReadContent(null, 0, 10), { content: '', totalChars: 0, returnedChars: 0, truncated: false })
    assert.deepEqual(sliceReadContent('abcdef', 2, 3), { content: 'cde', totalChars: 6, returnedChars: 3, truncated: true, nextOffset: 5 })
  })
})

describe('reading a whole tab', () => {
  function controllerOf(options: {
    main: unknown | (() => unknown)
    frames?: Array<{ frameKey: string; url: string; main?: boolean; result: unknown | (() => unknown) }>
  }) {
    const scripts: string[] = []
    const value = (source: unknown | (() => unknown)) => typeof source === 'function' ? (source as () => unknown)() : source
    const controller = {
      executeJS: async (_tabId: string | null, script: string) => { scripts.push(script); return value(options.main) },
      listContentFrames: () => (options.frames || []).map(({ frameKey, url, main }) => ({ frameKey, url, main: main === true })),
      executeJSInFrame: async (_tabId: string | null, frameKey: string, script: string) => {
        scripts.push(script)
        return value(options.frames!.find((frame) => frame.frameKey === frameKey)!.result)
      },
    } as unknown as BrowserController
    return { controller, scripts }
  }
  const document = (markdown: string, extra: Record<string, unknown> = {}) => ({ ok: true, url: 'https://example.test/', title: 'Main', markdown, hitHardLimit: false, ...extra })

  it('puts each content frame after the main document, under a line naming the frame and its address', async () => {
    const { controller, scripts } = controllerOf({
      main: document('# Main page'),
      frames: [
        { frameKey: '0', url: 'https://example.test/', main: true, result: document('never asked') },
        { frameKey: 'f1', url: 'https://pay.example/frame', result: document('Card number', { url: 'https://pay.example/frame' }) },
        { frameKey: 'f2', url: 'https://ads.example/x', result: document('   ') },
      ],
    })
    assert.deepEqual(await readTabAsMarkdown(controller, 'tab-1'), {
      ok: true,
      url: 'https://example.test/',
      title: 'Main',
      markdown: '# Main page\n\n[frame f1 https://pay.example/frame]\nCard number',
      hardLimitReached: false,
    })
    assert.equal(scripts.length, 3)
    assert.ok(scripts.every((script) => script.includes('__READY_PAGE_MARKDOWN__')))
  })

  it('reports a page that outgrew the hard limit', async () => {
    const { controller } = controllerOf({ main: document('cut text', { hitHardLimit: true }) })
    const reading = await readTabAsMarkdown(controller, null)
    assert.equal(reading.ok && reading.hardLimitReached, true)
  })

  it('a document that cannot be converted is a failure, never an empty success', async () => {
    assert.deepEqual(await readTabAsMarkdown(controllerOf({ main: null }).controller, null),
      { ok: false, errorKind: 'page_read_failed', message: 'page_script_returned_nothing' })
    assert.deepEqual(await readTabAsMarkdown(controllerOf({ main: { ok: false, reason: 'no_document_body' } }).controller, null),
      { ok: false, errorKind: 'page_read_failed', message: 'no_document_body' })
    assert.deepEqual(await readTabAsMarkdown(controllerOf({ main: () => { throw new Error('Execution context was destroyed') } }).controller, null),
      { ok: false, errorKind: 'page_read_failed', message: 'Execution context was destroyed' })
    const cancelled = Object.assign(new Error('run cancelled'), { name: 'AbortError' })
    await assert.rejects(readTabAsMarkdown(controllerOf({ main: () => { throw cancelled } }).controller, null), /run cancelled/)
    await assert.rejects(readTabAsMarkdown(controllerOf({
      main: document('# Main'),
      frames: [{ frameKey: 'f1', url: 'https://x.example/', result: () => { throw cancelled } }],
    }).controller, null), /run cancelled/)
    assert.deepEqual(
      await readTabAsMarkdown(controllerOf({
        main: document('# Main'),
        frames: [{ frameKey: 'f1', url: 'https://x.example/', result: () => { throw new Error('frame detached') } }],
      }).controller, null),
      { ok: false, errorKind: 'frame_read_failed', frameId: 'f1', message: 'frame detached' },
    )
  })
})
