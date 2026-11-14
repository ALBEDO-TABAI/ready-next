// Page-structure sites: SPA routes with late rendering, nested cross-origin frames,
// shadow DOM controls, pagination / infinite scroll, and the wait page.
import type { CaseGroup } from '../harness'
import {
  allTargets,
  delivered,
  errorKind,
  fail,
  gap,
  journalAgrees,
  missingTargets,
  pass,
  pointerRefused,
  submitFailure,
  summarize,
  target,
  targetSummary,
  textOf,
  unavailable,
  waitForRecord,
} from './helpers'

export const spaGroup: CaseGroup = {
  site: 'spa',
  title: '单页应用的路由与延迟渲染',
  async run(ctx) {
    const run = await ctx.run('spa')
    await run.open(ctx.url('/spa/'))
    await ctx.check(
      'wait-late-render',
      '等待延迟渲染的列表：该结束时结束',
      ['browser_wait'],
      async () => {
        const waited = await run.call('browser_wait', { condition: 'text', text: '订单列表', timeout_ms: 6_000 })
        const elapsed = Number(waited.data.elapsedMs ?? -1)
        return waited.data.matched === true && elapsed < 4_000
          ? pass(`matched，${elapsed}ms`)
          : fail(summarize(waited))
      })
    await ctx.check(
      'hash-route-detail',
      '哈希路由到详情，等待 1.2 秒后的内容',
      ['browser_navigate', 'browser_wait', 'browser_read'],
      async () => {
        await run.call('browser_navigate', { url: ctx.url('/spa/#/orders/SPA-1007') })
        const waited = await run.call('browser_wait', { condition: 'text', text: 'SF-77120', timeout_ms: 6_000 })
        const read = await run.call('browser_read', {})
        return waited.data.matched === true && textOf(read).includes('368.00')
          ? pass(`matched，${String(waited.data.elapsedMs)}ms`)
          : fail(`${summarize(waited)} | ${summarize(read)}`)
      })
    let staleNote = ''
    await ctx.check(
      'note-submit',
      '详情页备注：填写并提交（JS 拦截提交）',
      ['browser_fill_form', 'browser_wait'],
      async () => {
        const note = await target(run, '添加备注', { purpose: 'input' })
        staleNote = note.targetId
        const filled = await run.call(
          'browser_fill_form',
          { fields: [{ target_id: note.targetId, value: '已核对' }], submit: true }
        )
        const rows = await waitForRecord(run, 'spa.note', 1, 3_000)
        const row = rows[0]?.data
        if (row && row.orderId === 'SPA-1007' && row.note === '已核对') return pass('spa.note 已记录', row)
        const reason = submitFailure(filled)
        if (reason) return fail(reason)
        if (filled.data.submitted === true)
          return fail(
            '缺陷：fill_form 用回车提交；'
              + '最后一个字段是多行文本框时回车只换行，表单没有提交'
          )
        return fail(`record=${JSON.stringify(row ?? null)} ${summarize(filled, 400)}`)
      })
    await ctx.check(
      'hash-route-repeat',
      '45 秒内导航回同一页面的另一个 hash 路由',
      ['browser_navigate'],
      async () => {
        await run.call('browser_snapshot', {})
        const navigated = await run.call('browser_navigate', { url: ctx.url('/spa/#/') })
        await new Promise((resolve) => setTimeout(resolve, 300))
        const url = await run.currentUrl()
        if (new URL(url).hash === '#/' && navigated.data.ok !== false) return pass('已导航到列表路由')
        if (errorKind(navigated) === 'browser_mutation_transport_not_invoked') {
          return fail(
            '缺陷：只差 hash 的 SPA 路由在 45 '
              + '秒内被当成“重复导航”跳过；跳过说明被改写成 '
              + 'browser_mutation_transport_not_invoked，模型看不到原因（要加 '
              + 'allow_repeat）'
          )
        }
        return fail(`url=${url} ${summarize(navigated, 300)}`)
      })
    await ctx.check(
      'stale-ref-after-route',
      '路由换页后旧引用不能继续写',
      ['browser_navigate', 'browser_type'],
      async () => {
        if (!staleNote) return fail('前置用例没有拿到备注框引用')
        if ((await run.currentUrl()).includes('/orders/')) {
          await run.call('browser_snapshot', {})
          await run.call('browser_navigate', { url: ctx.url('/spa/#/'), allow_repeat: true })
        }
        await run.call('browser_wait', { condition: 'text', text: '订单列表', timeout_ms: 6_000 })
        if ((await run.currentUrl()).includes('/orders/'))
          return fail('没能回到列表，旧引用测试无从谈起')
        const before = await run.probe()
        const typed = await run.call('browser_type', { target_id: staleNote, text: '旧引用' })
        const after = await run.probe()
        const inputs = (after?.counts.input ?? 0) - (before?.counts.input ?? 0)
        if (typed.data.ok === false && inputs === 0)
          return pass(`拒绝：${String(errorKind(typed) || typed.data.reason || 'stale')}，页面零输入`)
        return fail(`旧引用仍被接受：ok=${String(typed.data.ok)} pageInputs=${inputs} ${summarize(typed)}`)
      })
    await ctx.check(
      'history-route',
      'History 路由版：直接导航到深链并等待渲染',
      ['browser_navigate', 'browser_wait'],
      async () => {
        await run.call('browser_snapshot', {})
        await run.call('browser_navigate', { url: ctx.url('/spa/history/orders/SPA-1003') })
        const waited = await run.call('browser_wait', { condition: 'text', text: '订单 SPA-1003', timeout_ms: 6_000 })
        return waited.data.matched === true
          ? pass(`matched，${String(waited.data.elapsedMs)}ms`)
          : fail(summarize(waited))
      })
  },
}

export const framesGroup: CaseGroup = {
  site: 'frames',
  title: '嵌套 iframe（含跨 origin）',
  async run(ctx) {
    const run = await ctx.run('frames')
    await run.open(ctx.url('/frames/'))
    // These cases test typing into a cross-origin frame; the turn involves that origin (BA7's ask-first rule for
    // origins outside the turn is covered by the w7 group).
    run.involveOrigins([new URL(ctx.url('/', 'alt')).origin])
    await run.call('browser_wait', { condition: 'text', text: '嵌套框架', timeout_ms: 6_000 })
    await new Promise((resolve) => setTimeout(resolve, 800))
    await ctx.check(
      'snapshot-nested-frames',
      '快照穿透同源与跨 origin 两层 iframe',
      ['browser_snapshot'],
      async () => {
        const { targets } = await allTargets(run)
        const missing = missingTargets(
          targets,
          [['combobox', '中层选项'], ['textbox', '深层输入'], ['button', '深层提交']]
        )
        return missing.length === 0
          ? pass(`${targets.length} 个目标`)
          : fail(`快照缺少 ${missing.join('、')}；看到：${targetSummary(targets)}`)
      })
    await ctx.check('read-deep-text', '读取深层 iframe 里的文字', ['browser_read'], async () => {
      const read = await run.call('browser_read', {})
      const text = textOf(read)
      if (text.includes('DEEP-42') && text.includes('MID-7')) return pass('两层文字都读到')
      return fail(
        `browser_read 只读到主文档，iframe 文字缺失（MID-7=${text.includes('MID-7')
        } DEEP-42=${text.includes('DEEP-42')
        }）（§4.6 覆盖）`
      )
    })
    await ctx.check(
      'type-deep-frame',
      '向跨 origin 深层输入框输入并回读',
      ['browser_find', 'browser_type'],
      async () => {
        const input = await target(run, '深层输入', { purpose: 'input' })
        const typed = await run.call('browser_type', { target_id: input.targetId, text: 'DEEP-OK' })
        const journal = journalAgrees(run, typed)
        return delivered(typed) && journal.ok
          ? pass(`delivered，${journal.detail}`)
          : fail(`${summarize(typed, 500)} journal=${journal.detail}`)
      })
    await ctx.check(
      'submit-deep-frame',
      '提交深层表单，服务端记录来自 alt origin',
      ['browser_fill_form'],
      async () => {
        const input = await target(run, '深层输入', { purpose: 'input' })
        const filled = await run.call(
          'browser_fill_form',
          { fields: [{ target_id: input.targetId, value: 'DEEP-OK' }], submit: true }
        )
        const rows = await waitForRecord(run, 'frames.submit', 1, 3_000)
        const row = rows[0]
        if (row && row.data.value === 'DEEP-OK')
          return pass(`frames.submit from ${String((row as { origin?: string }).origin)}`)
        const reason = submitFailure(filled)
        return reason ? fail(reason) : fail(`record=${JSON.stringify(row ?? null)} ${summarize(filled, 500)}`)
      })
  },
}

export const shadowGroup: CaseGroup = {
  site: 'shadow',
  title: 'Shadow DOM 控件',
  async run(ctx) {
    const run = await ctx.run('shadow')
    await run.open(ctx.url('/shadow/'))
    await ctx.check(
      'snapshot-open-shadow',
      '快照看到 open shadow 里的输入框与开关',
      ['browser_snapshot'],
      async () => {
        const { targets } = await allTargets(run)
        const missing = missingTargets(targets, [['textbox', '收件人'], ['switch', '加急']])
        return missing.length === 0
          ? pass(`${targets.length} 个目标`)
          : fail(`快照缺少 ${missing.join('、')}；看到：${targetSummary(targets)}`)
      })
    await ctx.check(
      'snapshot-closed-shadow',
      '快照看到 closed shadow 里的按钮',
      ['browser_snapshot'],
      async () => {
        const { targets } = await allTargets(run)
        return missingTargets(targets, [['button', '生成编号']]).length === 0
          ? pass('closed shadow 按钮可见')
          : fail('closed shadow 按钮缺失')
      })
    await ctx.check('type-shadow-input', '向 shadow 输入框输入并回读组件值', ['browser_type'], async () => {
      const input = await target(run, '收件人', { purpose: 'input' })
      const typed = await run.call('browser_type', { target_id: input.targetId, text: '张三' })
      const value = await run.pageEval<string>("return document.querySelector('eval-field')?.value ?? null")
      if (delivered(typed) && value === '张三') return pass('组件值“张三”')
      const detail = typed.data.detail as { captured?: { name?: string }; live?: { name?: string } } | undefined
      if (errorKind(typed) === 'stale_page_map' && detail?.captured?.name && !detail?.live?.name && !value) {
        return fail(
          '缺陷：open shadow 里由外层 <label> 命名的输入框，'
            + `写入前的身份核对拿不到名字（快照名“${detail.captured.name
          }”，实时名为空），判为 stale_page_map，写不进`
        )
      }
      return fail(`value=${String(value)} ${summarize(typed, 500)}`)
    })
    await ctx.check('switch-pointer', 'shadow 开关只能靠指针或按键', ['browser_click'], async () => {
      const toggle = await target(run, '加急', { role: 'switch' })
      const before = await run.probe()
      return pointerRefused(run, await run.call('browser_click', { target_id: toggle.targetId }), before)
    })
    await ctx.check(
      'submit-light-form',
      '提交 light DOM 表单，带上 shadow 组件的值',
      ['browser_fill_form'],
      async () => {
        const input = await target(run, '收件人', { purpose: 'input' })
        const filled = await run.call(
          'browser_fill_form',
          { fields: [{ target_id: input.targetId, value: '张三' }], submit: true }
        )
        const rows = await waitForRecord(run, 'shadow.submit', 1, 3_000)
        const row = rows[0]?.data
        if (row && row.recipient === '张三') return pass('shadow.submit 已记录', row)
        return fail(
          `寄件单提交不了：收件人写不进（同上，${String(errorKind(filled) || 'form_field_failed')
          }），提交按钮只能靠指针`,
          { text: summarize(filled, 400) }
        )
      })
  },
}

export const pagingGroup: CaseGroup = {
  site: 'paging',
  title: '分页与无限滚动',
  async run(ctx) {
    const run = await ctx.run('paging')
    await run.open(ctx.url('/paging/?page=1'))
    await ctx.check(
      'next-link-href',
      '快照里的“下一页”带真实 href，可直接导航',
      ['browser_find', 'browser_navigate', 'browser_read'],
      async () => {
        const next = await target(run, '下一页', { role: 'link' })
        const href = String(next.states?.url || next.fingerprint?.href || '')
        if (!href.includes('page=2')) return fail(`链接没有可用 href：${JSON.stringify(next)}`)
        await run.call('browser_navigate', { url: href })
        const read = await run.call('browser_read', {})
        return textOf(read).includes('P-011') && textOf(read).includes('P-020')
          ? pass('第 2 页内容可读')
          : fail(summarize(read))
      })
    const news = await ctx.run('news')
    await news.open(ctx.url('/sites/news/?page=1', 'third'))
    await ctx.check(
      'collect-article-list',
      '结构化采集新闻列表（标题、链接）',
      ['browser_collect'],
      async () => {
        const collected = await news.call(
          'browser_collect',
          { mode: 'structured', template: 'article_list', limit: 20 }
        )
        const items = ((collected.data.result as { items?: Array<{ link?: string }> } | undefined)?.items) || []
        const linked = items.filter((item) => String(item.link || '').includes('/sites/news/article/'))
        return linked.length === 8
          ? pass('采集到 8 条带链接的文章')
          : fail(`items=${items.length} linked=${linked.length} ${summarize(collected, 400)}`)
      })
    const feed = await ctx.run('feed')
    await feed.open(ctx.url('/feed/'))
    await ctx.check(
      'feed-scroll',
      '无限滚动：滚动在后台被拒绝且零投递',
      ['browser_scroll'],
      async () => {
        const before = await feed.probe()
        return pointerRefused(feed, await feed.call('browser_scroll', { direction: 'down', amount: 2000 }), before)
      })
    await ctx.check('feed-scroll-collect', '无限滚动：滚动采集', ['browser_collect'], async () => {
      const collected = await feed.call(
        'browser_collect',
        { mode: 'scroll', max_scrolls: 6, scroll_delay_ms: 600, limit: 80 }
      )
      const count = await feed.pageEval<number>('return document.querySelectorAll("article").length')
      if ((count ?? 0) > 15) return pass(`滚动后共 ${count} 条`)
      const kind = errorKind(collected)
      if (kind === 'foreground_required' || kind === 'browser_surface_required'
        || /foreground|surface/.test(collected.text)) {
        return unavailable(`滚动采集需要前台指针（${kind || 'refused'}），仍只有 ${count} 条（T5）`)
      }
      return gap(`滚动采集没有加载更多（仍 ${count} 条）：${summarize(collected, 300)}`)
    })
  },
}

export const waitGroup: CaseGroup = {
  site: 'wait',
  title: '等待条件',
  async run(ctx) {
    const run = await ctx.run('wait')
    const opened = Date.now()
    await run.open(ctx.url('/wait/'), { observe: false })
    await ctx.check('text-appears', '等待 1.5 秒后出现的文字', ['browser_wait'], async () => {
      const waited = await run.call('browser_wait', { condition: 'text', text: 'LATE-15', timeout_ms: 6_000 })
      const since = Date.now() - opened
      return waited.data.matched === true && since >= 1_000 && since < 5_000
        ? pass(`matched，开页后 ${since}ms`)
        : fail(`${summarize(waited)} since=${since}`)
    })
    await ctx.check('url-hash', '等待 2.5 秒后的网址变化', ['browser_wait'], async () => {
      const waited = await run.call('browser_wait', { condition: 'url', url: '#ready', timeout_ms: 6_000 })
      const since = Date.now() - opened
      return waited.data.matched === true && since >= 2_000
        ? pass(`matched，开页后 ${since}ms`)
        : fail(`${summarize(waited)} since=${since}`)
    })
    await ctx.check(
      'selector-after-slow-request',
      '等待慢请求（3 秒）完成后出现的节点',
      ['browser_wait'],
      async () => {
        const waited = await run.call('browser_wait', { condition: 'selector', selector: '#slow', timeout_ms: 8_000 })
        const since = Date.now() - opened
        return waited.data.matched === true && since >= 2_500
          ? pass(`matched，开页后 ${since}ms`)
          : fail(`${summarize(waited)} since=${since}`)
      })
    await ctx.check('timeout-respected', '等不到的文字：到时即止', ['browser_wait'], async () => {
      const started = Date.now()
      const waited = await run.call(
        'browser_wait',
        { condition: 'text', text: '永远不会出现的文字', timeout_ms: 1_500 }
      )
      const spent = Date.now() - started
      return waited.data.matched === false && spent >= 1_300 && spent < 4_000
        ? pass(`matched=false，${spent}ms`)
        : fail(`${summarize(waited)} spent=${spent}`)
    })
    const fresh = await ctx.run('network-idle')
    const freshOpened = Date.now()
    await fresh.open(ctx.url('/wait/'), { observe: false })
    await ctx.check(
      'network-idle-longpoll',
      'network_idle：有长轮询且有 3 秒慢请求时',
      ['browser_wait'],
      async () => {
        const waited = await fresh.call('browser_wait', { condition: 'network_idle', timeout_ms: 15_000 })
        const since = Date.now() - freshOpened
        const slowDone = await fresh.pageEval<boolean>("return Boolean(document.querySelector('#slow'))")
        if (waited.data.matched === true && slowDone)
          return pass(`在慢请求完成后判定空闲（开页后 ${since}ms）`)
        if (waited.data.matched === true)
          return fail(
            `慢请求仍在途就判定空闲（开页后 ${since
            }ms）：network_idle 不看在途请求（BA5 / T6）`
          )
        return fail(`长轮询页面上等到超时（${since}ms）：network_idle 不排除长连接（BA5 / T6）`)
      })
  },
}
