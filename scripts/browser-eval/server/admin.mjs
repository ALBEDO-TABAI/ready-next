import { template, escapeHtml } from './html.mjs'
import { FIXTURE_FILES, sha256 } from '../fixtures.mjs'

const loginPage = (next, error = '') =>
  template('login/index.html', {
    next: escapeHtml(next),
    error: error ? template('login/error.html', { error: escapeHtml(error) }) : '',
  })
function eventPage(step, token, data) {
  return template(`admin/events/step${step}.html`, {
    token: escapeHtml(token),
    name: escapeHtml(data.name),
    date: escapeHtml(data.date),
    place: escapeHtml(data.place),
    signup: data.signup ? '是' : '否',
  })
}
export function routeAdmin(c) {
  const { path, req, fields, files, state, html, redirect, record, url, origin } = c
  if (!path.startsWith('/admin/') && !path.startsWith('/login/') && path !== '/logout') return false
  if (origin !== 'main') return c.send(404, '后台仅在主站开放')
  const session = /(?:^|;\s*)eval_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]
  if (path === '/login/') return html(loginPage(url.searchParams.get('next') || '/admin/'))
  if (path === '/login/submit' && req.method === 'POST') {
    const next =
      fields.next?.startsWith('/admin/') && !fields.next.includes('\\') ? fields.next : '/admin/'
    if (fields.username !== 'eval-user' || fields.password !== 'ready-eval-2026') {
      record('login.failure', { username: fields.username || '' })
      return html(loginPage(next, '用户名或密码错误'))
    }
    const { value: token } = c.login()
    record('login.success', { username: fields.username })
    return redirect(next, 303, {
      'Set-Cookie': `eval_session=${token}; HttpOnly; Path=/; SameSite=Lax`,
    })
  }
  if (path === '/logout') {
    state.sessions.delete(session)
    return redirect('/login/', 303, {
      'Set-Cookie': 'eval_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax',
    })
  }
  if (!state.sessions.has(session))
    return redirect(`/login/?next=${encodeURIComponent(url.pathname + url.search)}`, 302)
  if (path === '/admin/')
    return html(
      template('admin/index.html', {
        displayName: escapeHtml(state.settings.displayName),
      }),
    )
  if (path === '/admin/posts/')
    return html(
      template('admin/posts/index.html', {
        rows: state.posts
          .map(post =>
            template('admin/posts/row.html', {
              title: escapeHtml(post.title),
              category: post.category,
              id: post.id,
              confirmation: escapeHtml(JSON.stringify(`确定删除「${post.title}」吗？`)),
            }),
          )
          .join(''),
      }),
    )
  if (path === '/admin/posts/new') {
    if (req.method === 'POST') {
      const post = {
        id: ++state.postSeq,
        title: fields.title,
        body: fields.body,
        category: fields.category,
        publish: fields.publish === 'yes',
      }
      state.posts.push(post)
      record('admin.post.create', post)
      return redirect('/admin/posts/')
    }
    return html(template('admin/posts/new.html'))
  }
  const deletion = /^\/admin\/posts\/(\d+)\/delete$/.exec(path)
  if (deletion && req.method === 'POST') {
    const post = state.posts.find(post => post.id === Number(deletion[1]))
    if (!post) return c.send(404, '帖子不存在')
    state.posts = state.posts.filter(p => p !== post)
    record('admin.post.delete', { id: post.id, title: post.title })
    return redirect('/admin/posts/')
  }
  if (path === '/admin/tickets/')
    return html(
      template('admin/tickets/index.html', {
        rows: state.tickets
          .map(
            t =>
              `<tr><td><a href="/admin/tickets/${t.id}">${t.id}</a></td>` +
              `<td>${t.subject}</td><td>${t.status}</td><td>${t.assignee}</td></tr>`,
          )
          .join(''),
      }),
    )
  if (path.startsWith('/admin/tickets/')) {
    const ticket = state.tickets.find(t => t.id === path.split('/').at(-1))
    if (!ticket) return c.send(404, '工单不存在')
    if (req.method === 'POST') {
      if (
        !['待处理', '处理中', '已解决'].includes(fields.status) ||
        !['', '客服', '财务', '技术'].includes(fields.assignee)
      )
        return c.send(400, '工单选项不正确')
      Object.assign(ticket, {
        reply: fields.reply || '',
        status: fields.status,
        assignee: fields.assignee,
      })
      record('admin.ticket.update', {
        id: ticket.id,
        reply: ticket.reply,
        status: ticket.status,
        assignee: ticket.assignee,
      })
    }
    return html(
      template('admin/tickets/detail.html', {
        id: ticket.id,
        subject: ticket.subject,
        content: escapeHtml(ticket.content),
        path: path,
        reply: escapeHtml(ticket.reply),
        pending: '待处理' === ticket.status ? 'selected' : '',
        processing: '处理中' === ticket.status ? 'selected' : '',
        resolved: '已解决' === ticket.status ? 'selected' : '',
        unassigned: '' === ticket.assignee ? 'selected' : '',
        support: '客服' === ticket.assignee ? 'selected' : '',
        finance: '财务' === ticket.assignee ? 'selected' : '',
        technical: '技术' === ticket.assignee ? 'selected' : '',
      }),
    )
  }
  if (path === '/admin/contacts/new') {
    if (req.method === 'POST') {
      const contact = Object.fromEntries(
        ['name', 'email', 'company', 'phone'].map(key => [key, fields[key] || '']),
      )
      state.contacts.push(contact)
      record('admin.contact.create', contact)
      return redirect('/admin/contacts/')
    }
    return html(template('admin/contacts/new.html'))
  }
  if (path === '/admin/contacts/')
    return html(
      template('admin/contacts/index.html', {
        rows: state.contacts
          .map(
            c =>
              `<tr>${Object.values(c)
                .map(v => `<td>${escapeHtml(v)}</td>`)
                .join('')}</tr>`,
          )
          .join(''),
      }),
    )
  if (path === '/admin/settings/') {
    if (req.method === 'POST') {
      if (!['zh-CN', 'en'].includes(fields.language)) return c.send(400, '语言不正确')
      state.settings = {
        displayName: fields.displayName,
        emailNotify: fields.emailNotify === 'yes',
        language: fields.language,
      }
      record('admin.settings.update', state.settings)
    }
    return html(
      template('admin/settings/index.html', {
        path: path,
        displayName: escapeHtml(state.settings.displayName),
        emailNotifyChecked: state.settings.emailNotify ? 'checked' : '',
        chinese: 'zh-CN' === state.settings.language ? 'selected' : '',
        english: 'en' === state.settings.language ? 'selected' : '',
      }),
    )
  }
  if (path === '/admin/events/new') {
    const token = `event-${++state.eventSeq}`
    state.events.set(token, { step: 1, data: {} })
    return html(eventPage(1, token, {}))
  }
  if (path.startsWith('/admin/events/') && req.method === 'POST') {
    const entry = state.events.get(fields.token)
    if (!entry) return c.send(400, '无效活动会话')
    if (path.endsWith('/step2') && entry.step === 1) {
      if (!fields.name || !['2026-12-06', '2026-12-13', '2026-12-20'].includes(fields.date))
        return c.send(400, '请填写活动信息')
      entry.data = { name: fields.name, date: fields.date }
      entry.step = 2
      return html(eventPage(2, fields.token, entry.data))
    }
    if (path.endsWith('/step3') && entry.step === 2) {
      if (!fields.place) return c.send(400, '请填写地点')
      Object.assign(entry.data, { place: fields.place, signup: fields.signup === 'yes' })
      entry.step = 3
      return html(eventPage(3, fields.token, entry.data))
    }
    if (path.endsWith('/create') && entry.step === 3) {
      record('admin.event.create', entry.data)
      entry.step = 4
      return html(template('admin/events/done.html'))
    }
    return c.send(409, '活动步骤不正确')
  }
  if (path === '/admin/notice/') {
    if (req.method === 'POST') {
      state.notice = { html: fields.html, text: fields.text }
      record('admin.notice.save', state.notice)
      return c.json({ ok: true })
    }
    return html(template('admin/notice/index.html'))
  }
  if (path === '/admin/export/members.json') {
    record('download', { file: 'members.json', authed: true })
    return c.download('members.json', FIXTURE_FILES['members.json'])
  }
  if (path === '/admin/avatar/') {
    if (req.method === 'POST') {
      const file = files.find(f => f.field === 'avatar')
      if (!file) return c.send(400, '请选择头像文件')
      state.avatar = {
        field: 'avatar',
        filename: file.filename,
        size: file.bytes.length,
        sha256: sha256(file.bytes),
        authed: true,
      }
      record('upload', state.avatar)
      return html(template('admin/avatar/done.html'))
    }
    return html(template('admin/avatar/index.html'))
  }
  return c.send(404, '后台页面不存在')
}
