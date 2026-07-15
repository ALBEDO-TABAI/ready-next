import readyWordmarkSvg from '../renderer/assets/ready-wordmark.svg?raw'
import { createReadyLogoDotPattern, type ReadyLogoDot } from '../shared/ready-logo-dots'

type StartupSplashVariant = 'orange' | 'pink'

const GRID_ROWS = 8
const GRID_COLUMNS = 37
const MATRIX_ROW_STEP = 137
const MATRIX_COLUMN_STEP = 139
const MATRIX_DOT_RADIUS = 52
const MATRIX_X_START = 75
const MATRIX_Y_START = 75
const LOGO_X_OFFSET = MATRIX_COLUMN_STEP * 4
const LOGO_Y_OFFSET = MATRIX_ROW_STEP
const MATRIX_WIDTH = 5160
const MATRIX_HEIGHT = 1109
const READY_LOGO_PATTERN = createReadyLogoDotPattern(readyWordmarkSvg, {
  xOffset: LOGO_X_OFFSET,
  yOffset: LOGO_Y_OFFSET,
  matrixXStart: MATRIX_X_START,
  matrixColumnStep: MATRIX_COLUMN_STEP,
})

// 动画节奏（与旧 rAF 版语义对齐）：揭幕 680ms、扫描每列 86ms、
// 收尾 logo 聚合 980ms + 定格 460ms + 退场 280ms（退场由主进程整窗渐隐承担）。
const BACKDROP_REVEAL_MS = 680
const LOGO_COLUMN_MS = 86
const LOGO_COMPLETE_MS = 980
const BACKDROP_FADE_DELAY_MS = 240
const BACKDROP_FADE_MS = 560
const FINAL_LOGO_HOLD_MS = 460
const CARD_EXIT_MS = 280
const EXIT_TOTAL_MS = LOGO_COMPLETE_MS + FINAL_LOGO_HOLD_MS + CARD_EXIT_MS

const VARIANT_COLORS: Record<StartupSplashVariant, { logo: string; glow: string }> = {
  orange: {
    logo: '#FF4B2B',
    glow: 'rgba(255, 75, 43, 0.18)'
  },
  pink: {
    logo: '#F366AD',
    glow: 'rgba(243, 102, 173, 0.22)'
  }
}

interface LogoColumn {
  index: number
  dots: ReadyLogoDot[]
  minX: number
  minY: number
  width: number
  height: number
}

const LOGO_COLUMNS: LogoColumn[] = (() => {
  const byIndex = new Map<number, ReadyLogoDot[]>()
  for (const dot of READY_LOGO_PATTERN.dots) {
    const bucket = byIndex.get(dot.columnIndex)
    if (bucket) {
      bucket.push(dot)
    } else {
      byIndex.set(dot.columnIndex, [dot])
    }
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, dots]) => {
      const minX = Math.min(...dots.map((dot) => dot.x - dot.r))
      const maxX = Math.max(...dots.map((dot) => dot.x + dot.r))
      const minY = Math.min(...dots.map((dot) => dot.y - dot.r))
      const maxY = Math.max(...dots.map((dot) => dot.y + dot.r))
      return { index, dots, minX, minY, width: maxX - minX, height: maxY - minY }
    })
})()

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const pct = (value: number): string => `${(value * 100).toFixed(4)}%`

function renderMatrixCircles(): string {
  const circles: string[] = []
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      circles.push(
        `<circle cx="${MATRIX_X_START + column * MATRIX_COLUMN_STEP}" cy="${MATRIX_Y_START + row * MATRIX_ROW_STEP}" r="${MATRIX_DOT_RADIUS}" fill="currentColor"/>`
      )
    }
  }
  return circles.join('')
}

function renderLogoColumnSvgs(): string {
  const scanPeriodMs = READY_LOGO_PATTERN.columnCount * LOGO_COLUMN_MS
  return LOGO_COLUMNS.map((column) => {
    // 负延迟让所有列一开场就处于各自的循环相位（首帧即第 0 列亮起）。
    const scanDelayMs = -(scanPeriodMs - column.index * LOGO_COLUMN_MS)
    // 收尾聚合按 easeOutCubic 的反函数排布每列点亮时刻，复刻旧版左→右加速收束。
    const buildDelayMs = Math.round(
      LOGO_COMPLETE_MS * (1 - Math.pow(1 - column.index / READY_LOGO_PATTERN.columnCount, 1 / 3))
    )
    const circles = column.dots
      .map((dot) => `<circle cx="${dot.x}" cy="${dot.y}" r="${dot.r}" fill="currentColor"/>`)
      .join('')
    const style = [
      `left:${pct(column.minX / MATRIX_WIDTH)}`,
      `top:${pct(column.minY / MATRIX_HEIGHT)}`,
      `width:${pct(column.width / MATRIX_WIDTH)}`,
      `height:${pct(column.height / MATRIX_HEIGHT)}`,
      `animation-delay:${scanDelayMs}ms`,
      `transition-delay:${buildDelayMs}ms`,
    ].join(';')
    return `<svg class="logo-col" style="${style}" viewBox="${column.minX} ${column.minY} ${column.width} ${column.height}" preserveAspectRatio="none" aria-hidden="true">${circles}</svg>`
  }).join('')
}

export function createStartupSplashDataUrl(variant: StartupSplashVariant): string {
  const colors = VARIANT_COLORS[variant]
  const scanPeriodMs = READY_LOGO_PATTERN.columnCount * LOGO_COLUMN_MS
  const litSlicePct = (100 / READY_LOGO_PATTERN.columnCount).toFixed(4)
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ready — 通用桌面工作台</title>
  <style>
    /* 动画合同：本页所有运动只允许 CSS 合成器可驱动的 opacity/transform
       关键帧与过渡（等价"预渲染播片"）。启动期主进程与本窗 renderer 主线程
       都会被重活挤压，任何逐帧 JS / 触发重排重绘的动画都会肉眼卡顿。 */
    html,
    body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #fff;
    }

    .card {
      position: absolute;
      inset: 0;
      overflow: hidden;
      background: #fff;
    }

    .matrix,
    .logo {
      position: absolute;
      inset: 3% 7%;
    }

    .stage {
      position: absolute;
      inset: 0;
      margin: auto;
      aspect-ratio: ${MATRIX_WIDTH} / ${MATRIX_HEIGHT};
      max-width: 100%;
      max-height: 100%;
    }

    .matrix { color: #dfded9; }

    .matrix-stage svg {
      display: block;
      width: 100%;
      height: 100%;
      opacity: 0.32;
    }

    .matrix-stage {
      overflow: hidden;
      transition: opacity ${BACKDROP_FADE_MS}ms cubic-bezier(0.65, 0, 0.35, 1) ${BACKDROP_FADE_DELAY_MS}ms;
    }

    /* 揭幕：白色软边幕布向右滑出（transform 合成器动画），复刻逐列点亮的观感。 */
    .matrix-veil {
      position: absolute;
      top: -4%;
      bottom: -4%;
      left: 0;
      width: 200%;
      background: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, #fff 8%, #fff 100%);
      transform: translateX(-8%);
      will-change: transform;
      animation: ready-veil-wipe ${BACKDROP_REVEAL_MS}ms cubic-bezier(0.33, 1, 0.68, 1) forwards;
    }

    @keyframes ready-veil-wipe {
      /* 62% × 自身宽(200% stage) = 124% stage 行程：软边(16% stage)恰在动画结束时完全越过右缘 */
      to { transform: translateX(62%); }
    }

    .logo {
      color: ${escapeHtml(colors.logo)};
      filter: drop-shadow(0 0 8px ${escapeHtml(colors.glow)});
    }

    .logo-col {
      position: absolute;
      display: block;
      opacity: 0;
      will-change: opacity;
      animation: ready-logo-scan ${scanPeriodMs}ms linear infinite;
      transition: opacity 160ms cubic-bezier(0.33, 1, 0.68, 1);
    }

    @keyframes ready-logo-scan {
      0% { opacity: 0.9; }
      ${litSlicePct}% { opacity: 0.9; }
      ${(Number(litSlicePct) + 0.01).toFixed(4)}% { opacity: 0; }
      100% { opacity: 0; }
    }

    /* 收尾：扫描停止，各列按预排延迟点亮聚合出完整 logo；点阵背景淡出。 */
    .finishing .logo-col {
      animation: none;
      opacity: 0.96;
    }

    .finishing .matrix-stage {
      opacity: 0;
    }
  </style>
</head>
<body>
  <section class="card" aria-label="Ready loading mark">
    <div class="matrix" aria-hidden="true">
      <div class="stage matrix-stage">
        <svg viewBox="0 0 ${MATRIX_WIDTH} ${MATRIX_HEIGHT}" preserveAspectRatio="xMidYMid meet">${renderMatrixCircles()}</svg>
        <div class="matrix-veil"></div>
      </div>
    </div>
    <div class="logo" aria-hidden="true">
      <div class="stage">${renderLogoColumnSvgs()}</div>
    </div>
  </section>
  <script>
    (() => {
      const EXIT_TOTAL_MS = ${EXIT_TOTAL_MS};
      window.addEventListener('ready-startup-finish', () => {
        if (document.documentElement.classList.contains('finishing')) return;
        document.documentElement.classList.add('finishing');
        // 视觉退场由主进程整窗 setOpacity 渐隐承担；这里只兜底自关闭。
        setTimeout(() => window.close(), EXIT_TOTAL_MS + ${CARD_EXIT_MS});
      });
    })();
  </script>
</body>
</html>`

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
