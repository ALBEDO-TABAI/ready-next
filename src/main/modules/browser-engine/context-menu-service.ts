import {
  clipboard,
  dialog,
  Menu,
  shell,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'

interface BrowserContextMenuHost {
  mainWindow: BrowserWindow
  isAllowedUrl(url: string): boolean
  createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }>
  logBrowserDiag(message: string): void
}

function replaceIllegalFilenameChars(value: string): string {
  let next = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    next += code <= 31 || '<>:"/\\|?*'.includes(char) ? '-' : char
  }
  return next
}

export class BrowserContextMenuService {
  constructor(private readonly host: BrowserContextMenuHost) {}

  setMainWindow(mainWindow: BrowserWindow): void {
    this.host.mainWindow = mainWindow
  }

  install(webContents: WebContents): void {
    webContents.on('context-menu', (_event, params) => {
      try {
        const template = this.build(webContents, params)
        if (!template.length) return
        const menu = Menu.buildFromTemplate(template)
        menu.popup({ window: this.host.mainWindow })
      } catch (error) {
        this.host.logBrowserDiag(`[browser-v3][context] build menu failed: ${String(error)}`)
      }
    })
  }

  private build(webContents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
    const template: MenuItemConstructorOptions[] = []
    const pushSeparator = () => {
      if (template.length === 0) return
      if (template[template.length - 1].type === 'separator') return
      template.push({ type: 'separator' })
    }

    template.push(
      {
        label: '后退',
        enabled: webContents.navigationHistory.canGoBack(),
        click: () => {
          if (webContents.navigationHistory.canGoBack()) webContents.navigationHistory.goBack()
        },
      },
      {
        label: '前进',
        enabled: webContents.navigationHistory.canGoForward(),
        click: () => {
          if (webContents.navigationHistory.canGoForward()) webContents.navigationHistory.goForward()
        },
      },
      {
        label: '刷新',
        click: () => webContents.reload(),
      },
      {
        label: '强制刷新（忽略缓存）',
        click: () => webContents.reloadIgnoringCache(),
      },
    )

    pushSeparator()
    template.push(
      { label: '实际大小', click: () => webContents.setZoomFactor(1) },
      { label: '放大', click: () => webContents.setZoomFactor(Math.min(3, webContents.getZoomFactor() + 0.1)) },
      { label: '缩小', click: () => webContents.setZoomFactor(Math.max(0.25, webContents.getZoomFactor() - 0.1)) },
    )

    const linkUrl = String(params.linkURL || '').trim()
    if (linkUrl && this.host.isAllowedUrl(linkUrl)) {
      pushSeparator()
      template.push(
        {
          label: '在新标签页打开链接',
          click: () => {
            void this.host.createTab(linkUrl).catch((error) => {
              this.host.logBrowserDiag(`[browser-v3][context] open link in tab failed: ${String(error)}`)
            })
          },
        },
        { label: '在外部浏览器打开链接', click: () => { void shell.openExternal(linkUrl) } },
        { label: '复制链接地址', click: () => clipboard.writeText(linkUrl) },
        {
          label: '下载链接',
          click: () => {
            try {
              webContents.downloadURL(linkUrl)
            } catch (error) {
              this.host.logBrowserDiag(`[browser-v3][context] download link failed: ${String(error)}`)
            }
          },
        },
      )
    }

    const imageUrl = String(params.srcURL || '').trim()
    const hasImage = params.mediaType === 'image' || params.hasImageContents
    if (hasImage && imageUrl) {
      pushSeparator()
      template.push(
        {
          label: '在新标签页打开图片',
          click: () => {
            void this.host.createTab(imageUrl).catch((error) => {
              this.host.logBrowserDiag(`[browser-v3][context] open image in tab failed: ${String(error)}`)
            })
          },
        },
        { label: '复制图片地址', click: () => clipboard.writeText(imageUrl) },
        {
          label: '复制图片',
          click: () => {
            try {
              webContents.copyImageAt(params.x, params.y)
            } catch (error) {
              this.host.logBrowserDiag(`[browser-v3][context] copy image failed: ${String(error)}`)
            }
          },
        },
        {
          label: '下载图片',
          click: () => {
            try {
              webContents.downloadURL(imageUrl)
            } catch (error) {
              this.host.logBrowserDiag(`[browser-v3][context] download image failed: ${String(error)}`)
            }
          },
        },
        { label: '在外部浏览器打开图片', click: () => { void shell.openExternal(imageUrl) } },
      )
    }

    pushSeparator()
    template.push(
      { label: '复制页面地址', click: () => clipboard.writeText(webContents.getURL()) },
      {
        label: '查看网页源代码',
        click: () => {
          const url = webContents.getURL()
          if (!this.host.isAllowedUrl(url)) return
          void shell.openExternal(`view-source:${url}`)
        },
      },
      {
        label: '网页另存为…',
        click: () => {
          void (async () => {
            try {
              const defaultName = replaceIllegalFilenameChars(webContents.getTitle() || '网页内容').slice(0, 64)
              const result = await dialog.showSaveDialog(this.host.mainWindow, {
                title: '保存网页',
                defaultPath: `${defaultName || '网页内容'}.html`,
                filters: [
                  { name: '网页文件', extensions: ['html', 'htm'] },
                  { name: '全部文件', extensions: ['*'] },
                ],
              })
              if (result.canceled || !result.filePath) return
              await webContents.savePage(result.filePath, 'HTMLComplete')
            } catch (error) {
              this.host.logBrowserDiag(`[browser-v3][context] save page failed: ${String(error)}`)
            }
          })()
        },
      },
      { label: '打印…', click: () => webContents.print() },
    )

    pushSeparator()
    template.push(
      {
        label: '剪切',
        click: () => {
          try { webContents.cut() } catch (error) {
            this.host.logBrowserDiag(`[browser-v3][context] cut failed: ${String(error)}`)
          }
        },
        enabled: Boolean(params.editFlags?.canCut),
      },
      {
        label: '复制',
        click: () => {
          try { webContents.copy() } catch (error) {
            this.host.logBrowserDiag(`[browser-v3][context] copy failed: ${String(error)}`)
          }
        },
        enabled: Boolean(params.editFlags?.canCopy || (params.selectionText && params.selectionText.length > 0)),
      },
      {
        label: '粘贴',
        click: () => {
          try { webContents.paste() } catch (error) {
            this.host.logBrowserDiag(`[browser-v3][context] paste failed: ${String(error)}`)
          }
        },
        enabled: Boolean(params.editFlags?.canPaste),
      },
      {
        label: '全选',
        click: () => {
          try { webContents.selectAll() } catch (error) {
            this.host.logBrowserDiag(`[browser-v3][context] selectAll failed: ${String(error)}`)
          }
        },
      },
    )

    pushSeparator()
    template.push(
      {
        label: '检查元素',
        click: () => {
          webContents.openDevTools({ mode: 'detach' })
          webContents.inspectElement(params.x, params.y)
        },
      },
      {
        label: '打开开发者工具',
        click: () => webContents.openDevTools({ mode: 'detach' }),
      },
    )

    return template
  }
}
