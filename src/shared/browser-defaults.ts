const READY_BROWSER_BLANK_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>New Tab</title>
  <style>
    :root {
      color-scheme: light dark;
      --ready-blank-surface: #e8e8e9;
      background: var(--ready-blank-surface);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --ready-blank-surface: #24282e;
      }
    }

    html,
    body {
      margin: 0;
      width: 100%;
      height: 100%;
      min-height: 100%;
      background: var(--ready-blank-surface);
    }

    body { overflow: hidden; }
  </style>
</head>
<body></body>
</html>`

export const READY_BROWSER_BLANK_URL = `data:text/html;charset=utf-8,${encodeURIComponent(READY_BROWSER_BLANK_HTML)}`
export const DEFAULT_BROWSER_URL = READY_BROWSER_BLANK_URL

const READY_BROWSER_BLANK_PREFIX = 'data:text/html;charset=utf-8,'
const READY_BROWSER_BLANK_SIGNATURE = normalizeReadyBlankHtml(READY_BROWSER_BLANK_HTML)

function normalizeReadyBlankHtml(html: string): string {
  return html.replace(/--ready-blank-surface:\s*#[0-9a-f]{6};/gi, '--ready-blank-surface: <surface>;')
}

export function isReadyBrowserBlankUrl(url: string): boolean {
  const value = String(url || '')
  if (value === READY_BROWSER_BLANK_URL) return true
  if (!value.startsWith(READY_BROWSER_BLANK_PREFIX)) return false
  try {
    return normalizeReadyBlankHtml(decodeURIComponent(value.slice(READY_BROWSER_BLANK_PREFIX.length))) === READY_BROWSER_BLANK_SIGNATURE
  } catch {
    return false
  }
}
