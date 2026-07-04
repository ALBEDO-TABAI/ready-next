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
      const alt = readyCleanText(el.getAttribute('alt'));
      if (alt) return alt;
      const name = readyCleanText(el.getAttribute('name'));
      if (name) return name;
      if (el instanceof HTMLInputElement && el.type === 'file') return 'file input';
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
      return semantic.concat(readyPointerClickableElements(new Set(semantic)));
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
        if (el.closest && el.closest(READY_AGENT_TARGET_SELECTOR)) continue;
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
    if (!start) return { label: '', inputLabel: '', password: false, editable: false };
    const owner = readyClickableOwner(start);
    return {
      label: readyClickSemanticsLabel(start),
      inputLabel: readyInputSemanticsLabel(owner),
      password: readyIsPasswordField(owner),
      // editable → the click only FOCUSES a field (judge by field semantics,
      // which exclude the current value); non-editable → the click is an
      // action (judge by the click/caption label, value included).
      editable: readyIsEditableField(owner),
    };
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
    if (action === 'fill') {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.value = value;
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
      // 对它们是 no-op。先派发指针序列，再 el.click() 保留原生激活语义
      // （anchor 导航/checkbox 默认行为）；对原生控件多出的前奏无害。
      const rect = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
    }
    return { ok: true, action, target: record, url: String(location.href || ''), title: String(document.title || '') };
  })()`
}

export function buildBrowserActionDeltaJs(): string {
  return `(() => ({
    url: String(location.href || ''),
    title: String(document.title || ''),
    bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000)
  }))()`
}

