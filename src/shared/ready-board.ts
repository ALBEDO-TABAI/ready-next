export const READY_BOARD_FILE_SUFFIX = '.readyboard'
export const READY_BOARD_ENGINE_VERSION = '1.0.0'
export const READY_BOARD_STATE_SCRIPT_ID = 'ready-board-state'
export const READY_BOARD_STATE_PLACEHOLDER = '__READY_BOARD_STATE__'

export type ReadyBoardAssetKind = 'image' | 'video' | 'markdown'
export type ReadyBoardNodeType = ReadyBoardAssetKind | 'text' | 'rect' | 'note' | 'arrow' | 'path'

export interface ReadyBoardViewport {
  x: number
  y: number
  zoom: number
}

export interface ReadyBoardBaseNode {
  id: string
  type: ReadyBoardNodeType
  x: number
  y: number
  width: number
  height: number
  rotation?: number
}

export interface ReadyBoardImageNode extends ReadyBoardBaseNode {
  type: 'image'
  src: string
  title?: string
  alt?: string
}

export interface ReadyBoardVideoNode extends ReadyBoardBaseNode {
  type: 'video'
  src: string
  title?: string
}

export interface ReadyBoardMarkdownNode extends ReadyBoardBaseNode {
  type: 'markdown'
  src: string
  title: string
  excerpt: string
}

export interface ReadyBoardTextNode extends ReadyBoardBaseNode {
  type: 'text'
  text: string
  fontSize: number
  color: string
}

export interface ReadyBoardRectNode extends ReadyBoardBaseNode {
  type: 'rect'
  fill: string
  stroke: string
}

export interface ReadyBoardNoteNode extends ReadyBoardBaseNode {
  type: 'note'
  text: string
  color: string
  background: string
}

export interface ReadyBoardArrowNode extends ReadyBoardBaseNode {
  type: 'arrow'
  x2: number
  y2: number
  stroke: string
  strokeWidth: number
}

export interface ReadyBoardPathPoint {
  x: number
  y: number
}

export interface ReadyBoardPathNode extends ReadyBoardBaseNode {
  type: 'path'
  points: ReadyBoardPathPoint[]
  stroke: string
  strokeWidth: number
}

export type ReadyBoardNode =
  | ReadyBoardImageNode
  | ReadyBoardVideoNode
  | ReadyBoardMarkdownNode
  | ReadyBoardTextNode
  | ReadyBoardRectNode
  | ReadyBoardNoteNode
  | ReadyBoardArrowNode
  | ReadyBoardPathNode

export interface ReadyBoardState {
  version: 1
  engineVersion: string
  title: string
  viewport: ReadyBoardViewport
  nodes: ReadyBoardNode[]
  updatedAt: string
}

export interface ReadyBoardAsset {
  src: string
  kind: ReadyBoardAssetKind
  name: string
  absPath: string
  size: number
  width?: number
  height?: number
  title?: string
  excerpt?: string
}

export function isReadyBoardFile(path: string | null | undefined): boolean {
  return typeof path === 'string' && /\.readyboard$/i.test(path)
}

export function createEmptyReadyBoardState(title = '画板'): ReadyBoardState {
  return {
    version: 1,
    engineVersion: READY_BOARD_ENGINE_VERSION,
    title,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    updatedAt: new Date(0).toISOString(),
  }
}

export function escapeReadyBoardJson(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<': return '\\u003C'
      case '>': return '\\u003E'
      case '&': return '\\u0026'
      case '\u2028': return '\\u2028'
      case '\u2029': return '\\u2029'
      default: return char
    }
  })
}

export function serializeReadyBoardState(state: ReadyBoardState): string {
  return escapeReadyBoardJson(JSON.stringify(normalizeReadyBoardState(state)))
}

export function createReadyBoardTemplate(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ready Reference Board</title>
  <style>
    :root {
      color-scheme: light dark;
      --board-bg: #f7f6f3;
      --board-text: #181818;
      --board-muted: #696969;
      --board-panel: rgba(255,255,255,.88);
      --board-border: rgba(24,24,24,.14);
      --board-accent: #ff4b2b;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --board-bg: #151515;
        --board-text: #f4f0ea;
        --board-muted: #a8a29a;
        --board-panel: rgba(28,28,28,.88);
        --board-border: rgba(255,255,255,.14);
      }
    }
    html, body, #ready-board-viewer { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--board-bg); color: var(--board-text); }
    #ready-board-viewer { position: relative; background-image: radial-gradient(var(--board-border) 1px, transparent 1px); background-size: 28px 28px; }
    .ready-board-stage { position: absolute; left: 50%; top: 50%; transform-origin: 0 0; }
    .ready-board-node { position: absolute; box-sizing: border-box; border-radius: 8px; overflow: hidden; background: var(--board-panel); border: 1px solid var(--board-border); box-shadow: 0 16px 32px rgba(0,0,0,.12); }
    .ready-board-node img, .ready-board-node video { width: 100%; height: 100%; object-fit: contain; display: block; background: #111; }
    .ready-board-text { padding: 10px 12px; white-space: pre-wrap; overflow: hidden; }
    .ready-board-note { padding: 12px; white-space: pre-wrap; overflow: hidden; }
    .ready-board-markdown { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .ready-board-markdown strong { font-size: 14px; }
    .ready-board-markdown p { margin: 0; color: var(--board-muted); font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
    .ready-board-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--board-muted); font-size: 13px; }
  </style>
</head>
<body>
  <script type="application/json" id="${READY_BOARD_STATE_SCRIPT_ID}">${READY_BOARD_STATE_PLACEHOLDER}</script>
  <div id="ready-board-viewer"></div>
  <script>
    (() => {
      const el = document.getElementById('${READY_BOARD_STATE_SCRIPT_ID}');
      const root = document.getElementById('ready-board-viewer');
      const state = el ? JSON.parse(el.textContent || '{}') : { nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
      document.title = state.title || 'Ready Reference Board';
      const stage = document.createElement('div');
      stage.className = 'ready-board-stage';
      const viewport = state.viewport || { x: 0, y: 0, zoom: 1 };
      stage.style.transform = 'translate(' + (viewport.x || 0) + 'px, ' + (viewport.y || 0) + 'px) scale(' + (viewport.zoom || 1) + ')';
      root.appendChild(stage);
      const esc = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      const nodeStyle = (node) => {
        const style = 'left:' + (node.x || 0) + 'px;top:' + (node.y || 0) + 'px;width:' + (node.width || 180) + 'px;height:' + (node.height || 120) + 'px;';
        return node.rotation ? style + 'transform:rotate(' + node.rotation + 'deg);' : style;
      };
      for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
        const div = document.createElement('div');
        div.className = 'ready-board-node ready-board-' + node.type;
        div.style.cssText = nodeStyle(node);
        if (node.type === 'image') {
          div.innerHTML = '<img src="' + esc(node.src) + '" alt="' + esc(node.alt || node.title || '') + '">';
        } else if (node.type === 'video') {
          div.innerHTML = '<video src="' + esc(node.src) + '" controls></video>';
        } else if (node.type === 'markdown') {
          div.innerHTML = '<div class="ready-board-markdown"><strong>' + esc(node.title) + '</strong><p>' + esc(node.excerpt) + '</p></div>';
        } else if (node.type === 'note') {
          div.style.background = node.background || '#fff4b8';
          div.innerHTML = '<div class="ready-board-note" style="color:' + esc(node.color || '#181818') + '">' + esc(node.text) + '</div>';
        } else if (node.type === 'text') {
          div.style.background = 'transparent';
          div.style.borderColor = 'transparent';
          div.style.boxShadow = 'none';
          div.innerHTML = '<div class="ready-board-text" style="font-size:' + (node.fontSize || 24) + 'px;color:' + esc(node.color || 'var(--board-text)') + '">' + esc(node.text) + '</div>';
        } else if (node.type === 'rect') {
          div.style.background = node.fill || 'rgba(255,75,43,.14)';
          div.style.borderColor = node.stroke || 'var(--board-accent)';
        } else if (node.type === 'arrow') {
          div.style.background = 'transparent';
          div.style.border = 0;
          div.style.boxShadow = 'none';
          div.innerHTML = '<svg width="100%" height="100%" viewBox="0 0 ' + Math.max(node.width || 120, 1) + ' ' + Math.max(node.height || 80, 1) + '"><defs><marker id="m-' + esc(node.id) + '" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="' + esc(node.stroke || '#ff4b2b') + '"/></marker></defs><line x1="0" y1="0" x2="' + esc(node.x2 ?? node.width ?? 120) + '" y2="' + esc(node.y2 ?? node.height ?? 80) + '" stroke="' + esc(node.stroke || '#ff4b2b') + '" stroke-width="' + (node.strokeWidth || 3) + '" marker-end="url(#m-' + esc(node.id) + ')"/></svg>';
        } else if (node.type === 'path') {
          div.style.background = 'transparent';
          div.style.border = 0;
          div.style.boxShadow = 'none';
          const points = Array.isArray(node.points) ? node.points.map((p) => (p.x || 0) + ',' + (p.y || 0)).join(' ') : '';
          div.innerHTML = '<svg width="100%" height="100%" viewBox="0 0 ' + Math.max(node.width || 1, 1) + ' ' + Math.max(node.height || 1, 1) + '"><polyline points="' + esc(points) + '" fill="none" stroke="' + esc(node.stroke || '#ff4b2b') + '" stroke-linecap="round" stroke-linejoin="round" stroke-width="' + (node.strokeWidth || 4) + '"/></svg>';
        }
        stage.appendChild(div);
      }
      if (!stage.children.length) {
        const empty = document.createElement('div');
        empty.className = 'ready-board-empty';
        empty.textContent = 'Ready Reference Board';
        root.appendChild(empty);
      }
    })();
  </script>
</body>
</html>
`
}

export function renderReadyBoardHtmlFromTemplate(template: string, state: ReadyBoardState): string {
  return template.replace(READY_BOARD_STATE_PLACEHOLDER, serializeReadyBoardState(state))
}

export function buildReadyBoardHtml(state: ReadyBoardState): string {
  return renderReadyBoardHtmlFromTemplate(createReadyBoardTemplate(), state)
}

export function extractReadyBoardStateFromHtml(html: string): ReadyBoardState {
  const pattern = new RegExp(`<script[^>]*id=["']${READY_BOARD_STATE_SCRIPT_ID}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i')
  const match = html.match(pattern)
  if (!match) return createEmptyReadyBoardState()
  return normalizeReadyBoardState(JSON.parse(match[1] || '{}'))
}

export function isSafeBoardAssetReference(src: string): boolean {
  if (!src || typeof src !== 'string') return false
  if (!src.startsWith('assets/')) return false
  if (src.includes('\\')) return false
  if (src.split('/').includes('..')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false
  return true
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function textOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeBaseNode(raw: Record<string, unknown>, type: ReadyBoardNodeType): ReadyBoardBaseNode {
  return {
    id: textOr(raw.id, `node-${Math.random().toString(36).slice(2)}`),
    type,
    x: numberOr(raw.x, 0),
    y: numberOr(raw.y, 0),
    width: Math.max(1, numberOr(raw.width, 180)),
    height: Math.max(1, numberOr(raw.height, 120)),
    rotation: numberOr(raw.rotation, 0),
  }
}

export function normalizeReadyBoardState(input: unknown): ReadyBoardState {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const viewportRaw = (raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : {}) as Record<string, unknown>
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.flatMap((candidate): ReadyBoardNode[] => {
        if (!candidate || typeof candidate !== 'object') return []
        const nodeRaw = candidate as Record<string, unknown>
        const type = textOr(nodeRaw.type) as ReadyBoardNodeType
        const base = normalizeBaseNode(nodeRaw, type)
        if (type === 'image') {
          const src = textOr(nodeRaw.src)
          if (!isSafeBoardAssetReference(src)) return []
          return [{ ...base, type, src, title: textOr(nodeRaw.title), alt: textOr(nodeRaw.alt) }]
        }
        if (type === 'video') {
          const src = textOr(nodeRaw.src)
          if (!isSafeBoardAssetReference(src)) return []
          return [{ ...base, type, src, title: textOr(nodeRaw.title) }]
        }
        if (type === 'markdown') {
          const src = textOr(nodeRaw.src)
          if (!isSafeBoardAssetReference(src)) return []
          return [{ ...base, type, src, title: textOr(nodeRaw.title, 'Markdown'), excerpt: textOr(nodeRaw.excerpt) }]
        }
        if (type === 'text') {
          return [{ ...base, type, text: textOr(nodeRaw.text, 'Text'), fontSize: numberOr(nodeRaw.fontSize, 24), color: textOr(nodeRaw.color, '#181818') }]
        }
        if (type === 'rect') {
          return [{ ...base, type, fill: textOr(nodeRaw.fill, 'rgba(255,75,43,.14)'), stroke: textOr(nodeRaw.stroke, '#ff4b2b') }]
        }
        if (type === 'note') {
          return [{ ...base, type, text: textOr(nodeRaw.text, 'Note'), color: textOr(nodeRaw.color, '#181818'), background: textOr(nodeRaw.background, '#fff4b8') }]
        }
        if (type === 'arrow') {
          return [{ ...base, type, x2: numberOr(nodeRaw.x2, base.width), y2: numberOr(nodeRaw.y2, base.height), stroke: textOr(nodeRaw.stroke, '#ff4b2b'), strokeWidth: numberOr(nodeRaw.strokeWidth, 3) }]
        }
        if (type === 'path') {
          const points = Array.isArray(nodeRaw.points)
            ? nodeRaw.points.flatMap((point): ReadyBoardPathPoint[] => {
                if (!point || typeof point !== 'object') return []
                const rawPoint = point as Record<string, unknown>
                return [{ x: numberOr(rawPoint.x, 0), y: numberOr(rawPoint.y, 0) }]
              })
            : []
          return [{ ...base, type, points, stroke: textOr(nodeRaw.stroke, '#ff4b2b'), strokeWidth: numberOr(nodeRaw.strokeWidth, 4) }]
        }
        return []
      })
    : []

  return {
    version: 1,
    engineVersion: textOr(raw.engineVersion, READY_BOARD_ENGINE_VERSION),
    title: textOr(raw.title, '画板'),
    viewport: {
      x: numberOr(viewportRaw.x, 0),
      y: numberOr(viewportRaw.y, 0),
      zoom: Math.max(0.1, Math.min(4, numberOr(viewportRaw.zoom, 1))),
    },
    nodes,
    updatedAt: textOr(raw.updatedAt, new Date(0).toISOString()),
  }
}
