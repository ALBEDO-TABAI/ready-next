#!/usr/bin/env node
/**
 * validate-cards.mjs — 真实 DOM 测量校验（Playwright）
 *
 * 用法: node scripts/validate-cards.mjs <index.html|task-dir>
 * 退出码: 0=无 FAIL（可有 WARN） 1=有 FAIL 2=用法错误
 *
 * 规则：
 *  C1 overflow        内容溢出画板（FAIL）
 *  C2 visual bounds   渲染内容越界 / 底部留白过大（FAIL / WARN）
 *  C3 min font        可见文本 <18px FAIL；18-19px WARN（1080 宽卡的移动端下限）
 *  C4 density         3:4 卡闭合行占用 <52% 或相邻空带（WARN；data-density-exempt 可豁免并注明理由）
 *  C5 style redline   Human Touch：>80px 容器带非 0 圆角 / 任何 box-shadow → FAIL；Ready：出现衬线字体 → FAIL
 *  C6 slots           is-empty 里有 <img> FAIL；已填图缺 inline object-position WARN
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let target = process.argv[2];
if (!target) { console.error('用法: node scripts/validate-cards.mjs <index.html|task-dir>'); process.exit(2); }
target = resolve(target);
if (statSync(target).isDirectory()) target = target + '/index.html';

async function loadPW() {
  for (const mod of ['playwright', 'playwright-core']) {
    try { return await import(mod); } catch {}
  }
  throw new Error('未找到 playwright；Ready 内可跳过 DOM 校验并交付 HTML。');
}
async function launch(pw) {
  const tries = [
    () => pw.chromium.launch({ channel: 'msedge', headless: true }),
    () => pw.chromium.launch({ channel: 'chrome', headless: true }),
    () => pw.chromium.launch({ headless: true }),
    () => pw.webkit.launch(),
  ];
  for (const fn of tries) { try { return await fn(); } catch {} }
  throw new Error('没有可用浏览器');
}

const pw = await loadPW();
const browser = await launch(pw);
const page = await browser.newPage({ viewport: { width: 2560, height: 1800 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(target).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts ? document.fonts.ready : true);
await page.waitForTimeout(600);

const style = await page.evaluate(() => document.documentElement.dataset.style || '?');
const posters = await page.$$('section.poster');

let totalFail = 0, totalWarn = 0;
const report = [];

/* C0：[必填] 占位残留（含 <title>） */
const mustFill = await page.evaluate(() => (document.documentElement.outerHTML.match(/\[必填\]/g) || []).length);
if (mustFill > 0) { report.push({ id: '(全文)', board: '-', fails: [`C0 还有 ${mustFill} 处 [必填] 占位未替换`], warns: [] }); totalFail += 1; }

for (const p of posters) {
  const skip = await p.evaluate(el => !!el.closest('.pair-preview'));
  if (skip) continue;   /* pair-preview 里的克隆不重复校验 */
  const r = await p.evaluate((el, style) => {
    const fails = [], warns = [];
    const er = el.getBoundingClientRect();
    const W = el.clientWidth, H = el.clientHeight;
    const board = el.classList.contains('xhs') ? 'xhs' : el.classList.contains('square') ? 'square' : el.classList.contains('wide') ? 'wide' : '?';

    /* C1 overflow */
    const over = el.scrollHeight - el.clientHeight;
    if (over > 4) fails.push(`C1 overflow ${over}px（scrollH ${el.scrollHeight} > ${el.clientHeight}）` +
      (over <= 40 ? '｜微调：收一处 gap/padding 20-40px' : over <= 90 ? '｜局部压缩间距与一个块高' : over <= 160 ? '｜先压标题或一段文字' : '｜换更高容量的 recipe 或删内容'));

    /* 收集"有意义节点" */
    const TRANSPARENT = /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|transparent/;
    const hasText = n => { for (const c of n.childNodes) if (c.nodeType === 3 && c.textContent.trim()) return true; return false; };
    const meaningful = [];
    let minFont = Infinity, minFontSample = '';
    for (const n of el.querySelectorAll('*')) {
      if (n.closest('script,style')) continue;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r2 = n.getBoundingClientRect();
      if (r2.width < 6 || r2.height < 6) continue;
      const isText = hasText(n);
      const isMedia = ['IMG', 'CANVAS', 'SVG', 'svg'].includes(n.tagName);
      const isRule = n.tagName === 'HR' || (r2.height <= 4 && cs.backgroundColor && !TRANSPARENT.test(cs.backgroundColor));
      const hasFill = cs.backgroundColor && !TRANSPARENT.test(cs.backgroundColor) && r2.width * r2.height >= 1600 && !['SECTION', 'MAIN'].includes(n.tagName) && !n.classList.contains('content');
      const hasBorder = (parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)) >= 1 && r2.width * r2.height >= 1600;
      if (isText) {
        const fs = parseFloat(cs.fontSize);
        if (fs < minFont) { minFont = fs; minFontSample = (n.textContent || '').trim().slice(0, 18); }
      }
      if (!isText && !isMedia && !isRule && !hasFill && !hasBorder) continue;
      if (cs.position === 'absolute' && r2.width * r2.height >= W * H * 0.85) continue;
      meaningful.push({ top: r2.top - er.top, bottom: r2.bottom - er.top, left: r2.left - er.left, right: r2.right - er.left });

      /* C5 风格红线（逐节点） */
      if (style === 'human-touch') {
        const br = parseFloat(cs.borderTopLeftRadius);
        if (br > 0 && Math.max(r2.width, r2.height) > 80 && cs.borderTopLeftRadius !== '50%')
          fails.push(`C5 Human Touch 圆角红线：<${n.tagName.toLowerCase()} class="${n.className}"> border-radius=${cs.borderTopLeftRadius}`);
        if (cs.boxShadow && cs.boxShadow !== 'none')
          fails.push(`C5 Human Touch 阴影红线：<${n.tagName.toLowerCase()} class="${n.className}">`);
      }
      if (style === 'ready' && isText) {
        const ff = cs.fontFamily.toLowerCase();
        if (/(noto serif|songti|simsun|stsong|serif sc)/.test(ff))
          fails.push(`C5 Ready 衬线红线："${(n.textContent || '').trim().slice(0, 14)}" 用了 ${cs.fontFamily.slice(0, 40)}`);
      }
    }

    /* C3 min font */
    if (minFont < 18) fails.push(`C3 最小字号 ${minFont.toFixed(1)}px（"${minFontSample}"）< 18px 移动端红线`);
    else if (minFont < 20) warns.push(`C3 最小字号 ${minFont.toFixed(1)}px（"${minFontSample}"）偏小，建议 ≥20px`);

    /* C2 visual bounds */
    if (meaningful.length) {
      const top = Math.min(...meaningful.map(m => m.top));
      const bottom = Math.max(...meaningful.map(m => m.bottom));
      if (top < -2) fails.push(`C2 内容顶部越界 ${(-top).toFixed(0)}px`);
      if (bottom > H + 2) fails.push(`C2 内容底部越界 ${(bottom - H).toFixed(0)}px`);
      const gapLimit = board === 'wide' ? 130 : board === 'square' ? 160 : 190;
      const bottomGap = H - bottom;
      const activeRatio = (bottom - Math.max(0, top)) / H;
      if (bottomGap > gapLimit && activeRatio < 0.78)
        warns.push(`C2 底部空白 ${bottomGap.toFixed(0)}px（>${gapLimit}）且活跃占比 ${(activeRatio * 100).toFixed(0)}% <78%`);
    }

    /* C4 density（仅 3:4）。
       量法：有意义节点的行位图 + 形态学闭合（组内 ≤48px 的呼吸间距视为连续占用）。
       Ready/Human Touch 是让位型设计语言，裸行占用会把设计性留白误判成欠填；
       经验边界：目检成立的卡闭合后 ≥54%，目检嫌空的 ≤48%——阈值 52%。
       闭合后 52% + 无相邻空带 + C2 底部空带守卫，共同拦"细条内容+大空洞"的真病。 */
    if (board === 'xhs' && !el.dataset.densityExempt) {
      const rows = new Uint8Array(H);
      for (const m of meaningful) {
        const a = Math.max(0, Math.floor(m.top)), b = Math.min(H, Math.ceil(m.bottom));
        for (let y = a; y < b; y++) rows[y] = 1;
      }
      const CLOSE = 48;
      let gapStart = -1;
      for (let y = 0; y <= H; y++) {
        const v = y < H ? rows[y] : 1;
        if (!v && gapStart < 0) gapStart = y;
        if (v && gapStart >= 0) {
          if (y - gapStart <= CLOSE && gapStart > 0) for (let k = gapStart; k < y; k++) rows[k] = 1;
          gapStart = -1;
        }
      }
      const BAND = H / 4, occ = [];
      for (let i = 0; i < 4; i++) {
        let c = 0;
        for (let y = Math.floor(i * BAND); y < Math.floor((i + 1) * BAND); y++) c += rows[y];
        occ.push(c / BAND);
      }
      const total = occ.reduce((a, b) => a + b, 0) / 4;
      if (total < 0.52) warns.push(`C4 密度 ${(total * 100).toFixed(0)}%（闭合后 bands ${occ.map(o => (o * 100).toFixed(0) + "%").join(" / ")}）<52%——扩内容或换 recipe；宣言/hero 卡加 data-density-exempt="statement" 并自证`);
      for (let i = 0; i < 3; i++) if (occ[i] < 0.2 && occ[i + 1] < 0.2) { warns.push('C4 相邻两带空 >25% 画布（中部空洞）'); break; }
    }

    /* C6 slots */
    for (const fg of el.querySelectorAll('.img-slot')) {
      const id = fg.dataset.imageSlot || '(no-id)';
      const img = fg.querySelector('img');
      if (fg.classList.contains('is-empty') && img) fails.push(`C6 槽位 ${id} 标 is-empty 却有 <img>`);
      if (!fg.classList.contains('is-empty') && img && !img.style.objectPosition && !fg.classList.contains('fit-contain'))
        warns.push(`C6 槽位 ${id} 的 <img> 没写 inline object-position`);
    }

    return { id: el.id || '(no-id)', board, fails, warns };
  }, style);

  report.push(r);
  totalFail += r.fails.length;
  totalWarn += r.warns.length;
}

await browser.close();

console.log('==== validate-cards ====');
console.log(`target: ${target}`);
console.log(`style:  ${style} · posters: ${report.length} · FAIL ${totalFail} · WARN ${totalWarn}\n`);
for (const r of report) {
  const tag = r.fails.length ? '[FAIL]' : r.warns.length ? '[WARN]' : '[PASS]';
  console.log(`${tag}  ${r.id} · ${r.board}`);
  r.fails.forEach(f => console.log('   ✗ ' + f));
  r.warns.forEach(w => console.log('   ⚠ ' + w));
}
process.exit(totalFail > 0 ? 1 : 0);
