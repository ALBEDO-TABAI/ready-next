const READY_BROWSER_BLANK_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>New Tab</title>
  <style>
    :root {
      color-scheme: light dark;
      --ready-blank-surface: #eff2f6;
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

export function isReadyBrowserBlankUrl(url: string): boolean {
  return String(url || '') === READY_BROWSER_BLANK_URL
}
