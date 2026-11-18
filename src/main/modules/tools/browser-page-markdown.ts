/**
 * Reading a page as Markdown: the script a document runs on itself, and the reading of a whole tab
 * (its main document and every content frame) built on it. The page is read as it is rendered right
 * now; nothing is requested again and nothing on the page is changed.
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import { isBrowserAbortError } from './browser-input-actions'

/** The longest Markdown one document may hand over, so a runaway page cannot fill the main process. */
export const PAGE_MARKDOWN_HARD_LIMIT = 2_000_000

/**
 * Headings, paragraphs, lists, tables and code keep their structure; links carry their absolute address;
 * images keep their description. Scripts, styles, hidden parts and whatever was typed into form fields
 * are left out. It works on any page, not only on articles: text between blocks is kept as paragraphs.
 */
const PAGE_MARKDOWN_BODY = String.raw`
  const __READY_PAGE_MARKDOWN__ = true;
  const HARD_LIMIT = __HARD_LIMIT__;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'CANVAS', 'HEAD', 'META', 'LINK', 'TITLE', 'DESC', 'DEFS', 'SYMBOL']);
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DD', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'MAIN', 'NAV', 'P', 'SECTION', 'SUMMARY', 'TR', 'TBODY', 'THEAD', 'TFOOT', 'CAPTION']);
  const isBlockTag = (tag) => BLOCK.has(tag) || /^H[1-6]$/.test(tag) || tag === 'UL' || tag === 'OL'
    || tag === 'TABLE' || tag === 'PRE' || tag === 'BLOCKQUOTE' || tag === 'HR' || tag === 'LI';
  let budget = HARD_LIMIT;
  let cutShort = false;

  const absolute = (href) => {
    try {
      const url = new URL(String(href || ''), location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  };
  const here = String(location.href || '').split('#')[0];
  const collapse = (text) => String(text || '').replace(/[ \t\r\n\f\v\u00a0]+/g, ' ');
  const escapeCell = (text) => collapse(text).trim().replace(/\|/g, '\\|');
  const isHidden = (el) => {
    if (el.hidden) return true;
    if (typeof el.checkVisibility === 'function') {
      try { return !el.checkVisibility({ checkVisibilityCSS: true }); } catch { /* fall through */ }
    }
    const style = el.style;
    return Boolean(style && (style.display === 'none' || style.visibility === 'hidden'));
  };

  // Inline content of one block: text, emphasis, code, links and images, on a single line.
  const inline = (node) => {
    if (budget <= 0) { cutShort = true; return ''; }
    if (node.nodeType === 3) return collapse(node.nodeValue);
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || isHidden(el)) return '';
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') {
      const alt = collapse(el.getAttribute('alt')).trim();
      return alt.length >= 2 ? '![' + alt.replace(/\]/g, '\\]') + ']' : '';
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return '';
    let inner = '';
    for (const child of childrenOf(el)) inner += inline(child);
    if (tag === 'A') {
      const label = inner.replace(/\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
      const href = absolute(el.getAttribute('href'));
      if (!label) return '';
      return href && href.split('#')[0] !== here ? '[' + label.replace(/\]/g, '\\]') + '](' + href + ')' : label;
    }
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
      const code = inner.trim();
      return code ? '\u0060' + code.replace(/\u0060/g, "'") + '\u0060' : '';
    }
    if (tag === 'STRONG' || tag === 'B') {
      const text = inner.trim();
      return text ? '**' + text + '**' : '';
    }
    if (tag === 'EM' || tag === 'I') {
      const text = inner.trim();
      return text ? '*' + text + '*' : '';
    }
    // A block inside inline content, and each label drawn in a chart, keeps its words apart from its neighbours.
    return isBlockTag(tag) || tag === 'TEXT' ? ' ' + inner + ' ' : inner;
  };

  const childrenOf = (el) => {
    const nodes = Array.from(el.childNodes || []);
    // An open shadow root renders in place of the host's own children wherever it has no slot for them.
    if (el.shadowRoot && el.shadowRoot.childNodes && el.shadowRoot.childNodes.length > 0) {
      return Array.from(el.shadowRoot.childNodes).concat(nodes);
    }
    return nodes;
  };

  // A link wrapped around a whole card stands on its own line, like the card it is.
  const isBlockNode = (el) => {
    const tag = el.tagName.toUpperCase();
    return isBlockTag(tag) || (tag === 'A' && hasBlockChild(el));
  };
  const hasBlockChild = (el) => {
    for (const child of childrenOf(el)) {
      if (child.nodeType === 1 && isBlockNode(child)) return true;
    }
    return false;
  };

  const blocks = [];
  const push = (text) => {
    const value = String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!value) return;
    if (budget <= 0) { cutShort = true; return; }
    const kept = value.length > budget ? value.slice(0, budget) : value;
    if (kept.length < value.length) cutShort = true;
    budget -= kept.length + 2;
    blocks.push(kept);
  };

  // The rows of this table itself (not of a table nested in it), each as its visible cells.
  const rowsOf = (el) => {
    const rows = [];
    for (const row of Array.from(el.querySelectorAll('tr'))) {
      if (row.closest('table') !== el || isHidden(row)) continue;
      const cells = Array.from(row.children || []).filter((cell) => /^(TD|TH)$/i.test(cell.tagName) && !isHidden(cell));
      if (cells.length > 0) rows.push(cells);
    }
    return rows;
  };
  // A table that only arranges the page (old sites are built this way) is read cell by cell, like any
  // other container; written as a grid it would squeeze whole sections into single cells.
  const LAYOUT_CONTENT = 'table, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, form, article, section, nav, header, footer';
  const isLayoutTable = (el, rows) => {
    const role = String(el.getAttribute('role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none') return true;
    const cells = rows.reduce((all, row) => all.concat(row), []);
    return cells.length <= 1 || cells.some((cell) => cell.querySelector(LAYOUT_CONTENT));
  };

  const tableOf = (tableRows) => {
    const rows = [];
    for (const cells of tableRows) {
      rows.push({ header: cells.every((cell) => cell.tagName.toUpperCase() === 'TH'), cells: cells.map((cell) => escapeCell(inline(cell))) });
    }
    if (rows.length === 0) return '';
    const width = Math.max.apply(null, rows.map((row) => row.cells.length));
    const line = (cells) => '| ' + Array.from({ length: width }, (_unused, index) => cells[index] || '').join(' | ') + ' |';
    const head = rows[0].header ? rows.shift() : { cells: [] };
    return [line(head.cells), line(Array.from({ length: width }, () => '---'))].concat(rows.map((row) => line(row.cells))).join('\n');
  };

  const listOf = (el, depth) => {
    const ordered = el.tagName.toUpperCase() === 'OL';
    const lines = [];
    let index = 0;
    for (const item of Array.from(el.children || [])) {
      if (item.tagName.toUpperCase() !== 'LI' || isHidden(item)) continue;
      index += 1;
      let text = '';
      const nested = [];
      for (const child of childrenOf(item)) {
        const tag = child.nodeType === 1 ? child.tagName.toUpperCase() : '';
        if (tag === 'UL' || tag === 'OL') nested.push(listOf(child, depth + 1));
        else text += inline(child);
      }
      const label = text.replace(/\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
      const marker = ordered ? index + '. ' : '- ';
      if (label) lines.push('  '.repeat(depth) + marker + label);
      for (const block of nested) if (block) lines.push(block);
    }
    return lines.join('\n');
  };

  const walk = (el) => {
    if (budget <= 0) { cutShort = true; return; }
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || isHidden(el)) return;
    const heading = tag.match(/^H([1-6])$/);
    if (heading) {
      const text = inline(el).replace(/\n+/g, ' ').trim();
      if (text) push('#'.repeat(Number(heading[1])) + ' ' + text);
      return;
    }
    if (tag === 'UL' || tag === 'OL') { push(listOf(el, 0)); return; }
    if (tag === 'TABLE') {
      const rows = rowsOf(el);
      if (isLayoutTable(el, rows)) { for (const cells of rows) for (const cell of cells) walk(cell); }
      else push(tableOf(rows));
      return;
    }
    if (tag === 'PRE') {
      const code = String(el.textContent || '').replace(/\n+$/, '');
      if (code.trim()) push('\u0060\u0060\u0060\n' + code + '\n\u0060\u0060\u0060');
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const text = inline(el).trim();
      if (text) push(text.split('\n').map((line) => '> ' + line.trim()).join('\n'));
      return;
    }
    if (tag === 'HR') { push('---'); return; }
    if (!hasBlockChild(el)) {
      // A leaf block: everything inside is inline content of one paragraph.
      push(inline(el).replace(/ {2,}/g, ' '));
      return;
    }
    // A container: its direct text and inline children between block children form paragraphs of their own.
    let run = '';
    const flush = () => { if (run.trim()) push(run.replace(/ {2,}/g, ' ')); run = ''; };
    for (const child of childrenOf(el)) {
      if (child.nodeType === 3) { run += collapse(child.nodeValue); continue; }
      if (child.nodeType !== 1) continue;
      if (!isBlockNode(child)) { run += inline(child); continue; }
      flush();
      if (isBlockTag(child.tagName.toUpperCase())) walk(child); else push(inline(child));
    }
    flush();
  };

  const root = document.body || document.documentElement;
  if (!root) return { ok: false, reason: 'no_document_body' };
  walk(root);
  return {
    ok: true,
    url: String(location.href || ''),
    title: String(document.title || ''),
    markdown: blocks.join('\n\n'),
    hitHardLimit: cutShort,
  };
`

export function buildPageMarkdownScript(): string {
  return `(() => {\n${PAGE_MARKDOWN_BODY.replace(/__HARD_LIMIT__/g, String(PAGE_MARKDOWN_HARD_LIMIT))}\n})()`
}

export interface PageMarkdownDocument {
  url: string
  title: string
  markdown: string
  hitHardLimit: boolean
}

function readDocument(value: unknown): PageMarkdownDocument | { failure: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { failure: 'page_script_returned_nothing' }
  const record = value as Record<string, unknown>
  if (record.ok !== true || typeof record.markdown !== 'string') {
    return { failure: typeof record.reason === 'string' && record.reason ? record.reason : 'page_script_failed' }
  }
  return {
    url: typeof record.url === 'string' ? record.url : '',
    title: typeof record.title === 'string' ? record.title : '',
    markdown: record.markdown,
    hitHardLimit: record.hitHardLimit === true,
  }
}

export type PageMarkdownReading =
  | { ok: true; url: string; title: string; markdown: string; hardLimitReached: boolean }
  | { ok: false; errorKind: 'page_read_failed' | 'frame_read_failed'; message: string; frameId?: string }

/**
 * The whole tab as one Markdown text: the main document, then each content frame under a line that
 * names the frame and its address. A document that cannot be converted is a failure, never an empty
 * or partial success.
 */
export async function readTabAsMarkdown(controller: BrowserController, tabId: string | null): Promise<PageMarkdownReading> {
  const script = buildPageMarkdownScript()
  let main: PageMarkdownDocument | { failure: string }
  try {
    main = readDocument(await controller.executeJS(tabId, script))
  } catch (error) {
    // A cancelled run ends the call; it is not a page that failed to read.
    if (isBrowserAbortError(error)) throw error
    return { ok: false, errorKind: 'page_read_failed', message: error instanceof Error ? error.message : String(error) }
  }
  if ('failure' in main) return { ok: false, errorKind: 'page_read_failed', message: main.failure }

  const parts = [main.markdown]
  let hardLimitReached = main.hitHardLimit
  const frames = typeof controller.listContentFrames === 'function'
    ? (controller.listContentFrames(tabId) as Array<{ main?: boolean; frameKey: string; url: string }>).filter((frame) => !frame.main)
    : []
  for (const frame of frames) {
    let document: PageMarkdownDocument | { failure: string }
    try {
      document = readDocument(await controller.executeJSInFrame(tabId, frame.frameKey, script))
    } catch (error) {
      if (isBrowserAbortError(error)) throw error
      return { ok: false, errorKind: 'frame_read_failed', frameId: frame.frameKey, message: error instanceof Error ? error.message : String(error) }
    }
    if ('failure' in document) return { ok: false, errorKind: 'frame_read_failed', frameId: frame.frameKey, message: document.failure }
    if (document.markdown.trim()) parts.push(`[frame ${frame.frameKey} ${frame.url}]\n${document.markdown}`)
    hardLimitReached = hardLimitReached || document.hitHardLimit
  }
  return { ok: true, url: main.url, title: main.title, markdown: parts.filter((part) => part.trim()).join('\n\n'), hardLimitReached }
}

export interface ReadSlice {
  content: string
  totalChars: number
  returnedChars: number
  truncated: boolean
  /** Where the next call should start, when something is left. */
  nextOffset?: number
}

/** One window of a text. Windows of an unchanged text, read one after another, join up to the whole. */
export function sliceReadContent(value: unknown, offset: number, maxChars: number): ReadSlice {
  const full = String(value ?? '')
  const start = Math.min(Math.max(0, Math.floor(offset) || 0), full.length)
  const content = full.slice(start, start + Math.max(1, Math.floor(maxChars)))
  const end = start + content.length
  return {
    content,
    totalChars: full.length,
    returnedChars: content.length,
    truncated: end < full.length,
    ...(end < full.length ? { nextOffset: end } : {}),
  }
}
