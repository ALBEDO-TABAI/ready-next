import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPORT_ROWS } from '../fixtures.mjs'
import { task, download, writeDocument } from './oracle-helpers.mjs'
import {
  check,
  result,
  documentJudge,
  recordsOf,
  matches,
  hasUrl,
  number,
  normalizeText,
  source,
  parseCsv,
  sameRows,
} from './judge-helpers.mjs'

const downloaded = (o, name) =>
  o.files.some(
    f =>
      f.root === 'workspace' &&
      f.path.startsWith('下载/') &&
      f.sha256 === o.fixtures.files[name].sha256,
  )
export const C_TASKS = [
  task({
    id: 'C1',
    title: '下载进资料库',
    start: { path: '/downloads/' },
    session: 'logged_out',
    prompt: '把这个页面上的 2026 年第三季度报表（CSV）下载' +
      '下来，存到资料库的‘下载’文件夹里。',
    attachments: [],
    limits: { maxSteps: 60, maxMinutes: 12 },
    tags: [],
    oracle: async ctx => {
      await download(ctx, 'report-2026-q3.csv')
    },
    judge: o => result([check('downloaded-q3', downloaded(o, 'report-2026-q3.csv'))]),
  }),
  task({
    id: 'C2',
    title: '算合计',
    start: { path: '/downloads/' },
    session: 'logged_out',
    prompt:
      '下载这个页面上的 2026 年第三季度报表，' +
      '算出‘华东’地区三个月销售额合计，' +
      '写成文档《Q3 华东合计》，' +
      '写明合计数字和报表的下载网址。',
    attachments: [],
    limits: { maxSteps: 60, maxMinutes: 12 },
    tags: [],
    oracle: async ctx => {
      const response = await download(ctx, 'report-2026-q3.csv')
      const total = parseCsv(response.text)
        .slice(1)
        .filter(row => row[0] === '华东')
        .reduce((sum, row) => sum + Number(row[2]), 0)
      await writeDocument(
        ctx,
        'Q3 华东合计',
        `华东三个月销售额合计：${total} 元。\n${ctx.url('/downloads/files/report-2026-q3.csv')}`,
      )
    },
    judge: o =>
      documentJudge(o, text => [
        check('total', number(text, 1286450)),
        check('source', hasUrl(text, source(o, '/downloads/files/report-2026-q3.csv'))),
      ]),
  }),
  task({
    id: 'C3',
    title: '上传附件',
    start: { path: '/upload/' },
    session: 'logged_out',
    prompt: '把我附上的 eval-receipt.pdf 上传到这个报销表单，' +
      '描述填‘十一月差旅’，然后提交。',
    attachments: ['eval-receipt.pdf'],
    limits: { maxSteps: 60, maxMinutes: 12 },
    tags: [],
    oracle: async ctx => {
      await ctx.http.postMultipart(ctx.url('/upload/submit'), { description: '十一月差旅' }, [
        { ...ctx.attachments[0], field: 'file' },
      ])
    },
    judge: o =>
      result([
        check(
          'receipt-upload',
          recordsOf(o, 'upload').some(r =>
            matches(r, {
              field: 'file',
              sha256: o.fixtures.files['eval-receipt.pdf'].sha256,
              description: '十一月差旅',
            }),
          ),
        ),
      ]),
  }),
  task({
    id: 'C4',
    title: '登录后下载并统计',
    start: { path: '/admin/' },
    session: 'logged_in',
    prompt:
      '在这个后台里下载‘会员名单’（JSON），' +
      '数一下一共几位会员、其中几位是‘年费’会员' +
      '，写成文档《会员统计》，附上下载网址。',
    attachments: [],
    limits: { maxSteps: 60, maxMinutes: 12 },
    tags: [],
    oracle: async ctx => {
      ctx.http.setCookie(ctx.server.login())
      const response = await download(ctx, 'members.json', '/admin/export/members.json')
      const members = JSON.parse(response.text)
      await writeDocument(
        ctx,
        '会员统计',
        '总计 ' +
          `${members.length}` +
          ' 位会员，其中年费会员 ' +
          `${members.filter(m => m.plan === '年费').length}` +
          ' 位。\n' +
          `${ctx.url('/admin/export/members.json')}`,
      )
    },
    judge: o =>
      documentJudge(
        o,
        text => {
          const value = normalizeText(text)
          return [
            check(
              'members',
              /(?<!\d)23\s*[位名人]|(?:共|总计|总数).{0,12}(?<!\d)23(?![\d.])/.test(value),
            ),
            check('annual', /(?<!\d)9\s*[位名人]|年费.{0,12}(?<!\d)9(?![\d.])/.test(value)),
            check('source', hasUrl(text, source(o, '/admin/export/members.json'))),
          ]
        },
        [
          check(
            'authed-download',
            recordsOf(o, 'download').some(r => r.file === 'members.json' && r.authed === true),
          ),
        ],
      ),
  }),
  task({
    id: 'C5',
    title: 'PDF 型号',
    start: { path: '/downloads/' },
    session: 'logged_out',
    prompt:
      '下载这个页面上的 S2 说明书（PDF），' +
      '存进资料库‘下载’文件夹，' +
      '再在资料库新建文档《S2 型号》，' +
      '写上说明书里的完整型号。',
    attachments: [],
    limits: { maxSteps: 60, maxMinutes: 12 },
    tags: [],
    oracle: async ctx => {
      await download(ctx, 'manual-s2.pdf')
      await writeDocument(ctx, 'S2 型号', '说明书里的完整型号：S2-PRO-2026。')
    },
    judge: o =>
      documentJudge(
        o,
        text => [check('model', /(?<![\w-])S2-PRO-2026(?![\w-])/.test(normalizeText(text)))],
        [check('manual', downloaded(o, 'manual-s2.pdf'))],
      ),
  }),
  task({
    id: 'C6',
    title: '合并报表',
    start: { path: '/downloads/' },
    session: 'logged_out',
    prompt:
      '把这个页面上 2026 年前三个季度的报表都下载下' +
      '来，合并成一个 CSV（保留一行表头），' +
      '存到资料库‘下载/2026前三季度.csv’。',
    attachments: [],
    limits: { maxSteps: 60, maxMinutes: 12 },
    tags: [],
    oracle: async ctx => {
      const rows = []
      for (const q of [1, 2, 3])
        rows.push(...parseCsv((await download(ctx, `report-2026-q${q}.csv`)).text).slice(1))
      await mkdir(join(ctx.workspaceDir, '下载'), { recursive: true })
      await writeFile(
        join(ctx.workspaceDir, '下载/2026前三季度.csv'),
        `地区,月份,销售额\n${rows.map(row => row.join(',')).join('\n')}\n`,
      )
    },
    judge: o => {
      const file = o.files.find(f => f.root === 'workspace' && f.path === '下载/2026前三季度.csv')
      const rows = parseCsv(file?.text)
      return result([
        check('merged-file', Boolean(file)),
        check('header', rows?.[0]?.join(',') === '地区,月份,销售额'),
        check(
          'rows',
          rows &&
            sameRows(
              rows.slice(1),
              Object.values(REPORT_ROWS)
                .flat()
                .map(row => row.map(String)),
            ),
        ),
      ])
    },
  }),
]
