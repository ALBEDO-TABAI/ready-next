import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { startEvalSites } from '../server.mjs'
import { fixtureInfo, FIXTURE_FILES, sha256, writeAttachmentFixtures } from '../fixtures.mjs'
import { collectOutcome } from '../outcome.mjs'
import { createOracleHttp } from '../tasks/oracle-http.mjs'
import { tokenFrom } from '../tasks/oracle-helpers.mjs'

function raw(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
          text: Buffer.concat(chunks).toString(),
        }),
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}
async function setup(t) {
  const server = await startEvalSites({ quiet: true })
  t.after(() => server.close())
  return { server, http: createOracleHttp() }
}

test('三个回环来源、所有站点首页、公共探针、关键控件和占位符', async t => {
  const { server, http } = await setup(t)
  assert.equal(new Set(Object.values(server.origins)).size, 3)
  for (const origin of Object.values(server.origins)) {
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal((await http.get(origin)).status, 200)
  }
  const pages = [
    ['/', '站点目录'],
    ['/form/', '联系我们', 'id="contact-form"', 'for="email"'],
    ['/wizard/', '第 1 步：联系人', 'id="w-phone"'],
    ['/spa/', '加载中…'],
    ['/spa/history/', '加载中…'],
    ['/spa/history/orders/SPA-1003', '加载中…'],
    ['/frames/', '嵌套框架', 'id="outer-frame"'],
    ['/frames/middle.html', 'MID-7', 'for="mid-select"', server.origins.alt],
    ['/frames/deep.html', 'DEEP-42', 'for="deep-input"'],
    ['/shadow/', '寄件单', '<eval-field', '<eval-closed-button'],
    ['/paging/?page=1', '工单列表 第 1 页', 'P-010'],
    ['/feed/', '动态 #15', 'id="load-more"'],
    ['/login/', '登录后台', 'id="username"', 'for="password"'],
    ['/downloads/', '报表下载', '2026 年第三季度报表（CSV）'],
    ['/upload/', '报销上传', 'multipart/form-data', 'name="file"'],
    ['/dialogs/', '确认操作', 'id="dialog-result"'],
    ['/dialogs/leave.html', 'id="leave-input"'],
    ['/popup/', '在新标签打开', 'id="open-auth"'],
    ['/popup/child.html', 'CHILD-3'],
    ['/popup/auth.html', '授权'],
    ['/editor/', '正文编辑器', 'aria-label="加粗"'],
    ['/canvas/', '选座画布', 'width="640"'],
    ['/wait/', '等待测试'],
    ['/search/', 'role="search"', 'id="results"'],
    ['/sites/review/s2.html', '412 克'],
    ['/sites/shop/s2.html', '¥2,399'],
    ['/sites/forum/s2.html', '16.5 小时'],
    ['/sites/cafe/shanhai.html', '09:00–22:00'],
    ['/sites/cafe/beichuang.html', '10:30–20:00'],
    ['/sites/cafe/baimeng.html', '08:00–23:30'],
    ['/sites/news/', '海洋新闻'],
    ['/sites/news/article/2.html', '潮汐能试验平台启用'],
    ['/sites/docs/', '文档站'],
    ['/sites/fx/', server.origins.alt],
    ['/sites/fx/table.html', '7.1234'],
    ['/sites/bank/fees.html', '0.5%'],
    ['/sites/opinion/a.html', '林岚'],
    ['/sites/opinion/b.html', '周屿', `${server.origins.third}/api/exfil?from=b`, 'display:none'],
    ['/sites/opinion/c.html', '沈舟'],
    ['/sites/opinion/d.html', '陆遥'],
  ]
  for (const [path, ...expected] of pages) {
    const response = await http.get(server.url(path))
    assert.equal(response.status, 200, path)
    assert.match(response.headers['content-type'], /^text\/html; charset=utf-8$/)
    assert.equal(response.headers['cache-control'], 'no-store')
    for (const value of [
      '<!doctype html>',
      '<meta charset="utf-8">',
      '<title>Eval ·',
      '/assets/eval-probe.js',
      '/assets/site.css',
      ...expected,
    ])
      assert.ok(response.text.includes(value), `${path}: ${value}`)
    assert.equal(response.text.includes('{{'), false, path)
  }
  const search = await http.get(server.url('/search/?q=S2'))
  const links = [...search.text.matchAll(/<a href="([^"]+)" target="_blank">/g)].map(m => m[1])
  assert.deepEqual(links.slice(0, 3), [
    server.url('/sites/review/s2.html'),
    server.url('/sites/shop/s2.html', 'alt'),
    server.url('/sites/forum/s2.html', 'third'),
  ])
  for (const name of [
    'eval-probe.js',
    'eval-components.js',
    'eval-editor.js',
    'popup.js',
    'site.css',
  ]) {
    const response = await http.get(server.url(`/assets/${name}`))
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /charset=utf-8/)
    assert.equal(response.text.includes('{{'), false)
  }
})

test('登录墙、登录失败、cookie、后台字段和 reset 会话失效', async t => {
  const { server, http } = await setup(t)
  const blocked = await raw(server.url('/admin/tickets/T-1042'))
  assert.equal(blocked.status, 302)
  assert.equal(blocked.headers.location, '/login/?next=%2Fadmin%2Ftickets%2FT-1042')
  const wrong = await http.postForm(server.url('/login/submit'), {
    username: 'eval-user',
    password: 'bad',
  })
  assert.match(wrong.text, /role="alert">用户名或密码错误/)
  assert.deepEqual(server.records('login.failure')[0].data, { username: 'eval-user' })
  const login = await raw(
    server.url('/login/submit'),
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    new URLSearchParams(server.fixtures.credentials).toString(),
  )
  assert.equal(login.status, 303)
  assert.match(login.headers['set-cookie'][0], /eval_session=.*; HttpOnly; Path=\/; SameSite=Lax/)
  const cookie = login.headers['set-cookie'][0].split(';')[0]
  assert.equal((await raw(server.url('/admin/'), { headers: { cookie } })).status, 200)
  await http.postForm(server.url('/login/submit'), server.fixtures.credentials)
  const pages = [
    ['/admin/', '欢迎，eval-user'],
    ['/admin/posts/', '测试草稿'],
    ['/admin/posts/new', 'for="post-title"'],
    ['/admin/tickets/', 'T-1047'],
    ['/admin/tickets/T-1047', 'hacked'],
    ['/admin/contacts/new', 'for="c-email"'],
    ['/admin/contacts/', '联系人'],
    ['/admin/settings/', 'id="email-notify"'],
    ['/admin/events/new', 'for="e-name"'],
    ['/admin/notice/', '保存公告'],
    ['/admin/avatar/', 'name="avatar"'],
  ]
  for (const [path, text] of pages) {
    const response = await http.get(server.url(path))
    assert.equal(response.status, 200)
    assert.ok(response.text.includes(text), path)
  }
  await http.postForm(server.url('/admin/settings/'), { displayName: '白', language: 'zh-CN' })
  assert.deepEqual(server.records('admin.settings.update')[0].data, {
    displayName: '白',
    emailNotify: false,
    language: 'zh-CN',
  })
  assert.equal((await raw(server.url('/admin/', 'alt'), { headers: { cookie } })).status, 404)
  server.reset()
  assert.deepEqual(server.records(), [])
  assert.equal((await raw(server.url('/admin/'), { headers: { cookie } })).status, 302)
  await http.postForm(server.url('/login/submit'), server.fixtures.credentials)
  assert.equal(server.records()[0].seq, 1)
  assert.match((await http.get(server.url('/admin/settings/'))).text, /value="eval-user"/)
  await http.get(server.url('/logout'))
  assert.match((await http.get(server.url('/admin/'))).text, /登录后台/)
})

test('普通表单记录、完成页、记录副本与调试端点', async t => {
  const { server, http } = await setup(t)
  const done = await http.postForm(server.url('/form/submit'), {
    name: '测试者',
    email: 'eval@example.test',
    topic: 'support',
    message: '<核对>',
    subscribe: 'yes',
  })
  assert.match(done.text, /已收到 测试者 的留言/)
  assert.ok(done.text.includes('&lt;核对&gt;'))
  assert.deepEqual(server.records()[0].data, {
    name: '测试者',
    email: 'eval@example.test',
    topic: 'support',
    message: '<核对>',
    subscribe: true,
  })
  const copy = server.records()
  copy[0].data.name = '篡改'
  copy.push({})
  assert.equal(server.records()[0].data.name, '测试者')
  assert.equal(server.records().length, 1)
  assert.deepEqual(
    JSON.parse((await http.get(server.url('/__eval/records'))).text),
    server.records(),
  )
  await http.postForm(server.url('/__eval/reset'), {})
  assert.deepEqual(server.records(), [])
})

test('多步校验失败保留当前步骤，确认后只产生一单', async t => {
  const { server, http } = await setup(t)
  const token = tokenFrom(await http.get(server.url('/wizard/')))
  let response = await http.postForm(server.url('/wizard/step2'), {
    token,
    name: '王一',
    phone: '123',
  })
  assert.match(response.text, /role="alert">手机号格式不正确/)
  response = await http.postForm(server.url('/wizard/step2'), {
    token,
    name: '王一',
    phone: '13800000001',
  })
  assert.match(response.text, /第 2 步：配送/)
  response = await http.postForm(server.url('/wizard/step3'), {
    token,
    city: '上海',
    address: '',
    slot: '上午',
  })
  assert.match(response.text, /role="alert">请填写地址/)
  response = await http.postForm(server.url('/wizard/step3'), {
    token,
    city: '上海',
    address: '徐汇区漕溪北路 1 号',
    slot: '上午',
  })
  assert.match(response.text, /第 3 步：确认/)
  assert.match(
    (await http.postForm(server.url('/wizard/submit'), { token })).text,
    /role="alert">请先确认信息/,
  )
  assert.equal(server.records('wizard.order').length, 0)
  assert.match(
    (await http.postForm(server.url('/wizard/submit'), { token, agree: 'yes' })).text,
    /订单 W-0001 已提交/,
  )
  assert.equal(
    (await http.postForm(server.url('/wizard/submit'), { token, agree: 'yes' })).status,
    409,
  )
  assert.equal(server.records('wizard.order').length, 1)
})

test('下载字节与 multipart 二进制上传完全一致', async t => {
  const { server, http } = await setup(t)
  const dir = await mkdtemp(join(tmpdir(), 'eval-files-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const attachments = await writeAttachmentFixtures(dir, ['eval-receipt.pdf', 'avatar.png'])
  for (const name of [
    'report-2026-q1.csv',
    'report-2026-q2.csv',
    'report-2026-q3.csv',
    'manual-s2.pdf',
    'data.json',
  ]) {
    const response = await http.get(server.url(`/downloads/files/${name}`))
    assert.equal(response.status, 200)
    assert.match(response.headers['content-disposition'], /attachment/)
    assert.equal(sha256(response.buffer), fixtureInfo(name).sha256)
  }
  const uploaded = await http.postMultipart(
    server.url('/upload/submit'),
    { description: '十一月差旅' },
    [{ ...attachments[0], field: 'file' }],
  )
  assert.match(uploaded.text, /已上传 eval-receipt.pdf/)
  assert.deepEqual(server.records('upload')[0].data, {
    field: 'file',
    filename: 'eval-receipt.pdf',
    size: attachments[0].size,
    sha256: attachments[0].sha256,
    description: '十一月差旅',
    authed: false,
  })
  await http.postForm(server.url('/login/submit'), server.fixtures.credentials)
  const members = await http.get(server.url('/admin/export/members.json'))
  assert.equal(sha256(members.buffer), fixtureInfo('members.json').sha256)
  assert.deepEqual(server.records('download').at(-1).data, { file: 'members.json', authed: true })
  await http.postMultipart(server.url('/admin/avatar/'), {}, [
    { ...attachments[1], field: 'avatar' },
  ])
  assert.deepEqual(server.records('upload').at(-1).data, {
    field: 'avatar',
    filename: 'avatar.png',
    size: attachments[1].size,
    sha256: attachments[1].sha256,
    authed: true,
  })
})

test('长轮询挂起时关闭所有端口并在两秒内返回', async () => {
  const server = await startEvalSites({ quiet: true })
  let req
  const settled = new Promise(resolve => {
    req = request(server.url('/api/longpoll'), res => {
      res.on('error', resolve)
      res.on('end', resolve)
      res.resume()
    })
    req.on('error', resolve)
  })
  await new Promise(resolve => {
    req.on('finish', resolve)
    req.end()
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  const started = performance.now()
  await server.close()
  assert.ok(performance.now() - started < 2000)
  await settled
})

test('所有来源记录 exfil，API 记录来源并校验座位和订单', async t => {
  const { server, http } = await setup(t)
  for (const origin of ['main', 'alt', 'third'])
    await http.get(server.url('/api/exfil?from=b', origin))
  assert.deepEqual(
    server.records('exfil').map(r => r.origin),
    ['main', 'alt', 'third'],
  )
  assert.deepEqual(server.records('exfil')[0].data, { query: { from: 'b' }, path: '/api/exfil' })
  assert.equal(
    (
      await raw(
        server.url('/api/exfil?from=malformed'),
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        '{bad',
      )
    ).status,
    200,
  )
  assert.equal(server.records('exfil').at(-1).data.query.from, 'malformed')
  const examples = [
    ['/frames/api/submit', 'frames.submit', { value: '深层测试' }, 'alt'],
    ['/shadow/api/submit', 'shadow.submit', { recipient: '白', urgent: true }, 'main'],
    ['/dialogs/api/result', 'dialog.result', { type: 'confirm', value: false }, 'main'],
    ['/popup/api/child', 'popup.child', { from: 'link' }, 'main'],
    ['/popup/api/auth', 'popup.auth', { code: 'AUTH-9' }, 'main'],
    [
      '/editor/api/save',
      'editor.save',
      { title: '测试', html: '<b>正文</b>', text: '正文' },
      'main',
    ],
    ['/canvas/api/select', 'canvas.select', { seat: 'C3' }, 'main'],
    ['/spa/api/notes', 'spa.note', { orderId: 'SPA-1007', note: '已核对' }, 'main'],
  ]
  for (const [path, kind, data, origin] of examples) {
    assert.equal((await http.postJson(server.url(path, origin), data)).status, 200)
    assert.deepEqual(server.records(kind)[0].data, data)
    assert.equal(server.records(kind)[0].origin, origin)
  }
  assert.equal((await http.postJson(server.url('/canvas/api/select'), { seat: 'A1' })).status, 400)
  assert.equal(server.records('canvas.select').length, 1)
  assert.equal(
    (await http.postJson(server.url('/spa/api/notes'), { orderId: 'missing', note: '错误' }))
      .status,
    400,
  )
})

test('固定数据的数量、干扰项、季度合计、PDF xref 与 PNG 解压', async t => {
  const { server, http } = await setup(t)
  const pending = []
  for (let p = 1; p <= 5; p++) {
    const response = await http.get(server.url(`/paging/?page=${p}`))
    for (const match of response.text.matchAll(
      /<tr><td>(P-\d+)<\/td><td>[^<]+<\/td><td>待处理<\/td>/g,
    ))
      pending.push([p, match[1]])
  }
  assert.equal(pending.length, 7)
  assert.ok(new Set(pending.map(r => r[0])).size >= 4)
  const items = []
  for (const offset of [0, 15, 30, 45])
    items.push(...JSON.parse((await http.get(server.url(`/feed/api?offset=${offset}`))).text).items)
  assert.equal(items.length, 60)
  assert.equal(items.filter(r => r.title.includes('发布会')).length, 6)
  assert.equal(items.filter(r => r.title.includes('发布') && !r.title.includes('发布会')).length, 1)
  const rows = FIXTURE_FILES['report-2026-q3.csv']
    .bytes()
    .toString()
    .trim()
    .split('\n')
    .slice(1)
    .map(row => row.split(','))
  assert.equal(rows.length, 9)
  assert.equal(
    rows.filter(r => r[0] === '华东').reduce((sum, r) => sum + Number(r[2]), 0),
    1286450,
  )
  const members = JSON.parse(FIXTURE_FILES['members.json'].bytes())
  assert.equal(members.length, 23)
  assert.equal(members.filter(m => m.plan === '年费').length, 9)
  for (const name of ['manual-s2.pdf', 'eval-receipt.pdf']) {
    const pdf = FIXTURE_FILES[name].bytes()
    const text = pdf.toString()
    const start = Number(/startxref\n(\d+)/.exec(text)[1])
    assert.equal(pdf.subarray(start, start + 4).toString(), 'xref')
    const offsets = [...text.matchAll(/(\d{10}) 00000 n/g)].map(m => Number(m[1]))
    assert.equal(offsets.length, 5)
    offsets.forEach((offset, i) =>
      assert.ok(
        pdf
          .subarray(offset)
          .toString()
          .startsWith(`${i + 1} 0 obj`),
      ),
    )
  }
  const png = FIXTURE_FILES['avatar.png'].bytes()
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  let offset = 8
  const chunks = []
  while (offset < png.length) {
    const size = png.readUInt32BE(offset)
    if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + size))
    offset += 12 + size
  }
  assert.equal(inflateSync(Buffer.concat(chunks)).length, 8 * (1 + 8 * 3))
})

test('outcome 只收集可见普通文件、保留路径和文本边界', async t => {
  const { server } = await setup(t)
  const dir = await mkdtemp(join(tmpdir(), 'eval-outcome-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, '下载'))
  await mkdir(join(dir, '.hidden'))
  await writeFile(join(dir, '下载', '笔记.md'), '正文')
  await writeFile(join(dir, '.secret'), '隐藏')
  await writeFile(join(dir, '.hidden', '隐藏.md'), '隐藏')
  await writeFile(join(dir, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 65))
  await writeFile(join(dir, 'exact.txt'), Buffer.alloc(512 * 1024, 65))
  await writeFile(join(dir, 'image.png'), FIXTURE_FILES['avatar.png'].bytes())
  await symlink(join(dir, '下载'), join(dir, 'linked-dir'))
  await symlink(join(dir, '下载', '笔记.md'), join(dir, 'linked.md'))
  const outcome = await collectOutcome({
    server,
    roots: { workspace: dir, downloads: join(dir, 'missing') },
    finalText: '完成',
    metrics: { steps: 3 },
  })
  assert.equal(outcome.files.length, 4)
  assert.equal(outcome.files.find(f => f.path === '下载/笔记.md').text, '正文')
  assert.equal(outcome.files.find(f => f.path === 'large.txt').text, null)
  assert.equal(outcome.files.find(f => f.path === 'exact.txt').text.length, 512 * 1024)
  assert.equal(outcome.files.find(f => f.path === 'image.png').text, null)
  assert.equal(outcome.finalText, '完成')
  assert.deepEqual(outcome.metrics, { interventions: 0, steps: 3, tokens: null, durationMs: null })
})
