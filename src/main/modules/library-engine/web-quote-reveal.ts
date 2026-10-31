// Electron does not apply text fragments to navigations started with loadURL, so a web source page's "原文" link
// (`#:~:text=prefix-,quote,-suffix`) is revealed by Ready itself once the page is ready.

export interface TextDirective { prefix: string; start: string; end: string; suffix: string }

/** Reads the first text directive of a URL (https://wicg.github.io/scroll-to-text-fragment/#syntax). */
export function textDirectiveFromUrl(url: string): TextDirective | null {
  const at = url.indexOf(':~:')
  if (at < 0) return null
  const directive = url.slice(at + 3).split('&').find(part => part.startsWith('text='))
  if (!directive) return null
  const parts = directive.slice(5).split(',')
  const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
  const prefix = parts[0]?.endsWith('-') ? decode(parts.shift()!.slice(0, -1)) : ''
  const suffix = parts.at(-1)?.startsWith('-') ? decode(parts.pop()!.slice(1)) : ''
  const [start = '', end = ''] = parts.map(decode)
  return start ? { prefix, start, end, suffix } : null
}

/** Page script: highlights the directive's quote (prefix and suffix disambiguate) until the reader clicks. */
export function buildWebQuoteRevealScript(directive: TextDirective): string {
  return `(() => {
  const directive = ${JSON.stringify(directive)};
  if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') return false;
  // Visible text with whitespace collapsed, as the directive was written; map keeps each character's DOM position.
  const map = [];
  let norm = '', space = true;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || node.parentElement.closest('script,style,noscript,template')) continue;
    for (let offset = 0; offset < node.data.length; offset++) {
      const blank = /\\s/.test(node.data[offset]);
      if (blank && space) continue;
      norm += blank ? ' ' : node.data[offset]; map.push([node, offset]); space = blank;
    }
  }
  const clean = value => value.replace(/\\s+/g, ' ').trim();
  const quote = clean(directive.start), prefix = clean(directive.prefix), suffix = clean(directive.suffix), last = clean(directive.end);
  const fits = at => (!prefix || norm.slice(0, at).trimEnd().endsWith(prefix)) && (!suffix || norm.slice(at + quote.length).trimStart().startsWith(suffix));
  const found = [];
  for (let at = norm.indexOf(quote); at >= 0; at = norm.indexOf(quote, at + 1)) found.push(at);
  const begin = found.find(fits) ?? (found.length === 1 ? found[0] : -1);
  if (begin < 0) return false;
  let finish = begin + quote.length;
  if (last) { const tail = norm.indexOf(last, finish); if (tail < 0) return false; finish = tail + last.length; }
  const range = document.createRange();
  range.setStart(map[begin][0], map[begin][1]);
  range.setEnd(map[finish - 1][0], map[finish - 1][1] + 1);
  if (!document.getElementById('ready-source-quote-style')) {
    const style = document.createElement('style'); style.id = 'ready-source-quote-style';
    style.textContent = '::highlight(ready-source-quote){background-color:rgba(255,196,0,.45);color:inherit}';
    (document.head || document.documentElement).appendChild(style);
  }
  CSS.highlights.set('ready-source-quote', new Highlight(range));
  (range.startContainer.parentElement || document.body).scrollIntoView({ block: 'center' });
  const clear = () => { CSS.highlights.delete('ready-source-quote'); window.removeEventListener('pointerdown', clear, true); };
  window.addEventListener('pointerdown', clear, true); setTimeout(clear, 8000);
  return true;
})()`
}
