import { app, type ProcessMetric } from 'electron'
import type { BrowserActionOutcome } from '../../../../src/shared/browser-action-outcome'
import { fail, pass, unavailable, type CaseGroup } from '../harness'

export const backgroundGroup: CaseGroup = {
  site: 'background', title: '后台工作面',
  async run(ctx) {
    if (process.env.READY_BROWSER_BACKGROUND_SURFACE !== '1') {
      await ctx.check('disabled', '默认不开放后台指针', [], async () => unavailable('READY_BROWSER_BACKGROUND_SURFACE 未打开'))
      return
    }
    const run = await ctx.run('pointer')
    await run.open(ctx.url('/form/'))
    const foreground = run.controller.getActiveTab()?.id
    const opened = await run.call('browser_tabs', { action: 'open', url: ctx.url('/form/') })
    const tabId = (opened.data.outcome as BrowserActionOutcome)?.postActionTabId
    if (!tabId) throw new Error(opened.text)
    await run.controller.executeJS(tabId, `(() => {
      document.body.innerHTML = '<button style="position:absolute;left:40px;top:40px;width:200px;height:80px">Target</button><div id="lazy" style="position:absolute;top:2000px">Lazy</div>';
      document.body.style.height = '4000px';
      window.bgProbe = { clicks: 0, drag: 0, frames: 0, lazy: false };
      document.querySelector('button').onclick = () => bgProbe.clicks++;
      document.onpointermove = e => { if(e.buttons) bgProbe.drag++ };
      new IntersectionObserver(es => { if(es.some(e => e.isIntersecting)) bgProbe.lazy = true }).observe(document.querySelector('#lazy'));
      const tick = () => { bgProbe.frames++; requestAnimationFrame(tick) }; tick();
    })()`)
    const read = () => run.controller.executeJS(tabId, '({...bgProbe, visibility:document.visibilityState, width:innerWidth,height:innerHeight,scrollY})') as Promise<{ clicks: number; drag: number; frames: number; lazy: boolean; visibility: string; width: number; height: number; scrollY: number }>
    await run.call('browser_snapshot', { tab_id: tabId })
    await ctx.check('pointer', 'CDP 点击与拖拽命中', ['browser_click', 'browser_drag'], async () => {
      const click = await run.call('browser_click', { tab_id: tabId, x: 78, y: 100 })
      await run.call('browser_snapshot', { tab_id: tabId })
      const drag = await run.call('browser_drag', { tab_id: tabId, source_x: 78, source_y: 100, target_x: 155, target_y: 150 })
      const state = await read()
      return state.clicks > 0 && state.drag > 0 ? pass('真实指针命中', state) : fail(click.text + drag.text, state)
    })
    await ctx.check('rendering', '滚轮、懒加载、动画与可见性', ['browser_scroll'], async () => {
      const before = await read()
      await run.call('browser_snapshot', { tab_id: tabId })
      const scroll = await run.call('browser_scroll', { tab_id: tabId, direction: 'down', amount: 1800 })
      await new Promise(resolve => setTimeout(resolve, 1200))
      const after = await read()
      return after.lazy && after.frames > before.frames && after.scrollY > 0 && after.visibility === 'visible'
        && after.width === 1280 && after.height === 800 ? pass('完整视口持续渲染', after) : fail(scroll.text, after)
    })
    await ctx.check('resources-focus', '资源采样与不抢焦点', [], async () => {
      const samples: Pick<ProcessMetric, 'pid' | 'type' | 'cpu' | 'memory'>[][] = []
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        samples.push(app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })))
      }
      return run.controller.getActiveTab()?.id === foreground && !ctx.env.window.isFocused()
        ? pass('5 次一秒间隔采样；memory 为 KiB，cpu 为进程占用百分比', samples) : fail('用户前台被改变', samples)
    })
    await ctx.check('takeover', '接管后零投递', ['browser_click'], async () => {
      await run.controller.requestAgentInterruption(tabId)
      const before = await read()
      const denied = await run.call('browser_click', { tab_id: tabId, x: 78, y: 100 })
      const after = await read()
      return denied.data.ok === false && before.clicks === after.clicks && before.drag === after.drag
        ? pass('接管生效后没有新的指针事件') : fail(denied.text)
    })
    await ctx.check('release', '释放后不再保留后台承载面', [], async () => {
      run.releaseControls()
      const state = run.controller.getBrowserInputEnvironment(tabId)
      return !state.backgroundWorkSurfaceAdmitted ? pass('旧任务失去后台投递资格', state) : fail(JSON.stringify(state))
    })
  },
}
