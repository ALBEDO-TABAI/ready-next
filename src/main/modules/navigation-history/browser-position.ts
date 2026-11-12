import type { WebContents } from 'electron'
import { BrowserNavigationPositionSchema, type BrowserNavigationPosition } from '../../../shared/navigation-history'

/** Only fixed scroll scripts, on the user's currently active view. No arbitrary renderer code or background agent tab. */
export function browserNavigationPosition(active: () => { owner?: string; view?: { webContents: WebContents } } | undefined) {
  const view = () => { const tab = active(); return tab?.owner !== 'agent' && tab?.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null }
  return {
    async read(): Promise<BrowserNavigationPosition | null> {
      const contents = view()
      if (!contents || !/^https?:\/\//.test(contents.getURL())) return null
      const result: unknown = await contents.executeJavaScript('({url: location.href, top: Math.max(0, scrollY), left: Math.max(0, scrollX)})')
      return BrowserNavigationPositionSchema.parse(result)
    },
    async restore(input: BrowserNavigationPosition): Promise<void> {
      const position = BrowserNavigationPositionSchema.parse(input), contents = view()
      if (!contents) throw new Error('浏览器页面已变化，无法恢复阅读位置')
      if (contents.isLoadingMainFrame()) await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('浏览器页面加载超时，无法恢复阅读位置')) }, 10000)
        const cleanup = () => { clearTimeout(timeout); contents.removeListener('did-finish-load', finish); contents.removeListener('did-fail-load', fail); contents.removeListener('destroyed', destroyed) }
        const finish = () => { cleanup(); resolve() }
        const fail = (_event: Electron.Event, code: number, description: string, _url: string, main: boolean) => { if (main) { cleanup(); reject(new Error(`${code}: ${description}`)) } }
        const destroyed = () => { cleanup(); reject(new Error('浏览器页面已关闭')) }
        contents.once('did-finish-load', finish); contents.on('did-fail-load', fail); contents.once('destroyed', destroyed)
      })
      if (contents.isDestroyed() || contents.getURL() !== position.url) throw new Error('浏览器页面已变化，无法恢复阅读位置')
      await contents.executeJavaScript(`scrollTo(${position.left}, ${position.top})`)
    },
  }
}
