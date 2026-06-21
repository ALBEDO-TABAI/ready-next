import readyWordmarkSvg from '../renderer/assets/ready-wordmark.svg?raw'
import { createReadyLogoDotPattern } from '../shared/ready-logo-dots'

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function createStartupSplashDataUrl(variant: StartupSplashVariant): string {
  const colors = VARIANT_COLORS[variant]
  const logoDots = JSON.stringify(READY_LOGO_PATTERN.dots)
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ready - 自媒体 AI 工作台</title>
  <style>
    html,
    body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
    }

    body {
      display: grid;
      place-items: center;
    }

    .card {
      position: relative;
      width: min(600px, calc(100vw - 24px));
      aspect-ratio: 3.85 / 1;
      overflow: hidden;
      border: 1px solid rgba(20, 20, 20, 0.045);
      border-radius: clamp(18px, 2.5vw, 26px);
      background: #fff;
      box-shadow:
        0 14px 30px rgba(30, 28, 24, 0.055),
        0 3px 10px rgba(30, 28, 24, 0.025),
        inset 0 1px 0 rgba(255, 255, 255, 0.9);
      opacity: 1;
    }

    .matrix,
    .logo {
      position: absolute;
      inset: 3% 7%;
    }

    .matrix {
      color: #dfded9;
    }

    .logo {
      color: ${escapeHtml(colors.logo)};
      filter: drop-shadow(0 0 8px ${escapeHtml(colors.glow)});
    }

    .matrix svg,
    .logo svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
  </style>
</head>
<body>
  <section class="card" aria-label="Ready loading mark">
    <div class="matrix" aria-hidden="true">
      <svg id="ready-startup-grid" viewBox="0 0 ${MATRIX_WIDTH} ${MATRIX_HEIGHT}" preserveAspectRatio="xMidYMid meet"></svg>
    </div>
    <div class="logo" aria-hidden="true">
      <svg id="ready-startup-logo" viewBox="0 0 ${MATRIX_WIDTH} ${MATRIX_HEIGHT}" preserveAspectRatio="xMidYMid meet"></svg>
    </div>
  </section>
  <script>
    (() => {
      const GRID_ROWS = ${GRID_ROWS};
      const GRID_COLUMNS = ${GRID_COLUMNS};
      const MATRIX_ROW_STEP = ${MATRIX_ROW_STEP};
      const MATRIX_COLUMN_STEP = ${MATRIX_COLUMN_STEP};
      const MATRIX_DOT_RADIUS = ${MATRIX_DOT_RADIUS};
      const MATRIX_X_START = ${MATRIX_X_START};
      const MATRIX_Y_START = ${MATRIX_Y_START};
      const LOGO_DOTS = ${logoDots};
      const LOGO_COLUMN_COUNT = ${READY_LOGO_PATTERN.columnCount};
      const BACKDROP_REVEAL_MS = 680;
      const LOGO_COLUMN_MS = 86;
      const LOGO_COMPLETE_MS = 980;
      const BACKDROP_FADE_DELAY_MS = 240;
      const BACKDROP_FADE_MS = 560;
      const FINAL_LOGO_HOLD_MS = 460;
      const CARD_EXIT_MS = 280;
      const EXIT_TOTAL_MS = LOGO_COMPLETE_MS + FINAL_LOGO_HOLD_MS + CARD_EXIT_MS;

      const clamp01 = value => Math.max(0, Math.min(1, value));
      const easeOutCubic = value => 1 - Math.pow(1 - clamp01(value), 3);
      const easeInOutCubic = value => {
        const t = clamp01(value);
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      };

      const grid = document.getElementById('ready-startup-grid');
      const logo = document.getElementById('ready-startup-logo');
      const card = document.querySelector('.card');
      const matrixDots = [];
      const logoDotElements = [];

      for (let row = 0; row < GRID_ROWS; row += 1) {
        for (let column = 0; column < GRID_COLUMNS; column += 1) {
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', String(MATRIX_X_START + column * MATRIX_COLUMN_STEP));
          circle.setAttribute('cy', String(MATRIX_Y_START + row * MATRIX_ROW_STEP));
          circle.setAttribute('r', String(MATRIX_DOT_RADIUS));
          circle.setAttribute('fill', 'currentColor');
          circle.setAttribute('opacity', '0');
          grid.appendChild(circle);
          matrixDots.push({ column, circle });
        }
      }

      for (const dot of LOGO_DOTS) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(dot.x));
        circle.setAttribute('cy', String(dot.y));
        circle.setAttribute('r', String(dot.r));
        circle.setAttribute('fill', 'currentColor');
        circle.setAttribute('opacity', '0');
        logo.appendChild(circle);
        logoDotElements.push({ columnIndex: dot.columnIndex, circle });
      }

      function resolveBackdropOpacity(finishElapsedMs) {
        if (finishElapsedMs === null) return 1;
        const fadeElapsedMs = Math.max(0, finishElapsedMs - BACKDROP_FADE_DELAY_MS);
        return 1 - easeInOutCubic(fadeElapsedMs / BACKDROP_FADE_MS);
      }

      function resolveLogoDotOpacity(dot, loopElapsedMs, finishElapsedMs) {
        if (finishElapsedMs !== null) {
          const buildProgress = easeOutCubic(finishElapsedMs / LOGO_COMPLETE_MS) * LOGO_COLUMN_COUNT;
          return 0.96 * clamp01(buildProgress - dot.columnIndex);
        }

        const activeColumnIndex = Math.floor(loopElapsedMs / LOGO_COLUMN_MS) % LOGO_COLUMN_COUNT;
        if (dot.columnIndex !== activeColumnIndex) return 0;
        const phase = (loopElapsedMs % LOGO_COLUMN_MS) / LOGO_COLUMN_MS;
        return 0.78 + 0.18 * Math.sin(phase * Math.PI);
      }

      const startedAt = performance.now();
      let finishStartedAt = null;
      let frameId = 0;

      function tick(now) {
        const loopElapsedMs = now - startedAt;
        const finishElapsedMs = finishStartedAt === null ? null : now - finishStartedAt;
        const visibleColumns = loopElapsedMs < BACKDROP_REVEAL_MS
          ? easeOutCubic(loopElapsedMs / BACKDROP_REVEAL_MS) * GRID_COLUMNS
          : GRID_COLUMNS;
        const backdropOpacity = resolveBackdropOpacity(finishElapsedMs);

        for (const dot of matrixDots) {
          dot.circle.setAttribute('opacity', String(backdropOpacity * 0.32 * clamp01(visibleColumns - dot.column)));
        }

        for (const dot of logoDotElements) {
          dot.circle.setAttribute('opacity', String(resolveLogoDotOpacity(dot, loopElapsedMs, finishElapsedMs)));
        }

        if (finishElapsedMs !== null) {
          const exitElapsedMs = finishElapsedMs - LOGO_COMPLETE_MS - FINAL_LOGO_HOLD_MS;
          if (exitElapsedMs > 0) {
            card.style.opacity = String(1 - easeInOutCubic(exitElapsedMs / CARD_EXIT_MS));
          }
          if (finishElapsedMs >= EXIT_TOTAL_MS) {
            window.close();
            return;
          }
        }

        frameId = window.requestAnimationFrame(tick);
      }

      window.addEventListener('ready-startup-finish', () => {
        if (finishStartedAt === null) finishStartedAt = performance.now();
      });
      window.addEventListener('beforeunload', () => window.cancelAnimationFrame(frameId));
      frameId = window.requestAnimationFrame(tick);
    })();
  </script>
</body>
</html>`

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
