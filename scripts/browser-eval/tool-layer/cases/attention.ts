import type { BrowserActionOutcome } from '../../../../src/shared/browser-action-outcome'
import { fail, pass, type CaseGroup } from '../harness'

export const attentionGroup: CaseGroup = {
  site: 'attention', title: '需要用户处理',
  async run(ctx) {
    const notifications: string[] = []
    ctx.env.controller.setAttentionNotificationPort(body => notifications.push(body))
    try {
      for (const reason of ['login', 'captcha'] as const) {
        await ctx.check(reason, '声明阻碍、持久读回、请到前台并禁止继续写入', ['browser_status', 'browser_type'], async () => {
          const run = await ctx.run(reason)
          await run.open(ctx.url('/form/'))
          const opened = await run.call('browser_tabs', { action: 'open', url: ctx.url('/login/') })
          const outcome = opened.data.browserActionOutcome as BrowserActionOutcome
          const tabId = outcome.postActionTabId
          if (!tabId) return fail(opened.text)
          await run.call('browser_snapshot', { tab_id: tabId })
          const status = await run.call('browser_status', { tab_id: tabId, needs_user: reason })
          const attention = run.controller.getTaskAttention(String(outcome.taskId))
          if (!attention || attention.reason !== reason || attention.action.kind !== 'send_user_input') return fail(status.text)
          if (run.controller.getActiveTab()?.id !== tabId || ctx.env.window.isFocused()) return fail('页面未迁回或抢了焦点')
          const before = await run.controller.executeJS(tabId, 'document.querySelector("input[type=text]").value')
          const denied = await run.call('browser_type', { tab_id: tabId, selector: 'input[type=text]', text: 'must-not-arrive' })
          const after = await run.controller.executeJS(tabId, 'document.querySelector("input[type=text]").value')
          return denied.data.ok === false && before === after && notifications.length > 0
            ? pass('阻碍可冷读；新输入动作引用原任务；旧任务零写入', attention) : fail(denied.text)
        })
      }
    } finally {
      ctx.env.controller.setAttentionNotificationPort(() => undefined)
    }
  },
}
