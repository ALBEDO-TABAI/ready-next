#!/usr/bin/env node
/**
 * validate-deck.mjs — 零依赖静态校验（纯正则，不需要浏览器）
 *
 * 用法: node scripts/validate-deck.mjs <index.html>
 * 退出码: 0=通过（可有 warning） 1=有 error 2=用法错误
 *
 * 检查：版式登记 / [必填] 残留 / 图片槽位协议 / 图表数据契约 / 风格红线 / 节奏
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法: node scripts/validate-deck.mjs <index.html>'); process.exit(2); }
const raw = readFileSync(file, 'utf8');
const html = raw.replace(/<!--[\s\S]*?-->/g, '');

const errors = [], warnings = [];

/* ---- 风格识别 ---- */
const style = raw.match(/<html[^>]*data-style="(ready|human-touch)"/)?.[1];
if (!style) errors.push('<html> 缺少 data-style="ready|human-touch"（模板自带，不要删）');

const REGISTRY = {
  ready: new Set(Array.from({ length: 14 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`)),
  'human-touch': new Set(Array.from({ length: 13 }, (_, i) => `H${String(i + 1).padStart(2, '0')}`)),
};
const registry = REGISTRY[style] || new Set([...REGISTRY.ready, ...REGISTRY['human-touch']]);

/* ---- [必填] 残留 ---- */
const mustFill = (raw.match(/\[必填\]/g) || []).length;
if (mustFill > 0) errors.push(`还有 ${mustFill} 处 [必填] 占位没有替换（grep '\\[必填\\]' 定位）`);

/* ---- 逐页检查 ---- */
const slideRe = /<section\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>[\s\S]*?<\/section>/g;
const slides = [...html.matchAll(slideRe)].map((m, i) => ({
  no: i + 1, html: m[0], tag: m[0].match(/<section\b[^>]*>/)?.[0] ?? '',
}));
if (!slides.length) errors.push('没有找到 <section class="slide"> 页');

const slotIds = new Map();
let darkCount = 0;

for (const s of slides) {
  const layout = s.tag.match(/\bdata-layout="([^"]+)"/)?.[1];
  if (!layout) errors.push(`第 ${s.no} 页缺 data-layout`);
  else if (!registry.has(layout)) errors.push(`第 ${s.no} 页 data-layout="${layout}" 未登记（${style} 风格只认 ${style === 'human-touch' ? 'H01-H13' : 'R01-R14'}）`);

  if (/\bclass="[^"]*slide[^"]*\b(dark|amber)\b/.test(s.tag)) darkCount++;

  /* 本地图必须住槽位 */
  for (const im of s.html.matchAll(/<img\b[^>]*>/g)) {
    const t = im[0];
    const src = t.match(/\bsrc="([^"]+)"/)?.[1] || '';
    if (/^https?:/.test(src)) continue;
    if (!/\bdata-image-slot=/.test(t)) {
      /* img 自身可以不带槽位属性，但必须在带槽位的 figure 里——粗检：往前 600 字符找 figure 开标签 */
      const before = s.html.slice(Math.max(0, im.index - 600), im.index);
      const fig = before.match(/<figure\b[^>]*data-image-slot="[^"]+"[^>]*>(?![\s\S]*<\/figure>)/);
      if (!fig) errors.push(`第 ${s.no} 页本地图 ${src} 不在带 data-image-slot 的 .img-slot 里`);
    }
  }

  /* 槽位协议 */
  for (const fg of s.html.matchAll(/<figure\b[^>]*\bimg-slot\b[^>]*>/g)) {
    const t = fg[0];
    const id = t.match(/\bdata-image-slot="([^"]+)"/)?.[1];
    if (!id) { errors.push(`第 ${s.no} 页有 .img-slot 缺 data-image-slot`); continue; }
    if (slotIds.has(id)) errors.push(`槽位 id 重复：${id}（第 ${slotIds.get(id)} 页与第 ${s.no} 页）`);
    slotIds.set(id, s.no);
    if (!/\br-(21x9|16x9|16x10|4x3|3x2|1x1|3x4)\b/.test(t) && !/aspect-ratio/.test(t))
      errors.push(`槽位 ${id} 缺比例类（r-21x9/r-16x9/r-16x10/r-4x3/r-3x2/r-1x1/r-3x4 选一）`);
    const isEmpty = /\bis-empty\b/.test(t);
    if (!isEmpty) {
      /* 找到 figure 到 </figure> 的内容，检查 img 与 object-position */
      const rest = s.html.slice(fg.index, s.html.indexOf('</figure>', fg.index) + 9);
      const img = rest.match(/<img\b[^>]*>/)?.[0];
      if (!img) errors.push(`槽位 ${id} 非 is-empty 却没有 <img>（等图就加 is-empty）`);
      else if (!/object-position/.test(img) && !/fit-contain/.test(t))
        warnings.push(`槽位 ${id} 的 <img> 没写 inline object-position（主体裁切不受控）`);
    }
    if (!/\bdata-slot-desc="/.test(t)) warnings.push(`槽位 ${id} 缺 data-slot-desc（空槽铭牌与换图指令都依赖它）`);
  }

  /* 图表契约 */
  for (const dc of s.html.matchAll(/<div\b[^>]*\bdot-chart\b[^>]*>/g)) {
    const t = dc[0];
    const type = t.match(/\bdata-type="([^"]+)"/)?.[1];
    if (!type) { errors.push(`第 ${s.no} 页 .dot-chart 缺 data-type`); continue; }
    if (type === 'bar' || type === 'hbar' || type === 'line') {
      if (!/\bdata-values="/.test(t)) errors.push(`第 ${s.no} 页 ${type} 图缺 data-values`);
      if (!/\bdata-labels="/.test(t)) errors.push(`第 ${s.no} 页 ${type} 图缺 data-labels`);
      if ((type === 'bar' || type === 'hbar') && !/\bdata-unit="/.test(t))
        warnings.push(`第 ${s.no} 页 ${type} 图没写 data-unit（默认 1；请确认单位诚实）`);
    }
    if (type === 'waffle' && !/\bdata-percent="/.test(t)) errors.push(`第 ${s.no} 页 waffle 图缺 data-percent`);
  }

  /* 手绘 SVG 文字（图表是运行时渲染的，源码里出现 <svg><text> 一定是手绘） */
  if (/<svg\b[\s\S]*?<text\b/i.test(s.html)) errors.push(`第 ${s.no} 页 SVG 里有 <text>：标签用 HTML 排，不进 SVG`);

  /* ---- 风格红线 ---- */
  if (style === 'human-touch') {
    if (/border-radius\s*:\s*(?!0\b|0px)/.test(s.html)) errors.push(`第 ${s.no} 页出现非 0 border-radius（Human Touch 直角铁律）`);
    if (/box-shadow\s*:/.test(s.html)) errors.push(`第 ${s.no} 页出现 box-shadow（Human Touch 无阴影铁律）`);
    if (/var\(--mono\)|ui-monospace|JetBrains Mono|SF Mono/.test(s.html)) errors.push(`第 ${s.no} 页用了等宽字体（mono 是 Ready 的语汇，Human Touch 不用）`);
    if (/class="[^"]*\bdotword\b/.test(s.html)) errors.push(`第 ${s.no} 页用了 dotword（点阵字标是 Ready 的语汇）`);
    if (/glass-panel/.test(s.html)) errors.push(`第 ${s.no} 页用了玻璃面板（Human Touch 平面铁律）`);
  }
  if (style === 'ready') {
    if (/var\(--serif\)|Noto Serif|Songti|SimSun|STSong|font-family\s*:\s*serif/.test(s.html))
      errors.push(`第 ${s.no} 页出现衬线字体（Ready 全程无衬线）`);
    if (/linear-gradient|radial-gradient/.test(s.html) && !/img-slot/.test(s.html))
      warnings.push(`第 ${s.no} 页 inline 渐变——Ready 不用渐变大底，确认这是必要的`);
  }
}

/* ---- 全局节奏 ---- */
if (slides.length >= 8 && darkCount === 0)
  warnings.push(`${slides.length} 页 deck 没有任何 dark/amber 呼吸页（节奏会平）`);
if (raw.includes('<title>[必填]')) errors.push('<title> 还是占位标题');

/* ---- 报告 ---- */
console.log(`==== validate-deck ====`);
console.log(`file:   ${file}`);
console.log(`style:  ${style || '?'} · slides: ${slides.length} · 图片槽位: ${slotIds.size} · dark/amber: ${darkCount}`);
if (warnings.length) { console.log(`\nWarnings (${warnings.length}):`); warnings.forEach(w => console.log('  ⚠ ' + w)); }
if (errors.length) { console.log(`\nErrors (${errors.length}):`); errors.forEach(e => console.log('  ✗ ' + e)); console.log('\n未通过。'); process.exit(1); }
console.log('\n通过。');
