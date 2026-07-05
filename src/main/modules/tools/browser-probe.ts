/**
 * Browser probe/target-JS builders + live-target guards — extracted verbatim
 * from browser-tools.ts (Phase B, 2026-07-03). Pure injected-page-probe JS
 * string builders + the destructive/password live-target guard helpers. No
 * dispatch state: depends only on injected constants + BrowserController.
 */
import { BrowserController } from '../browser-engine/ipc-handler'
import { ToolDomainError } from './tool-errors'
import type { AgentBrowserAction } from '../browser-engine/agent-browser-act'
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
import { BROWSER_DESTRUCTIVE_TARGET_REGEX_SOURCES } from '../agent-control/safety/action-confirmation-policy'

function buildBrowserDomTargetLibraryJs(): string {
  return `
    const READY_AGENT_TARGET_SELECTOR = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role]',
      'summary',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6'
    ].join(',');
    // D13-b：pointer 收集的"祖先已覆盖"判断只能看真正可交互的语义祖先。
    // 拿整张 READY_AGENT_TARGET_SELECTOR 判会把 [role] 容器（微前端页面
    // 通篇 role=main/region/dialog/tabpanel）下的全部 pointer 按钮误杀——
    // 真机第七轮「发布」不可见的根因。
    const READY_INTERACTIVE_ANCESTOR_SELECTOR = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="slider"]'
    ].join(',');
    function readyCleanText(value) {
      return String(value || '').replace(/\\s+/g, ' ').trim();
    }
    function readyLabelFor(el) {
      const aria = readyCleanText(el.getAttribute('aria-label'));
      if (aria) return aria;
      const labelledBy = readyCleanText(el.getAttribute('aria-labelledby'));
      if (labelledBy) {
        const text = labelledBy.split(/\\s+/).map((id) => readyCleanText(document.getElementById(id)?.innerText)).filter(Boolean).join(' ');
        if (text) return text;
      }
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        const labelText = readyCleanText(label?.innerText || label?.textContent);
        if (labelText) return labelText;
      }
      const ownText = readyCleanText(el.innerText || el.textContent);
      if (ownText) return ownText.slice(0, 160);
      const title = readyCleanText(el.getAttribute('title'));
      if (title) return title;
      const placeholder = readyCleanText(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
      // D18-d：富文本编辑器（tiptap/ProseMirror）用 data-placeholder 而非
      // placeholder 属性——空编辑器此前名字为空串，模型在 map 里认不出
      // "正文该填哪"（第十六轮实锚：模型只反复 fill 有名字的标题 target）。
      const dataPlaceholder = readyCleanText(el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder'));
      if (dataPlaceholder) return dataPlaceholder;
      const alt = readyCleanText(el.getAttribute('alt'));
      if (alt) return alt;
      const name = readyCleanText(el.getAttribute('name'));
      if (name) return name;
      if (el instanceof HTMLInputElement && el.type === 'file') return 'file input';
      if (el.isContentEditable) return 'contenteditable 编辑区';
      // D14-c：自定义元素 host 在 closed shadow 下可能读不到任何渲染文本，
      // 标签名是模型唯一可用的把手（如 xhs-publish-btn）。
      if (el.tagName && el.tagName.indexOf('-') !== -1) return el.tagName.toLowerCase();
      return '';
    }
    function readyRoleFor(el) {
      const explicit = readyCleanText(el.getAttribute('role'));
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
      if (tag === 'input') {
        const type = String(el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'search') return 'searchbox';
        if (type === 'file') return 'button';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      // D14（2026-07-04 R1 真机实锚，XHS <xhs-publish-btn>）：Web Component
      // host 的真实控件藏在 shadow root 里，语义/cursor 信号都在影子内侧，
      // host 自身全无标记。自定义元素（标签名带 '-'）按可点击 widget 对待。
      if (tag.indexOf('-') !== -1) return 'clickable';
      // D10-c（2026-07-04 真机实锚，XHS creator "写长文"）：React 委托型
      // 控件是零语义标记的 span/div，唯一可观测信号是 cursor:pointer。
      // 给它专属 role 'clickable'，避免落进 'generic' 被 page-map 去噪层
      // 当 wrapper 抬走。
      try {
        if (window.getComputedStyle(el).cursor === 'pointer') return 'clickable';
      } catch {}
      return 'generic';
    }
    function readyStatesFor(el) {
      const states = {};
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) {
        if (el.disabled) states.disabled = true;
      }
      const expanded = el.getAttribute('aria-expanded');
      if (expanded) states.expanded = expanded;
      const checked = el.getAttribute('aria-checked');
      if (checked) states.checked = checked;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && el.checked) states.checked = true;
      const selected = el.getAttribute('aria-selected');
      if (selected) states.selected = selected;
      if (el instanceof HTMLInputElement && el.type === 'password') states.password = true;
      return states;
    }
    function readyTargetElements() {
      const semantic = Array.from(document.querySelectorAll(READY_AGENT_TARGET_SELECTOR));
      const semanticSet = new Set(semantic);
      return semantic
        .concat(readyPointerClickableElements(semanticSet))
        .concat(readyCustomElementHosts(semanticSet));
    }
    // D14（2026-07-04 R1 真机实锚，XHS 发布按钮 <xhs-publish-btn>）：Web
    // Component host 在 light DOM 可枚举，但语义选择器不认、pointer 扫描的
    // 标签清单不含自定义标签、cursor 信号又在影子内侧——三层全盲。host 自身
    // 就是可点击表面（rect 有效，Chrome 的 innerText 含 shadow 渲染文本）。
    // D14-c（第九轮实锚）：首版用 scanned>=6000 文档序扫描配额，publish 页
    // 前部烧光预算、DOM 尾部的发布按钮永远轮不到——复犯 D13 尾部偏置定律。
    // 现在便宜的 dash 标签判断走完整棵树（O(1) 字符串查），贵检查只对
    // custom 候选做（超 200 时头尾各 100），产出超 16 时保头 10 + 尾 6。
    function readyCustomElementHosts(semanticSet) {
      const nodes = document.querySelectorAll('*');
      const hosts = [];
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el.tagName && el.tagName.indexOf('-') !== -1 && !semanticSet.has(el)) hosts.push(el);
      }
      const candidates = hosts.length > 200
        ? hosts.slice(0, 100).concat(hosts.slice(hosts.length - 100))
        : hosts;
      const out = [];
      for (const el of candidates) {
        let style;
        try { style = window.getComputedStyle(el); } catch { continue; }
        if (!style || style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (!(rect.width >= 8 && rect.height >= 8)) continue;
        if (rect.width * rect.height > Math.max(1, (window.innerWidth || 1) * (window.innerHeight || 1)) * 0.5) continue;
        // 空文本不再淘汰：closed shadow root 的 host 从 light 侧可能读不到
        // 渲染文本，名字由 readyLabelFor 的自定义标签回退兜底。
        const text = readyCleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
        if (text.length > 40) continue;
        if (el.closest && el.closest(READY_INTERACTIVE_ANCESTOR_SELECTOR)) continue;
        out.push(el);
      }
      if (out.length > 16) return out.slice(0, 10).concat(out.slice(out.length - 6));
      return out;
    }
    // D10-c：cursor:pointer 视觉可点击收集级——语义选择器漏掉的委托型控件
    // （span/div tab、卡片按钮）。只收 pointer 边界元素（父级非 pointer，
    // 一个控件收敛成一个目标）、可见、短文本、未被语义集覆盖；上限 40 个
    // 防 map 膨胀。枚举顺序确定（文档序），probe/act 按 index 重定位一致。
    function readyPointerClickableElements(semanticSet) {
      const out = [];
      let scanned = 0;
      for (const el of document.querySelectorAll('div,span,li,p,img,svg')) {
        if (out.length >= 120 || scanned >= 8000) break;
        scanned += 1;
        if (semanticSet.has(el)) continue;
        let style;
        try { style = window.getComputedStyle(el); } catch { continue; }
        if (!style || style.cursor !== 'pointer') continue;
        const parent = el.parentElement;
        if (parent) {
          try { if (window.getComputedStyle(parent).cursor === 'pointer') continue; } catch {}
        }
        const rect = el.getBoundingClientRect();
        if (!(rect.width >= 8 && rect.height >= 8)) continue;
        if (rect.width * rect.height > Math.max(1, (window.innerWidth || 1) * (window.innerHeight || 1)) * 0.5) continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = readyCleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        if (!text || text.length > 40) continue;
        if (el.closest && el.closest(READY_INTERACTIVE_ANCESTOR_SELECTOR)) continue;
        out.push(el);
      }
      // D13（真机第六轮实锚，XHS 发布设置页）：主行动按钮（发布/发送）
      // 几乎总在 DOM 尾部，纯文档序 cap 会被页面前部的 pointer 设置行
      // 吃光名额。超过 40 个时保留头 28 + 尾 12——头部导航/tab 与底部
      // CTA 双端都在。规则确定性（probe/act 重枚举索引一致）。
      if (out.length > 40) {
        return out.slice(0, 28).concat(out.slice(out.length - 12));
      }
      return out;
    }
    function readyTargetRecord(el, index) {
      const rect = el.getBoundingClientRect();
      const box = rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        : undefined;
      return {
        role: readyRoleFor(el),
        name: readyLabelFor(el),
        value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? readyCleanText(el.value).slice(0, 160) : undefined,
        states: Object.assign(
          readyStatesFor(el),
          el instanceof HTMLInputElement && el.type === 'file' ? { fileInput: true } : {}
        ),
        backendDOMNodeId: index + 1,
        frameId: '0',
        box
      };
    }
  `
}

export function buildBrowserPageMapProbeJs(): string {
  return `(() => {
    const __READY_AGENT_PAGE_MAP__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    const elements = readyTargetElements();
    const rawTargets = elements.map((el, index) => readyTargetRecord(el, index));
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
    };
    const externalLinks = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
      try { return new URL(a.href, location.href).origin !== location.origin; } catch { return false; }
    }).length;
    const iframes = Array.from(document.querySelectorAll('iframe,frame')).slice(0, 20).map((frame, index) => {
      let readable = false;
      let reason = 'cross_origin_or_unavailable';
      try {
        const doc = frame.contentDocument;
        readable = Boolean(doc);
        reason = doc ? 'same_origin_readable' : 'cross_origin_or_unavailable';
      } catch {
        readable = false;
        reason = 'cross_origin_unreadable';
      }
      return {
        index,
        title: clean(frame.getAttribute('title') || frame.getAttribute('aria-label') || ''),
        src: String(frame.getAttribute('src') || ''),
        readable,
        reason,
        hidden: !visible(frame)
      };
    });
    const shadowRoots = Array.from(document.querySelectorAll('*')).filter((el) => Boolean(el.shadowRoot)).slice(0, 20).map((el, index) => ({
      index,
      host: String(el.tagName || '').toLowerCase(),
      label: clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.id || ''),
      childCount: el.shadowRoot ? el.shadowRoot.childElementCount : 0,
      hidden: !visible(el)
    }));
    const hiddenLoaded = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],section,article,dialog,[hidden],[aria-hidden="true"]'))
      .filter((el) => !visible(el) && clean(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder')).length > 0)
      .slice(0, 20)
      .map((el, index) => ({
        index,
        role: readyRoleFor(el),
        label: readyLabelFor(el).slice(0, 160),
        reason: el.hasAttribute('hidden') ? 'hidden_attribute' : el.getAttribute('aria-hidden') === 'true' ? 'aria_hidden' : 'css_hidden'
      }));
    return {
      identity: { url: String(location.href || ''), title: String(document.title || '') },
      viewport: { width: Math.round(window.innerWidth || 0), height: Math.round(window.innerHeight || 0) },
      bodyText: String(document.body?.innerText || '').slice(0, 4000),
      rawRoots: [{ role: 'generic', name: '', children: rawTargets }],
      structureHints: { iframes, shadowRoots, hiddenLoaded },
      riskFlags: {
        fileInputCount: document.querySelectorAll('input[type="file"]').length,
        passwordInputCount: document.querySelectorAll('input[type="password"]').length,
        externalLinkCount: externalLinks,
        iframeCount: document.querySelectorAll('iframe').length,
        shadowHostCount: Array.from(document.querySelectorAll('*')).filter((el) => Boolean(el.shadowRoot)).length
      }
    };
  })()`
}

export function buildBrowserTargetProbeJs(nodeId: string): string {
  return `(() => {
    const __READY_AGENT_TARGET_PROBE__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    const nodeId = ${JSON.stringify(nodeId)};
    const nodeIndex = /^\\d+$/.test(nodeId) ? Number(nodeId) - 1 : -1;
    const elements = readyTargetElements();
    const el = nodeIndex >= 0 ? elements[nodeIndex] : null;
    if (!el) return { matchCount: 0 };
    const record = readyTargetRecord(el, nodeIndex);
    const disabled = Boolean(record.states && record.states.disabled === true);
    return { matchCount: 1, disabled, target: record };
  })()`
}

/**
 * EP1-I3 live-target net — ONE in-page semantics library shared by every
 * enforcement point (selector click, coordinate click/type, selector type,
 * smart type, focused-field key guard). Defines:
 *
 *   readyAriaLabelledbyText(el) — resolves aria-labelledby references
 *   readyInputSemanticsLabel(el) — what the FIELD IS: placeholder /
 *     aria-label / aria-labelledby / name / id / title / associated <label>.
 *     Deliberately NOT value/textContent — a chat draft mentioning「验证码」
 *     must not trip the net.
 *   readyClickSemanticsLabel(el) — what the CLICK will press: climbs to the
 *     nearest clickable owner (clicks bubble — an icon/span inside a
 *     「确认支付」button still presses the button) and reads its
 *     text/aria-label/aria-labelledby/value/title.
 *
 * Destructive browser-target patterns are generated from the policy module
 * (single source).
 */
export function buildTargetSemanticsLibraryJs(): string {
  return `
    const READY_DESTRUCTIVE_TARGET_PATTERNS = [${BROWSER_DESTRUCTIVE_TARGET_REGEX_SOURCES.map((src) => `new RegExp(${JSON.stringify(src)}, 'i')`).join(', ')}];
    function readyAriaLabelledbyText(el) {
      try {
        const ref = el && el.getAttribute ? el.getAttribute('aria-labelledby') : null;
        if (!ref) return '';
        const parts = [];
        for (const id of ref.split(/\\s+/)) {
          const node = document.getElementById(id);
          if (node) parts.push(node.textContent);
        }
        return parts.filter(Boolean).join(' ');
      } catch { return ''; }
    }
    function readyInputSemanticsLabel(el) {
      if (!el || !el.getAttribute) return '';
      const parts = [
        el.getAttribute('placeholder'), el.getAttribute('aria-label'), readyAriaLabelledbyText(el),
        el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('title'), el.getAttribute('data-placeholder'),
      ];
      try {
        const id = el.getAttribute('id');
        if (id) {
          const owner = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (owner) parts.push(owner.textContent);
        }
        const wrap = el.closest && el.closest('label');
        if (wrap) parts.push(wrap.textContent);
      } catch { /* label association is best-effort */ }
      return parts.filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    function readyClickableOwner(el) {
      if (!el) return el;
      return (el.closest && el.closest('button, a, [role="button"], [role="link"], input, textarea, select, summary, [onclick], label')) || el;
    }
    function readyClickSemanticsLabel(el) {
      if (!el) return '';
      const owner = readyClickableOwner(el);
      const parts = [owner.textContent, owner.getAttribute && owner.getAttribute('aria-label'), readyAriaLabelledbyText(owner), owner.value, owner.title];
      if (owner !== el && el.getAttribute) {
        parts.push(el.getAttribute('aria-label'));
        parts.push(readyAriaLabelledbyText(el));
      }
      return parts.filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    function readyIsPasswordField(el) {
      return el instanceof HTMLInputElement && el.type === 'password';
    }
    function readyIsEditableField(el) {
      if (el instanceof HTMLInputElement) {
        const t = (el.type || 'text').toLowerCase();
        return !['button','submit','reset','checkbox','radio','file','range','color','image','hidden'].includes(t);
      }
      if (el instanceof HTMLTextAreaElement) return true;
      if (el.isContentEditable) return true;
      const role = (el.getAttribute && (el.getAttribute('role') || '').toLowerCase()) || '';
      return role === 'textbox' || role === 'searchbox' || role === 'combobox';
    }
  `
}

/**
 * In-page guard for typing scripts (browser_type / browser_type_smart /
 * browser_compose_message). Returns a blocked-marker object or null.
 */
export function buildInputGuardSnippetJs(allowPasswordFill: boolean): string {
  return `
    const __READY_LIVE_TARGET_GUARD__ = true;
    ${buildTargetSemanticsLibraryJs()}
    function readyInputGuard(el) {
      const label = readyInputSemanticsLabel(el);
      if (label && READY_DESTRUCTIVE_TARGET_PATTERNS.some((p) => p.test(label))) {
        return { __readyDestructiveTargetBlocked: true, label: label.slice(0, 80) };
      }
      if (readyIsPasswordField(el) && !${JSON.stringify(allowPasswordFill)}) {
        return { __readyPasswordFillBlocked: true };
      }
      return null;
    }
  `
}

/**
 * EP1-I3 live-target net — best-effort target probe for coordinate actions
 * (click_at / type_at). Returns `{ label, inputLabel, password }` for the
 * clickable owner under the CSS point. Callers refuse destructive-grant /
 * unconfirmed-password targets and proceed on empty probes. Probe exceptions
 * fail closed because the target guard did not actually run.
 */
function buildClickPointLabelProbeJs(cssX: number, cssY: number): string {
  return `(() => {
    const __READY_CLICK_POINT_LABEL_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const start = document.elementFromPoint(${JSON.stringify(Math.round(cssX))}, ${JSON.stringify(Math.round(cssY))});
    if (!start) return { label: '', inputLabel: '', password: false, editable: false, tag: '' };
    const owner = readyClickableOwner(start);
    return {
      label: readyClickSemanticsLabel(start),
      inputLabel: readyInputSemanticsLabel(owner),
      password: readyIsPasswordField(owner),
      // editable → the click only FOCUSES a field (judge by field semantics,
      // which exclude the current value); non-editable → the click is an
      // action (judge by the click/caption label, value included).
      editable: readyIsEditableField(owner),
      // D18-c：label 为空时模型分不清"点到空白容器"和"点到无名编辑器"——
      // 回传命中元素 tag 供闭环自纠（第十四轮实锚：click_at 命中 tiptap
      // 编辑器返回空 label，模型误判脱靶反复重点）。
      tag: String((start.tagName || '')).toLowerCase(),
      // R18（第十七轮实锚）：dash-tag host 命中时调用方要对 host rect 做
      // 组合树扫描，把 rect 一并回传省一次探测。
      rect: (() => {
        try {
          const r = start.getBoundingClientRect();
          return r && r.width > 0 && r.height > 0
            ? { left: r.left, top: r.top, width: r.width, height: r.height }
            : null;
        } catch (e) { return null; }
      })(),
    };
  })()`
}

/**
 * R18（真机第十七轮实锚）：点击"生效但无 map 变化"的第三种真相是页面弹了
 * 瞬时校验 toast——delta 的 bodyText 只取前 1000 字符，挂在 body 末尾的
 * toast 完全落在窗口外，changed=false 掩盖了页面已给出的拒绝理由。此探针
 * 收集当前可见的 toast/alert 类轻量提示文本（fixed/absolute 定位 + 短文本
 * + 非零尺寸），机械采集不判断语义。
 */
export function buildTransientNoticeProbeJs(): string {
  return `(() => {
    const out = [];
    const seen = new Set();
    const selector = '[class*="toast" i],[class*="notice" i],[class*="alert" i],[class*="tips" i],[class*="tip-" i],[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]';
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) {}
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      let cs = null;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || '1') <= 0.02) continue;
      const pos = cs.position;
      // toast 层几乎总是 fixed；absolute 需要高 z-index 才算（避免误收正文区块）
      if (pos !== 'fixed' && !(pos === 'absolute' && Number(cs.zIndex) >= 100)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.height > 220) continue;
      const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length < 2 || t.length > 140) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 5) break;
    }
    return out;
  })()`
}

export async function probeCoordinateTargetOrThrow(
  controller: BrowserController,
  tabId: string | null,
  point: { cssX: number; cssY: number },
  detail: { x: number; y: number; action: 'click' | 'type' },
): Promise<unknown> {
  try {
    return await controller.executeJS(tabId, buildClickPointLabelProbeJs(point.cssX, point.cssY))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const actionLabel = detail.action === 'click' ? '点击' : '输入'
    throw new ToolDomainError(
      ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code,
      `无法确认坐标${actionLabel}目标是否安全，已拒绝执行。请改用明确 selector/target_id，或引导用户亲自完成。`,
      {
        x: detail.x,
        y: detail.y,
        reason: 'coordinate_target_probe_failed',
        probeError: message,
      },
    )
  }
}

/**
 * EP1-I3 live-target net — probe of the currently FOCUSED field, used by the
 * send-keys guard: printable keystrokes land in whatever already has focus,
 * which can be a captcha/password field no argument ever named.
 */
export function buildFocusedFieldProbeJs(): string {
  return `(() => {
    const __READY_FOCUSED_FIELD_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const el = document.activeElement;
    if (!el || el === document.body) return { inputLabel: '', password: false };
    return {
      inputLabel: readyInputSemanticsLabel(el),
      password: readyIsPasswordField(el),
    };
  })()`
}

/**
 * D18-c（真机第十四轮实锚）：type_at 的聚焦点击落在不可聚焦位置时，焦点
 * 滞留在上一个控件（XHS 标题框），正文全文打进标题、模型毫无感知烧掉
 * 4 分钟。打字前探测点击后的真实焦点：kind=none（焦点回落 body）必须
 * 响亮拒绝打字；kind=frame（跨帧编辑器）无法验证放行；kind=editable /
 * non_editable 按可编辑性裁决。
 */
export function buildFocusedEditableProbeJs(): string {
  return `(() => {
    const __READY_FOCUSED_EDITABLE_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { kind: 'none', tag: el === document.body ? 'body' : 'html', label: '', password: false };
    }
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'iframe' || tag === 'frame' || tag === 'webview' || tag === 'object' || tag === 'embed') {
      return { kind: 'frame', tag, label: '', password: false };
    }
    const editable = readyIsEditableField(el);
    // D18-d：容量与形态信号——maxLength 装不下长文本的字段（标题框）与
    // 单行 input 必须能被工具层机械识别并拒打（第十六轮实锚：typedInto
    // 如实报告"输入标题"三次，模型三次无视继续灌——只报不拒救不了循环）。
    const rawMax = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? Number(el.maxLength) : -1;
    return {
      kind: editable ? 'editable' : 'non_editable',
      tag,
      label: editable ? readyInputSemanticsLabel(el) : readyClickSemanticsLabel(el),
      password: readyIsPasswordField(el),
      maxLength: rawMax > 0 ? rawMax : null,
      singleLine: el instanceof HTMLInputElement,
    };
  })()`
}

/**
 * D18-c：打完字回读文本真实落点（焦点元素身份 + 内容头部），让"打进了
 * 哪个框"在同一次工具结果里可见。密码框不回显内容。
 */
export function buildTypedIntoProbeJs(): string {
  return `(() => {
    const __READY_TYPED_INTO_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const tag = String(el.tagName || '').toLowerCase();
    const password = readyIsPasswordField(el);
    let text = '';
    if (!password) {
      if ('value' in el && typeof el.value === 'string') text = el.value;
      else text = String(el.innerText || el.textContent || '');
    }
    return {
      tag,
      label: readyInputSemanticsLabel(el),
      password,
      textHead: password ? '' : text.replace(/\\s+/g, ' ').trim().slice(0, 80),
      textLength: password ? 0 : text.length,
    };
  })()`
}

/**
 * Convert an in-page guard marker into the structured domain refusal
 * (ToolDomainError flows through the browser catch to the dispatcher).
 */
export function throwIfLiveTargetGuardBlocked(result: unknown, detail: Record<string, unknown>): void {
  if (!result || typeof result !== 'object') return
  const marker = result as { __readyDestructiveTargetBlocked?: unknown; __readyPasswordFillBlocked?: unknown; label?: unknown }
  if (marker.__readyDestructiveTargetBlocked === true) {
    const label = String(marker.label || '')
    throw new ToolDomainError(
      'grant_required',
      `目标「${label.slice(0, 80)}」命中浏览器破坏性动作清单，需要用户授予该目标的 Power grant 后才能执行。`,
      { ...detail, label },
    )
  }
  if (marker.__readyPasswordFillBlocked === true) {
    throw new ToolDomainError(
      ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code,
      '目标是密码输入框。请在调用参数中说明目标（如「登录密码输入框」），经用户确认后执行。',
      { ...detail, ruleId: 'm3-login-existing-account' },
    )
  }
}

export function buildBrowserActOnTargetJs(nodeId: string, action: AgentBrowserAction, value?: string): string {
  return `(() => {
    const __READY_AGENT_ACT_ON_TARGET__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    const nodeId = ${JSON.stringify(nodeId)};
    const action = ${JSON.stringify(action)};
    const value = ${JSON.stringify(value ?? '')};
    const nodeIndex = /^\\d+$/.test(nodeId) ? Number(nodeId) - 1 : -1;
    const elements = readyTargetElements();
    const el = nodeIndex >= 0 ? elements[nodeIndex] : null;
    if (!el) return { ok: false, errorCode: 'target_not_found', message: 'Target no longer resolves to an element.' };
    const record = readyTargetRecord(el, nodeIndex);
    if (record.states && record.states.disabled === true) {
      return { ok: false, errorCode: 'target_not_found', message: 'Target is disabled.', target: record };
    }
    let clickPoint = null;
    if (action === 'fill') {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        // D16-b（真机第十一轮实锚）：React 受控组件在实例上装 valueTracker，
        // 直接 el.value 赋值会被吞——DOM 有字、框架状态为空，表单校验静默
        // 失败（发布按钮人点也无反应）。走原型链原生 setter 绕过 tracker，
        // 再派发 input 让 React 读到真实变更。
        const __readyProto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const __readyNativeSet = (Object.getOwnPropertyDescriptor(__readyProto, 'value') || {}).set;
        if (__readyNativeSet) __readyNativeSet.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      } else {
        return { ok: false, errorCode: 'target_not_found', message: 'Target is not fillable.', target: record };
      }
    } else if (action === 'choose') {
      if (el instanceof HTMLSelectElement) {
        const option = Array.from(el.options).find((opt) => opt.value === value || readyCleanText(opt.textContent) === value);
        if (!option) return { ok: false, errorCode: 'target_not_found', message: 'Option not found.', target: record };
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.click();
      }
    } else if (action === 'hover') {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
    } else {
      // D10-c：React 委托型控件监听 pointerdown/mousedown，裸 el.click()
      // 对它们是 no-op。先派发指针序列，再 click() 保留原生激活语义
      // （anchor 导航/checkbox 默认行为）；对原生控件多出的前奏无害。
      // D14：Web Component 的真实按钮在 shadow root 内，host 上的合成事件
      // 到不了内部监听器。沿 elementFromPoint 逐层穿透 open shadow root，
      // 把事件派发到命中节点（composed 事件会经重定向冒泡回 host，两侧
      // 监听器各触发一次）；命中节点不属于 el 时保持原行为。
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dispatchTarget = el;
      try {
        let hit = document.elementFromPoint(cx, cy);
        let guard = 0;
        while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function' && guard < 5) {
          const inner = hit.shadowRoot.elementFromPoint(cx, cy);
          if (!inner || inner === hit) break;
          hit = inner;
          guard += 1;
        }
        const belongsToEl = (node) => {
          let n = node;
          for (let i = 0; n && i < 12; i++) {
            if (n === el) return true;
            if (n.parentElement) { n = n.parentElement; continue; }
            const root = n.getRootNode ? n.getRootNode() : null;
            n = root && root.host ? root.host : null;
          }
          return false;
        };
        if (hit && hit !== el && belongsToEl(hit)) dispatchTarget = hit;
      } catch {}
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };
      dispatchTarget.dispatchEvent(new PointerEvent('pointerdown', opts));
      dispatchTarget.dispatchEvent(new MouseEvent('mousedown', opts));
      dispatchTarget.dispatchEvent(new PointerEvent('pointerup', opts));
      dispatchTarget.dispatchEvent(new MouseEvent('mouseup', opts));
      if (typeof dispatchTarget.click === 'function') dispatchTarget.click();
      else el.click();
      // D18：closed shadow root 内的监听器对上面整套合成事件仍然不可达
      // （事件不会向 shadow 内部传播，host.click() 也点不到内部按钮）。
      // 把点击坐标交回工具层，readBack 判无效果时由主进程升级为可信
      // 指针输入（与 browser_click_at 同通道，走真实命中测试）。
      // D18-b：回传 host 的 shadow 可达性。closed/无 shadowRoot 的自定义
      // host（dash tag）合成点击必然是 no-op——工具层对这类目标无条件升级，
      // 不再被动态页面（轮播/占位符轮换）造成的 changed:true 假信号压制
      // （真机第十三轮实锚：发布按钮 act ok 但升级被 changed 假信号跳过）。
      clickPoint = {
        x: cx,
        y: cy,
        vw: Number(window.innerWidth || 0),
        vh: Number(window.innerHeight || 0),
        hostShadow: (el.tagName && el.tagName.indexOf('-') !== -1)
          ? (el.shadowRoot ? 'open' : 'closed_or_none')
          : null,
        // D18-c：host 包围盒可能横跨整个按钮组（真机第十四轮实锚：
        // xhs-publish-btn 的 rect 中心落在「暂存离开/发布」之间的死区，
        // 可信升级点击点空）。把完整 rect 交回工具层，升级前先经 CDP
        // 组合树命中测试在 rect 内扫描真实内部按钮。
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    }
    return { ok: true, action, target: record, url: String(location.href || ''), title: String(document.title || ''), clickPoint };
  })()`
}

export function buildBrowserActionDeltaJs(): string {
  return `(() => ({
    url: String(location.href || ''),
    title: String(document.title || ''),
    bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000)
  }))()`
}

