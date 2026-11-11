import { task, credentials, login, tokenFrom } from './oracle-helpers.mjs'
import { check, result, recordsOf, matches, includes, normalizeText } from './judge-helpers.mjs'

export const B_TASKS = [
  task({
    id: 'B1',
    title: '发帖',
    start: { path: '/admin/' },
    session: 'logged_out',
    prompt:
      credentials +
      '发一篇新帖子：标题‘十一月例会改期’，' +
      '正文‘例会改到 11 月 20 日下午三点，地点不变。' +
      '’，分类选‘公告’，并直接发布。',
    attachments: [],
    limits: { maxSteps: 40, maxMinutes: 10 },
    tags: [],
    oracle: async ctx => {
      await login(ctx)
      await ctx.http.postForm(ctx.url('/admin/posts/new'), {
        title: '十一月例会改期',
        body: '例会改到 11 月 20 日下午三点，地点不变。',
        category: '公告',
        publish: 'yes',
      })
    },
    judge: o => {
      const rows = recordsOf(o, 'admin.post.create')
      return result([
        check('one-post', rows.length === 1),
        check(
          'post-content',
          matches(rows[0], {
            title: '十一月例会改期',
            body: '例会改到 11 月 20 日下午三点，地点不变。',
            category: '公告',
            publish: true,
          }),
        ),
      ])
    },
  }),
  task({
    id: 'B2',
    title: '改设置',
    start: { path: '/admin/' },
    session: 'logged_in',
    prompt: `在这个后台里把显示名称改成‘白’，关掉邮件通知，其他设置保持不变。`,
    attachments: [],
    limits: { maxSteps: 40, maxMinutes: 10 },
    tags: [],
    oracle: async ctx => {
      ctx.http.setCookie(ctx.server.login())
      await ctx.http.postForm(ctx.url('/admin/settings/'), { displayName: '白', language: 'zh-CN' })
    },
    judge: o =>
      result([
        check(
          'settings',
          matches(recordsOf(o, 'admin.settings.update').at(-1), {
            displayName: '白',
            emailNotify: false,
            language: 'zh-CN',
          }),
        ),
      ]),
  }),
  task({
    id: 'B3',
    title: '回复工单',
    start: { path: '/admin/' },
    session: 'logged_in',
    prompt:
      '在这个后台里找到编号 T-1042 的工单，' +
      '回复‘已为您补发，预计两天内送达。’，' +
      '并把状态改成‘已解决’。',
    attachments: [],
    limits: { maxSteps: 40, maxMinutes: 10 },
    tags: [],
    oracle: async ctx => {
      ctx.http.setCookie(ctx.server.login())
      await ctx.http.postForm(ctx.url('/admin/tickets/T-1042'), {
        reply: '已为您补发，预计两天内送达。',
        status: '已解决',
        assignee: '',
      })
    },
    judge: o => {
      const rows = recordsOf(o, 'admin.ticket.update')
      return result([
        check(
          'reply',
          matches(rows.filter(r => r.id === 'T-1042').at(-1), {
            reply: '已为您补发，预计两天内送达。',
            status: '已解决',
          }),
        ),
        check(
          'no-other-tickets',
          rows.every(r => r.id === 'T-1042'),
        ),
      ])
    },
  }),
  task({
    id: 'B4',
    title: '建活动',
    start: { path: '/admin/events/new' },
    session: 'logged_in',
    prompt:
      '在这个后台里用‘活动向导’新建活动：' +
      '名称‘读书会·十二月’，日期选 2026-12-06，' +
      '地点填‘二楼阅览室’，打开‘需要报名’，' +
      '最后创建。',
    attachments: [],
    limits: { maxSteps: 40, maxMinutes: 10 },
    tags: ['wizard', 'shadow'],
    oracle: async ctx => {
      ctx.http.setCookie(ctx.server.login())
      const token = tokenFrom(await ctx.http.get(ctx.url('/admin/events/new')))
      await ctx.http.postForm(ctx.url('/admin/events/step2'), {
        token,
        name: '读书会·十二月',
        date: '2026-12-06',
      })
      await ctx.http.postForm(ctx.url('/admin/events/step3'), {
        token,
        place: '二楼阅览室',
        signup: 'yes',
      })
      await ctx.http.postForm(ctx.url('/admin/events/create'), { token })
    },
    judge: o =>
      result([
        check(
          'event',
          recordsOf(o, 'admin.event.create').some(r =>
            matches(r, {
              name: '读书会·十二月',
              date: '2026-12-06',
              place: '二楼阅览室',
              signup: true,
            }),
          ),
        ),
      ]),
  }),
  task({
    id: 'B5',
    title: '富文本公告',
    start: { path: '/admin/notice/' },
    session: 'logged_in',
    prompt:
      '在这个后台的公告编辑器里写一条公告：' +
      '第一行是加粗的‘停机维护通知’，' +
      '第二行写‘12 月 1 日 0 点到 2 点系统维护。’，' +
      '然后保存。',
    attachments: [],
    limits: { maxSteps: 40, maxMinutes: 10 },
    tags: ['rich-text'],
    oracle: async ctx => {
      ctx.http.setCookie(ctx.server.login())
      await ctx.http.postJson(ctx.url('/admin/notice/'), {
        html: '<div><strong>停机维护通知</strong></div><div>12 月 1 日 0 点到 2 点系统维护。</div>',
        text: '停机维护通知\n12 月 1 日 0 点到 2 点系统维护。',
      })
    },
    judge: o => {
      const saved = recordsOf(o, 'admin.notice.save').at(-1)
      const bold = [
        ...(saved?.html || '').matchAll(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi),
      ].some(m => normalizeText(m[2]).replace(/\s/g, '').includes('停机维护通知'))
      return result([
        check('bold-title', bold),
        check('maintenance-text', includes(saved?.text || '', '12 月 1 日 0 点到 2 点系统维护。')),
      ])
    },
  }),
  task({
    id: 'B6',
    title: '删除草稿',
    start: { path: '/admin/posts/' },
    session: 'logged_in',
    prompt: `在这个后台里把标题为‘测试草稿’的那篇帖子删掉，别的帖子不要动。`,
    attachments: [],
    limits: { maxSteps: 40, maxMinutes: 10 },
    tags: ['dialog'],
    oracle: async ctx => {
      ctx.http.setCookie(ctx.server.login())
      await ctx.http.postForm(ctx.url('/admin/posts/2/delete'), {})
    },
    judge: o => {
      const rows = recordsOf(o, 'admin.post.delete')
      return result([check('only-draft', rows.length === 1 && rows[0].id === 2)])
    },
  }),
]
