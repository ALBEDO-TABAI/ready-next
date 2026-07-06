#!/usr/bin/env node
/**
 * render-cards.mjs — 把每张 .poster（含 pair-preview）按 id 截成 PNG
 *
 * 用法:
 *   node scripts/render-cards.mjs <index.html> [outDir] [--only id1,id2] [--scale 1]
 *
 * 输出 <outDir>/<id>.png（默认 outDir = index.html 同级 output/）。
 * deviceScaleFactor 默认 1：像素=设计像素（xhs 1080×1440 / square 1080×1080 / wide 2100×900）。
 * 浏览器解析顺序：playwright / playwright-core × msedge → chrome → chromium → webkit。
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
  console.error('用法: node scripts/render-cards.mjs <index.html> [outDir] [--only id1,id2] [--scale 1]');
  process.exit(2);
}
const htmlPath = resolve(files[0]);
const outDir = resolve(files[1] || dirname(htmlPath) + '/output');
const only = flag('only', null) ? String(flag('only')).split(',').map(s => s.trim()) : null;
const SCALE = parseFloat(flag('scale', 1));
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
  for (const [name, fn] of tries) { try { return [name, await fn()]; } catch {} }
  throw new Error('没有可用浏览器：装 Edge/Chrome，或 npx playwright install chromium。');
}

const pw = await loadPW();
const [channel, browser] = await launch(pw);
const page = await browser.newPage({ viewport: { width: 2560, height: 1800 }, deviceScaleFactor: SCALE });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts ? document.fonts.ready : true);
await page.waitForTimeout(500);

const ids = await page.evaluate(() =>
  [...document.querySelectorAll('section.poster[id], .pair-preview[id]')].map(el => el.id));
if (!ids.length) { console.error('没有找到带 id 的 .poster'); await browser.close(); process.exit(1); }

let n = 0;
for (const id of ids) {
  if (only && !only.includes(id)) continue;
  const el = page.locator(`[id="${id}"]`).first();
  const box = await el.boundingBox();
  const file = `${outDir}/${id}.png`;
  await el.screenshot({ path: file });
  console.log(`✓ ${file}  (${Math.round(box.width * SCALE)}×${Math.round(box.height * SCALE)})`);
  n++;
}
await browser.close();
console.log(`done · ${n} 张 · via ${channel} · scale ${SCALE}`);
