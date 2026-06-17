import readyWordmarkSvg from '../renderer/assets/ready-wordmark.svg?raw'

type StartupSplashVariant = 'orange' | 'pink'

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

function createInlineWordmark(): string {
  return readyWordmarkSvg
    .replace('<svg ', '<svg class="ready-startup-wordmark" aria-hidden="true" ')
    .replace('role="img"', '')
    .replace('aria-label="Ready"', '')
}

export function createStartupSplashDataUrl(variant: StartupSplashVariant): string {
  const colors = VARIANT_COLORS[variant]
  const wordmark = createInlineWordmark()
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

    .matrix {
      position: absolute;
      inset: 3% 7%;
      color: #dfded9;
    }

    .matrix svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    .logo {
      position: absolute;
      inset: 3% 7%;
      clip-path: inset(0 100% 0 0);
      will-change: clip-path;
    }

    .ready-startup-wordmark {
      position: absolute;
      left: 10.775%;
      top: 12.354%;
      width: 78.45%;
      height: 76.2%;
      filter: drop-shadow(0 0 8px ${escapeHtml(colors.glow)});
    }

    .ready-startup-wordmark g {
      fill: ${escapeHtml(colors.logo)};
    }
  </style>
</head>
<body>
  <section class="card" aria-label="Ready loading mark">
    <div class="matrix" aria-hidden="true">
      <svg id="ready-startup-grid" viewBox="0 0 5160 1109" preserveAspectRatio="xMidYMid meet"></svg>
    </div>
    <div class="logo" aria-hidden="true">${wordmark}</div>
  </section>
  <script>
    (() => {
      const GRID_ROWS = 8;
      const GRID_COLUMNS = 37;
      const MATRIX_ROW_STEP = 137;
      const MATRIX_COLUMN_STEP = 139;
      const MATRIX_DOT_RADIUS = 52;
      const MATRIX_X_START = 75;
      const MATRIX_Y_START = 75;
      const BACKDROP_REVEAL_MS = 1050;
      const LOGO_START_DELAY_MS = 520;
      const LOGO_ON_MS = 1280;
      const LOGO_HOLD_MS = 780;
      const LOGO_OFF_MS = 1060;
      const LOGO_DARK_MS = 340;
      const LOGO_LOOP_MS = LOGO_ON_MS + LOGO_HOLD_MS + LOGO_OFF_MS + LOGO_DARK_MS;
      const BACKDROP_FADE_MS = 760;
      const FINAL_LOGO_HOLD_MS = 2000;
      const CARD_EXIT_MS = 620;
      const EXIT_TOTAL_MS = BACKDROP_FADE_MS + FINAL_LOGO_HOLD_MS + CARD_EXIT_MS;

      const clamp01 = value => Math.max(0, Math.min(1, value));
      const easeOutCubic = value => 1 - Math.pow(1 - clamp01(value), 3);
      const easeInOutCubic = value => {
        const t = clamp01(value);
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      };

      const grid = document.getElementById('ready-startup-grid');
      const logo = document.querySelector('.logo');
      const card = document.querySelector('.card');
      const dots = [];

      for (let row = 0; row < GRID_ROWS; row += 1) {
        for (let column = 0; column < GRID_COLUMNS; column += 1) {
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', String(MATRIX_X_START + column * MATRIX_COLUMN_STEP));
          circle.setAttribute('cy', String(MATRIX_Y_START + row * MATRIX_ROW_STEP));
          circle.setAttribute('r', String(MATRIX_DOT_RADIUS));
          circle.setAttribute('fill', 'currentColor');
          circle.setAttribute('opacity', '0');
          grid.appendChild(circle);
          dots.push({ column, circle });
        }
      }

      function resolveLoopLogoClipPath(elapsedMs) {
        if (elapsedMs < LOGO_START_DELAY_MS) return 'inset(0 100% 0 0)';
        const cycleMs = (elapsedMs - LOGO_START_DELAY_MS) % LOGO_LOOP_MS;
        if (cycleMs < LOGO_ON_MS) {
          const progress = easeOutCubic(cycleMs / LOGO_ON_MS);
          return 'inset(0 ' + ((1 - progress) * 100) + '% 0 0)';
        }
        if (cycleMs < LOGO_ON_MS + LOGO_HOLD_MS) return 'inset(0 0 0 0)';
        if (cycleMs < LOGO_ON_MS + LOGO_HOLD_MS + LOGO_OFF_MS) {
          const progress = easeInOutCubic((cycleMs - LOGO_ON_MS - LOGO_HOLD_MS) / LOGO_OFF_MS);
          return 'inset(0 0 0 ' + (progress * 100) + '%)';
        }
        return 'inset(0 100% 0 0)';
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
        const backdropOpacity = finishElapsedMs === null
          ? 1
          : 1 - easeInOutCubic(finishElapsedMs / BACKDROP_FADE_MS);

        for (const dot of dots) {
          dot.circle.setAttribute('opacity', String(backdropOpacity * 0.34 * clamp01(visibleColumns - dot.column)));
        }

        logo.style.clipPath = finishElapsedMs === null ? resolveLoopLogoClipPath(loopElapsedMs) : 'inset(0 0 0 0)';

        if (finishElapsedMs !== null) {
          const exitElapsedMs = finishElapsedMs - BACKDROP_FADE_MS - FINAL_LOGO_HOLD_MS;
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
