/**
 * The shelves. A fixed set of topics, each with a cloth (four shades so its books read as a set) and the words
 * that send a book there. ebook-treasure-chest tags every book with one of ~1000 categories and Z-Library has its
 * own; both are folded onto these by keyword. Every book's spine (cloth, style, width, height) comes from its id,
 * so the same book always looks the same.
 */

import { TOPICS, TOPIC, isTopic, type TopicKey } from '../../../shared/library-topics'
export { TOPICS, TOPIC, isTopic }
export type { Topic, TopicKey } from '../../../shared/library-topics'
const ORDER = Object.fromEntries(TOPICS.map((topic, index) => [topic.key, index]))

/* ---------- looks ---------- */

/** FNV-1a, then a small PRNG: the same id always gives the same book. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SpineStyle = 'bands' | 'label' | 'sans' | 'foil';
export type Look = { color: string; fg: string; light: boolean; style: SpineStyle; w: number; h: number; hue: number };
const STYLES: SpineStyle[] = ['bands', 'label', 'sans', 'foil'];

export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function hueOf(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return 400 + luminance(hex) * 100;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360 + 20) % 360;
}

const looks = new Map<string, Look>();
export function lookOf(b: { id: string; topic: TopicKey; chars: number }): Look {
  const key = `${b.id}:${b.topic}:${Math.round(b.chars / 5000)}`;
  const hit = looks.get(key);
  if (hit) return hit;
  const r = rng(hash(b.id));
  const shades = TOPIC[b.topic].shades;
  const pick = r();
  const color = shades[pick < 0.38 ? 0 : pick < 0.7 ? 2 : pick < 0.88 ? 1 : 3];
  const light = luminance(color) > 0.3;
  const style = STYLES[Math.floor(r() * STYLES.length)];
  const wr = r();
  const w = b.chars > 0 ? 28 + 10 * Math.log2(1 + b.chars / 20000) : 34 + wr * 22;
  const look: Look = { color, fg: light ? '#2a2520' : '#f6efe2', light, style, w: Math.round(Math.min(78, Math.max(30, w))), h: Math.round(206 + r() * 52), hue: hueOf(color) };
  if (looks.size >= 512) looks.clear();
  looks.set(key, look);
  return look;
}

/* ---------- sorting the shelf ---------- */

export type Sort = 'topic' | 'recent' | 'color' | 'length';
export const SORTS: { key: Sort; label: string }[] = [
  { key: 'topic', label: '分类' },
  { key: 'recent', label: '最近' },
  { key: 'color', label: '颜色' },
  { key: 'length', label: '厚薄' },
];

export type ShelfBook = {
  id: string; title: string; author: string; year?: number; topic: TopicKey; chars: number;
  added: number; opened?: number; pct: number; favorite: boolean; wish: boolean; ext?: string; cover?: string;
};

export function sortBooks(books: ShelfBook[], sort: Sort): ShelfBook[] {
  const by = [...books];
  if (sort === 'topic') by.sort((a, b) => ORDER[a.topic] - ORDER[b.topic] || a.added - b.added);
  if (sort === 'recent') by.sort((a, b) => Math.max(b.added, b.opened ?? 0) - Math.max(a.added, a.opened ?? 0));
  if (sort === 'color') by.sort((a, b) => lookOf(a).hue - lookOf(b).hue || lookOf(a).h - lookOf(b).h);
  if (sort === 'length') by.sort((a, b) => (a.chars || 1e9) - (b.chars || 1e9));
  return by;
}

/** The label on the plank under each run of books: a topic, a month or a thickness. */
export function groupOf(b: ShelfBook, sort: Sort): { key: string; label: string; color?: string } | null {
  if (sort === 'topic') return { key: b.topic, label: TOPIC[b.topic].name, color: TOPIC[b.topic].shades[0] };
  if (sort === 'recent') {
    const d = new Date(Math.max(b.added, b.opened ?? 0));
    const label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    return { key: label, label };
  }
  if (sort === 'length') {
    if (!b.chars) return { key: 'unknown', label: '还不知道多厚' };
    if (b.chars < 80_000) return { key: 'thin', label: '薄薄一册' };
    if (b.chars < 250_000) return { key: 'mid', label: '一个周末' };
    return { key: 'thick', label: '大部头' };
  }
  return null;
}

export const fmtChars = (n: number) => (!n ? '' : n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万字` : `${Math.round(n / 100) * 100} 字`);
