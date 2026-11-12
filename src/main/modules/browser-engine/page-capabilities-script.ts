/** Mozilla Readability-readerable.js default algorithm (Apache-2.0), evaluated beside the DOM. */
export const PAGE_CAPABILITIES_SCRIPT = `(() => {
  const url = location.href;
  if (!/^https?:$/.test(location.protocol)) return { url, readable: false, feeds: [] };
  const unlikely = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
  const maybe = /and|article|body|column|content|main|shadow/i;
  const nodes = new Set(document.querySelectorAll('p, pre, article'));
  for (const br of document.querySelectorAll('div > br')) nodes.add(br.parentNode);
  let score = 0;
  const readable = [...nodes].some(node => {
    if ((node.style && node.style.display === 'none') || node.hasAttribute('hidden') ||
        (node.getAttribute('aria-hidden') === 'true' && !(node.className && node.className.includes && node.className.includes('fallback-image')))) return false;
    const match = node.className + ' ' + node.id;
    if (unlikely.test(match) && !maybe.test(match)) return false;
    if (node.matches('li p')) return false;
    const length = node.textContent.trim().length;
    if (length < 140) return false;
    score += Math.sqrt(length - 140);
    return score > 20;
  });
  const feeds = [], seen = new Set();
  for (const link of document.querySelectorAll('link[rel~=alternate]')) {
    const type = (link.getAttribute('type') || '').trim().toLowerCase();
    const title = link.getAttribute('title') || '';
    const href = link.getAttribute('href') || '';
    if (!['application/rss+xml', 'application/atom+xml', 'application/feed+json'].includes(type) &&
        !(type === 'application/json' && /feed|rss|atom/i.test(title + ' ' + href))) continue;
    if (!href.trim()) continue;
    let parsed;
    try { parsed = new URL(href, document.baseURI); } catch { continue; }
    if (!/^https?:$/.test(parsed.protocol)) continue;
    parsed.hash = '';
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    feeds.push({ url: parsed.href, title, type });
  }
  return { url, readable, feeds };
})()`
