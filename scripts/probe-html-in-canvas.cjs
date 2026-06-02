#!/usr/bin/env node

const { writeFileSync, mkdirSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const { app, BrowserWindow } = require('electron')

const HTML_IN_CANVAS_BLINK_FEATURE = 'CanvasDrawElement'
const enabledByCommandLine = process.env.READY_HTML_IN_CANVAS_ENABLE === '1'
const enabledByWebPreferences = process.env.READY_HTML_IN_CANVAS_WEBPREF === '1'

if (enabledByCommandLine) {
  app.commandLine.appendSwitch('enable-features', HTML_IN_CANVAS_BLINK_FEATURE)
  app.commandLine.appendSwitch('enable-blink-features', HTML_IN_CANVAS_BLINK_FEATURE)
}

function pageProbeSource() {
  return String.raw`
    (async () => {
      const result = {
        userAgent: navigator.userAgent,
        apis: {
          canvasLayoutSubtreeProperty: 'layoutSubtree' in HTMLCanvasElement.prototype,
          canvasOnPaint: 'onpaint' in HTMLCanvasElement.prototype,
          canvasRequestPaint: typeof HTMLCanvasElement.prototype.requestPaint,
          canvasCaptureElementImage: typeof HTMLCanvasElement.prototype.captureElementImage,
          canvasGetElementTransform: typeof HTMLCanvasElement.prototype.getElementTransform,
          contextDrawElementImage: typeof CanvasRenderingContext2D.prototype.drawElementImage,
          offscreenDrawElementImage:
            typeof OffscreenCanvasRenderingContext2D === 'undefined'
              ? 'undefined'
              : typeof OffscreenCanvasRenderingContext2D.prototype.drawElementImage,
        },
        draw: null,
        paintEvent: null,
        errors: [],
      };

      document.body.style.margin = '0';
      document.body.style.background = 'white';

      const canvas = document.createElement('canvas');
      canvas.id = 'html-in-canvas-probe';
      canvas.setAttribute('layoutsubtree', '');
      canvas.width = 320;
      canvas.height = 160;
      canvas.style.width = '320px';
      canvas.style.height = '160px';
      canvas.style.display = 'block';

      const child = document.createElement('div');
      child.id = 'probe-child';
      child.textContent = 'Ready HTML-in-Canvas';
      child.style.cssText = [
        'width: 180px',
        'height: 48px',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'font: 16px sans-serif',
        'color: rgb(255, 255, 255)',
        'background: rgb(20, 120, 90)',
      ].join(';');

      canvas.appendChild(child);
      document.body.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      result.layoutSubtreeValue = canvas.layoutSubtree;

      async function samplePixel() {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        try {
          result.samplePixel = Array.from(ctx.getImageData(24, 24, 1, 1).data);
        } catch (error) {
          result.errors.push('samplePixel: ' + (error && error.message ? error.message : String(error)));
        }
      }

      canvas.addEventListener('paint', (event) => {
        result.paintEvent = {
          fired: true,
          changedTargets: event && event.changedTargets ? event.changedTargets.length : null,
        };
        try {
          ctx.reset();
          const transform = ctx.drawElementImage(child, 20, 20);
          result.draw = {
            ok: true,
            transformType: transform && transform.constructor ? transform.constructor.name : typeof transform,
            transform: transform && typeof transform.toString === 'function' ? transform.toString() : String(transform),
          };
          if (transform && typeof transform.toString === 'function') {
            child.style.transform = transform.toString();
          }
        } catch (error) {
          result.draw = {
            ok: false,
            error: error && error.message ? error.message : String(error),
          };
        }
      }, { once: true });

      if (typeof canvas.requestPaint === 'function') {
        try {
          canvas.requestPaint();
        } catch (error) {
          result.errors.push('requestPaint: ' + (error && error.message ? error.message : String(error)));
        }
      }

      await samplePixel();

      if (!result.draw && typeof ctx.drawElementImage === 'function') {
        try {
          ctx.reset();
          const transform = ctx.drawElementImage(child, 20, 20);
          result.draw = {
            ok: true,
            direct: true,
            transformType: transform && transform.constructor ? transform.constructor.name : typeof transform,
            transform: transform && typeof transform.toString === 'function' ? transform.toString() : String(transform),
          };
          await samplePixel();
        } catch (error) {
          result.draw = {
            ok: false,
            direct: true,
            error: error && error.message ? error.message : String(error),
          };
        }
      }

      return result;
    })()
  `
}

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({
    width: 360,
    height: 220,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      ...(enabledByWebPreferences ? { enableBlinkFeatures: HTML_IN_CANVAS_BLINK_FEATURE } : {}),
    },
  })

  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>')
    const pageResult = await win.webContents.executeJavaScript(pageProbeSource(), true)
    const result = {
      timestamp: new Date().toISOString(),
      process: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        modules: process.versions.modules,
        v8: process.versions.v8,
      },
      enabledByProbe: enabledByCommandLine || enabledByWebPreferences,
      enabledByCommandLine,
      enabledByWebPreferences,
      page: pageResult,
    }

    const json = JSON.stringify(result, null, 2)
    console.log(json)

    const outPath = process.env.READY_HTML_IN_CANVAS_PROBE_OUT
    if (outPath) {
      const abs = resolve(outPath)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, json + '\n')
    }

    const hasRequiredApis =
      pageResult.apis.contextDrawElementImage === 'function'
      && pageResult.apis.canvasRequestPaint === 'function'
      && pageResult.apis.canvasOnPaint
    const drawOk = Boolean(pageResult.draw && pageResult.draw.ok)

    app.exit(process.env.READY_HTML_IN_CANVAS_REQUIRE === '1' && (!hasRequiredApis || !drawOk) ? 1 : 0)
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error))
    app.exit(1)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

main()
