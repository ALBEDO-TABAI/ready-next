// Reading a page (plan 2026-11-18, D1–D5): the rendered content as Markdown with its links, read in
// windows that say what is left, and never what was typed into a password field.
import type { CaseGroup, ToolCallResult } from '../harness'
import { fail, pass, summarize } from './helpers'

const content = (result: ToolCallResult) => typeof result.data.content === 'string' ? result.data.content : ''

export const readGroup: CaseGroup = {
  site: 'read',
  title: '读网页',
  async run(ctx) {
    const paging = await ctx.run('read-links')
    await paging.open(ctx.url('/paging/?page=1'))
    await ctx.check(
      'links-carry-addresses',
      '整页读取是带链接地址的 Markdown，拿到的地址可以直接导航',
      ['browser_read', 'browser_navigate'],
      async () => {
        const read = await paging.call('browser_read', {})
        const text = content(read)
        const next = /\[下一页\]\((https?:\/\/[^)\s]+)\)/.exec(text)?.[1]
        if (read.data.ok !== true || read.data.format !== 'markdown') return fail(`不是 Markdown 结果：${summarize(read)}`)
        if (!next || !next.includes('/paging/?page=2')) return fail(`“下一页”没有带绝对地址：${text.slice(0, 400)}`)
        if (read.data.totalChars !== text.length || read.data.truncated !== false) return fail(`长度信息不对：${summarize(read)}`)
        await paging.call('browser_navigate', { url: next })
        const second = await paging.call('browser_read', {})
        return content(second).includes('P-011') && content(second).includes('P-020')
          ? pass(`读到的链接 ${new URL(next).pathname}${new URL(next).search} 可直接导航，第 2 页可读`)
          : fail(summarize(second))
      })
    await ctx.check(
      'continues-from-offset',
      '内容超过一次的上限时说明被截断，按 nextOffset 续读，各段拼起来等于完整内容',
      ['browser_read'],
      async () => {
        const whole = await paging.call('browser_read', { max_chars: 200_000 })
        const full = content(whole)
        if (full.length < 200) return fail(`页面太短，无法检验分段：${full.length}`)
        const size = Math.max(40, Math.floor(full.length / 4))
        let joined = ''
        let offset = 0
        for (let round = 0; round < 12; round += 1) {
          const part = await paging.call('browser_read', { max_chars: size, offset })
          joined += content(part)
          if (part.data.totalChars !== full.length || part.data.returnedChars !== content(part).length) {
            return fail(`分段的长度信息不对：${summarize(part)}`)
          }
          if (part.data.truncated !== true) break
          if (part.data.nextOffset !== offset + content(part).length) return fail(`nextOffset 不对：${summarize(part)}`)
          offset = Number(part.data.nextOffset)
        }
        return joined === full
          ? pass(`${full.length} 字，按 ${size} 字一段读完，拼接后与整页一致`)
          : fail(`拼接后与整页不一致：${joined.length} / ${full.length}`)
      })

    const table = await ctx.run('read-table')
    await table.open(ctx.url('/sites/fx/table.html', 'third'))
    await ctx.check('table-keeps-its-grid', '表格读成带表头的网格', ['browser_read'], async () => {
      const read = await table.call('browser_read', {})
      const text = content(read)
      const expected = '| 币种 | 汇率 |\n| --- | --- |\n| 美元 → 人民币 | 7.1234 |\n| 欧元 → 人民币 | 7.8123 |\n| 日元 → 人民币 | 0.0476 |'
      return text.includes('# 汇率表') && text.includes(expected)
        ? pass('标题与表格结构都在')
        : fail(`表格结构丢失：${text.slice(0, 500)}`)
    })

    const login = await ctx.run('read-password')
    await login.open(ctx.url('/login/'))
    await ctx.check(
      'password-stays-on-the-page',
      '密码框里的内容不会被读出来（整页读取和按选择器读取都不带）',
      ['browser_read'],
      async () => {
        // The user typed these; the assistant only reads.
        await login.pageEval("document.querySelector('#username').value = 'bai'; document.querySelector('#password').value = 'hunter2-secret'; return true")
        const page = await login.call('browser_read', {})
        const field = await login.call('browser_read', { selector: '#password' })
        const user = await login.call('browser_read', { selector: '#username' })
        if (JSON.stringify(page).includes('hunter2') || JSON.stringify(field).includes('hunter2')) {
          return fail(`密码被读出：${summarize(field)}`)
        }
        if (!content(user).includes('bai')) return fail(`普通输入框的内容应当可读：${summarize(user)}`)
        return page.data.ok === true && content(page).includes('登录后台')
          ? pass('整页与选择器读取都不含密码；普通输入框内容可读')
          : fail(summarize(page))
      })
  },
}
