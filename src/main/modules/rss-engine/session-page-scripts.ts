/**
 * The read-only scripts a session page runs on itself. They look at what the page already holds (its embedded
 * state, its rendered list) and report it; they make no request. The Bilibili and Xiaohongshu scripts neither
 * scroll nor dispatch events. A page counts as readable as soon as it shows items; only a page with nothing to
 * read is checked for a sign-in or verification screen, and that check looks at the address, dedicated
 * containers and whole phrases, never at a single common word.
 */
import type { PlatformType } from './scrapers'
import { extractWeiboUserId, extractXiaohongshuUserId } from './session-profile-urls'

export type BrowserAcquisitionMode = 'full' | 'incremental'

const XIAOHONGSHU_BODY = String.raw`
  const NOTE_ID = /^[0-9a-f]{24}$/i;
  const unref = (value) => {
    if (value && typeof value === 'object') {
      if ('_rawValue' in value) return value._rawValue;
      if ('_value' in value) return value._value;
    }
    return value;
  };
  const readNodeImage = (node) => {
    if (!node || typeof node.querySelector !== 'function') return '';
    const image = node.querySelector('img');
    const src = image?.getAttribute('src') || image?.getAttribute('data-src') || image?.currentSrc || '';
    if (src) return abs(src);
    const candidate = node.querySelector('[style*="background-image"]');
    const background = candidate?.style?.backgroundImage || '';
    const match = background.match(/url\((['"]?)(.*?)\1\)/i);
    return match?.[2] ? abs(match[2]) : '';
  };
  const extractNoteId = (href) => {
    const decoded = decodeMaybe(String(href || ''));
    let match = decoded.match(/\/explore\/([a-zA-Z0-9]+)/i);
    if (match) return match[1];
    match = decoded.match(/\/discovery\/item\/([a-zA-Z0-9]+)/i);
    if (match) return match[1];
    match = decoded.match(/\/([a-f0-9]{24})(?:\?|$)/i);
    return match ? match[1] : '';
  };
  const readToken = (href) => {
    try { return new URL(String(href || ''), location.href).searchParams.get('xsec_token') || ''; } catch { return ''; }
  };
  const readProfileAuthor = () => {
    const selectors = ['.user-name', '.info .username', '.user-nickname', 'h1', '[data-testid="user-name"]'];
    for (const selector of selectors) {
      const value = normalize(document.querySelector(selector)?.textContent || '');
      if (value && value !== '我') return value;
    }
    return '';
  };
  const sanitizeTitleLines = (text, author) => {
    const lines = String(text || '').split(/\n+/).map((line) => normalize(line)).filter(Boolean);
    return lines.filter((line) => {
      if (line === '置顶') return false;
      if (author && line === author) return false;
      if (/^[\d.万w]+$/.test(line)) return false;
      if (line === '赞' || line === '收藏' || line === '评论' || line === '分享' || line === '笔记' || line === '作品') return false;
      return true;
    });
  };

  const pushNote = (items, seen, card, outer) => {
    if (!card || typeof card !== 'object') return;
    const noteId = String(card.noteId || card.note_id || (outer && (outer.noteId || outer.note_id || outer.id)) || '');
    if (!NOTE_ID.test(noteId) || seen.has(noteId)) return;
    const user = unref(card.user) || {};
    const userId = String(user.userId || user.user_id || '');
    if (targetUserId && userId && userId !== targetUserId) return;
    const cover = unref(card.cover) || {};
    seen.add(noteId);
    items.push({
      noteId,
      xsecToken: String(card.xsecToken || card.xsec_token || (outer && (outer.xsecToken || outer.xsec_token)) || ''),
      title: clip(card.displayTitle || card.display_title || card.title || '小红书内容', 160),
      link: abs('/explore/' + noteId),
      description: clip(card.desc || '', 280),
      author: clip(user.nickname || user.nickName || user.nick_name || '', 80),
      pubDate: '',
      coverImage: clip(cover.urlDefault || cover.url_default || cover.url || '', 500),
    });
  };

  const readEmbeddedState = () => {
    if (window.__INITIAL_STATE__ && typeof window.__INITIAL_STATE__ === 'object') return window.__INITIAL_STATE__;
    for (const node of Array.from(document.scripts || [])) {
      const raw = node.textContent || '';
      if (!raw.includes('window.__INITIAL_STATE__')) continue;
      const match = raw.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (!match) continue;
      try {
        return JSON.parse(match[1].replace(/:undefined/g, ':null').replace(/:NaN/g, ':null'));
      } catch {
        // a state block that does not parse is treated as absent
      }
    }
    return null;
  };

  const collectFromState = () => {
    const items = [];
    const seen = new Set();
    const state = readEmbeddedState();
    if (!state || typeof state !== 'object') return items;
    // The profile keeps one list of notes per tab.
    const user = unref(state.user);
    const groups = unref(user && user.notes);
    if (Array.isArray(groups)) {
      for (const group of groups) {
        const cards = unref(group);
        if (!Array.isArray(cards)) continue;
        for (const entry of cards) {
          const outer = unref(entry);
          if (!outer || typeof outer !== 'object') continue;
          pushNote(items, seen, unref(outer.noteCard || outer.note_card) || outer, outer);
        }
      }
    }
    if (items.length > 0) return items;
    // The layout of the state changed: look for note cards anywhere in it.
    let budget = 20000;
    const visited = new WeakSet();
    const visit = (node, depth) => {
      if (budget <= 0 || depth > 10 || node === null || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      budget -= 1;
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry, depth + 1);
        return;
      }
      if (node.noteCard || node.note_card) pushNote(items, seen, unref(node.noteCard || node.note_card), node);
      else if (node.noteId || node.note_id) pushNote(items, seen, node, null);
      let values;
      try { values = Object.values(node); } catch { return; }
      for (const value of values) visit(value, depth + 1);
    };
    visit(state, 0);
    return items;
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
      const tokenAnchor = section.querySelector('a[href*="xsec_token="]');
      const lines = sanitizeTitleLines(section.innerText || '', author);
      const title = normalize(coverAnchor?.getAttribute('title') || '') || lines[0] || '小红书内容';
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
        noteId: NOTE_ID.test(noteId) ? noteId : '',
        xsecToken: readToken(tokenAnchor ? tokenAnchor.getAttribute('href') : href),
        title: clip(title, 160),
        link: stableLink,
        description: clip(lines.slice(1, 4).join(' '), 280),
        author: clip(author, 80),
        pubDate: '',
        coverImage: clip(readNodeImage(section), 500),
        fingerprint: clip([title, lines.slice(0, 4).join(' '), readNodeImage(section)].filter(Boolean).join('|'), 500),
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
      const noteId = extractNoteId(href);
      const fallbackKey = encodeURIComponent(title.slice(0, 48)).replace(/%/g, '').toLowerCase() || 'card';
      const stableLink = NOTE_ID.test(noteId)
        ? abs('/explore/' + noteId)
        : (targetUserId
            ? abs('/user/profile/' + targetUserId + '#note-' + fallbackKey + '-' + String(anchorIndex + 1))
            : href);
      if (!stableLink || seen.has(stableLink)) continue;
      seen.add(stableLink);
      items.push({
        noteId: NOTE_ID.test(noteId) ? noteId : '',
        xsecToken: readToken(href),
        title: clip(title, 160),
        link: stableLink,
        description: clip(lines.slice(1, 4).join(' '), 280),
        author: clip(author, 80),
        pubDate: '',
        coverImage: clip(readNodeImage(container), 500),
        fingerprint: clip([title, lines.slice(0, 4).join(' '), readNodeImage(container)].filter(Boolean).join('|'), 500),
      });
    }
    return items;
  };

  const blockedState = () => {
    const href = location.href;
    if (href.includes('/website-login/captcha') || document.querySelector('#red-captcha, .red-captcha-container')) {
      return { state: 'anti_bot', detail: 'captcha_or_risk_challenge' };
    }
    if (
      href.includes('/website-login/error') ||
      textHas(['ip存在风险', 'ip 存在风险', '安全限制', '访问频繁', '操作频繁', '请完成安全验证', '当前访问存在安全风险'])
    ) {
      return { state: 'waf', detail: 'security_restriction' };
    }
    if (
      href.includes('/login') ||
      document.querySelector('input[type="password"]') ||
      textHas(['登录后查看更多', '登录后即可', '登录后推荐更懂你的笔记'])
    ) {
      return { state: 'auth', detail: 'browser_session_login_required' };
    }
    return null;
  };

  const maxAttempts = acquisitionMode === 'incremental' ? 6 : 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const stateItems = collectFromState();
    if (stateItems.length > 0) {
      return { title: document.title || '', finalUrl: location.href, state: 'ready', via: 'state', items: stateItems };
    }
    const sectionItems = collectFromSections();
    if (sectionItems.length > 0) {
      return { title: document.title || '', finalUrl: location.href, state: 'ready', via: 'dom', items: sectionItems };
    }
    const anchorItems = collectFromProfileAnchors();
    if (anchorItems.length > 0) {
      return { title: document.title || '', finalUrl: location.href, state: 'ready', via: 'dom', items: anchorItems };
    }
    const blocked = blockedState();
    if (blocked) {
      return { title: document.title || '', finalUrl: location.href, state: blocked.state, detail: blocked.detail, textSnippet: bodyText(), items: [] };
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
`

const BILIBILI_BODY = String.raw`
  const readNodeImage = (node) => {
    if (!node || typeof node.querySelector !== 'function') return '';
    const image = node.querySelector('img');
    const src = image?.getAttribute('src') || image?.getAttribute('data-src') || image?.currentSrc || '';
    return src ? abs(src) : '';
  };
  const collectVideoAnchors = () => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/video/BV"], a[href*="/video/av"]'));
    const seen = new Set();
    const items = [];
    for (const anchor of anchors) {
      const href = abs(anchor.getAttribute('href'));
      if (!/bilibili\.com\/video\/(?:BV[0-9A-Za-z]+|av\d+)/i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const container =
        anchor.closest('li, article, .small-item, .bili-video-card, .list-item, [class*="video-card"], [class*="video-item"]') ||
        anchor.parentElement ||
        anchor;
      const title =
        normalize(anchor.getAttribute('title') || '') ||
        normalize(container?.querySelector('img[alt]')?.getAttribute('alt') || '') ||
        normalize(container?.querySelector('h3, h4, [title]')?.textContent || '') ||
        'Bilibili 视频';
      const body = normalize(container?.innerText || anchor.textContent || '');
      items.push({
        title: clip(title, 160),
        link: href,
        description: clip(body.replace(title, '').trim(), 280),
        author: '',
        pubDate: '',
        coverImage: clip(readNodeImage(container), 500),
        fingerprint: clip([href, title, readNodeImage(container)].filter(Boolean).join('|'), 500),
      });
      if (items.length >= 20) break;
    }
    return items;
  };
  // The sign-in prompt sits on top of a page that may still list other people's videos, so a visitor is
  // reported as signed out before anything is read.
  const signedIn = /(?:^|;\s*)DedeUserID=\d+/.test(String(document.cookie || ''));
  const signInPrompt = () =>
    location.href.includes('passport.bilibili.com') ||
    textHas(['登录后你可以', '立即登录', '首次使用？ 点我注册', '免费看高清视频']);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!signedIn && signInPrompt()) {
      return {
        title: document.title || '',
        finalUrl: location.href,
        state: 'auth',
        detail: 'browser_session_login_required',
        textSnippet: bodyText(),
        items: [],
      };
    }
    const items = collectVideoAnchors();
    if (items.length > 0) {
      return { title: document.title || '', finalUrl: location.href, state: 'ready', via: 'dom', items };
    }
    if (textHas(['访问异常', '安全验证', '请求过于频繁', '风控校验'])) {
      return {
        title: document.title || '',
        finalUrl: location.href,
        state: 'anti_bot',
        detail: 'risk_control_or_waf',
        textSnippet: bodyText(),
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
`

/** Reads the uploader of the video page the hidden page is on, from the page's own embedded state. */
export const BILIBILI_VIDEO_OWNER_SCRIPT = String.raw`
  (() => {
    const state = window.__INITIAL_STATE__;
    const owner = state && (state.upData?.mid || state.videoData?.owner?.mid);
    return { ownerId: owner ? String(owner) : '' };
  })()
`

export const PAGE_META_SCRIPT = String.raw`(() => ({ title: document.title || '', finalUrl: location.href }))()`

export function buildSessionPageScript(
  platform: PlatformType,
  targetUrl: string,
  mode: BrowserAcquisitionMode = 'full',
): string {
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
    return `
      (async () => {
        ${commonHelpers}
        const targetUserId = ${JSON.stringify(extractXiaohongshuUserId(targetUrl) || '')};
        const acquisitionMode = ${JSON.stringify(mode)};
        ${XIAOHONGSHU_BODY}
      })()
    `
  }

  if (platform === 'bilibili') {
    return `
      (async () => {
        ${commonHelpers}
        ${BILIBILI_BODY}
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
