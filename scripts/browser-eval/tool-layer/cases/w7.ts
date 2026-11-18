import type { CaseGroup } from '../harness'
import { pass, fail, unavailable } from '../harness'
import type { BrowserActionOutcome } from '../../../../src/shared/browser-action-outcome'

export const w7Group: CaseGroup = {
  site: 'w7', title: '任务标签、来源与感知',
  async run(ctx) {
    const run = await ctx.run('task-tabs')
    await run.open(ctx.url('/form/'))
    const root = run.tabId
    const unrelated = await run.controller.createTab(ctx.url('/downloads/'), { background: true })
    let workTab = '', taskId = ''
    await ctx.check('tabs-lineage', '开页因果与可见范围', ['browser_tabs'], async () => {
      const opened = await run.call('browser_tabs', { action: 'open', url: ctx.url('/form/', 'alt'), background: false })
      const outcome = opened.data.outcome as BrowserActionOutcome
      workTab = String(outcome.postActionTabId || opened.data.tabId || '')
      taskId = String(outcome.taskId || '')
      if (!workTab || !taskId || outcome.identity?.tabId !== root) return fail(opened.text)
      await run.call('browser_snapshot', { tab_id: workTab })
      const listed = await run.call('browser_tabs', { action: 'list' })
      const ids = (listed.data.tabs as { id: string }[] || []).map(tab => tab.id)
      const switched = await run.call('browser_tabs', { action: 'switch', tab_id: workTab })
      return ids.includes(root) && ids.includes(workTab) && !ids.includes(unrelated.tabId || '')
        && run.controller.getActiveTab()?.id === root && switched.data.ok !== false
        ? pass('后台创建、因果入账、私有标签不泄露、切换不抢前台', { outcome, ids }) : fail(listed.text)
    })
    await ctx.check('foreign-origin-write', '跨来源输入先询问且零投递', ['browser_type'], async () => {
      const before = await run.controller.executeJS(workTab, 'document.querySelector("input").value')
      const result = await run.call('browser_type', { tab_id: workTab, selector: 'input', text: 'injected' })
      const after = await run.controller.executeJS(workTab, 'document.querySelector("input").value')
      return result.data.ruleId === 'browser-origin-write' && result.data.errorKind === 'denied_pending_confirmation' && before === after
        ? pass('缺少来源确认，页面零输入') : fail(result.text)
    })
    await ctx.check('tabs-close-release', '禁止关闭用户页；释放后保留工作页；批量关闭', ['browser_tabs'], async () => {
      const denied = await run.call('browser_tabs', { action: 'close', tab_id: root })
      if (denied.data.errorKind !== 'browser_task_tab_not_owned') return fail(denied.text)
      const extra = await run.call('browser_tabs', { action: 'open', url: ctx.url('/form/') })
      const extraId = String((extra.data.outcome as BrowserActionOutcome)?.postActionTabId || '')
      if (!extraId || extraId === workTab) return fail('第二次开页没有独立工作标签')
      const singleClose = await run.call('browser_tabs', { action: 'close', tab_id: extraId })
      if (singleClose.data.success !== true || run.controller.getTabList().some(tab => tab.id === extraId)) return fail(singleClose.text)
      run.releaseControls()
      if (run.controller.getBrowserLeaseSnapshot().claims.some(claim => claim.ownerRunId === run.runId && claim.state === 'held')) return fail('任务占用未释放')
      if (!run.controller.getTabList().some(tab => tab.id === workTab)) return fail('释放占用删除了工作页')
      const closed = run.controller.closeTaskTabs({ browserTaskId: taskId })
      return closed.success && closed.closedTabIds.includes(workTab) && run.controller.getTabList().some(tab => tab.id === root)
        ? pass('释放保留，批量关闭只处理所属任务') : fail(JSON.stringify(closed))
    })
    const canvas = await ctx.run('annotated-canvas')
    await canvas.open(ctx.url('/canvas/'))
    await ctx.check('numbered-screenshot', '画布截图按当前快照目标标号', ['browser_screenshot'], async () => {
      const result = await canvas.call('browser_screenshot', { annotate: true })
      if (/display surface not available|not available for capture/i.test(result.text)) return unavailable('当前隐藏承载面无法截图；编号合成须在可截图承载面补验')
      const labels = result.data.labels as { number: number; targetId: string }[] | undefined
      return result.hasImage && Boolean(labels?.length) ? pass('图片与编号映射同时返回', labels) : fail(result.text)
    })
    const wait = await ctx.run('target-waits')
    await wait.open(ctx.url('/wait/'), { observe: false })
    await ctx.check('target-appear', '延迟目标出现', ['browser_wait'], async () => {
      const result = await wait.call('browser_wait', { condition: 'target_appeared', selector: '#late', timeout_ms: 5000 })
      return result.data.matched ? pass('目标出现后结束') : fail(result.text)
    })
    await ctx.check('target-text-disappear', '目标文字变化与消失', ['browser_wait'], async () => {
      await wait.pageEval('setTimeout(() => { document.querySelector("#late").textContent = "changed" }, 300); return true')
      const changed = await wait.call('browser_wait', { condition: 'text_changed', selector: '#late', previous_text: '延迟出现的文字 LATE-15' })
      await wait.pageEval('setTimeout(() => document.querySelector("#late").remove(), 300); return true')
      const gone = await wait.call('browser_wait', { condition: 'target_disappeared', selector: '#late' })
      return changed.data.matched && gone.data.matched ? pass('文字变化和消失均匹配') : fail(changed.text + gone.text)
    })
    await ctx.check('snapshot-tokens', '差分返回令牌对比', ['browser_snapshot'], async () => {
      await wait.call('browser_snapshot')
      const result = await wait.call('browser_snapshot')
      const counts = result.data.tokenComparison as { full?: number; diff?: number }
      return Number(counts?.full) > 0 && Number(counts?.diff) > 0 ? pass('提供完整与差分估算', counts) : fail(result.text)
    })
  },
}
