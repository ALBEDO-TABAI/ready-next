// Interaction-heavy sites: downloads, uploads, native dialogs, new tabs/popups, rich text,
// canvas, and the takeover fence.
import {
  getBrowserTargetClaimService
} from '../../../../src/main/modules/browser-engine/browser-target-claim-singleton'
import { partitionForBrowserProfile } from '../../../../src/main/modules/browser-engine/browser-target-claims'
import type { CaseGroup } from '../harness'
import {
  actionOutcome,
  allTargets,
  delivered,
  errorKind,
  fail,
  gap,
  journalAgrees,
  keyboardOutcome,
  missingTargets,
  pass,
  pointerRefused,
  snapshotTargets,
  submitFailure,
  summarize,
  target,
  targetSummary,
  textOf,
  unavailable,
  waitForRecord,
} from './helpers'

export const downloadsGroup: CaseGroup = {
  site: 'downloads',
  title: '下载',
  async run(ctx) {
    const run = await ctx.run('downloads')
    await run.open(ctx.url('/downloads/'))
    await ctx.check('links-visible', '快照看到全部下载链接及其地址', ['browser_snapshot'], async () => {
      const { targets } = await allTargets(run)
      const links = targets.filter((item) => item.role === 'link')
      const want = ['report-2026-q1.csv', 'report-2026-q2.csv', 'report-2026-q3.csv', 'manual-s2.pdf']
      const missing = want.filter(
        (file) => !links.some((link) => String(link.states?.url || link.fingerprint?.href || '').includes(file))
      )
      return missing.length === 0
        ? pass(`${links.length} 个链接带地址`)
        : fail(`缺少 ${missing.join('、')}；看到：${targetSummary(targets)}`)
    })
    await ctx.check('download-receipt', '下载落盘、哈希、回执与 ReadyRef 一致', ['browser_download'], async () => {
      const result = await run.call('browser_download', { mode: 'urls', urls: [ctx.url('/downloads/files/report-2026-q3.csv')] })
      const receipts = result.data.downloadReceipts as import('../../../../src/shared/browser-download-receipt').BrowserDownloadReceipt[]
      if (receipts?.length !== 1) return fail(result.text)
      const receipt = receipts[0]
      const { readFileSync } = await import('node:fs')
      const { createHash } = await import('node:crypto')
      const bytes = readFileSync(receipt.path)
      const saved = run.controller.getTaskDownloadReceipts({ browserTaskId: receipt.browserTaskId }).downloadReceipts
      return bytes.length === receipt.size && createHash('sha256').update(bytes).digest('hex') === receipt.sha256
        && receipt.sha256 === ctx.server.fixtures.files['report-2026-q3.csv'].sha256
        && receipt.readyUri.startsWith('ready://doc/file/') && JSON.stringify(saved) === JSON.stringify(receipts)
        ? pass('文件和独立回执完全一致', receipts) : fail(result.text)
    })
    await ctx.check('download-public-local-redirect', '公开名称跳转本地网络拒绝发布', ['browser_download'], async () => {
      const url = new URL(ctx.url('/__eval/public-download-redirect'))
      url.hostname = 'public.browser-eval.test'
      const result = await run.call('browser_download', { mode: 'urls', urls: [url.href] })
      const { readdirSync } = await import('node:fs')
      return /public_to_local|redirect.*local|local.*redirect/.test(result.text)
        && !readdirSync(ctx.env.downloadsDir).some(name => name.endsWith('.part'))
        ? pass('重定向被拒绝且无临时残留') : fail(result.text)
    })
    await ctx.check('download-outside', '下载拒绝越界目录且不发起请求', ['browser_download'], async () => {
      const count = ctx.server.records('download').length
      const result = await run.call('browser_download', { mode: 'urls', directory: '/', urls: [ctx.url('/downloads/files/report-2026-q3.csv')] })
      return result.text.includes('download_directory_not_authorized') && ctx.server.records('download').length === count
        ? pass('越界在下载前拒绝') : fail(result.text)
    })
  },
}

export const uploadGroup: CaseGroup = {
  site: 'upload',
  title: '上传',
  async run(ctx) {
    const run = await ctx.run('upload', { attachments: ['eval-receipt.pdf'] })
    await run.open(ctx.url('/upload/'))
    await ctx.check('surface-has-upload', '有显式附件时工具面加入 browser_upload', [], async () => (
      run.allowedToolNames.includes('browser_upload')
        ? pass('browser_upload 已准入')
        : fail(`工具面：${run.allowedToolNames.join(',')}`)
    ))
    await ctx.check('upload-requires-choice', '上传必须显式选择附件', ['browser_upload'], async () => {
      const input = await target(run, '文件')
      const result = await run.call('browser_upload', { target_id: input.targetId })
      return result.data.ok === false || /attachment/i.test(result.text)
        ? pass(`拒绝：${String(errorKind(result) || 'schema')}`)
        : fail(summarize(result))
    })
    await ctx.check(
      'upload-assign',
      '把会话附件赋给文件框并按文件名回读',
      ['browser_upload'],
      async () => {
        const input = await target(run, '文件')
        const result = await run.call(
          'browser_upload',
          { target_id: input.targetId, attachment_name: 'eval-receipt.pdf' }
        )
        const name = await run.pageEval<string>(
          "return document.querySelector('#upload-file')?.files?.[0]?.name ?? null"
        )
        const outcome = actionOutcome(result)
        return name === 'eval-receipt.pdf' && outcome.delivery === 'delivered'
          ? pass(`delivered，页面文件 ${name}`)
          : fail(`name=${String(name)} delivery=${String(outcome.delivery)} ${summarize(result, 500)}`)
      })
    await ctx.check(
      'upload-submit',
      '填写描述并提交，服务端收到的文件哈希一致',
      ['browser_fill_form'],
      async () => {
        const desc = await target(run, '描述', { purpose: 'input' })
        const filled = await run.call(
          'browser_fill_form',
          { fields: [{ target_id: desc.targetId, value: '十一月差旅' }], submit: true }
        )
        const rows = await waitForRecord(run, 'upload', 1, 4_000)
        const row = rows[0]?.data
        const expected = ctx.server.fixtures.files['eval-receipt.pdf']?.sha256
        if (row && row.sha256 === expected && row.description === '十一月差旅')
          return pass('upload 记录 sha256 与附件一致', { filename: row.filename, size: row.size })
        const reason = submitFailure(filled)
        return reason
          ? gap(reason)
          : fail(`record=${JSON.stringify(row ?? null)} expected=${String(expected)} ${summarize(filled, 400)}`)
      })
  },
}

const DIALOG_HANG = '缺陷：原生对话框打开时，'
  + '工具调用先核对页面身份（在页面里跑脚本），'
  + '而页面脚本被对话框挡住，调用一直挂起到超时；'
  + 'browser_dialog 拿不到也关不掉对话框'

export const dialogsGroup: CaseGroup = {
  site: 'dialogs',
  title: '原生对话框',
  async run(ctx) {
    // Bind the page first, then let a tool navigation open the auto dialog: a page with an open
    // modal dialog cannot answer the identity probe that binds a pageRef.
    const openWithDialog = async (label: string, kind: 'confirm' | 'prompt' | 'alert') => {
      const run = await ctx.run(label)
      await run.open(ctx.url('/dialogs/'))
      const navigated = await run.call('browser_navigate', { url: ctx.url(`/dialogs/?auto=${kind}`) })
      await new Promise((resolve) => setTimeout(resolve, 900))
      navigations.set(run, summarize(navigated, 300))
      return run
    }
    const navigations = new Map<object, string>()
    const hung = (error: unknown) => error instanceof Error && /timed out/.test(error.message)
    const confirmRun = await openWithDialog('confirm', 'confirm')
    await ctx.check('confirm-get', '读到自动弹出的 confirm', ['browser_dialog'], async () => {
      try {
        const got = await confirmRun.call('browser_dialog', { action: 'get' }, 10_000)
        return /确定要继续吗/.test(got.text) ? pass('confirm 文案可读') : fail(summarize(got))
      } catch (error) {
        if (hung(error)) return gap(DIALOG_HANG)
        throw error
      }
    })
    await ctx.check(
      'confirm-accept',
      '接受 confirm，页面与服务端都看到结果',
      ['browser_dialog'],
      async () => {
        try {
          const accepted = await confirmRun.call('browser_dialog', { action: 'accept' }, 10_000)
          const rows = await waitForRecord(confirmRun, 'dialog.result')
          const row = rows[0]?.data
          return row && row.type === 'confirm' && row.value === true
            ? pass('confirm=true 已记录')
            : fail(`record=${JSON.stringify(row ?? null)} ${summarize(accepted)}`)
        } catch (error) {
          if (hung(error)) return gap(DIALOG_HANG)
          throw error
        }
      })
    confirmRun.close()
    const promptRun = await openWithDialog('prompt', 'prompt')
    await ctx.check('prompt-unsupported', 'window.prompt 输入框', ['browser_dialog'], async () => {
      const accepted = await promptRun.call('browser_dialog', { action: 'accept', prompt_text: '白' }, 10_000)
      const rows = await waitForRecord(promptRun, 'dialog.result')
      const row = rows.find((item) => item.data.type === 'prompt')?.data
      if (row && row.value === '白') return pass('prompt=白 已记录')
      if (errorKind(accepted) === 'dialog_not_open' && (!row || row.value === null)) {
        const thrown = await promptRun.pageEval<string>(
          "try { window.prompt('probe'); return 'no-error' } catch (error) { return String(error && error.message || error) }"
        )
        if (thrown && thrown !== 'no-error')
          return unavailable(
            `Electron 不支持 window.prompt（页面调用直接抛错：${thrown
            }），没有对话框可让助手输入`
          )
        if (row)
          return unavailable(
            'Electron 不支持 window.prompt：页面直接拿到 null，没有对话框可让助手输入'
          )
      }
      return fail(
        `record=${JSON.stringify(row ?? null)
        } ${summarize(accepted)
        }；打开对话框的导航：${navigations.get(promptRun)
        }`
      )
    })
    promptRun.close()
  },
}

export const popupGroup: CaseGroup = {
  site: 'popup',
  title: '新标签与弹窗',
  async run(ctx) {
    const run = await ctx.run('popup')
    await run.open(ctx.url('/popup/'))
    const tabsBefore = run.controller.getTabList().length
    await ctx.check('links-visible', '快照看到新标签链接与弹窗按钮', ['browser_snapshot'], async () => {
      const { targets } = await allTargets(run)
      const missing = missingTargets(
        targets,
        [['link', '在新标签打开'], ['button', '弹出窗口'], ['button', '第三方登录']]
      )
      return missing.length === 0
        ? pass('目标齐全')
        : fail(`缺少 ${missing.join('、')}；看到：${targetSummary(targets)}`)
    })
    await ctx.check(
      'window-open-pointer',
      '弹窗按钮在后台点不了，也没有新窗口或新标签',
      ['browser_click'],
      async () => {
        const button = await target(run, '弹出窗口', { role: 'button' })
        const before = await run.probe()
        const outcome = await pointerRefused(
          run,
          await run.call('browser_click', { target_id: button.targetId }),
          before
        )
        const tabsAfter = run.controller.getTabList().length
        return tabsAfter !== tabsBefore ? fail(`标签数变化 ${tabsBefore}→${tabsAfter}`) : outcome
      })
    await ctx.check(
      'navigate-child-in-place',
      '在当前标签打开子页面（代替新标签）',
      ['browser_navigate', 'browser_read'],
      async () => {
        await run.call('browser_navigate', { url: ctx.url('/popup/child.html?from=link') })
        const read = await run.call('browser_read', {})
        const rows = await waitForRecord(run, 'popup.child')
        return textOf(read).includes('CHILD-3') && rows.some((row) => row.data.from === 'link')
          ? pass('子页面可读并已记录')
          : fail(summarize(read))
      })
  },
}

export const editorGroup: CaseGroup = {
  site: 'editor',
  title: '富文本编辑器',
  async run(ctx) {
    const run = await ctx.run('editor')
    await run.open(ctx.url('/editor/'))
    await ctx.check('type-title', '标题输入框输入并回读', ['browser_type'], async () => {
      const title = await target(run, '标题', { purpose: 'input' })
      const typed = await run.call('browser_type', { target_id: title.targetId, text: '维护公告' })
      return delivered(typed) ? pass('delivered') : fail(summarize(typed, 400))
    })
    await ctx.check('type-contenteditable', '向 contenteditable 正文输入并回读', ['browser_type'], async () => {
      const editor = await target(run, '正文编辑器', { purpose: 'input' })
      const typed = await run.call('browser_type', { target_id: editor.targetId, text: '停机维护通知' })
      const text = await run.pageEval<string>("return document.querySelector('#editor')?.textContent ?? null")
      const journal = journalAgrees(run, typed)
      return delivered(typed) && String(text).includes('停机维护通知') && journal.ok
        ? pass(`delivered，${journal.detail}`)
        : fail(`text=${String(text)} ${summarize(typed, 400)} journal=${journal.detail}`)
    })
    await ctx.check('shortcut-save', '快捷键保存（Meta+S）', ['browser_press_key'], async () => {
      const before = await run.probe()
      const pressed = await run.call('browser_press_key', { key: 's', modifiers: ['meta'] })
      return keyboardOutcome(run, pressed, before, async () => {
        const rows = await waitForRecord(run, 'editor.save', 1, 3_000)
        return rows.length > 0 ? pass('editor.save 已记录') : fail('按键送达但没有保存记录')
      })
    })
    await ctx.check('save-button-pointer', '保存按钮在后台点不了', ['browser_click'], async () => {
      const save = await target(run, '保存', { role: 'button' })
      const before = await run.probe()
      return pointerRefused(run, await run.call('browser_click', { target_id: save.targetId }), before)
    })
  },
}

export const canvasGroup: CaseGroup = {
  site: 'canvas',
  title: 'canvas 应用',
  async run(ctx) {
    const run = await ctx.run('canvas')
    await run.open(ctx.url('/canvas/'))
    await ctx.check(
      'snapshot-canvas',
      '快照里能看到画布（座位只在像素里）',
      ['browser_snapshot'],
      async () => {
        const result = await run.call('browser_snapshot', {})
        const targets = snapshotTargets(result)
        const seats = targets.filter((item) => /^[A-H][1-5]$/.test(item.name))
        const canvas = targets.some((item) => item.name.includes('选座画布'))
        if (seats.length > 0) return fail(`座位不该出现在结构里：${seats.length}`)
        if (canvas) return pass('画布可见、座位只在像素里（需要截图定位）')
        return gap(
          '快照里没有画布元素（tabindex + aria-label 的 canvas 也不收），'
            + `助手只能靠截图坐标；看到：${targetSummary(targets)
          }（§4.6 带编号截图）`
        )
      })
    await ctx.check('screenshot', '截图返回真实图像', ['browser_screenshot'], async () => {
      const shot = await run.call('browser_screenshot', {})
      if (shot.hasImage) return pass('有图像')
      if (/display surface not available|not available for capture/i.test(shot.text))
        return unavailable('隐藏窗口下截图不可用（Current display surface not available for capture）')
      return fail(summarize(shot))
    })
    await ctx.check(
      'keyboard-select',
      '键盘选座（→ → ↓ ↓ 回车 = C3）',
      ['browser_press_key'],
      async () => {
        const before = await run.probe()
        const pressed = await run.call('browser_press_key', { key: 'ArrowRight' })
        return keyboardOutcome(run, pressed, before, async () => {
          for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'Enter'])
            await run.call('browser_press_key', { key })
          const rows = await waitForRecord(run, 'canvas.select', 1, 3_000)
          return rows[0]?.data.seat === 'C3' ? pass('canvas.select = C3') : fail(`records=${JSON.stringify(rows)}`)
        })
      })
    await ctx.check('pointer-select', '点击选座', ['browser_click'], async () => {
      const before = await run.probe()
      return pointerRefused(run, await run.call('browser_click', { x: 500, y: 500 }), before)
    })
  },
}

export const takeoverGroup: CaseGroup = {
  site: 'takeover',
  title: '接管后不再投递',
  async run(ctx) {
    const run = await ctx.run('takeover')
    await run.open(ctx.url('/form/'))
    let nameRef = ''
    await ctx.check('before-takeover', '接管前输入正常', ['browser_type'], async () => {
      const name = await target(run, '姓名', { purpose: 'input' })
      nameRef = name.targetId
      const typed = await run.call('browser_type', { target_id: name.targetId, text: '接管前' })
      return delivered(typed) ? pass('delivered') : fail(summarize(typed, 400))
    })
    await ctx.check(
      'takeover-fences-writes',
      '用户接管后：输入、填表、提交全部零投递',
      ['browser_type', 'browser_fill_form'],
      async () => {
        const interruption = await run.controller.requestAgentInterruption(run.tabId)
        const claims = getBrowserTargetClaimService()
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline
          && claims.read({ partition: partitionForBrowserProfile(null), tabId: run.tabId })?.state !== 'user_owned') {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const state = claims.read({ partition: partitionForBrowserProfile(null), tabId: run.tabId })?.state
        const before = await run.probe()
        const typed = await run.call('browser_type', { target_id: nameRef, text: '接管后' })
        const filled = await run.call(
          'browser_fill_form',
          { fields: [{ selector: '#message', value: '接管后' }], submit: true }
        )
        await new Promise((resolve) => setTimeout(resolve, 500))
        const after = await run.probe()
        const inputs = (after?.counts.input ?? 0) - (before?.counts.input ?? 0)
        const value = await run.pageEval<string>("return document.querySelector('#name')?.value ?? null")
        const submits = ctx.server.records('form.submit').length
        if (state === 'user_owned' && typed.data.ok === false && filled.data.ok === false && inputs === 0
          && value === '接管前'
          && submits === 0) {
          return pass(
            `claim=user_owned；type=${String(errorKind(typed))
            }，fill=${String(errorKind(filled))
            }；页面零输入、零提交`,
            { frozen: interruption?.frozen }
          )
        }
        return fail(
          `claim=${String(state)
          } type.ok=${String(typed.data.ok)
          } fill.ok=${String(filled.data.ok)
          } inputs=${inputs
          } value=${String(value)
          } submits=${submits
          }`
        )
      })
  },
}
