#!/usr/bin/env node
/**
 * render-deck.mjs — 把 deck 每一页渲染成 PNG（QA/交付预览用）
 *
 * 用法:
 *   node scripts/render-deck.mjs <index.html> [outDir] [--dynamic] [--slides 1,3,5] [--vw 1600] [--vh 900] [--scale 2]
 *
 * 默认以静态模式截图（低功耗=动画终态，确定性输出）；--dynamic 则等待入场动画后截图。
 * 浏览器解析顺序：playwright / playwright-core 模块 × msedge → chrome → chromium → webkit。
 * 需要当前环境已有 Playwright/Chrome；Ready 内缺失时跳过 PNG 渲染，交付 HTML。
 */
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : dflt;
};
if (!files[0]) {
  console.error('用法: node scripts/render-deck.mjs <index.html> [outDir] [--dynamic] [--slides 1,3] [--vw 1600] [--vh 900] [--scale 2]');
  process.exit(2);
}
const htmlPath = resolve(files[0]);
const outDir = resolve(files[1] || dirname(htmlPath) + '/renders');
const dynamic = !!flag('dynamic', false);
const only = flag('slides', null);
const VW = parseInt(flag('vw', 1600), 10);
const VH = parseInt(flag('vh', 900), 10);
const SCALE = parseFloat(flag('scale', 2));
mkdirSync(outDir, { recursive: true });

async function loadPW() {
  for (const mod of ['playwright', 'playwright-core']) {
    try { return await import(mod); } catch {}
  }
  throw new Error('未找到 playwright；Ready 内不要安装依赖，本轮可跳过 PNG 渲染并交付 HTML。');
}
async function launch(pw) {
  const tries = [
    ['msedge', () => pw.chromium.launch({ channel: 'msedge', headless: true })],
    ['chrome', () => pw.chromium.launch({ channel: 'chrome', headless: true })],
    ['chromium', () => pw.chromium.launch({ headless: true })],
    ['webkit', () => pw.webkit.launch()],
  ];
  for (const [name, fn] of tries) {
    try { const b = await fn(); return [name, b]; } catch {}
  }
  throw new Error('没有可用浏览器：装 Edge/Chrome，或 npx playwright install chromium。');
}

const pw = await loadPW();
const [channel, browser] = await launch(pw);
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: SCALE });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts ? document.fonts.ready : true);
await page.waitForTimeout(400);

const total = await page.evaluate(() => document.querySelectorAll('#deck .slide').length);
if (!total) { console.error('没有找到 .slide 页'); await browser.close(); process.exit(1); }

if (!dynamic) {
  await page.evaluate(() => window.__setLowPowerMode && window.__setLowPowerMode(true, { persist: false }));
  await page.waitForTimeout(250);
}

const wanted = only
  ? String(only).split(',').map(n => parseInt(n.trim(), 10) - 1).filter(n => n >= 0 && n < total)
  : Array.from({ length: total }, (_, i) => i);

for (const i of wanted) {
  await page.evaluate(n => window.__go(n), i);
  await page.waitForTimeout(dynamic ? 1600 : 350);
  const file = `${outDir}/slide-${String(i + 1).padStart(2, '0')}.png`;
  await page.screenshot({ path: file });
  console.log('✓', file);
}
await browser.close();
console.log(`done · ${wanted.length}/${total} 页 · via ${channel} · ${dynamic ? 'dynamic' : 'static'}`);
