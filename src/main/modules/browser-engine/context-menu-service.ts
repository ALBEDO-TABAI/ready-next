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
import {
  type BrowserFastCardContextAction,
  type BrowserFastCardContextActionEvent,
  type BrowserFastCardImageTarget,
  type BrowserFastCardTarget,
  type BrowserFastCardTextTarget,
  type BrowserFastCardVideoTarget,
  extractFastCardDomain,
} from '../../../shared/fastcard'

interface BrowserContextMenuHost {
  mainWindow: BrowserWindow
  isAllowedUrl(url: string): boolean
  createTab(url: string, options?: { background?: boolean; openerTabId?: string | null }): Promise<{ success: boolean; tabId?: string; error?: string }>
  addImageToActiveBoard(url: string): Promise<unknown>
  getTabIdForWebContents(webContents: WebContents): string | null
  sendToRenderer(channel: 'board:activeBoardExternalImageAdded' | 'browser:fastCardContextAction', data: unknown): void
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

interface ElementFastCardMetadata {
  imageUrl?: string
  imageAlt?: string
  caption?: string
  videoUrl?: string
  posterUrl?: string
  videoTitle?: string
  sources?: string[]
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
            void this.host.createTab(linkUrl, { background: true, openerTabId: this.host.getTabIdForWebContents(webContents) }).catch((error) => {
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
          label: '反推描述',
          click: () => this.emitFastCardAction(webContents, params, 'describe-image', 'image'),
        },
        {
          label: '添加到 FastCard',
          click: () => this.emitFastCardAction(webContents, params, 'add-to-fastcard', 'image'),
        },
        {
          label: '添加到画板…',
          click: () => this.emitFastCardAction(webContents, params, 'save-to-canvas', 'image'),
        },
        {
          label: '在新标签页打开图片',
          click: () => {
            void this.host.createTab(imageUrl, { background: true, openerTabId: this.host.getTabIdForWebContents(webContents) }).catch((error) => {
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

    const selectedText = String(params.selectionText || '').trim()
    if (selectedText) {
      pushSeparator()
      template.push(
        {
          label: '翻译',
          click: () => this.emitFastCardAction(webContents, params, 'translate-selection', 'text'),
        },
        {
          label: '添加到 FastCard',
          click: () => this.emitFastCardAction(webContents, params, 'add-to-fastcard', 'text'),
        },
        { label: '添加到画板…', click: () => this.emitFastCardAction(webContents, params, 'save-to-canvas', 'text') },
      )
    }

    const hasVideo = params.mediaType === 'video'
    if (hasVideo) {
      pushSeparator()
      template.push({
        label: '添加到 FastCard',
        click: () => this.emitFastCardAction(webContents, params, 'add-to-fastcard', 'video'),
      })
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

  private async readElementMetadata(webContents: WebContents, params: ContextMenuParams): Promise<ElementFastCardMetadata> {
    const x = Number.isFinite(params.x) ? params.x : 0
    const y = Number.isFinite(params.y) ? params.y : 0
    const code = `(() => {
      const x = ${JSON.stringify(x)};
      const y = ${JSON.stringify(y)};
      const absolutize = (value) => {
        if (!value) return '';
        if (/^(data:|blob:|https?:)/i.test(value)) return value;
        try { return new URL(value, document.baseURI).href; } catch { return String(value || ''); }
      };
      const closest = (node, tag) => {
        let current = node;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          if (current.tagName && current.tagName.toLowerCase() === tag) return current;
          current = current.parentElement;
        }
        return null;
      };
      const element = document.elementFromPoint(x, y);
      const img = closest(element, 'img');
      const video = closest(element, 'video');
      const figure = element?.closest?.('figure');
      const caption = figure?.querySelector?.('figcaption')?.textContent?.trim?.() || '';
      return {
        imageUrl: img ? absolutize(img.currentSrc || img.src || img.getAttribute('src') || '') : '',
        imageAlt: img ? (img.alt || img.getAttribute('aria-label') || '') : '',
        caption,
        videoUrl: video ? absolutize(video.currentSrc || video.src || video.getAttribute('src') || '') : '',
        posterUrl: video ? absolutize(video.poster || video.getAttribute('poster') || '') : '',
        videoTitle: video ? (video.title || video.getAttribute('aria-label') || document.title || '') : '',
        sources: video ? Array.from(video.querySelectorAll('source')).map((source) => absolutize(source.currentSrc || source.src || source.getAttribute('src') || '')).filter(Boolean) : [],
      };
    })()`
    try {
      const result = await webContents.executeJavaScript(code, true)
      return result && typeof result === 'object' ? result as ElementFastCardMetadata : {}
    } catch (error) {
      this.host.logBrowserDiag(`[browser-v3][context] fastcard element read failed: ${String(error)}`)
      return {}
    }
  }

  private getSource(webContents: WebContents) {
    const pageUrl = webContents.getURL()
    return {
      pageUrl,
      pageTitle: webContents.getTitle(),
      domain: extractFastCardDomain(pageUrl),
      tabId: this.host.getTabIdForWebContents(webContents),
      capturedAt: Date.now(),
    }
  }

  private async resolveFastCardTarget(
    webContents: WebContents,
    params: ContextMenuParams,
    action: BrowserFastCardContextAction,
    preferredKind?: BrowserFastCardTarget['kind'],
  ): Promise<BrowserFastCardTarget | null> {
    const source = this.getSource(webContents)
    const selectedText = String(params.selectionText || '').trim()
    if ((preferredKind === 'text' || action === 'translate-selection' || (action === 'add-to-fastcard' && !preferredKind && selectedText)) && selectedText) {
      return { ...source, kind: 'text', text: selectedText } satisfies BrowserFastCardTextTarget
    }

    const metadata = await this.readElementMetadata(webContents, params)
    const fallbackSrc = String(params.srcURL || '').trim()
    if ((preferredKind === 'image' || action === 'describe-image' || params.mediaType === 'image' || params.hasImageContents) && (metadata.imageUrl || fallbackSrc)) {
      return {
        ...source,
        kind: 'image',
        imageUrl: metadata.imageUrl || fallbackSrc,
        alt: metadata.imageAlt,
        caption: metadata.caption,
      } satisfies BrowserFastCardImageTarget
    }

    if (preferredKind === 'video' || params.mediaType === 'video' || metadata.videoUrl || metadata.sources?.length) {
      return {
        ...source,
        kind: 'video',
        videoUrl: metadata.videoUrl || fallbackSrc || undefined,
        posterUrl: metadata.posterUrl,
        title: metadata.videoTitle,
        sources: metadata.sources,
      } satisfies BrowserFastCardVideoTarget
    }

    return null
  }

  private emitFastCardAction(
    webContents: WebContents,
    params: ContextMenuParams,
    action: BrowserFastCardContextAction,
    preferredKind?: BrowserFastCardTarget['kind'],
  ): void {
    void (async () => {
      const target = await this.resolveFastCardTarget(webContents, params, action, preferredKind)
      if (!target) return
      const payload: BrowserFastCardContextActionEvent = { action, target }
      this.host.sendToRenderer('browser:fastCardContextAction', payload)
    })().catch((error) => {
      this.host.logBrowserDiag(`[browser-v3][context] fastcard action failed: ${String(error)}`)
    })
  }
}
