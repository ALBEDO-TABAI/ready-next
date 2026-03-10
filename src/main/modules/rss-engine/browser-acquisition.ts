import { createHash } from 'crypto'
import type { BrowserController } from '../browser-engine/ipc-handler'
import { platformLabel, type PlatformType } from './scrapers'
import type { ScrapeResult, ScrapedItem } from './scrapers/base'

interface BrowserFeedCandidate {
  title?: string
  link?: string
  description?: string
  author?: string
  pubDate?: string
}

type BrowserFeedExtractionState = 'ready' | 'auth' | 'anti_bot' | 'waf' | 'empty'

interface BrowserFeedExtractionResult {
  title?: string
  finalUrl?: string
  items?: BrowserFeedCandidate[]
  state?: BrowserFeedExtractionState
  detail?: string
  textSnippet?: string
}

function generateItemId(platform: PlatformType, key: string): string {
  const hash = createHash('md5').update(key).digest('hex').slice(0, 12)
  return `${platform}_${hash}`
}

function clipText(input: string | undefined, maxChars: number): string {
  const text = String(input || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

function isValidBrowserCandidateLink(platform: PlatformType, link: string): boolean {
  if (!link) return false

  if (platform === 'xiaohongshu') {
    return (
      /xiaohongshu\.com\/(explore|discovery\/item)\/[a-zA-Z0-9]+/i.test(link) ||
      /xiaohongshu\.com\/user\/profile\/[a-zA-Z0-9_-]+(?:[/?#].*)?$/i.test(link)
    )
  }

  return true
}

function normalizeItems(platform: PlatformType, payload: BrowserFeedExtractionResult): ScrapedItem[] {
  const seen = new Set<string>()
  const rows = Array.isArray(payload.items) ? payload.items : []
  const mapped: ScrapedItem[] = []

  for (const row of rows) {
    const link = clipText(row.link, 500)
    if (!isValidBrowserCandidateLink(platform, link) || seen.has(link)) continue
    seen.add(link)
    const title = clipText(row.title, 160) || '(Untitled)'
    const description = clipText(row.description, 500)
    mapped.push({
      itemId: generateItemId(platform, `${link}|${title}`),
      title,
      description,
      link,
      pubDate: clipText(row.pubDate, 80),
      author: clipText(row.author, 80),
      coverImage: null,
      metadata: {},
    })
    if (mapped.length >= 20) break
  }

  return mapped
}

const BROWSER_ACQUISITION_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  Connection: 'keep-alive',
}

async function resolveFinalUrl(url: string, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: BROWSER_ACQUISITION_HEADERS,
      signal: controller.signal,
    })
    return response.url || url
  } finally {
    clearTimeout(timer)
  }
}

function extractWeiboUserId(url: string): string | null {
  let match = url.match(/weibo\.com\/u\/(\d+)/i)
  if (match) return match[1]
  match = url.match(/m\.weibo\.cn\/u\/(\d+)/i)
  if (match) return match[1]
  match = url.match(/m\.weibo\.cn\/profile\/(\d+)/i)
  if (match) return match[1]
  match = url.match(/[?&]containerid=100505(\d+)/i)
  if (match) return match[1]
  match = url.match(/weibo\.com\/(\d+)/i)
  return match ? match[1] : null
}

function extractXiaohongshuUserId(url: string): string | null {
  let match = url.match(/user\/profile\/([a-zA-Z0-9_-]+)/i)
  if (match) return match[1]
  match = url.match(/xiaohongshu\.com\/([a-zA-Z0-9_-]+)/i)
  return match ? match[1] : null
}

export async function normalizeBrowserAcquisitionUrl(
  platform: PlatformType,
  url: string,
): Promise<string> {
  const lower = url.toLowerCase()
  let resolvedUrl = url

  if (platform === 'douyin') {
    return url
  }

  if (
    (platform === 'xiaohongshu' && (lower.includes('xhslink.com') || lower.includes('xhsurl.cn'))) ||
    (platform === 'weibo' && (lower.includes('m.weibo.cn') || lower.includes('t.cn/') || !extractWeiboUserId(url)))
  ) {
    try {
      resolvedUrl = await resolveFinalUrl(url)
    } catch {
      resolvedUrl = url
    }
  }

  if (platform === 'weibo') {
    const userId = extractWeiboUserId(resolvedUrl) || extractWeiboUserId(url)
    return userId ? `https://weibo.com/u/${userId}` : resolvedUrl
  }

  if (platform === 'xiaohongshu') {
    const userId = extractXiaohongshuUserId(resolvedUrl) || extractXiaohongshuUserId(url)
    return userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : resolvedUrl
  }

  return resolvedUrl
}

function buildExtractionScript(platform: PlatformType, targetUrl: string): string {
  const commonHelpers = String.raw`
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const clip = (value, maxChars = 240) => {
      const text = normalize(value);
      return text.length <= maxChars ? text : text.slice(0, maxChars);
    };
    const abs = (href) => {
      try { return new URL(href, location.href).href; } catch { return String(href || ''); }
    };
    const bodyText = () => clip(document.body?.innerText || '', 500);
    const textHas = (patterns) => {
      const haystack = ((document.title || '') + '\n' + (document.body?.innerText || '')).toLowerCase();
      return patterns.some((pattern) => haystack.includes(pattern));
    };
    const findJsonScript = (selector) => {
      const node = document.querySelector(selector);
      return node && node.textContent ? node.textContent.trim() : '';
    };
    const decodeMaybe = (value) => {
      try {
        return value.includes('%') ? decodeURIComponent(value) : value;
      } catch {
        return value;
      }
    };
    const walk = (node, visit, depth = 0) => {
      if (depth > 10 || node == null) return;
      visit(node);
      if (Array.isArray(node)) {
        for (const item of node) walk(item, visit, depth + 1);
        return;
      }
      if (typeof node === 'object') {
        for (const value of Object.values(node)) walk(value, visit, depth + 1);
      }
    };
  `

  if (platform === 'xiaohongshu') {
    const targetUserId = extractXiaohongshuUserId(targetUrl) || ''
    return `
      (async () => {
        ${commonHelpers}
        const targetUserId = ${JSON.stringify(targetUserId)};
        const clickNotesTabIfPresent = () => {
          const preferred = Array.from(document.querySelectorAll('div, button, a'));
          for (const node of preferred) {
            const label = normalize(node.textContent || '');
            if (!label) continue;
            if (label === '笔记' || label === '作品' || label.includes('笔记') || label.includes('作品')) {
              if (node.getAttribute('aria-selected') === 'true' || String(node.className || '').toLowerCase().includes('active')) {
                return true;
              }
              node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return true;
            }
          }
          const fallback = document.querySelector('div.reds-tab-item:nth-child(2), [class*="reds-tab-item"]:nth-child(2)');
          if (fallback) {
            fallback.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
          }
          return false;
        };

        const extractNoteId = (href) => {
          const decoded = decodeMaybe(String(href || ''));
          let match = decoded.match(new RegExp('/explore/([a-zA-Z0-9]+)', 'i'));
          if (match) return match[1];
          match = decoded.match(new RegExp('/discovery/item/([a-zA-Z0-9]+)', 'i'));
          if (match) return match[1];
          match = decoded.match(new RegExp('/([a-f0-9]{24})(?:\\\\?|$)', 'i'));
          return match ? match[1] : '';
        };

        const readProfileAuthor = () => {
          const selectors = [
            '.user-name',
            '.info .username',
            '.user-nickname',
            'h1',
            '[data-testid="user-name"]',
          ];
          for (const selector of selectors) {
            const value = normalize(document.querySelector(selector)?.textContent || '');
            if (value && value !== '我') return value;
          }
          return '';
        };

        const sanitizeTitleLines = (text, author) => {
          const lines = normalize(text).split(/\\n+/).map((line) => line.trim()).filter(Boolean);
          const filtered = lines.filter((line) => {
            if (!line) return false;
            if (line === '置顶') return false;
            if (author && line === author) return false;
            if (/^[\\d.万w]+$/.test(line)) return false;
            if (line === '赞' || line === '收藏' || line === '评论' || line === '分享' || line === '笔记' || line === '作品') return false;
            return true;
          });
          return filtered;
        };

        const collectFromSections = () => {
          const author = readProfileAuthor();
          const sections = Array.from(document.querySelectorAll('section.note-item, .note-item'));
          const seen = new Set();
          const items = [];
          for (const [sectionIndex, section] of sections.entries()) {
            const coverAnchor = section.querySelector('a.cover, a[href*="/explore/"], a[href*="/discovery/item/"]');
            const href = coverAnchor ? abs(coverAnchor.getAttribute('href')) : '';
            const noteId = extractNoteId(href);
            const lines = sanitizeTitleLines(section.innerText || '', author);
            const title =
              normalize(coverAnchor?.getAttribute('title') || '') ||
              lines[0] ||
              '小红书内容';
            const fallbackKey = title
              ? encodeURIComponent(title.slice(0, 48)).replace(/%/g, '').toLowerCase()
              : 'section-' + String(sectionIndex + 1);
            const stableLink = noteId
              ? abs('/explore/' + noteId)
              : (targetUserId
                  ? abs('/user/profile/' + targetUserId + '#note-' + fallbackKey + '-' + String(sectionIndex + 1))
                  : href);
            if (!stableLink || seen.has(stableLink)) continue;
            seen.add(stableLink);
            items.push({
              title: clip(title, 160),
              link: stableLink,
              description: clip(lines.slice(1, 4).join(' '), 280),
              author: clip(author, 80),
              pubDate: '',
            });
          }
          return items;
        };

        const collectFromProfileAnchors = () => {
          const author = readProfileAuthor();
          const profileHrefPattern = targetUserId
            ? new RegExp('/user/profile/' + targetUserId + '(?:[/?#]|$)', 'i')
            : new RegExp('/user/profile/', 'i');
          const cardAnchors = Array.from(document.querySelectorAll('a[href*="/user/profile/"]'));
          const seen = new Set();
          const items = [];
          for (const [anchorIndex, anchor] of cardAnchors.entries()) {
            const href = abs(anchor.getAttribute('href'));
            if (!href || !profileHrefPattern.test(href)) continue;
            const ownerLink = /xsec_source=pc_note/i.test(href);
            const coverLink = /xsec_source=pc_user/i.test(href);
            if (!ownerLink && !coverLink) continue;
            const container =
              anchor.closest('section.note-item, .note-item, [class*="note-item"]') ||
              anchor.parentElement?.parentElement ||
              anchor.parentElement ||
              anchor;
            const lines = sanitizeTitleLines(container?.innerText || anchor.textContent || '', author);
            const title = lines[0] || '';
            if (!title || title === author) continue;
            const fallbackKey = encodeURIComponent(title.slice(0, 48)).replace(/%/g, '').toLowerCase() || 'card';
            const stableLink = targetUserId
              ? abs('/user/profile/' + targetUserId + '#note-' + fallbackKey + '-' + String(anchorIndex + 1))
              : href;
            if (!stableLink || seen.has(stableLink)) continue;
            seen.add(stableLink);
            items.push({
              title: clip(title, 160),
              link: stableLink,
              description: clip(lines.slice(1, 4).join(' '), 280),
              author: clip(author, 80),
              pubDate: '',
            });
          }
          return items;
        };

        const collectFromInitialState = () => {
          const scripts = Array.from(document.scripts).map((node) => node.textContent || '');
          const items = [];
          for (const raw of scripts) {
            if (!raw.includes('window.__INITIAL_STATE__')) continue;
            const match = raw.match(/window\\.__INITIAL_STATE__\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?\\s*$/);
            if (!match) continue;
            try {
              const state = JSON.parse(match[1].replace(/:undefined/g, ':null').replace(/:NaN/g, ':null'));
              walk(state, (node) => {
                if (!node || typeof node !== 'object' || Array.isArray(node)) return;
                const noteId = node.noteId || node.note_id || node.id;
                const title = node.displayTitle || node.title || node.noteTitle || node.desc;
                const nodeUserId =
                  node.userId ||
                  node.user_id ||
                  node.user?.userId ||
                  node.user?.user_id ||
                  node.user?.userid ||
                  node.user?.id ||
                  '';
                if (targetUserId && nodeUserId && String(nodeUserId) !== targetUserId) return;
                if (typeof noteId !== 'string' || !/^[a-zA-Z0-9]{8,}$/.test(noteId)) return;
                if (typeof noteId === 'string' && typeof title === 'string') {
                  items.push({
                    title: clip(title, 160),
                    link: abs('/explore/' + noteId),
                    description: clip(node.desc || node.content || title, 280),
                    author: clip(node.nickname || node.user?.nickname || '', 80),
                    pubDate: '',
                  });
                }
              });
            } catch {
              // ignore malformed initial state
            }
          }
          return items;
        };

        let attemptedTabSwitch = false;
        for (let attempt = 0; attempt < 70; attempt += 1) {
          const href = location.href;
          if (href.includes('/login') || textHas(['登录后查看更多', '登录后即可']) || document.querySelector('input[type="password"]')) {
            return {
              title: document.title || '',
              finalUrl: href,
              state: 'auth',
              detail: 'browser_session_login_required',
              textSnippet: bodyText(),
              items: [],
            };
          }
          if (document.querySelector('#red-captcha, [id*="captcha"], [class*="captcha"], [class*="verify"]') || textHas(['验证码', 'captcha', '验证', '稍后再试', '操作频繁'])) {
            return {
              title: document.title || '',
              finalUrl: href,
              state: 'anti_bot',
              detail: 'captcha_or_risk_challenge',
              textSnippet: bodyText(),
              items: [],
            };
          }
          const items = collectFromSections();
          if (items.length > 0) {
            return { title: document.title || '', finalUrl: href, state: 'ready', items };
          }
          const profileItems = collectFromProfileAnchors();
          if (profileItems.length > 0) {
            return { title: document.title || '', finalUrl: href, state: 'ready', items: profileItems };
          }
          const stateItems = collectFromInitialState();
          if (stateItems.length > 0) {
            return { title: document.title || '', finalUrl: href, state: 'ready', items: stateItems };
          }
          if (!attemptedTabSwitch && attempt >= 4) {
            attemptedTabSwitch = clickNotesTabIfPresent();
          }
          await sleep(500);
        }

        return {
          title: document.title || '',
          finalUrl: location.href,
          state: 'empty',
          detail: 'browser_loaded_but_no_feed_candidates',
          textSnippet: bodyText(),
          items: [],
        };
      })()
    `
  }

  if (platform === 'douyin') {
    return `
      (async () => {
        ${commonHelpers}
        const collectFromUserPostList = () => {
          const container = document.querySelector('[data-e2e="user-post-list"]');
          if (!container) return [];
          const author = normalize(document.querySelector('h1, [data-e2e="user-detail"] h1, [data-e2e="user-info"] h1')?.textContent || '');
          const items = Array.from(container.querySelectorAll('li'))
            .map((item, index) => {
              const titleNode = item.querySelector('p, [class*="title"], [class*="desc"]');
              const rawTitle = normalize(titleNode?.textContent || item.textContent || '');
              const title = rawTitle
                .replace(/^看更多\\s*最新作品\\s*登录\\s*/i, '')
                .replace(/\\s*暂时没有更多了\\s*$/i, '')
                .trim();
              if (!title) return null;
              const directAnchor = item.querySelector('a[href*="/video/"], a[href*="/note/"]');
              const directHref = directAnchor ? abs(directAnchor.getAttribute('href')) : '';
              return {
                title: clip(title, 160),
                link: directHref || (location.href + '#post-' + String(index + 1)),
                description: clip(title, 280),
                author,
                pubDate: '',
              };
            })
            .filter(Boolean);
          return items;
        };

        for (let attempt = 0; attempt < 50; attempt += 1) {
          const href = location.href;
          const snippet = bodyText();
          const items = collectFromUserPostList();
          if (items.length > 0) {
            return { title: document.title || '', finalUrl: href, state: 'ready', items };
          }
          if (
            href.includes('/login') ||
            document.querySelector('input[type="password"], input[name*="mobile"], form[class*="login"]') ||
            (textHas(['登录后', '扫码登录', '手机号登录']) && !textHas(['作品', '合集', '搜索 Ta 的作品']))
          ) {
            return {
              title: document.title || '',
              finalUrl: href,
              state: 'auth',
              detail: 'browser_session_login_required',
              textSnippet: snippet,
              items: [],
            };
          }
          if (textHas(['风险', '异常', '验证', 'captcha', '稍后再试', '访问受限', '频繁'])) {
            return {
              title: document.title || '',
              finalUrl: href,
              state: snippet.includes('验证') || snippet.includes('captcha') ? 'anti_bot' : 'waf',
              detail: 'risk_control_or_waf',
              textSnippet: snippet,
              items: [],
            };
          }
          await sleep(400);
        }

        return {
          title: document.title || '',
          finalUrl: location.href,
          state: 'empty',
          detail: 'browser_loaded_but_no_feed_candidates',
          textSnippet: bodyText(),
          items: [],
        };
      })()
    `
  }

  return `
    (async () => {
      ${commonHelpers}
      const targetUserId = ${JSON.stringify(extractWeiboUserId(targetUrl) || '')};
      const clickTabIfPresent = () => {
        const labels = ['全部微博', '最新微博', '微博'];
        for (const node of Array.from(document.querySelectorAll('a, button, div, span'))) {
          const label = normalize(node.textContent || '');
          if (!label) continue;
          if (!labels.some((item) => label === item || label.includes(item))) continue;
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }
        return false;
      };
      const author = normalize(
        document.querySelector('h1, h2, [class*="ProfileHeader_name"], [class*="woo-font--extraBold"]')?.textContent || '',
      );
      const isPostHref = (href) => {
        const decoded = decodeMaybe(String(href || ''));
        if (!decoded) return false;
        if (/\\/detail\\/[a-zA-Z0-9]+/i.test(decoded) || /\\/status\\/[a-zA-Z0-9]+/i.test(decoded)) return true;
        if (/m\\.weibo\\.cn\\/(detail|status)\\/[a-zA-Z0-9]+/i.test(decoded)) return true;
        if (/weibo\\.com\\/\\d+\\/[a-zA-Z0-9]+/i.test(decoded)) return true;
        return false;
      };
      const sanitizeLines = (text) => {
        return normalize(text)
          .split(/\\n+/)
          .map((line) => line.trim())
          .filter((line) => {
            if (!line) return false;
            if (author && line === author) return false;
            if (line === '置顶' || line === '展开' || line === '收起') return false;
            if (line === '赞' || line === '评论' || line === '转发' || line === '收藏') return false;
            if (/^[\\d.万亿wW+]+$/.test(line)) return false;
            return true;
          });
      };
      const buildItemFromContainer = (container, href, fallbackIndex) => {
        const stableLink = abs(href);
        if (!isPostHref(stableLink)) return null;
        const lines = sanitizeLines(container?.innerText || container?.textContent || '');
        const title = lines[0] || normalize(container?.querySelector('a[title]')?.getAttribute('title') || '') || '微博内容';
        const description = clip(lines.slice(0, 4).join(' '), 280);
        return {
          title: clip(title, 160),
          link: stableLink || (location.href + '#weibo-post-' + String(fallbackIndex + 1)),
          description,
          author,
          pubDate: '',
        };
      };
      const collectFromFeedCards = () => {
        const selectors = [
          '[mid]',
          '[action-type="feed_list_item"]',
          '.WB_feed_type',
          '.card-wrap',
          'article',
          '[class*="Feed_wrap"]',
          '[class*="Feed_body"]',
        ];
        const cards = Array.from(document.querySelectorAll(selectors.join(',')));
        const seen = new Set();
        const items = [];
        for (const [index, card] of cards.entries()) {
          const anchors = Array.from(card.querySelectorAll('a[href]'));
          const postAnchor = anchors.find((anchor) => isPostHref(abs(anchor.getAttribute('href'))));
          if (!postAnchor) continue;
          const item = buildItemFromContainer(card, postAnchor.getAttribute('href') || '', index);
          if (!item || !item.link || seen.has(item.link)) continue;
          seen.add(item.link);
          items.push(item);
          if (items.length >= 20) break;
        }
        return items;
      };
      const collectFromAnchors = () => {
        const seen = new Set();
        const items = [];
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const [index, anchor] of anchors.entries()) {
          const href = abs(anchor.getAttribute('href'));
          if (!isPostHref(href) || seen.has(href)) continue;
          const container =
            anchor.closest('article, div[role="article"], [mid], [action-type="feed_list_item"], .card, .card-wrap, .WB_feed_type') ||
            anchor.parentElement ||
            anchor;
          const item = buildItemFromContainer(container, href, index);
          if (!item) continue;
          seen.add(item.link);
          items.push(item);
          if (items.length >= 20) break;
        }
        return items;
      };
      const collectFromEmbeddedState = () => {
        const scripts = Array.from(document.scripts).map((node) => node.textContent || '');
        const items = [];
        const seen = new Set();
        const patterns = [
          /"mblogid":"([^"]+)".{0,600}?"text_raw":"([^"]+)".{0,600}?"user":\\{"id(?:str)?":("?\\d+"?)/g,
          /"bid":"([^"]+)".{0,600}?"text_raw":"([^"]+)".{0,600}?"user":\\{"id(?:str)?":("?\\d+"?)/g,
        ];
        for (const raw of scripts) {
          for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(raw)) !== null) {
              const postId = String(match[1] || '').replace(/^"+|"+$/g, '');
              const text = String(match[2] || '').replace(/\\\\n/g, ' ').replace(/\\"/g, '"');
              const userId = String(match[3] || '').replace(/^"+|"+$/g, '');
              if (targetUserId && userId && userId !== targetUserId) continue;
              if (!postId || !text) continue;
              const link = abs('/detail/' + postId);
              if (seen.has(link)) continue;
              seen.add(link);
              items.push({
                title: clip(sanitizeLines(text)[0] || text, 160),
                link,
                description: clip(text, 280),
                author,
                pubDate: '',
              });
              if (items.length >= 20) return items;
            }
          }
        }
        return items;
      };

      let tabClicked = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const href = location.href;
        if (
          href.includes('passport.weibo.com/visitor') ||
          href.includes('/login') ||
          document.querySelector('input[type="password"], input[name*="username"], form[action*="login"]') ||
          textHas(['visitor system', '扫码登录', '账号登录'])
        ) {
          return {
            title: document.title || '',
            finalUrl: href,
            state: 'auth',
            detail: 'browser_session_login_required',
            textSnippet: bodyText(),
            items: [],
          };
        }
        if (textHas(['验证码', '验证', '频繁'])) {
          return {
            title: document.title || '',
            finalUrl: href,
            state: 'anti_bot',
            detail: 'captcha_or_rate_limit',
            textSnippet: bodyText(),
            items: [],
          };
        }
        const feedCardItems = collectFromFeedCards();
        if (feedCardItems.length > 0) {
          return { title: document.title || '', finalUrl: href, state: 'ready', items: feedCardItems };
        }
        const items = collectFromAnchors();
        if (items.length > 0) {
          return { title: document.title || '', finalUrl: href, state: 'ready', items };
        }
        const stateItems = collectFromEmbeddedState();
        if (stateItems.length > 0) {
          return { title: document.title || '', finalUrl: href, state: 'ready', items: stateItems };
        }
        if (!tabClicked && attempt >= 2) {
          tabClicked = clickTabIfPresent();
        }
        window.scrollTo(0, Math.min(document.body?.scrollHeight || 0, (attempt + 1) * 720));
        await sleep(400);
      }

      return {
        title: document.title || '',
        finalUrl: location.href,
        state: 'empty',
        detail: 'browser_loaded_but_no_feed_candidates',
        textSnippet: bodyText(),
        items: [],
      };
    })()
  `
}

export function buildExtractionScriptForTest(platform: PlatformType, targetUrl: string): string {
  return buildExtractionScript(platform, targetUrl)
}

function describeBrowserFailure(platform: PlatformType, payload: BrowserFeedExtractionResult): string {
  const label = platformLabel(platform)
  const finalUrl = clipText(payload.finalUrl, 240)
  const suffix = finalUrl ? ` (${finalUrl})` : ''

  if (payload.state === 'auth') {
    return `${label} 应用内浏览器会话当前未登录，或已被重定向到登录页${suffix}。请先在 Ready 浏览器中登录该站点后再刷新。`
  }

  if (payload.state === 'anti_bot') {
    return `${label} 应用内浏览器当前遇到验证码/风控校验${suffix}${payload.textSnippet ? `：${clipText(payload.textSnippet, 180)}` : ''}`
  }

  if (payload.state === 'waf') {
    return `${label} 应用内浏览器当前被平台风控/WAF 拦截${suffix}${payload.textSnippet ? `：${clipText(payload.textSnippet, 180)}` : ''}`
  }

  return `${label} 应用内浏览器已加载页面，但未提取到可用条目${suffix}${payload.textSnippet ? `：${clipText(payload.textSnippet, 180)}` : ''}`
}

export function supportsBrowserSessionAcquisition(platform: PlatformType): boolean {
  return platform === 'weibo' || platform === 'xiaohongshu' || platform === 'douyin'
}

export async function fetchFeedViaBrowserSession(
  controller: BrowserController,
  platform: PlatformType,
  url: string,
): Promise<ScrapeResult> {
  const acquisitionUrl = await normalizeBrowserAcquisitionUrl(platform, url)
  const captureOptions = {
    timeoutMs: platform === 'xiaohongshu' ? 65_000 : 45_000,
    settleMs: 1_000,
    script: buildExtractionScript(platform, acquisitionUrl),
  }

  let snapshot: (BrowserFeedExtractionResult & { __readyCaptureError?: string }) | null = null
  if (typeof (controller as BrowserController & {
    captureLiveTabPage?: (url: string, options?: typeof captureOptions) => Promise<unknown | null>
  }).captureLiveTabPage === 'function') {
    try {
      snapshot = (await (controller as BrowserController & {
        captureLiveTabPage?: (url: string, options?: typeof captureOptions) => Promise<unknown | null>
      }).captureLiveTabPage?.(acquisitionUrl, captureOptions)) as
        | (BrowserFeedExtractionResult & { __readyCaptureError?: string })
        | null
    } catch {
      snapshot = null
    }
  }
  if (!snapshot) {
    snapshot = (await controller.captureBackgroundPage(acquisitionUrl, captureOptions)) as
      | (BrowserFeedExtractionResult & { __readyCaptureError?: string })
      | null
  }

  if (snapshot?.__readyCaptureError) {
    return {
      items: [],
      feedTitle: '',
      platform,
      error: `${platformLabel(platform)} 应用内浏览器提取脚本执行失败：${clipText(snapshot.__readyCaptureError, 280)}`,
    }
  }

  if (!snapshot) {
    return {
      items: [],
      feedTitle: '',
      platform,
      error: `${platformLabel(platform)} 应用内浏览器当前没有可复用的页面上下文，且后台抓取未返回结果。`,
    }
  }

  const items = normalizeItems(platform, snapshot)
  if (items.length === 0) {
    return {
      items: [],
      feedTitle: clipText(snapshot?.title, 160),
      platform,
      error: describeBrowserFailure(platform, snapshot || {}),
    }
  }

  return {
    items,
    feedTitle: clipText(snapshot?.title, 160),
    platform,
  }
}
