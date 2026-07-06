#!/usr/bin/env node
/**
 * list-image-slots.mjs — 枚举图片槽位（DOM 即清单；换图前先跑这个）
 *
 * 用法: node scripts/list-image-slots.mjs <index.html> [--json]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('用法: node scripts/list-image-slots.mjs <index.html> [--json]'); process.exit(2); }
const html = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const slideRe = /<section\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>[\s\S]*?<\/section>/g;
const slides = [...html.matchAll(slideRe)];
const posterRe = /<section\b[^>]*class="[^"]*\bposter\b[^"]*"[^>]*>[\s\S]*?<\/section>/g;
const units = slides.length ? slides : [...html.matchAll(posterRe)];

const slots = [];
units.forEach((m, ui) => {
  const block = m[0];
  const layout = block.match(/<section\b[^>]*\bdata-layout="([^"]+)"/)?.[1] || '';
  const unitId = block.match(/<section\b[^>]*\bid="([^"]+)"/)?.[1] || '';
  for (const fg of block.matchAll(/<figure\b[^>]*\bimg-slot\b[^>]*>/g)) {
    const t = fg[0];
    const rest = block.slice(fg.index, block.indexOf('</figure>', fg.index) + 9);
    const img = rest.match(/<img\b[^>]*>/)?.[0] || '';
    slots.push({
      slot: t.match(/\bdata-image-slot="([^"]+)"/)?.[1] || '(缺 id!)',
      page: ui + 1,
      layout: layout || unitId,
      ratio: t.match(/\br-(21x9|16x9|16x10|4x3|3x2|1x1|3x4)\b/)?.[0] || (t.includes('aspect-ratio') ? 'inline' : '?'),
      status: /\bis-empty\b/.test(t) ? 'EMPTY' : 'filled',
      src: img.match(/\bsrc="([^"]+)"/)?.[1] || '—',
      objectPosition: img.match(/object-position\s*:\s*([^;"']+)/)?.[1]?.trim() || '—',
      fit: /fit-contain/.test(t) ? 'contain' : 'cover',
      desc: t.match(/\bdata-slot-desc="([^"]*)"/)?.[1] || '',
    });
  }
});

if (asJson) { console.log(JSON.stringify(slots, null, 2)); process.exit(0); }

if (!slots.length) { console.log('没有图片槽位。'); process.exit(0); }
const cols = ['slot', 'page', 'layout', 'ratio', 'status', 'src', 'objectPosition', 'desc'];
const width = Object.fromEntries(cols.map(c => [c, Math.max(c.length, ...slots.map(s => String(s[c]).length))]));
const line = row => cols.map(c => String(row[c] ?? c).padEnd(width[c] + 2)).join('');
console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
console.log(cols.map(c => '-'.repeat(width[c] + 2)).join(''));
slots.forEach(s => console.log(line(s)));
const empty = slots.filter(s => s.status === 'EMPTY').length;
console.log(`\n共 ${slots.length} 个槽位 · ${slots.length - empty} 已填 · ${empty} 空槽`);
