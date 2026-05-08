const READY_BROWSER_BLANK_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>New Tab</title>
  <style>
    :root {
      color-scheme: light dark;
      background: #f4f2ee;
    }
    html,
    body {
      margin: 0;
      width: 100%;
      min-height: 100%;
      background:
        radial-gradient(circle at 18% 12%, rgba(255,255,255,0.78), transparent 34rem),
        linear-gradient(135deg, #f7f5f1 0%, #ece9e2 100%);
    }
  </style>
</head>
<body></body>
</html>`

export const READY_BROWSER_BLANK_URL = `data:text/html;charset=utf-8,${encodeURIComponent(READY_BROWSER_BLANK_HTML)}`
export const DEFAULT_BROWSER_URL = READY_BROWSER_BLANK_URL

export function isReadyBrowserBlankUrl(url: string): boolean {
  return String(url || '') === READY_BROWSER_BLANK_URL
}
