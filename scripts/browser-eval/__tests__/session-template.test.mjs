import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { startEvalSites } from '../server.mjs'
import { template } from '../server/html.mjs'
import { TASKS, validateTasks } from '../tasks/index.mjs'
import { task } from '../tasks/oracle-helpers.mjs'
import { createOracleHttp } from '../tasks/oracle-http.mjs'

async function setup(t) {
  const server = await startEvalSites({ quiet: true })
  t.after(() => server.close())
  return { server, http: createOracleHttp() }
}

function status(url, cookie) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Cookie: `${cookie.name}=${cookie.value}` } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

test('login 返回可用 cookie；reset 后旧会话不会被新登录重新激活', async t => {
  const { server, http } = await setup(t)
  const first = server.login()
  assert.deepEqual(first, {
    name: 'eval_session',
    value: first.value,
    url: server.origins.main,
    path: '/',
    httpOnly: true,
  })
  assert.equal(typeof first.value, 'string')
  assert.ok(first.value.length > 0)
  assert.notEqual(server.login().value, first.value)
  assert.deepEqual(server.records(), [])
  assert.equal(await status(server.url('/admin/'), first), 200)
  assert.equal(await status(server.url('/admin/', 'alt'), first), 404)
  http.setCookie(first)
  assert.match((await http.get(server.url('/admin/settings/'))).text, /id="display-name"/)
  server.reset()
  assert.equal(await status(server.url('/admin/'), first), 302)
  const second = server.login()
  assert.notEqual(second.value, first.value)
  await http.postForm(server.url('/login/submit'), server.fixtures.credentials)
  assert.equal(await status(server.url('/admin/'), first), 302)
  assert.equal(await status(server.url('/admin/'), second), 200)
  http.setCookie(second)
  await http.get(server.url('/logout'))
  assert.equal(await status(server.url('/admin/'), second), 302)
})

test('任务明确区分八个预登录任务与其余未登录任务，并校验 session', () => {
  const ids = ['B2', 'B3', 'B4', 'B5', 'B6', 'C4', 'D1', 'D3']
  assert.deepEqual(
    TASKS.filter(t => t.session === 'logged_in').map(t => t.id),
    ids,
  )
  assert.equal(task({ id: 'A1', start: { path: '/' } }).session, 'logged_out')
  for (const definition of TASKS) {
    assert.equal(definition.session, ids.includes(definition.id) ? 'logged_in' : 'logged_out')
    if (definition.session === 'logged_in')
      assert.doesNotMatch(definition.prompt, /eval-user|ready-eval-2026|登录这个后台/)
  }
  assert.match(
    TASKS.find(t => t.id === 'B1').prompt,
    /登录这个后台（用户名 eval-user，密码 ready-eval-2026）/,
  )
  for (const session of [undefined, null, '', 'authenticated']) {
    const invalid = TASKS.map((t, i) => (i === 0 ? { ...t, session } : t))
    assert.ok(validateTasks(invalid).some(error => error.includes('session')))
  }
  assert.deepEqual(validateTasks(), [])
})

test('预登录 oracle 直接改后台，B1 oracle 仍产生真实登录记录', async t => {
  const { server, http } = await setup(t)
  const ctx = { server, http, url: server.url }
  await TASKS.find(t => t.id === 'B2').oracle(ctx)
  assert.deepEqual(
    server.records().map(r => r.kind),
    ['admin.settings.update'],
  )
  assert.equal(server.records()[0].data.displayName, '白')
  server.reset()
  await TASKS.find(t => t.id === 'B1').oracle({ ...ctx, http: createOracleHttp() })
  assert.deepEqual(
    server.records().map(r => r.kind),
    ['login.success', 'admin.post.create'],
  )
})

test('模板保留控件、转义服务端值，并在最终响应中替换来源占位符', async t => {
  const { server, http } = await setup(t)
  const query = '"<& {{literal}}'
  const response = await http.get(server.url(`/search/?q=${encodeURIComponent(query)}`))
  assert.equal(response.status, 200)
  assert.ok(response.text.startsWith('<!doctype html>'))
  assert.ok(response.text.includes('value="&quot;&lt;&amp; {{literal}}"'))
  assert.ok(response.text.includes('<label for="search-q">搜索</label>'))
  assert.ok(response.text.includes('<button>搜索</button>'))
  assert.ok(response.text.includes('没有找到结果'))
  const results = await http.get(server.url('/search/?q=S2'))
  assert.ok(results.text.includes(server.url('/sites/shop/s2.html', 'alt')))
  assert.ok(results.text.includes(server.url('/sites/forum/s2.html', 'third')))
  assert.doesNotMatch(results.text, /\{\{ORIGIN_/)
  assert.ok(template('frames/middle.html').includes('{{ORIGIN_ALT}}'))
  assert.equal(
    template('login/error.html', { error: '{{unexpanded}}' }).trim(),
    '<p role="alert">{{unexpanded}}</p>',
  )
  assert.throws(() => template('login/error.html'), /缺少 error/)
})
