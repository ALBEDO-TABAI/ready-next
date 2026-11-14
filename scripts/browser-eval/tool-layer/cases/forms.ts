// Form-shaped sites: the frozen tool surface, ordinary form, keyboard, server-side multi-step
// form, login wall + admin.
import type { CaseGroup, CaseOutcome } from '../harness'
import type { AgentRun, ToolCallResult } from '../harness'
import {
  actionOutcome,
  allTargets,
  closedTool,
  findMatches,
  snapshotTargets,
  delivered,
  errorKind,
  fail,
  journalAgrees,
  keyboardOutcome,
  missingTargets,
  observe,
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

/** Native <select> is driven by a trusted pointer press plus keys: closed in the background. */
async function selectOutcome(
  run: AgentRun,
  result: ToolCallResult,
  read: () => Promise<string | null>,
  expected: string
): Promise<CaseOutcome> {
  const value = await read()
  if (value === expected && result.data.ok !== false) return pass(`选中 ${expected}`)
  if (errorKind(result) === 'foreground_required' && actionOutcome(result).delivery === 'not_delivered'
    && value !== expected) {
    return unavailable('下拉选择要先用可信指针点开：后台被拒绝，页面值未变（T5）')
  }
  return fail(`value=${String(value)} ${summarize(result)}`)
}

export const surfaceGroup: CaseGroup = {
  site: 'surface',
  title: '冻结工具面',
  async run(ctx) {
    const run = await ctx.run('surface')
    await run.open(ctx.url('/form/'))
    await ctx.check('current-page-tools', '当前页工具面 20 项，与准入组合器一致', [], async () => {
      const expected = [
        'browser_tabs',
        'browser_download',
        'browser_click',
        'browser_collect',
        'browser_dialog',
        'browser_drag',
        'browser_fill_form',
        'browser_find',
        'browser_hover',
        'browser_navigate',
        'browser_press_key',
        'browser_read',
        'browser_screenshot',
        'browser_scroll',
        'browser_search',
        'browser_select',
        'browser_snapshot',
        'browser_status',
        'browser_type',
        'browser_wait'
      ]
      const got = run.allowedToolNames
      const missing = expected.filter((name) => !got.includes(name))
      const extra = got.filter((name) => !expected.includes(name))
      if (missing.length === 0 && extra.length === 0) return pass(`${got.length} 项`)
      return fail(`工具面变化：缺 ${missing.join(',') || '无'}，多 ${extra.join(',') || '无'}`, got)
    })
    await ctx.check('tabs-scoped', '跨标签只列钉住页和任务页', ['browser_tabs'], async () => {
      const listed = await run.call('browser_tabs', { action: 'list' })
      const tabs = listed.data.tabs as { id: string }[]
      return tabs?.length === 1 && tabs[0].id === run.tabId ? pass('只列本轮页面') : fail(listed.text)
    })
    await ctx.check(
      'research-closed',
      'browser_research 不属于当前页工具面',
      ['browser_research'],
      async () => (
        closedTool(
          await run.call('browser_research', { action: 'start', work_items: [{ requirement: 'probe' }] }),
          'browser_research 不在当前页工具面（合同 §6）'
        )
      ))
    const fresh = await ctx.run('navigate-first')
    await fresh.open(ctx.url('/form/'), { observe: false })
    await ctx.check(
      'navigate-before-snapshot',
      '本轮第一步就导航（还没做快照）',
      ['browser_navigate'],
      async () => {
        const navigated = await fresh.call('browser_navigate', { url: ctx.url('/wizard/') })
        const url = await fresh.currentUrl()
        if (url.includes('/wizard/') && navigated.data.ok !== false) return pass('导航成功')
        return fail(`url=${url} ${summarize(navigated)}`)
      })
  },
}

export const formGroup: CaseGroup = {
  site: 'form',
  title: '普通表单',
  async run(ctx) {
    const run = await ctx.run('form')
    await run.open(ctx.url('/form/'))
    await ctx.check(
      'snapshot-sees-fields',
      '快照看到全部文字字段、下拉框与提交按钮',
      ['browser_snapshot'],
      async () => {
        const { targets } = await allTargets(run)
        const missing = missingTargets(
          targets,
          [
            ['textbox', '姓名'],
            ['textbox', '邮箱'],
            ['combobox', '主题'],
            ['textbox', '留言'],
            ['button', '提交']
          ]
        )
        return missing.length === 0
          ? pass(`${targets.length} 个目标`)
          : fail(`快照缺少 ${missing.join('、')}；看到：${targetSummary(targets)}`)
      })
    await ctx.check('checkbox-role', '快照里的复选框角色与勾选状态', ['browser_snapshot'], async () => {
      const { targets } = await allTargets(run)
      const box = targets.find((item) => item.name === '订阅月报')
      if (!box) return fail(`快照里没有“订阅月报”；看到：${targetSummary(targets)}`)
      if (box.role === 'checkbox' && typeof box.states?.checked === 'boolean') return pass(`role=checkbox checked=${box.states.checked}`)
      return fail(
        `缺陷：复选框被标成 ${box.role
        }（fingerprint.inputType=${String(box.fingerprint?.inputType)
        }），快照不给勾选状态（§4.6 感知）`,
        box
      )
    })
    await ctx.check(
      'type-readback',
      '输入落在目标上并回读一致，回执与日志一致',
      ['browser_type'],
      async () => {
        const name = await target(run, '姓名', { purpose: 'input' })
        const typed = await run.call('browser_type', { target_id: name.targetId, text: '白' })
        const value = await run.pageEval<string>("return document.querySelector('#name')?.value ?? null")
        const journal = journalAgrees(run, typed)
        if (delivered(typed) && value === '白' && journal.ok)
          return pass(`delivered，页面值“白”，${journal.detail}`)
        return fail(`ok=${String(typed.data.ok)} value=${String(value)} journal=${journal.detail} ${summarize(typed)}`)
      })
    await ctx.check('type-email', '向 type=email 输入框输入', ['browser_type'], async () => {
      const email = await target(run, '邮箱', { purpose: 'input' })
      const typed = await run.call('browser_type', { target_id: email.targetId, text: 'bai@example.test' })
      const value = await run.pageEval<string>("return document.querySelector('#email')?.value ?? null")
      if (delivered(typed) && value === 'bai@example.test') return pass('delivered，页面值一致')
      return fail(`value=${String(value)} ${summarize(typed)}`)
    })
    await ctx.check('select-option', '下拉选择', ['browser_select'], async () => {
      const topic = await target(run, '主题', { role: 'combobox' })
      const selected = await run.call('browser_select', { target_id: topic.targetId, value: 'support' })
      return selectOutcome(
        run,
        selected,
        () => run.pageEval<string>("return document.querySelector('#topic')?.value ?? null"),
        'support'
      )
    })
    await ctx.check(
      'click-background',
      '后台点击提交按钮：拒绝且零投递',
      ['browser_click'],
      async () => {
        const button = await target(run, '提交', { role: 'button' })
        const before = await run.probe()
        const clicked = await run.call('browser_click', { target_id: button.targetId })
        const outcome = await pointerRefused(run, clicked, before)
        return outcome.status === 'unavailable' && ctx.server.records('form.submit').length > 0
          ? fail('点击被拒绝却产生了提交记录')
          : outcome
      })
    await ctx.check('checkbox-fill', 'fill_form 勾选复选框', ['browser_fill_form'], async () => {
      const page = await observe(run)
      const filled = await run.call(
        'browser_fill_form',
        { fields: [{ target_id: page.pick('订阅月报', { inputType: 'checkbox' }).targetId, value: true }] }
      )
      const checked = await run.pageEval<boolean>("return document.querySelector('#subscribe')?.checked ?? null")
      if (checked === true && filled.data.ok === true) return pass('已勾选')
      if (filled.data.ok === false && checked === false)
        return fail(
          `缺陷：fill_form 勾不上复选框（把 checkbox 当文字框输入，${String(errorKind(filled))}）`
        )
      return fail(`checked=${String(checked)} ${summarize(filled, 400)}`)
    })
    await ctx.check(
      'fill-form-submit',
      '填表并提交（含邮箱、复选框，最后一个字段是多行文本框），服务端记下提交内容',
      ['browser_fill_form', 'browser_read'],
      async () => {
        const page = await observe(run)
        const filled = await run.call('browser_fill_form', {
          fields: [
            { target_id: page.pick('姓名', { purpose: 'input' }).targetId, value: '白' },
            { target_id: page.pick('邮箱', { purpose: 'input' }).targetId, value: 'bai@example.test' },
            { target_id: page.pick('订阅月报', { inputType: 'checkbox' }).targetId, value: true },
            { target_id: page.pick('留言', { purpose: 'input' }).targetId, value: '评测留言 FORM-1' },
          ],
          submit: true,
        })
        const rows = await waitForRecord(run, 'form.submit', 1, 4_000)
        const row = rows[0]?.data
        if (!row) {
          const reason = submitFailure(filled)
          return reason ? fail(reason) : fail(`没有提交记录：${summarize(filled, 600)}`)
        }
        const read = await run.call('browser_read', {})
        if (!textOf(read).includes('已收到 白 的留言')) return fail(`完成页不可读：${summarize(read)}`)
        return filled.data.ok === true && filled.data.submitted === true && row.name === '白' && row.email === 'bai@example.test' && row.subscribe === true && row.message === '评测留言 FORM-1'
          ? pass('form.submit 与填写一致，完成页可读', row)
          : fail(JSON.stringify(row))
      })
  },
}

export const keyboardGroup: CaseGroup = {
  site: 'keyboard',
  title: '键盘（窗口不在前台）',
  async run(ctx) {
    const first = await ctx.run('key-first')
    await first.open(ctx.url('/form/'))
    await first.call('browser_snapshot', {})
    await ctx.check(
      'key-on-fresh-page',
      '新页面上直接按键：回执与页面一致',
      ['browser_press_key'],
      async () => {
        const before = await first.probe()
        const pressed = await first.call('browser_press_key', { key: 'a' })
        return keyboardOutcome(first, pressed, before, async () => pass('按键送达'))
      })
    const typed = await ctx.run('key-after-type')
    await typed.open(ctx.url('/form/'))
    await ctx.check(
      'key-after-type',
      '先输入文字再按 Tab：回执与页面一致',
      ['browser_type', 'browser_press_key'],
      async () => {
        const name = await target(typed, '姓名', { purpose: 'input' })
        const filled = await typed.call('browser_type', { target_id: name.targetId, text: '白' })
        if (!delivered(filled)) return fail(`前置输入失败：${summarize(filled)}`)
        const before = await typed.probe()
        const pressed = await typed.call('browser_press_key', { key: 'Tab' })
        return keyboardOutcome(typed, pressed, before, async () => pass('按键送达'))
      })
  },
}

export const wizardGroup: CaseGroup = {
  site: 'wizard',
  title: '多步表单',
  async run(ctx) {
    const run = await ctx.run('wizard')
    await run.open(ctx.url('/wizard/'))
    const step1 = async (phone: string) => {
      const page = await observe(run)
      return run.call('browser_fill_form', {
        fields: [
          { target_id: page.pick('姓名', { purpose: 'input' }).targetId, value: '王一' },
          { target_id: page.pick('手机', { purpose: 'input' }).targetId, value: phone },
        ],
        submit: true,
      })
    }
    await ctx.check(
      'step1-validation',
      '第 1 步提交非法手机号，服务端校验错误可读',
      ['browser_fill_form', 'browser_read'],
      async () => {
        const filled = await step1('12345')
        const reason = submitFailure(filled)
        if (reason) return fail(reason)
        await run.call('browser_wait', { condition: 'text', text: '手机号格式不正确', timeout_ms: 6_000 })
        const read = await run.call('browser_read', {})
        return textOf(read).includes('手机号格式不正确') ? pass('错误提示可读') : fail(summarize(read))
      })
    await ctx.check(
      'three-steps',
      '三步提交（下拉框用页面默认值），服务端记下订单',
      ['browser_fill_form', 'browser_wait'],
      async () => {
        const first = await step1('13800000001')
        const reason1 = submitFailure(first)
        if (reason1) return fail(`第 1 步：${reason1}`)
        const step2 = await run.call(
          'browser_wait',
          { condition: 'text', text: '第 2 步：配送', timeout_ms: 6_000 }
        )
        if (step2.data.matched !== true) return fail(`未到第 2 步：${summarize(step2)}`)
        const page2 = await observe(run)
        const second = await run.call(
          'browser_fill_form',
          {
            fields: [
              { target_id: page2.pick('地址', { purpose: 'input' }).targetId, value: '徐汇区漕溪北路 1 号' }
            ],
            submit: true
          }
        )
        const reason2 = submitFailure(second)
        if (reason2) return fail(`第 2 步：${reason2}`)
        const step3 = await run.call(
          'browser_wait',
          { condition: 'text', text: '第 3 步：确认', timeout_ms: 6_000 }
        )
        if (step3.data.matched !== true) return fail(`未到第 3 步：${summarize(step3)}`)
        const page3 = await observe(run)
        const third = await run.call(
          'browser_fill_form',
          {
            fields: [
              { target_id: page3.pick('我已确认信息无误', { inputType: 'checkbox' }).targetId, value: true }
            ],
            submit: true
          }
        )
        const reason3 = submitFailure(third)
        if (reason3) return fail(`第 3 步：${reason3}`)
        const rows = await waitForRecord(run, 'wizard.order', 1, 3_000)
        const row = rows[0]?.data
        if (row && row.name === '王一' && row.phone === '13800000001'
          && row.address === '徐汇区漕溪北路 1 号')
          return pass('wizard.order 与三步填写一致', row)
        const read = await run.call('browser_read', {})
        if (textOf(read).includes('请先确认信息'))
          return fail(
            '缺陷：第 3 步的确认复选框没被勾上，服务端拒绝（fill_form '
              + '对 checkbox 按文字框处理）'
          )
        return fail(`record=${JSON.stringify(row ?? null)} ${summarize(read)}`)
      })
  },
}

export const loginGroup: CaseGroup = {
  site: 'login',
  title: '登录墙与后台',
  async run(ctx) {
    const run = await ctx.run('login')
    await run.open(ctx.url('/admin/'))
    await ctx.check(
      'wall-redirect',
      '未登录访问后台被转到登录页，快照看到登录表单',
      ['browser_snapshot'],
      async () => {
        const url = await run.currentUrl()
        const { targets } = await allTargets(run)
        const missing = missingTargets(targets, [['textbox', '用户名'], ['textbox', '密码'], ['button', '登录']])
        if (url.includes('/login/') && missing.length === 0) return pass('登录页与表单可见')
        return fail(`url=${url} 缺少 ${missing.join('、')}`)
      })
    await ctx.check(
      'password-needs-confirmation',
      '往密码框输入：要求用户确认，未确认不写入',
      ['browser_type'],
      async () => {
        const password = await target(run, '密码', { purpose: 'input' })
        const typed = await run.call('browser_type', { target_id: password.targetId, text: 'ready-eval-2026' })
        const value = await run.pageEval<string>("return document.querySelector('#password')?.value ?? null")
        if (errorKind(typed) === 'credential_confirmation_required' && !value) {
          return unavailable(
            '助手不能代填密码：密码输入要求逐次确认，'
              + '而模型工具通道没有接确认入口（tool-executor 不传 '
              + 'requestPowerConfirmation）'
          )
        }
        if (delivered(typed) && value === 'ready-eval-2026')
          return fail('能力状态变化：密码已能代填，按新能力改写用例')
        return fail(`value=${String(value)} ${summarize(typed)}`)
      })
    await ctx.loginAsUser()
    await ctx.check(
      'prelogin-admin',
      '用户先登录后，助手导航进后台并读到正文',
      ['browser_navigate', 'browser_read'],
      async () => {
        await run.call('browser_snapshot', {})
        await run.call('browser_navigate', { url: ctx.url('/admin/') })
        const read = await run.call('browser_read', {})
        return textOf(read).includes('欢迎，eval-user') ? pass('后台正文可读') : fail(summarize(read))
      })
    await ctx.check(
      'create-post',
      '后台发帖：导航、填表、提交（分类用默认值）',
      ['browser_navigate', 'browser_fill_form'],
      async () => {
        await run.call('browser_snapshot', {})
        await run.call('browser_navigate', { url: ctx.url('/admin/posts/new') })
        await run.call('browser_wait', { condition: 'text', text: '立即发布', timeout_ms: 6_000 })
        const page = await observe(run)
        const filled = await run.call('browser_fill_form', {
          fields: [
            { target_id: page.pick('标题', { purpose: 'input' }).targetId, value: '评测帖子 POST-1' },
            { target_id: page.pick('正文', { purpose: 'input' }).targetId, value: '正文 BODY-1' },
          ],
          submit: true,
        })
        const rows = await waitForRecord(run, 'admin.post.create', 1, 4_000)
        const row = rows[0]?.data
        if (row && row.title === '评测帖子 POST-1' && row.body === '正文 BODY-1')
          return pass('admin.post.create 与填写一致', row)
        const reason = submitFailure(filled)
        return reason ? fail(reason) : fail(`record=${JSON.stringify(row ?? null)} ${summarize(filled, 500)}`)
      })
    const posts = await ctx.run('posts')
    await posts.open(ctx.url('/admin/posts/'))
    await ctx.check(
      'within-after-budgeted-snapshot',
      '带 max_bytes 的快照里的容器引用用作 within_target_id',
      ['browser_snapshot', 'browser_find'],
      async () => {
        const budgeted = await posts.call('browser_snapshot', { max_bytes: 60_000 })
        const form = snapshotTargets(budgeted).filter((item) => item.role === 'form')[1]
        if (!form) return fail('快照里没有删除表单')
        const scoped = await posts.call('browser_find', { query: '删除', within_target_id: form.targetId })
        if (findMatches(scoped).length === 1) return pass('within 查找成功')
        if (String(scoped.data.errorCode) === 'within_target_stale') {
          return fail(
            '缺陷：用带 max_bytes 的快照里的容器做 within_target_id，'
              + '总被判为“旧快照”（within_target_stale），'
              + '重拍同样预算的快照也一样；默认预算的快照没问题'
          )
        }
        return fail(summarize(scoped))
      })
    await ctx.check(
      'delete-needs-pointer',
      '同名“删除”按钮带行上下文；容器内查找后可定位（后台只能靠指针）',
      ['browser_find', 'browser_click'],
      async () => {
        const page = await observe(posts)
        const buttons = page.targets.filter(item => item.role === 'button' && item.name === '删除')
        if (buttons.length < 2 || new Set(buttons.map(item => item.fingerprint?.ancestorContext)).size !== buttons.length)
          return fail(`同名按钮缺少可区分的行上下文：${JSON.stringify(buttons)}`)
        const form = page.targets.find(
          (item) => item.role === 'form' && String(item.fingerprint?.formAction || '').includes('/admin/posts/2/delete')
        )
          || page.targets.filter((item) => item.role === 'form')[1]
        if (!form) return fail(`找不到删除表单；看到：${targetSummary(page.targets)}`)
        const scoped = await posts.call('browser_find', { query: '删除', within_target_id: form.targetId })
        const button = (scoped.data.matches as Array<{ targetId: string }> | undefined)?.[0]
        if (!button) return fail(`表单内找不到删除按钮：${summarize(scoped)}`)
        const before = await posts.probe()
        const clicked = await posts.call('browser_click', { target_id: button.targetId })
        if (errorKind(clicked) === 'ambiguous_target') {
          return fail(
            '缺陷：同名按钮（每行一个“删除”）即使用 within_target_id '
              + '在所在表单里找到唯一一个，点击仍判为有歧义；'
              + '表格行的标题不进快照，助手难以指明是哪一行'
          )
        }
        const outcome = await pointerRefused(posts, clicked, before)
        return outcome.status === 'unavailable' && ctx.server.records('admin.post.delete').length > 0
          ? fail('点击被拒绝却删除了帖子')
          : outcome
      })
  },
}
