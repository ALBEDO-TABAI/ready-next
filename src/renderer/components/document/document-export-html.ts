/**
 * Pure DOM/string helpers for document export capture (PDF path).
 *
 * Split out of `document-export-capture.tsx` so behavior tests can exercise
 * the DOM transform and HTML assembly under JSDOM without the capture
 * module's Vite-only `?raw` style imports or the live NotePreview render.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** youtube.com/embed/<id> → watch URL; player.bilibili.com → video page. */
export function deriveWatchUrlFromEmbedSrc(src: string): string | null {
  const youtubeMatch = src.match(/(?:youtube\.com|youtube-nocookie\.com)\/embed\/([\w-]{6,})/i)
  if (youtubeMatch) return `https://www.youtube.com/watch?v=${youtubeMatch[1]}`
  const bilibiliMatch = src.match(/player\.bilibili\.com\/player\.html\?([^"']*)/i)
  if (bilibiliMatch) {
    const bvid = new URLSearchParams(bilibiliMatch[1]).get('bvid')
    if (bvid) return `https://www.bilibili.com/video/${bvid}`
  }
  return null
}

function describeLocalMediaSrc(src: string): string {
  let candidate = src
  const localMatch = src.match(/^(?:local-file|file):\/\/(.*)$/i)
  if (localMatch) candidate = localMatch[1]
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // silent-catch: keep the raw form — a display label must never fail the export
  }
  const name = candidate.split(/[/\\]/).filter(Boolean).pop() || ''
  return name || '本地视频'
}

/**
 * Rewrite the cloned preview DOM into a print-appropriate static document:
 * strip interactive chrome, expand collapsed sections, replace live embeds
 * (site players / videos) with durable placeholders, and force images to
 * load eagerly so the hidden print window rasterizes everything.
 */
export function transformPreviewDomForExport(root: HTMLElement): void {
  const doc = root.ownerDocument

  root
    .querySelectorAll(
      '.note-preview-code-copy-button, .note-preview-repair-button, .ready-doc-widget-card-actions, .document-widget-fallback-shell button',
    )
    .forEach((node) => node.remove())

  // A reading artifact shows everything — expand collapsed sections.
  root.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''))

  root.querySelectorAll('img').forEach((img) => {
    img.setAttribute('loading', 'eager')
    img.setAttribute('decoding', 'sync')
  })

  // Site players cannot live inside a PDF — swap in a durable link.
  root.querySelectorAll('iframe.note-preview-youtube-iframe').forEach((iframe) => {
    const src = iframe.getAttribute('src') || ''
    const watchUrl = deriveWatchUrlFromEmbedSrc(src) || src
    const link = doc.createElement('a')
    link.className = 'ready-export-embed-link'
    link.href = watchUrl
    link.textContent = `▶ 在浏览器中观看：${watchUrl}`
    iframe.replaceWith(link)
  })

  root.querySelectorAll('video').forEach((video) => {
    const placeholder = doc.createElement('div')
    placeholder.className = 'ready-export-video-placeholder'
    placeholder.textContent = `视频文件：${describeLocalMediaSrc(video.getAttribute('src') || '')}`
    video.replaceWith(placeholder)
  })
}

/**
 * Collect the app's live CSS text. Same-origin sheets expose cssRules; any
 * sheet that refuses (cross-origin) is skipped — the raw base imports keep
 * the reading surface covered in that case.
 */
export function collectLiveStyleSheetText(sourceDocument: Document): string {
  const chunks: string[] = []
  for (const sheet of Array.from(sourceDocument.styleSheets)) {
    try {
      const rules = sheet.cssRules
      chunks.push(Array.from(rules).map((rule) => rule.cssText).join('\n'))
    } catch {
      // silent-catch: inaccessible stylesheet (cross-origin) — raw base CSS covers the gap.
    }
  }
  return chunks.join('\n')
}

const EXPORT_PRINT_CSS = `
/* 采集来的应用壳规则（base-chrome.css: html/body/#root height:100% +
   overflow:hidden）会把可打印区域裁成一屏——打印文档必须自上而下自然流动，
   这里最后一层强制还原，!important 盖过任何高特异度的壳规则。 */
html, body {
  margin: 0;
  padding: 0;
  width: auto !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
}
body.ready-document-export-body {
  background: var(--bg-primary, #ffffff);
  color: var(--text-normal, #1f2937);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.ready-document-export-page { max-width: 100%; }
/* 预览壳与正文在应用内是 flex 列 + gap；Chromium 打印对 flex 容器的跨页
   截断不可靠，导出时降级为块布局，用等距 margin 复刻 18px 的 gap 节奏。 */
.ready-document-export-page .note-preview-shell,
.ready-document-export-page .note-preview-body {
  display: block !important;
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
}
.ready-document-export-page .note-preview-shell > * + *,
.ready-document-export-page .note-preview-body > * + * {
  margin-top: 18px;
}
.ready-document-export-page .note-preview-shell { padding: 0; max-width: none; }
/* 分页策略：文本类容器（代码块/widget 卡/折叠段/属性区）允许自然跨页——
   对它们强行整块，中等高度的块放不进当页剩余空间就被整体推页，实测会把
   上一页压出大片留白。只有真正原子的媒体保持整块，并钳进单页可用高度
   （A4 除边距 ≈ 1010px），避免独占整页或被跨页切片。 */
.note-preview-mermaid, figure.note-preview-media-block,
.note-preview-markdown-table tr, img {
  break-inside: avoid;
  page-break-inside: avoid;
}
.note-preview-markdown-h1, .note-preview-markdown-h2,
.note-preview-markdown-h3, .note-preview-markdown-h4,
.document-widget-title {
  break-after: avoid;
  page-break-after: avoid;
}
.note-preview-markdown-p, .note-preview-markdown-li {
  orphans: 2;
  widows: 2;
}
.note-preview-table-scroll { overflow: visible; }
.note-preview-markdown-pre { white-space: pre-wrap; word-break: break-word; overflow: visible; }
.note-preview-markdown-code { word-break: break-word; }
/* 媒体单页钳制取 560px（纸面 ≈ 14.8cm，usable 高度的 55%）：图片/图表
   保持整块不被切片的前提下，"导读 + 大图"这类典型开篇也能同页共存——
   钳制越高，放不进当页剩余空间被整块推页产生的留白越大（实测 1600²
   结构图在 720 钳制下仍会把首页压出 2/3 空白）。 */
.note-preview-image { max-width: 100%; height: auto; max-height: 560px; }
.note-preview-mermaid svg { max-width: 100%; height: auto; max-height: 560px; }
iframe.document-widget-frame { max-height: 900px; }
.ready-export-video-placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border: 1px dashed var(--border-light, rgba(0, 0, 0, 0.16));
  border-radius: 12px;
  color: var(--text-muted, #6b7280);
  font-size: 13px;
}
.ready-export-embed-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 120px;
  padding: 16px;
  color: var(--color-blue, #2563eb);
  font-size: 13px;
  word-break: break-all;
}
`

export interface ExportHtmlDocumentParts {
  title: string
  bodyHtml: string
  /** Raw insurance CSS (theme tokens + markdown surface), applied first. */
  baseCss: string
  /** Live CSSOM snapshot, wins over baseCss at equal specificity. */
  collectedCss: string
  /** Mirror the live theme so page chrome and widget srcdoc stay consistent. */
  darkTheme: boolean
}

export function buildExportHtmlDocument(parts: ExportHtmlDocumentParts): string {
  const themeAttr = parts.darkTheme ? ' data-theme="dark"' : ''
  return `<!doctype html>
<html lang="zh-CN"${themeAttr}>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(parts.title)}</title>
<style>${parts.baseCss}</style>
<style>${parts.collectedCss}</style>
<style>${EXPORT_PRINT_CSS}</style>
</head>
<body class="ready-document-export-body">
<main class="ready-document-export-page">
${parts.bodyHtml}
</main>
</body>
</html>`
}
