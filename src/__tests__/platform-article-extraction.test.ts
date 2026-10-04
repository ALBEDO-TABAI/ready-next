import assert from 'node:assert/strict'
import test from 'node:test'
import { ReadabilityJsdomAdapter } from '../main/modules/clipping/readability-jsdom-adapter'

const extract = (html: string, url: string) => new ReadabilityJsdomAdapter().extract({ html, url })

const XHS_NOTE_ID = '66f1a2b3c4d5e6f708192a3b'
const xhsPage = (note: Record<string, unknown>) => `<!doctype html><html><head><title>小红书</title></head><body>
<div id="app"><div class="login-container"><form><input type="password" name="pw"></form></div><span>沪ICP备13030189号</span></div>
<script>window.__SSR__=true</script>
<script>window.__INITIAL_STATE__=${JSON.stringify({ global: { appSettings: { notificationInterval: 30 } }, note: { currentNoteId: XHS_NOTE_ID, noteDetailMap: { [XHS_NOTE_ID]: { note } } } })
  .replace('"__UNDEFINED__"', 'undefined')}</script>
</body></html>`

test('a Xiaohongshu note reads from the page state instead of leaking the state script as text', async () => {
  const result = await extract(xhsPage({
    noteId: XHS_NOTE_ID, type: 'normal', title: '分享广州默默无闻但很好吃的大排档。。。', time: Date.parse('2026-10-02T03:58:00Z'),
    desc: '藏在老城区的小巷里，开了二十多年。\n招牌是椒盐濑尿虾和啫啫鸡煲[哭惹R]\n#广州美食[话题]# #大排档[话题]#',
    user: { nickname: '广州潮会吃' }, tagList: [{ name: '广州美食' }, { name: '夜宵' }],
    imageList: [
      { urlDefault: 'http://sns-webpic-qc.xhscdn.com/202610/a1!nd_dft_wlteh_webp_3', infoList: [{ imageScene: 'WB_PRV', url: 'http://sns-webpic-qc.xhscdn.com/202610/a1!nd_prv' }, { imageScene: 'WB_DFT', url: 'http://sns-webpic-qc.xhscdn.com/202610/a1!nd_dft' }] },
      { urlDefault: 'https://sns-webpic-qc.xhscdn.com/202610/a2!nd_dft_wlteh_webp_3' },
    ],
    video: '__UNDEFINED__',
  }), `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}?xsec_token=abc`)
  assert.equal(result.title, '分享广州默默无闻但很好吃的大排档。。。')
  assert.doesNotMatch(result.contentMarkdown, /__INITIAL_STATE__|appSettings|ICP/)
  assert.match(result.contentMarkdown, /^!\[图 1\][^\n]+\n\n!\[图 2\][^\n]+\n\n藏在老城区的小巷里，开了二十多年。\n\n招牌是椒盐濑尿虾和啫啫鸡煲\n\n/, 'pictures lead, then the text')
  assert.match(result.contentMarkdown, /!\[图 1\]\(https:\/\/sns-webpic-qc\.xhscdn\.com\/202610\/a1!nd_dft\)/, 'the full-size https image')
  assert.match(result.contentMarkdown, /!\[图 2\]\(https:\/\/sns-webpic-qc\.xhscdn\.com\/202610\/a2/)
  assert.match(result.contentMarkdown, /\n\n#广州美食 #大排档 #夜宵$/, 'the closing tag line gains tags the text does not already mention')
  assert.equal(result.metadata.author, '广州潮会吃')
  assert.ok(result.diagnostics.confidence >= 0.8, 'a short but complete note is a whole article')
})

test('a Xiaohongshu video note shows its cover and points to the original for playback', async () => {
  const result = await extract(xhsPage({ noteId: XHS_NOTE_ID, type: 'video', title: '探店视频', desc: '一分钟看完这家店', imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/v/cover' }] }),
    `https://www.xiaohongshu.com/discovery/item/${XHS_NOTE_ID}`)
  assert.match(result.contentMarkdown, /^!\[视频封面\]\(https:\/\/sns-webpic-qc\.xhscdn\.com\/v\/cover\)\n\n_视频笔记：打开原文观看视频。_\n\n一分钟看完这家店$/)
})

const HN_ITEM = `<html><head><title>Bob Cringely Has Died | Hacker News</title></head><body><center><table id="hnmain"><tr><td><table><tr><td><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b> | <a href="newest">new</a></span></td></tr></table></td></tr>
<tr id="bigbox"><td><table class="fatitem" border="0">
<tr class="athing submission" id="49949438"><td align="right" valign="top" class="title"><span class="rank"></span></td><td valign="top" class="votelinks"><center><a id="up_49949438" href="vote?id=49949438&amp;how=up&amp;goto=item%3Fid%3D49949438"><div class="votearrow" title="upvote"></div></a></center></td><td class="title"><span class="titleline"><a href="item?id=49949438">Bob Cringely Has Died</a></span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_49949438">196 points</span> by <a href="user?id=paveworld" class="hnuser">paveworld</a> <span class="age" title="2026-10-04T00:50:52 1791075052"><a href="item?id=49949438">2 hours ago</a></span> <span id="unv_49949438"></span> | <a href="hide?id=49949438&amp;goto=item%3Fid%3D49949438">hide</a> | <a href="https://hn.algolia.com/?query=Bob">past</a> | <a href="fave?id=49949438&amp;auth=x">favorite</a> | <a href="item?id=49949438">30&nbsp;comments</a></span></td></tr>
<tr><td colspan="2"></td><td><div class="toptext">I heard from a friend of the family that Bob passed away in his sleep early Saturday. Very sad news.<p>Bob, who's real name was Mark Stephens, was best known for his PBS documentaries, especially "Triumph of the Nerds". He will be missed.</div></td></tr>
<tr><td colspan="2"></td><td><form action="comment" method="post"><textarea name="text"></textarea><br><input type="submit" value="add comment"></form></td></tr>
</table><br><table border="0" class="comment-tree">
<tr class="athing comtr" id="49949500"><td><table border="0"><tr><td class="ind" indent="0"><img src="s.gif" height="1" width="0"></td><td valign="top" class="votelinks"><center><a id="up_49949500" href="vote?id=49949500"><div class="votearrow"></div></a></center></td><td class="default"><div><span class="comhead"><a href="user?id=alice" class="hnuser">alice</a> <span class="age" title="2026-10-04T01:10:00"><a href="item?id=49949500">1 hour ago</a></span> <span class="navs"> | <a href="#49949520">next</a> <a class="togg clicky" href="javascript:void(0)">[–]</a></span></span></div><br><div class="comment"><div class="commtext c00">Triumph of the Nerds was <i>the</i> documentary of that era.<p>RIP Bob. Archive: <a href="https://example.com/pbs" rel="nofollow">https://example.com/pbs</a><p><pre><code>  10 PRINT "THANKS BOB"</code></pre></div><div class="reply"><p><font size="1"><u><a href="reply?id=49949500">reply</a></u></font></p></div></div></td></tr></table></td></tr>
<tr class="athing comtr" id="49949510"><td><table border="0"><tr><td class="ind" indent="1"><img src="s.gif" height="1" width="40"></td><td class="default"><span class="comhead"><a href="user?id=bob2" class="hnuser">bob2</a> <span class="age"><a href="item?id=49949510">50 minutes ago</a></span></span><div class="comment"><div class="commtext c00">A nested reply that stays on the original page.</div></div></td></tr></table></td></tr>
<tr class="athing comtr" id="49949520"><td><table border="0"><tr><td class="ind" indent="0"></td><td class="default"><span class="comhead"><a href="user?id=carol" class="hnuser">carol</a> <span class="age"><a href="item?id=49949520">40 minutes ago</a></span></span><div class="comment"><div class="commtext c00">His column was required reading.</div></div></td></tr></table></td></tr>
</table><br><center><a href="newsguidelines.html">Guidelines</a> | <a href="newsfaq.html">FAQ</a></center></td></tr></table></center></body></html>`

test('a Hacker News text post reads as the post, its byline and top-level comments instead of table markup', async () => {
  const result = await extract(HN_ITEM, 'https://news.ycombinator.com/item?id=49949438')
  assert.equal(result.title, 'Bob Cringely Has Died')
  assert.doesNotMatch(result.contentMarkdown, /<\/?(?:table|td|tr|span|form)\b|votearrow|Guidelines|add comment|nested reply/)
  assert.match(result.contentMarkdown, /^196 points · by paveworld · 2 hours ago · 30 comments\n\nI heard from a friend of the family that Bob passed away in his sleep early Saturday\. Very sad news\.\n\nBob, who's real name was Mark Stephens/)
  assert.doesNotMatch(result.contentMarkdown, /原文链接/, 'a text post links to itself, not to an outside article')
  assert.match(result.contentMarkdown, /## 评论\n\n\*\*alice\*\* · 1 hour ago\n\n> Triumph of the Nerds was \*the\* documentary of that era\.\n>\n> RIP Bob\. Archive: \[https:\/\/example\.com\/pbs\]\(https:\/\/example\.com\/pbs\)\n>\n> ```\n> {3}10 PRINT "THANKS BOB"\n> ```/)
  assert.match(result.contentMarkdown, /\*\*carol\*\* · 40 minutes ago\n\n> His column was required reading\.$/)
  assert.equal(result.metadata.published, '2026-10-04T00:50:52')
  assert.ok(result.diagnostics.confidence >= 0.8)
})

test('a Hacker News link post names the outside article it discusses', async () => {
  const result = await extract(HN_ITEM.replace('<a href="item?id=49949438">Bob Cringely Has Died</a>', '<a href="https://www.cringely.com/2026/10/03/farewell/">Bob Cringely Has Died</a>'),
    'https://news.ycombinator.com/item?id=49949438')
  assert.match(result.contentMarkdown, /\n\n原文链接：\[cringely\.com\]\(https:\/\/www\.cringely\.com\/2026\/10\/03\/farewell\/\)\n\n/)
})

test('generic pages drop page scripts, flatten layout tables and keep data tables as tables', async () => {
  const filler = 'This paragraph is part of the article body and carries enough words to be read as content. '.repeat(4)
  const html = `<html><body><script>window.__STATE__={"secret":"state-json"}</script><style>.x{color:red}</style>
<table role="presentation"><tr><td><p>${filler}</p></td><td><p>Second column of the layout. ${filler}</p></td></tr></table>
<article><h1>Benchmark notes</h1><p>${filler}</p><table><thead><tr><th>Model</th><th>Score</th></tr></thead><tbody><tr><td>A</td><td>91</td></tr></tbody></table><p>${filler}</p></article>
<noscript>Please enable JavaScript</noscript></body></html>`
  const result = await extract(html, 'https://example.com/post')
  assert.doesNotMatch(result.contentMarkdown, /state-json|color:red|enable JavaScript/)
  assert.match(result.contentMarkdown, /\| Model \| Score \|\n\| --- \| --- \|\n\| A \| 91 \|/, 'a data table keeps its rows and columns')
  // A script-rendered shell has no readable article, so extraction falls back to the whole body.
  const shell = await extract(`<html><body><div id="app"></div><script>window.__STATE__={"secret":"state-json"}</script></body></html>`, 'https://example.com/app')
  assert.equal(shell.diagnostics.warnings.includes('readability_parse_returned_null'), true, 'the fixture exercises the body fallback')
  assert.doesNotMatch(shell.contentMarkdown, /state-json|__STATE__/)
  // A nested layout table reads as text in both modes.
  const listing = `<html><body><table><tr><td><table><tr><td><p>Short listing title</p></td></tr></table></td></tr></table></body></html>`
  assert.doesNotMatch((await extract(listing, 'https://example.com/listing')).contentMarkdown, /<\/?(?:table|tr|td)\b/)
})

test('the reader extraction never keeps page HTML tables: heading-less grids gain an empty heading, spanning tables read as text', async () => {
  const reader = new ReadabilityJsdomAdapter({ tables: 'markdown' })
  const filler = 'This paragraph is part of the article body and carries enough words to be read as content. '.repeat(4)
  const page = (table: string) => `<html><body><article><h1>Notes</h1><p>${filler}</p>${table}<p>${filler}</p></article></body></html>`
  const rows = [['Model A', '91', '<a href="/a">notes</a>'], ['Model B', '88', 'n/a'], ['Model C', '84', 'n/a'], ['Model D', '80', 'n/a']]
  const plain = await reader.extract({ html: page(`<table>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`), url: 'https://example.com/a' })
  assert.match(plain.contentMarkdown, /\|\s*\|\s*\|\s*\|\n\| --- \| --- \| --- \|\n\| Model A \| 91 \| \[notes\]\(https:\/\/example\.com\/a\) \|\n\| Model B \| 88 \| n\/a \|/, 'the first row stays data under an empty heading')
  const spanning = await reader.extract({ html: page('<table><tr><th colspan="2">Quarter</th></tr><tr><td>Q1</td><td>12</td></tr></table>'), url: 'https://example.com/b' })
  assert.doesNotMatch(spanning.contentMarkdown, /<\/?(?:table|tr|td|th)\b/)
  assert.match(spanning.contentMarkdown, /Quarter[\s\S]*Q1\s+12/)
  const clip = await new ReadabilityJsdomAdapter().extract({ html: page(`<table>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`), url: 'https://example.com/c' })
  assert.match(clip.contentMarkdown, /<table>/, 'clipping into notes still keeps heading-less tables as HTML')
})
