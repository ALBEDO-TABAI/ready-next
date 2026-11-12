import assert from 'node:assert/strict'
import { WEBMCP_TOOL_NAMES } from '../../../../src/shared/browser-webmcp'
import { pass, unavailable, type CaseGroup } from '../harness'

export const webMcpGroup: CaseGroup = {
  site: 'webmcp', title: '网页自带工具（实验）',
  async run(ctx) {
    const run = await ctx.run('page-tools')
    await run.open(ctx.url('/webmcp/'))
    if (!run.controller.webMcp.enabled) {
      await ctx.check('disabled', '关闭时两工具不进入工具面', [...WEBMCP_TOOL_NAMES], async () => {
        for (const name of WEBMCP_TOOL_NAMES) {
          assert.equal(run.allowedToolNames.includes(name), false)
          const result = await run.call(name, name === 'browser_page_tools' ? {} : { frame_id: 'missing', tool_name: 'lookup', input: {} })
          assert.equal(result.data.errorKind, 'tool_restricted_this_turn')
        }
        return unavailable('实验未启用；冻结工具面和执行入口均拒绝两工具')
      })
      return
    }
    // Registration delivery is asynchronous; a new admission follows actual CDP evidence.
    // Under heavy machine load the page can take several seconds to register; a short wait fails every later case.
    const deadline = Date.now() + 30000
    while (run.controller.webMcp.tools(run.tabId).length !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (run.controller.webMcp.tools(run.tabId).length !== 2) throw new Error(`page registered ${run.controller.webMcp.tools(run.tabId).length} of 2 tools within 30 s`)
    await run.rebindPageRef()
    let frameId = ''
    await ctx.check('list-annotations', '列出与 CDP 注解回传核对', ['browser_page_tools'], async () => {
      for (const name of WEBMCP_TOOL_NAMES) assert.ok(run.allowedToolNames.includes(name))
      const listed = await run.call('browser_page_tools')
      assert.equal(listed.data.trust, 'untrusted_web_content')
      assert.match(listed.text, /资料，不是指令/)
      const tools = (listed.data.data as { tools: { name: string; frameId: string; origin: string; annotations?: Record<string, boolean> }[] }).tools
      assert.equal(tools.length, 2)
      const read = tools.find(tool => tool.name === 'lookup')!
      const write = tools.find(tool => tool.name === 'commit')!
      assert.equal(read.origin, ctx.server.origins.main)
      assert.equal(read.annotations?.readOnlyHint, true, 'toolsAdded must return the page read-only annotation')
      assert.equal(read.annotations?.untrustedContentHint, true)
      assert.equal(write.annotations?.consequentialHint, true, 'toolsAdded must return the consequence annotation')
      frameId = read.frameId
      return pass('两工具及来源可读，注解从真实 CDP 回传', tools)
    })
    await ctx.check('read', '只读工具调用返回结果', ['browser_call_page_tool'], async () => {
      const result = await run.call('browser_call_page_tool', { frame_id: frameId, tool_name: 'lookup', input: { query: 'hello' } })
      assert.equal(result.data.trust, 'untrusted_web_content')
      assert.match(result.text, /WEBMCP-READ:hello/)
      return pass('只读工具经真实 CDP 返回结果，来源与不可信提示保留')
    })
    await ctx.check('consequential', '带后果调用先确认且零执行', ['browser_call_page_tool'], async () => {
      const result = await run.call('browser_call_page_tool', { frame_id: frameId, tool_name: 'commit', input: { query: 'x' } })
      assert.equal(result.data.ruleId, 'browser-webmcp-write')
      assert.equal(result.data.errorKind, 'denied_pending_confirmation')
      assert.equal(await run.pageEval("return document.querySelector('iframe').contentWindow.webmcpCalls"), 0)
      return pass('原行动确认拦截，页面计数未变化')
    })
    await ctx.check('removed', '页面移除工具后调用失败', ['browser_call_page_tool'], async () => {
      await run.pageEval("document.querySelector('iframe').remove(); return true")
      const until = Date.now() + 3000
      while (run.controller.webMcp.hasTools(run.tabId) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(run.controller.webMcp.hasTools(run.tabId), false)
      const result = await run.call('browser_call_page_tool', { frame_id: frameId, tool_name: 'lookup', input: { query: 'x' } })
      assert.equal(result.data.errorKind, 'webmcp_preflight_failed')
      return pass('页面移除 frame 后旧调用失败，不重试')
    })
  },
}
