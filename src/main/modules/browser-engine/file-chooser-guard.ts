/**
 * D16 — agent 驾驶期间的原生文件选择器拦截。
 *
 * 真机第十一轮实锚（XHS 发布页「+」上传）：agent 点击触发 <input type=file>
 * 的原生选择器时，OS 级对话框挂起整个工具环，run 只能死等人来关。合同：
 * agent 持浏览器写租约执行写动作时武装该 tab 的 CDP
 * Page.setInterceptFileChooserDialog；选择器请求被拦截后站点照常等待文件，
 * 模型收到 file_chooser_intercepted 注记并改走
 * browser_list_upload_targets → browser_upload_scope_attachment
 * （DOM.setFileInputFiles，不经原生对话框）。租约离开 held（释放/接管/过期）
 * 时全量解除，用户自己的文件选择器行为不受影响。
 *
 * 模块本身 electron-free：CDP 通道由 BrowserCdpSessionService 注入，普通
 * Node 行为测试可直接实例化。
 */

import type { BrowserCdpSessionService } from './cdp-session-service'
import { recordFileChooserInterceptedNotice } from './browser-permission-policy'

interface BrowserFileChooserGuardDeps {
  cdp: BrowserCdpSessionService
  /** 拦截命中时随注记记录的页面 URL（origin 展示用）。 */
  resolveTabUrl?: (tabId: string) => string
  log?: (message: string) => void
}

interface ArmedTabRecord {
  unsubscribe: () => void
  releasePageDomain: () => Promise<void>
}

export class BrowserFileChooserGuard {
  private readonly armedTabs = new Map<string, ArmedTabRecord>()
  private readonly armingTabs = new Map<string, Promise<void>>()

  constructor(private readonly deps: BrowserFileChooserGuardDeps) {}

  /** 幂等武装：同一 tab 只拦一次；attach 失败（DevTools 冲突等）静默降级。 */
  async arm(tabId: string | null): Promise<void> {
    let resolvedTabId: string
    try {
      const attached = await this.deps.cdp.ensureAttached(tabId)
      resolvedTabId = attached.tabId
    } catch (error) {
      this.deps.log?.(`[browser-v3][file-chooser-guard] attach failed tabId=${String(tabId)}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (this.armedTabs.has(resolvedTabId)) return
    const pending = this.armingTabs.get(resolvedTabId)
    if (pending) return pending
    const arming = this.armTab(resolvedTabId)
    this.armingTabs.set(resolvedTabId, arming)
    try {
      await arming
    } finally {
      this.armingTabs.delete(resolvedTabId)
    }
  }

  private async armTab(tabId: string): Promise<void> {
    try {
      const releasePageDomain = await this.deps.cdp.retainDomain(tabId, 'Page')
      await this.deps.cdp.sendCommand(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true })
      const unsubscribe = this.deps.cdp.subscribe(tabId, (event) => {
        if (event.method !== 'Page.fileChooserOpened') return
        const url = this.deps.resolveTabUrl?.(tabId) || ''
        recordFileChooserInterceptedNotice(tabId, url)
        this.deps.log?.(`[browser-v3][file-chooser-guard] intercepted tabId=${tabId} url=${url}`)
      })
      this.armedTabs.set(tabId, { unsubscribe, releasePageDomain })
      this.deps.log?.(`[browser-v3][file-chooser-guard] armed tabId=${tabId}`)
    } catch (error) {
      this.deps.log?.(`[browser-v3][file-chooser-guard] arm failed tabId=${tabId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 租约离开 held 时调用：解除全部 tab 的拦截，恢复用户原生选择器。 */
  async disarmAll(): Promise<void> {
    const entries = Array.from(this.armedTabs.entries())
    this.armedTabs.clear()
    for (const [tabId, record] of entries) {
      record.unsubscribe()
      try {
        await this.deps.cdp.sendCommand(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false })
      } catch {
        // tab 可能已关闭；解除失败不冒泡（debugger detach 时拦截随之消失）。
      }
      try {
        await record.releasePageDomain()
      } catch {
        // 同上：清理路径不失败调用方。
      }
      this.deps.log?.(`[browser-v3][file-chooser-guard] disarmed tabId=${tabId}`)
    }
  }

  /** Test-only 可见性。 */
  get armedTabIds(): string[] {
    return Array.from(this.armedTabs.keys())
  }
}
