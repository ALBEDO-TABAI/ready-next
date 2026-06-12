/**
 * Browser tool definitions + executor for AI tool calling.
 * Provides browser control tools in both Anthropic and OpenAI formats.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import { broadcastDirectoryChanged } from '../document-engine/ipc/directory-change-broadcast'
import { BrowserAgentRuntimeAdapter } from '../browser-engine/agent-runtime-adapter'
import { BrowserPageStateService } from '../browser-engine/page-state-service'
import { BrowserEvidenceService } from '../browser-engine/evidence-service'
import { access, mkdir, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { constants as fsConstants, existsSync } from 'fs'
import { basename, extname, join } from 'path'
import { homedir } from 'os'
import { analyzeViewportWithVision } from './browser-vision'
import { domainsLikelyMatch } from '../agent-control/domain-adapters/browser-action-heuristics'
import { AgentRepository } from '../repositories/agent-repository'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import {
  getBrowserAnthropicTools,
  getBrowserOpenAITools,
} from './browser-tool-catalog'
import type {
  BrowserCapabilityTaskHandle,
  BrowserStructuredFieldMapping,
} from '../browser-engine/capability-types'
import { normalizeBrowserTaskFailedItems } from '../browser-engine/content-task-runner'
import { beginLeaseGate, type BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import {
  buildBrowserReadonlyProbeJs,
  normalizeBrowserReadonlyProbeRequest,
} from '../../../shared/browser-readonly-probe'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { ToolDomainError } from './tool-errors'
import {
  MANUAL_ONLY_TARGET_REGEX_SOURCES,
  argsCarryPasswordCue,
  matchManualOnlyBrowserTarget,
} from '../agent-control/safety/action-confirmation-policy'
import { buildPageMap, parseTargetId, type PageMap, type RawAxNode } from '../browser-engine/agent-browser-page-map'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import { normalizeCollectionTargets, targetsFromTask, type BrowserCollectionTarget } from '../browser-engine/collection-targets'
import { buildCollectionHandoffPlanFromTask, buildCollectionPlanNotes } from '../browser-engine/collection-handoff'
import {
  BrowserCollectionConsentStore,
  type BrowserCollectionConsentRecord,
  type PendingBrowserCollectionConsentRequest,
} from '../browser-engine/browser-collection-consent'
import { resolveFastCardVideo } from '../browser-engine/fastcard-video-resolver'
import type { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import type { ScopeRunSkillProgress } from '../agent-control/contracts/types'
import type { TaskProjectionRecord } from '../agent-control/contracts/run-contracts'

const logger = createRotatingLogger('ready-tools.log')
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

let collectionConsentStore = new BrowserCollectionConsentStore()
const browserPageMapGenerationByTab = new Map<string, number>()
const browserPageMapAmbiguityByTab = new Map<string, Map<string, { role: string; name: string; targetIds: string[] }>>()

export function __setBrowserCollectionConsentStoreForTests(store: BrowserCollectionConsentStore | null): void {
  collectionConsentStore = store || new BrowserCollectionConsentStore()
}

export function __resetBrowserAgentPageMapForTests(): void {
  browserPageMapGenerationByTab.clear()
  browserPageMapAmbiguityByTab.clear()
}

function resolveBrowserToolTabKey(controller: BrowserController, tabId: string | null): string {
  return tabId || controller.getActiveTab?.()?.id || '__active__'
}

function nextBrowserPageMapGeneration(controller: BrowserController, tabId: string | null): number {
  const key = resolveBrowserToolTabKey(controller, tabId)
  const next = (browserPageMapGenerationByTab.get(key) || 0) + 1
  browserPageMapGenerationByTab.set(key, next)
  return next
}

function currentBrowserPageMapGeneration(controller: BrowserController, tabId: string | null): number | null {
  return browserPageMapGenerationByTab.get(resolveBrowserToolTabKey(controller, tabId)) ?? null
}

function rememberBrowserPageMapAmbiguity(
  controller: BrowserController,
  tabId: string | null,
  groups: Array<{ role: string; name: string; targetIds: string[] }>,
): void {
  const byTarget = new Map<string, { role: string; name: string; targetIds: string[] }>()
  for (const group of groups) {
    for (const targetId of group.targetIds) {
      byTarget.set(targetId, group)
    }
  }
  browserPageMapAmbiguityByTab.set(resolveBrowserToolTabKey(controller, tabId), byTarget)
}

function currentBrowserPageMapAmbiguity(
  controller: BrowserController,
  tabId: string | null,
  targetId: string,
): { role: string; name: string; targetIds: string[] } | null {
  return browserPageMapAmbiguityByTab.get(resolveBrowserToolTabKey(controller, tabId))?.get(targetId) || null
}

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
      return Array.from(document.querySelectorAll(READY_AGENT_TARGET_SELECTOR));
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

function buildBrowserPageMapProbeJs(): string {
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

function buildBrowserTargetProbeJs(nodeId: string): string {
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
 * The M1 patterns are generated from the policy module (single source).
 */
function buildTargetSemanticsLibraryJs(): string {
  return `
    const READY_MANUAL_ONLY_PATTERNS = [${MANUAL_ONLY_TARGET_REGEX_SOURCES.map((src) => `new RegExp(${JSON.stringify(src)}, 'i')`).join(', ')}];
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
function buildInputGuardSnippetJs(allowPasswordFill: boolean): string {
  return `
    const __READY_LIVE_TARGET_GUARD__ = true;
    ${buildTargetSemanticsLibraryJs()}
    function readyInputGuard(el) {
      const label = readyInputSemanticsLabel(el);
      if (label && READY_MANUAL_ONLY_PATTERNS.some((p) => p.test(label))) {
        return { __readyManualOnlyBlocked: true, label: label.slice(0, 80) };
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
 * clickable owner under the CSS point. Callers refuse M1 /
 * unconfirmed-password targets and proceed on empty or failed probes (the
 * visual channel must keep working).
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

/**
 * EP1-I3 live-target net — probe of the currently FOCUSED field, used by the
 * send-keys guard: printable keystrokes land in whatever already has focus,
 * which can be a captcha/password field no argument ever named.
 */
function buildFocusedFieldProbeJs(): string {
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
function throwIfLiveTargetGuardBlocked(result: unknown, detail: Record<string, unknown>): void {
  if (!result || typeof result !== 'object') return
  const marker = result as { __readyManualOnlyBlocked?: unknown; __readyPasswordFillBlocked?: unknown; label?: unknown }
  if (marker.__readyManualOnlyBlocked === true) {
    const label = String(marker.label || '')
    throw new ToolDomainError(
      'denied_manual_only',
      `目标「${label.slice(0, 80)}」命中 M1 规则（支付确认/改密提交/验证码必须由用户亲手完成）。请引导用户亲自完成这一步，不要代替执行或绕过。`,
      { ...detail, label },
    )
  }
  if (marker.__readyPasswordFillBlocked === true) {
    throw new ToolDomainError(
      'denied_pending_confirmation',
      '目标是密码输入框。请在调用参数中说明目标（如「登录密码输入框」），经用户确认后执行。',
      { ...detail, ruleId: 'm3-login-existing-account' },
    )
  }
}

function buildBrowserActOnTargetJs(nodeId: string, action: AgentBrowserAction, value?: string): string {
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
      el.click();
    }
    return { ok: true, action, target: record, url: String(location.href || ''), title: String(document.title || '') };
  })()`
}

function buildBrowserActionDeltaJs(): string {
  return `(() => ({
    url: String(location.href || ''),
    title: String(document.title || ''),
    bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000)
  }))()`
}

function buildPageMapAmbiguityGroups(targets: PageMap['targets']): Array<{ role: string; name: string; targetIds: string[] }> {
  const groups = new Map<string, { role: string; name: string; targetIds: string[] }>()
  for (const target of targets) {
    const name = String(target.name || '').trim()
    if (!name) continue
    const key = `${target.role}::${name.toLowerCase()}`
    const group = groups.get(key) || { role: target.role, name, targetIds: [] }
    group.targetIds.push(target.targetId)
    groups.set(key, group)
  }
  return Array.from(groups.values()).filter((group) => group.targetIds.length > 1)
}

async function captureAgentPageMap(
  controller: BrowserController,
  tabId: string | null,
  maxBytes?: number,
): Promise<Record<string, unknown>> {
  const raw = await controller.executeJS(tabId, buildBrowserPageMapProbeJs()) as {
    identity?: { url?: string; title?: string }
    viewport?: { width?: number; height?: number }
    bodyText?: string
    rawRoots?: RawAxNode[]
    riskFlags?: Record<string, unknown>
    structureHints?: Record<string, unknown>
  } | null
  const generation = nextBrowserPageMapGeneration(controller, tabId)
  const viewport = {
    width: Number(raw?.viewport?.width || 0) || 0,
    height: Number(raw?.viewport?.height || 0) || 0,
  }
  const map = buildPageMap(Array.isArray(raw?.rawRoots) ? raw.rawRoots : [], {
    generation,
    viewport,
    ...(maxBytes ? { maxBytes } : {}),
  })
  const ambiguityGroups = buildPageMapAmbiguityGroups(map.targets)
  rememberBrowserPageMapAmbiguity(controller, tabId, ambiguityGroups)
  return {
    pageIdentity: {
      url: String(raw?.identity?.url || ''),
      title: String(raw?.identity?.title || ''),
      generation,
      capturedAt: new Date().toISOString(),
    },
    summary: {
      bodyText: String(raw?.bodyText || '').slice(0, 1000),
      targetCount: map.targets.length,
      truncated: map.truncated,
    },
    pageMap: {
      ...map,
      structureHints: raw?.structureHints || { iframes: [], shadowRoots: [], hiddenLoaded: [] },
    },
    ambiguityGroups,
    riskFlags: raw?.riskFlags || {},
    evidence: {
      generation,
      targetSource: 'dom-target-library',
      targetCount: map.targets.length,
      truncated: map.truncated,
    },
    nextAllowedActions: ['read map again', 'act on target', 'wait', 'stop with reason'],
  }
}

function didBrowserActionChange(before: unknown, after: unknown): boolean {
  if (before === null || after === null || before === undefined || after === undefined) return false
  try {
    return JSON.stringify(before) !== JSON.stringify(after)
  } catch {
    return true
  }
}

function collectionConsentMessage(request: PendingBrowserCollectionConsentRequest): string {
  if (request.consentKind === 'high_control_url_batch_downgrade') {
    return request.warningText || '高风控平台需要用户明确确认后，才允许使用 URL 批处理采集。'
  }
  return '发现清单尚未证明是完整全量，需要用户明确确认后，才允许只采集当前冻结的部分内容。'
}

async function upsertCollectionConsentProjection(
  runtime: AgentControlRuntime | null | undefined,
  request: PendingBrowserCollectionConsentRequest | undefined,
  summary?: string,
): Promise<void> {
  if (!runtime || !request?.scopeId || !request.sourceTaskId) return
  const store = runtime.getTaskProjectionStore()
  const existing = await store.get(request.sourceTaskId)
  const now = new Date().toISOString()
  const message = summary || collectionConsentMessage(request)
  const progress: ScopeRunSkillProgress = {
    stage: 'pending_consent',
    completed: existing?.progress?.completed ?? null,
    total: existing?.progress?.total ?? null,
    coverage: existing?.progress?.coverage ?? null,
    overallCoverage: existing?.progress?.overallCoverage ?? null,
    fingerprint: request.requestId,
    updatedAt: now,
    lastError: null,
    detail: message,
    activityUpdatedAt: now,
    browserCollectionConsent: {
      requestId: request.requestId,
      consentKind: request.consentKind,
      sourceTaskId: request.sourceTaskId,
      targetHost: request.targetHost || null,
      warningText: request.warningText || null,
      message,
      createdAt: request.createdAt || now,
    },
  }
  const record: TaskProjectionRecord = {
    taskId: request.sourceTaskId,
    scopeId: request.scopeId,
    runId: request.requestId,
    taskType: existing?.taskType || 'multi_step_task',
    module: 'browser',
    taskTitle: existing?.taskTitle || '浏览器采集确认',
    taskSummary: message,
    status: 'blocked',
    interactionState: 'awaiting_confirmation',
    waitingFor: 'confirmation',
    steps: existing?.steps || [],
    currentStepId: existing?.currentStepId || null,
    budget: existing?.budget || null,
    budgetUsagePercent: existing?.budgetUsagePercent ?? null,
    budgetWarningLevel: existing?.budgetWarningLevel ?? null,
    recoveryHistory: existing?.recoveryHistory || [],
    degradationReason: existing?.degradationReason ?? null,
    blockedReason: message,
    resumableActions: existing?.resumableActions || [],
    continuationRef: existing?.continuationRef || null,
    progress,
    recentArtifacts: existing?.recentArtifacts || [],
    canResume: existing?.canResume ?? false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  if (existing) await store.update(request.sourceTaskId, record)
  else await store.create(record)
}

async function clearCollectionConsentProjection(
  runtime: AgentControlRuntime | null | undefined,
  record: BrowserCollectionConsentRecord,
): Promise<void> {
  if (!runtime || !record.scopeId || !record.sourceTaskId) return
  const store = runtime.getTaskProjectionStore()
  const existing = await store.get(record.sourceTaskId)
  if (!existing) return
  const now = new Date().toISOString()
  await store.update(record.sourceTaskId, {
    taskSummary: '采集确认已记录，可以继续。',
    status: 'recoverable_paused',
    interactionState: 'suspended',
    waitingFor: 'none',
    blockedReason: null,
    progress: {
      ...(existing.progress || {
        stage: null,
        completed: null,
        total: null,
        coverage: null,
        fingerprint: null,
        updatedAt: null,
        lastError: null,
      }),
      updatedAt: now,
      lastError: null,
      detail: '采集确认已记录，可以继续。',
      browserCollectionConsent: null,
    },
    updatedAt: now,
  })
}

function targetHostForCollection(profileUrl: string, notes: Array<{ url: string }>): string {
  for (const value of [profileUrl, ...notes.map((note) => note.url)]) {
    try {
      const host = new URL(value).host
      if (host) return host
    } catch {
      // silent-catch: invalid candidate URL; try the next collection target.
    }
  }
  return ''
}

function normalizeUrlForProvenance(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
    return url.toString()
  } catch {
    // silent-catch: non-URL provenance values fall back to raw text matching.
    return String(value || '').trim()
  }
}

function userTextContainsUrl(userText: string, value: string): boolean {
  const haystack = String(userText || '')
  if (!haystack || !value) return false
  if (haystack.includes(value)) return true
  const normalized = normalizeUrlForProvenance(value)
  if (normalized && haystack.includes(normalized)) return true
  try {
    const url = new URL(value)
    const withoutTrailingSlash = url.toString().replace(/\/+$/g, '')
    if (withoutTrailingSlash && haystack.includes(withoutTrailingSlash)) return true
    const decoded = decodeURIComponent(url.toString())
    if (decoded && haystack.includes(decoded)) return true
  } catch {
    // silent-catch: non-URL provenance values are checked as raw strings only.
  }
  return false
}

function missingUserProvidedUrls(notes: BrowserCollectionTarget[], currentUserText: string): string[] {
  return notes
    .map((note) => note.openUrl || note.canonicalUrl || note.url)
    .filter((url) => !userTextContainsUrl(currentUserText, url))
}

function createBrowserAgentHelpers(controller: BrowserController) {
  const runtime = new BrowserAgentRuntimeAdapter(controller)
  const pageStateService = new BrowserPageStateService(runtime)
  const evidenceService = new BrowserEvidenceService()
  return { runtime, pageStateService, evidenceService }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function originOfUrl(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    // silent-catch: invalid URL has no origin for same-origin comparison.
    return null
  }
}

function browserTaskTimestampMs(task: BrowserCapabilityTaskHandle): number {
  const raw = task.updatedAt || task.createdAt || ''
  const parsed = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function resultObject(task: BrowserCapabilityTaskHandle | null): Record<string, unknown> | null {
  return task?.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
}

function sourceTaskDiscoveryStatus(task: BrowserCapabilityTaskHandle | null): 'complete' | 'partial' | 'paused' | 'unknown' {
  const result = resultObject(task)
  const explicit = String(result?.discoveryStatus || '').trim()
  if (explicit === 'complete' || explicit === 'partial' || explicit === 'paused') return explicit
  const stopReason = String(result?.stopReason || '').trim()
  if (stopReason === 'no_new_content') return 'complete'
  if (stopReason === 'cancelled' || stopReason === 'lease_lost') return 'paused'
  if (stopReason) return 'partial'
  return 'unknown'
}

function isCompleteSourceTask(task: BrowserCapabilityTaskHandle | null): boolean {
  return Boolean(task && task.kind === 'visible_collect' && task.status === 'completed' && sourceTaskDiscoveryStatus(task) === 'complete')
}

function mediaUrlsFromVisibleCollectTask(task: BrowserCapabilityTaskHandle | null): string[] {
  const result = resultObject(task)
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: unknown): void => {
    const url = String(value || '').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    out.push(url)
  }
  if (Array.isArray(result?.mediaCandidates)) {
    for (const value of result.mediaCandidates) push(value)
  }
  if (out.length > 0) return out
  const items = Array.isArray(result?.items) ? result.items : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (Array.isArray(record.media)) {
      for (const value of record.media) push(value)
    }
    push(record.link)
    push(record.image)
    const rawFields = record.rawFields && typeof record.rawFields === 'object'
      ? record.rawFields as Record<string, unknown>
      : null
    push(rawFields?.link)
    push(rawFields?.image)
    if (Array.isArray(rawFields?.media)) {
      for (const value of rawFields.media) push(value)
    }
  }
  return out
}

/** EP2 dogfood gap 1 — when this scope already ran an image-gallery
 *  discovery, raw URL downloads break the collection chain (card never
 *  learns about the files). Find the newest completed gallery source task
 *  for the scope so the dispatch can redirect. */
async function findScopeImageGallerySourceTask(
  controller: BrowserController,
  scopeId: string | null | undefined,
): Promise<BrowserCapabilityTaskHandle | null> {
  if (!scopeId) return null
  const list = (controller as { listTasksByKind?: (kind: string) => Promise<BrowserCapabilityTaskHandle[]> }).listTasksByKind
  if (typeof list !== 'function') return null
  try {
    const tasks = await list.call(controller, 'visible_collect')
    const getPayload = (controller as { getTaskPayload?: (taskId: string) => Record<string, unknown> | null }).getTaskPayload
    const candidates = tasks.filter((task) => {
      if (task.status !== 'completed') return false
      const payload = typeof getPayload === 'function' ? (getPayload.call(controller, task.taskId) || null) : null
      if (stringField(payload?.scopeId) !== scopeId) return false
      return isImageGallerySourceTask(task, payload) && mediaUrlsFromVisibleCollectTask(task).length > 0
    })
    return candidates.sort((a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null
  } catch {
    return null
  }
}

function isImageGallerySourceTask(
  task: BrowserCapabilityTaskHandle | null,
  payload: Record<string, unknown> | null,
): boolean {
  if (!task || task.kind !== 'visible_collect') return false
  const result = resultObject(task)
  return String(result?.template || payload?.template || '').trim() === 'image_gallery'
}

function hasSharedOrigin(
  left: Array<{ url: string }>,
  right: Array<{ url: string }>,
): boolean {
  const origins = new Set(left.map((item) => originOfUrl(item.url)).filter(Boolean))
  if (origins.size === 0) return false
  return right.some((item) => {
    const origin = originOfUrl(item.url)
    return Boolean(origin && origins.has(origin))
  })
}

async function findLargerRecentFrozenCollection(
  controller: BrowserController,
  notes: Array<{ url: string }>,
): Promise<{ taskId: string; count: number } | null> {
  const listTasks = (controller as { listAgentCollectionTasks?: () => Promise<BrowserCapabilityTaskHandle[]> }).listAgentCollectionTasks
  if (typeof listTasks !== 'function' || notes.length === 0) return null

  const now = Date.now()
  const tasks = await listTasks.call(controller)
  for (const task of tasks) {
    if (task.kind !== 'visible_collect') continue
    const timestamp = browserTaskTimestampMs(task)
    if (timestamp > 0 && now - timestamp > RECENT_COLLECTION_HANDOFF_WINDOW_MS) continue
    const frozen = targetsFromTask(task)
    if (frozen.length <= notes.length) continue
    if (!hasSharedOrigin(frozen, notes)) continue
    return { taskId: task.taskId, count: frozen.length }
  }
  return null
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function enrichBrowserTaskPayload(task: BrowserCapabilityTaskHandle): BrowserCapabilityTaskHandle & {
  failedItems: ReturnType<typeof normalizeBrowserTaskFailedItems>
  suggestedNextAction: string
} {
  const result = task.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
  const failedItems = normalizeBrowserTaskFailedItems(result?.failed)
  return {
    ...task,
    failedItems,
    suggestedNextAction: failedItems.length === 0
      ? 'done'
      : failedItems.some((item) => item.retryable)
        ? 'retry_failed'
        : 'review_manually',
  }
}

function normalizedPathField(value: unknown): string {
  const raw = stringField(value)
  return raw ? expandHomePath(raw) : ''
}

function sourceTaskHandoffMismatch(
  sourceTaskId: string,
  sourcePayload: Record<string, unknown> | null,
  sourceResult: Record<string, unknown> | null,
  sessionId: string | undefined,
  requestedOutputRootDir: string,
): { errorCode: string; message: string } | null {
  const sourceScopeId = stringField(sourcePayload?.scopeId)
  if (sessionId && sourceScopeId && sourceScopeId !== sessionId) {
    return {
      errorCode: 'stale_source_task_scope',
      message: `source_task_id ${sourceTaskId} 属于另一个会话，不能接力到当前采集。请使用本轮 browser_visible_collect 返回的 source_task_id。`,
    }
  }
  const sourceOutputRootDir = normalizedPathField(sourceResult?.outputRootDir) || normalizedPathField(sourcePayload?.outputRootDir)
  if (requestedOutputRootDir && sourceOutputRootDir && sourceOutputRootDir !== requestedOutputRootDir) {
    return {
      errorCode: 'stale_source_task_output',
      message: `source_task_id ${sourceTaskId} 的保存目录与当前请求不一致，不能用旧发现清单接力。请使用本轮 browser_visible_collect 返回的 source_task_id。`,
    }
  }
  return null
}

async function startCollectionFromCompletedVisibleTask(
  controller: BrowserController,
  sourceTask: BrowserCapabilityTaskHandle,
  sessionId?: string,
): Promise<unknown | null> {
  if (!isCompleteSourceTask(sourceTask)) return null
  const existing = await (controller as {
    findCollectionTaskBySourceTaskId?: (sourceTaskId: string) => Promise<BrowserCapabilityTaskHandle | null>
  }).findCollectionTaskBySourceTaskId?.(sourceTask.taskId)
  if (existing) return existing
  const handoff = buildCollectionHandoffPlanFromTask(sourceTask)
  if (!handoff) return null
  if (handoff.strategy === 'card_loop') {
    const startCardLoopCollection = (controller as { startCardLoopCollection?: (plan: Record<string, unknown>, scopeId?: string) => Promise<unknown> }).startCardLoopCollection
    if (typeof startCardLoopCollection !== 'function') {
      return {
        ok: false,
        errorCode: 'card_loop_not_ready',
        message: 'browser_resume_task 收到已完成发现任务，但 card_loop runner 未注册。',
        sourceTaskId: sourceTask.taskId,
      }
    }
    return startCardLoopCollection.call(controller, handoff.plan, sessionId)
  }
  return controller.startNoteCollection(handoff.plan, sessionId)
}

/**
 * WP3 — high-control platform script blacklist (plan §4.4). On strong-detection
 * platforms (小红书/抖音/微博/…), script-hard tools and script params are refused;
 * only visible / template DOM collection is allowed. Returns a structured
 * rejection string when blocked, or null when permitted.
 */
/**
 * Every URL this call could actually operate on: the active tab, the tab the
 * call explicitly targets via `tab_id`, an explicit `args.url`, and any target
 * URL inside `run_workflow` steps. Used by both the high-control script guard
 * and the visible_collect rate-limit decision so neither can be bypassed by
 * leaving a benign page active while pointing the call at a high-control page.
 */
function resolveCandidateTargetUrls(
  args: Record<string, unknown>,
  controller: BrowserController,
): string[] {
  const urls: string[] = []
  try {
    const active = controller.getActiveTab?.()?.url
    if (active) urls.push(active)
  } catch { /* silent-catch: optional controller state may be unavailable in tests. */ }
  if (typeof args.tab_id === 'string') {
    try {
      const tab = controller.getTabList?.().find((t) => t.id === args.tab_id)
      if (tab?.url) urls.push(tab.url)
    } catch { /* silent-catch: optional controller tab lookup may be unavailable in tests. */ }
  }
  if (typeof args.url === 'string') urls.push(args.url)
  if (Array.isArray(args.steps)) {
    for (const step of args.steps) {
      if (step && typeof step === 'object') {
        const s = step as Record<string, unknown>
        for (const key of ['url', 'target', 'href']) {
          if (typeof s[key] === 'string') urls.push(s[key] as string)
        }
      }
    }
  }
  // browser_start_task / thin task adapters carry the target URL(s) inside payload.
  const payload = args.payload && typeof args.payload === 'object' ? (args.payload as Record<string, unknown>) : null
  if (payload) {
    if (typeof payload.url === 'string') urls.push(payload.url)
    if (Array.isArray(payload.urls)) {
      for (const u of payload.urls) if (typeof u === 'string') urls.push(u)
    }
  }
  return urls
}

function resolvePrimaryBrowserTargetUrl(
  args: Record<string, unknown>,
  controller: BrowserController,
): string {
  if (typeof args.url === 'string' && args.url.trim()) return args.url.trim()
  const tabId = typeof args.tab_id === 'string' ? args.tab_id : ''
  try {
    if (tabId) {
      const tab = controller.getTabList?.().find((item) => item.id === tabId)
      if (tab?.url) return tab.url
    }
  } catch { /* silent-catch: optional controller tab lookup may be unavailable in tests. */ }
  try {
    return controller.getActiveTab?.()?.url || ''
  } catch {
    // silent-catch: optional active-tab lookup may be unavailable in tests.
    return ''
  }
}

async function resolveHighControlAgentTab(
  controller: BrowserController,
  args: Record<string, unknown>,
  options?: { navigateToTarget?: boolean; signal?: AbortSignal },
): Promise<{ tabId: string | null; redirected: boolean }> {
  const requestedTabId = typeof args.tab_id === 'string' ? args.tab_id : null
  const collectionSurface = typeof args.collection_surface === 'string' ? args.collection_surface : ''
  const targetUrl = resolvePrimaryBrowserTargetUrl(args, controller)
  if (!isHighControlPlatformText(targetUrl)) {
    return { tabId: requestedTabId, redirected: false }
  }

  if (requestedTabId && collectionSurface === 'user-view') {
    try {
      controller.switchTab?.(requestedTabId)
    } catch (error) {
      log(`resolveHighControlAgentTab switchTab failed tabId=${requestedTabId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { tabId: requestedTabId, redirected: false }
  }

  try {
    const requestedTab = requestedTabId
      ? controller.getTabList?.().find((item) => item.id === requestedTabId)
      : null
    if (requestedTab?.owner === 'agent') {
      return { tabId: requestedTabId, redirected: false }
    }
  } catch { /* silent-catch: optional controller tab lookup may be unavailable in tests. */ }

  const ensureAgentTab = (controller as { ensureAgentTab?: () => Promise<string> }).ensureAgentTab
  if (typeof ensureAgentTab !== 'function') {
    return { tabId: requestedTabId, redirected: false }
  }

  const agentTabId = await ensureAgentTab.call(controller)
  if (options?.navigateToTarget !== false && targetUrl) {
    const agentTab = controller.getTabList?.().find((item) => item.id === agentTabId)
    if (!activePageLikelyMatchesTarget(agentTab?.url, targetUrl)) {
      const nav = await controller.navigate(agentTabId, targetUrl)
      if (!nav.success) throw new Error(nav.error || 'failed to navigate agent tab')
      await waitForReady(controller, agentTabId, 10_000, undefined, options?.signal).catch(() => null)
    }
  }
  return { tabId: agentTabId, redirected: true }
}

/** True when a start_task payload carries a page-executing script param. */
function startTaskPayloadHasScript(args: Record<string, unknown>): boolean {
  const payload = args.payload && typeof args.payload === 'object' ? (args.payload as Record<string, unknown>) : null
  if (!payload) return false
  if (typeof payload.customScript === 'string' && payload.customScript.trim().length > 0) return true
  const wait = payload.wait && typeof payload.wait === 'object' ? (payload.wait as Record<string, unknown>) : null
  if (wait) {
    if (wait.condition === 'custom_js') return true
    if (typeof wait.customJs === 'string' && (wait.customJs as string).trim().length > 0) return true
  }
  return false
}

function highControlScriptGuard(
  toolName: string,
  args: Record<string, unknown>,
  candidateUrls: string[],
): string | null {
  if (!candidateUrls.some((url) => isHighControlPlatformText(url))) return null
  const hasCustomScript = typeof args.custom_script === 'string' && args.custom_script.trim().length > 0
  const hasCustomJs =
    args.condition === 'custom_js' || (typeof args.custom_js === 'string' && (args.custom_js as string).trim().length > 0)
  const blocked =
    toolName === 'browser_execute_js' ||
    toolName === 'browser_run_workflow' ||
    ((toolName === 'browser_extract_structured' || toolName === 'browser_scroll_collect') && hasCustomScript) ||
    (toolName === 'browser_wait_for_condition' && hasCustomJs) ||
    // browser_start_task wraps scroll_collect/research and can carry a page
    // script in payload.customScript / payload.wait.customJs (Codex R3) — block
    // it on high-control platforms so the start_task wrapper can't bypass.
    (toolName === 'browser_start_task' && startTaskPayloadHasScript(args))
  if (!blocked) return null
  return JSON.stringify(
    agentBrowserError(
      'script_blocked',
      '该平台为强检测平台，已禁用脚本硬操作（execute_js / run_workflow / custom_script / custom_js）。请改用可见采集：browser_read_page、browser_collect_images、browser_visible_collect（模板路径）、browser_capture_viewport、滚动。',
      { highControlPlatform: true, tool: toolName },
    ),
  )
}

function activePageLikelyMatchesTarget(activeUrl: string | undefined, target: string): boolean {
  if (!activeUrl || !target) return false
  try {
    const active = new URL(activeUrl)
    const next = new URL(target)
    if (active.origin === next.origin && active.pathname === next.pathname && active.search === next.search) return true
    return domainsLikelyMatch(activeUrl, target)
  } catch {
    return String(activeUrl).trim().toLowerCase() === String(target).trim().toLowerCase()
  }
}

type SearchEngine = 'auto' | 'google' | 'duckduckgo' | 'bing' | 'baidu'
export function getAnthropicTools(): Array<Record<string, unknown>> {
  return getBrowserAnthropicTools()
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return getBrowserOpenAITools()
}

// ── Browser Tool Executor ───────────────────────────────────────────

const MAX_RESULT_LENGTH = 20_000
const BROWSER_V2_WAIT_AFTER_NAV_MS = 250
const BROWSER_V2_STOP_LOADING_TIMEOUT_MS = 15_000
const BROWSER_V3_ACTION_SETTLE_MS = 220
const TOOL_CONTROLLER_ID = 'primary-browser-controller'
const RECENT_COLLECTION_HANDOFF_WINDOW_MS = 30 * 60 * 1000

const screenshotCache = new Map<string, { base64: string; width: number; height: number; createdAt: number }>()
const SCREENSHOT_CACHE_MAX = 30

function resolveToolContextMeta(
  controller: BrowserController,
  tabId: string | null,
): { controllerId: string; tabRole: 'current' | 'owned' | 'required' | 'background' | 'unknown' } {
  const tabs = controller.getTabList()
  const resolved = tabId
    ? tabs.find((tab) => tab.id === tabId) || tabs.find((tab) => tab.active)
    : tabs.find((tab) => tab.active)
  if (!resolved) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'unknown' }
  }
  if (resolved.required) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'required' }
  }
  if (resolved.owner === 'agent') {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'owned' }
  }
  if (resolved.active) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'current' }
  }
  return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'background' }
}

function truncate(s: string, max = MAX_RESULT_LENGTH): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... (truncated, ${s.length} total chars)`
}

function searchUrl(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query)
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${q}`
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${q}`
    case 'bing':
      return `https://www.bing.com/search?q=${q}`
    case 'baidu':
      return `https://www.baidu.com/s?wd=${q}`
    default:
      return `https://duckduckgo.com/?q=${q}`
  }
}

function expandHomePath(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return join(homedir(), 'Documents')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

function sanitizeFilename(input: string, fallback = 'download'): string {
  let sanitized = ''
  for (const char of String(input || '')) {
    const code = char.charCodeAt(0)
    sanitized += code <= 31 || '<>:"/\\|?*'.includes(char) ? '-' : char
  }
  const cleaned = sanitized
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) return fallback
  return cleaned.slice(0, 120)
}

function safeHostname(input: string): string | undefined {
  try {
    return new URL(input).hostname
  } catch {
    // silent-catch: malformed URL input simply has no hostname for filename hints.
    return undefined
  }
}

function extensionFromContentType(contentType: string): string {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim()
  const table: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'text/html': '.html',
    'text/plain': '.txt',
    'application/json': '.json',
  }
  return table[type] || ''
}

function inferFilenameParts(
  url: string,
  fallbackBase: string,
  contentType: string,
): { base: string; ext: string } {
  let pathnameBase = ''
  let pathnameExt = ''
  try {
    const parsed = new URL(url)
    pathnameBase = basename(parsed.pathname || '')
    pathnameExt = extname(pathnameBase || '')
  } catch {
    pathnameBase = ''
    pathnameExt = ''
  }

  const contentExt = extensionFromContentType(contentType)
  const ext = pathnameExt || contentExt || '.bin'
  const rawBase = pathnameBase ? pathnameBase.slice(0, pathnameBase.length - pathnameExt.length) : fallbackBase
  const base = sanitizeFilename(rawBase || fallbackBase, fallbackBase)
  return { base, ext: ext.startsWith('.') ? ext : `.${ext}` }
}

async function writeFileSmart(
  directory: string,
  base: string,
  ext: string,
  data: Buffer,
  overwrite: boolean,
): Promise<string> {
  const safeBase = sanitizeFilename(base, 'download')
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`
  const defaultPath = join(directory, `${safeBase}${safeExt}`)

  if (overwrite) {
    await writeFile(defaultPath, data)
    return defaultPath
  }

  for (let i = 0; i < 200; i += 1) {
    const candidate = i === 0 ? defaultPath : join(directory, `${safeBase}-${i}${safeExt}`)
    try {
      await writeFile(candidate, data, { flag: 'wx' })
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') continue
      throw error
    }
  }

  throw new Error(`无法在目录中写入文件：${directory}`)
}

async function downloadUrlsToDirectory(
  controller: BrowserController,
  params: {
    urls: string[]
    directory: string
    filenamePrefix?: string
    overwrite?: boolean
    tabId?: string | null
    referer?: string | null
  },
): Promise<string> {
  const urls = params.urls
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0)
    .slice(0, 100)
  if (urls.length === 0) return 'Error: urls is required and must be a non-empty array'

  const tabId = params.tabId || null
  const overwrite = params.overwrite === true
  const directory = expandHomePath(params.directory || '~/Documents')
  const filenamePrefix = sanitizeFilename(String(params.filenamePrefix || '').trim(), 'download')

  await mkdir(directory, { recursive: true })
  try {
    await access(directory, fsConstants.W_OK)
  } catch {
    return `Error: target directory is not writable: ${directory}`
  }

  let referer = String(params.referer || '').trim()
  if (!referer) {
    try {
      referer = String(await controller.executeJS(tabId, 'window.location.href') || '')
    } catch {
      referer = ''
    }
  }

  const results: Array<Record<string, unknown>> = []
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]
    if (!/^https?:\/\//i.test(url)) {
      results.push({ url, success: false, error: 'unsupported_protocol' })
      continue
    }

    let downloadedViaSession = false
    if (typeof controller.downloadUrlToDirectory === 'function') {
      try {
        const sessionResult = await controller.downloadUrlToDirectory({
          url,
          targetDir: directory,
          sourcePageUrl: referer || null,
          suggestedName: filenamePrefix ? `${filenamePrefix}-${index + 1}` : null,
        })
        if (sessionResult.success) {
          downloadedViaSession = true
          results.push({
            url,
            success: true,
            path: sessionResult.savePath,
            filename: sessionResult.filename,
            via: 'browser_session',
          })
        }
      } catch {
        // silent-catch: session download failed; fetch fallback records the final outcome.
      }
    }
    if (downloadedViaSession) continue

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Ready Browser Agent)',
          ...(referer ? { Referer: referer } : {}),
        },
      })
      if (!response.ok) {
        results.push({
          url,
          success: false,
          error: `http_${response.status}`,
          via: 'fetch',
        })
        continue
      }

      const contentType = response.headers.get('content-type') || ''
      const buffer = Buffer.from(await response.arrayBuffer())
      const fallbackBase = filenamePrefix
        ? `${filenamePrefix}-${index + 1}`
        : `download-${index + 1}`
      const parts = inferFilenameParts(url, fallbackBase, contentType)
      const filePath = await writeFileSmart(directory, parts.base, parts.ext, buffer, overwrite)
      results.push({
        url,
        success: true,
        path: filePath,
        size: buffer.byteLength,
        content_type: contentType,
        via: 'fetch',
      })
    } catch (error) {
      results.push({
        url,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        via: 'fetch',
      })
    }
  }

  const successCount = results.filter((item) => item.success === true).length
  // EP2 dogfood gap 4 — tool writes must surface in the file tree
  // immediately, even for directories the renderer never expanded.
  if (successCount > 0) {
    try { broadcastDirectoryChanged([directory]) } catch { /* never break the download result */ }
  }
  return JSON.stringify({
    directory,
    total: results.length,
    success: successCount,
    failed: results.length - successCount,
    results,
  }, null, 2)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function createAbortError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

async function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return
  if (!signal) {
    await sleep(ms)
    return
  }
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function clampNormalized(value: number, fallback = 500): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(999, Math.round(value)))
}

function normalizeErrorCode(error: unknown): string {
  const maybeCode = (error as { code?: string })?.code
  if (typeof maybeCode === 'string' && maybeCode.trim()) return maybeCode
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('No active tab')) return 'NO_ACTIVE_TAB'
  if (message.includes('Tab not found')) return 'TAB_NOT_FOUND'
  if (message.includes('Debugger attach failed')) return 'DEBUGGER_ATTACH_FAILED'
  return 'CDP_COMMAND_FAILED'
}

async function resolveCssPoint(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
): Promise<{ cssX: number; cssY: number; width: number; height: number; nx: number; ny: number }> {
  const nx = clampNormalized(x)
  const ny = clampNormalized(y)
  const mapped = await controller.normalizedToCss(tabId, nx, ny)
  return {
    cssX: mapped.x,
    cssY: mapped.y,
    width: mapped.width,
    height: mapped.height,
    nx,
    ny,
  }
}

function modifiersToMask(value: unknown): number {
  if (!value) return 0
  const input = Array.isArray(value) ? value : [value]
  let mask = 0
  for (const raw of input) {
    const token = String(raw || '').toLowerCase()
    if (token === 'alt' || token === 'option') mask |= 1
    if (token === 'ctrl' || token === 'control') mask |= 2
    if (token === 'meta' || token === 'cmd' || token === 'command') mask |= 4
    if (token === 'shift') mask |= 8
  }
  return mask
}

function keyToCode(key: string): string {
  if (!key) return ''
  if (key.length === 1) {
    const upper = key.toUpperCase()
    if (/^[A-Z]$/.test(upper)) return `Key${upper}`
    if (/^[0-9]$/.test(upper)) return `Digit${upper}`
  }
  const table: Record<string, string> = {
    enter: 'Enter',
    escape: 'Escape',
    esc: 'Escape',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    space: 'Space',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
  }
  const resolved = table[key.toLowerCase()]
  return resolved || key
}

function keyToVirtualCode(key: string): number {
  const normalized = key.toLowerCase()
  const table: Record<string, number> = {
    enter: 13,
    tab: 9,
    escape: 27,
    esc: 27,
    backspace: 8,
    delete: 46,
    arrowup: 38,
    arrowdown: 40,
    arrowleft: 37,
    arrowright: 39,
    home: 36,
    end: 35,
    pageup: 33,
    pagedown: 34,
    shift: 16,
    control: 17,
    ctrl: 17,
    alt: 18,
    meta: 91,
    cmd: 91,
    command: 91,
    space: 32,
  }
  if (table[normalized]) return table[normalized]
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0)
    if (Number.isFinite(code)) return code
  }
  return 0
}

function normalizeKeyLabel(key: string): string {
  const normalized = key.toLowerCase()
  if (normalized === 'ctrl') return 'Control'
  if (normalized === 'cmd' || normalized === 'command') return 'Meta'
  if (normalized === 'esc') return 'Escape'
  if (key.length === 1) return key
  return key.charAt(0).toUpperCase() + key.slice(1)
}

async function dispatchClickAt(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
): Promise<{ nx: number; ny: number; cssX: number; cssY: number; width: number; height: number }> {
  const point = await resolveCssPoint(controller, tabId, x, y)
  await controller.dispatchMouse(tabId, { type: 'mouseMoved', x: point.cssX, y: point.cssY, button: 'none', buttons: 0 })
  await controller.dispatchMouse(tabId, { type: 'mousePressed', x: point.cssX, y: point.cssY, button: 'left', buttons: 1, clickCount: 1 })
  await controller.dispatchMouse(tabId, { type: 'mouseReleased', x: point.cssX, y: point.cssY, button: 'left', buttons: 0, clickCount: 1 })
  return point
}

// EP1-I3 live-target net — ONE guarded entry per primitive action, shared by
// the top-level tools AND the workflow substeps (browser_run_workflow is not
// in the dispatch confirmation policy, so its inner click/type carry no
// semantics the gate can see — they MUST re-check at the execution layer).

/** Guarded CSS-selector click: judges the clickable owner's label (the click
 * bubbles), refuses M1 manual-only targets without clicking. */
async function runGuardedSelectorClick(
  controller: BrowserController,
  tabId: string | null,
  selector: string,
): Promise<string> {
  const clickJs = `
    (function() {
      const __READY_MANUAL_ONLY_CHECK__ = true;
      ${buildTargetSemanticsLibraryJs()}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return ${JSON.stringify(`Element not found: ${selector}`)};
      const owner = readyClickableOwner(el);
      const label = readyIsEditableField(owner) ? '' : readyClickSemanticsLabel(el);
      if (label && READY_MANUAL_ONLY_PATTERNS.some((p) => p.test(label))) {
        return { __readyManualOnlyBlocked: true, label: label.slice(0, 80) };
      }
      el.click();
      return 'Clicked: ' + (el.tagName || '') + (el.textContent ? ' "' + el.textContent.slice(0, 50) + '"' : '');
    })()
  `
  const result = await controller.executeJS(tabId, clickJs)
  throwIfLiveTargetGuardBlocked(result, { selector })
  return String(result)
}

/** Guarded coordinate click: probes the target under the point. Clicking a
 * non-editable target (button/link) is an action → M1 manual-only refused;
 * clicking an editable field just focuses it → allowed (value never judged). */
async function runGuardedCoordinateClick(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
  abortSignal?: AbortSignal,
): Promise<{ nx: number; ny: number; cssX: number; cssY: number; width: number; height: number }> {
  const probePoint = await resolveCssPoint(controller, tabId, x, y).catch(() => null)
  const probe = probePoint
    ? await controller.executeJS(tabId, buildClickPointLabelProbeJs(probePoint.cssX, probePoint.cssY)).catch(() => null)
    : null
  if (probe && typeof probe === 'object') {
    const p = probe as { label?: unknown; editable?: unknown }
    if (p.editable !== true) {
      const manualHit = matchManualOnlyBrowserTarget(String(p.label || ''))
      if (manualHit) {
        throw new ToolDomainError(
          'denied_manual_only',
          `坐标点击目标「${String(p.label || '').slice(0, 80)}」命中 M1 规则（${manualHit.reason}）。请引导用户亲自完成这一步。`,
          { x, y, ruleId: manualHit.ruleId },
        )
      }
    }
  }
  const point = await dispatchClickAt(controller, tabId, x, y)
  await settleAfterAction(controller, tabId, abortSignal)
  return point
}

/** Guarded CSS-selector type: in-page field-semantics guard (no value),
 * refuses M1 fields and unconfirmed password fields. */
async function runGuardedSelectorType(
  controller: BrowserController,
  tabId: string | null,
  selector: string,
  text: string,
  opts: { clearFirst: boolean; allowPasswordFill: boolean; submit?: boolean },
): Promise<string> {
  const typeJs = `
    (function() {
      ${buildInputGuardSnippetJs(opts.allowPasswordFill)}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return ${JSON.stringify(`Element not found: ${selector}`)};
      const guard = readyInputGuard(el);
      if (guard) return guard;
      el.focus();
      if ('value' in el) {
        ${opts.clearFirst ? 'el.value = "";' : ''}
        el.value = ${JSON.stringify(text)};
      } else {
        ${opts.clearFirst ? 'el.textContent = "";' : ''}
        el.textContent = ${JSON.stringify(text)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${opts.submit ? `
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        const form = el.closest && el.closest('form');
        if (form) form.requestSubmit && form.requestSubmit();
      ` : ''}
      return 'Typed "${text.slice(0, 50).replace(/"/g, '\\"')}" into ' + el.tagName + (el.name ? '[name=' + el.name + ']' : '');
    })()
  `
  const result = await controller.executeJS(tabId, typeJs)
  throwIfLiveTargetGuardBlocked(result, { selector })
  return String(result)
}

/** Guarded coordinate type: probes the field under the point. Non-editable
 * target → the focusing click is itself an action (M1 by click label);
 * editable field → judge by field semantics (no value) + password. */
async function runGuardedCoordinateType(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
  text: string,
  opts: { clearBefore: boolean; pressEnter: boolean; useShiftEnter: boolean; allowPasswordFill: boolean },
  abortSignal?: AbortSignal,
): Promise<{ nx: number; ny: number; cssX: number; cssY: number; width: number; height: number }> {
  const probePoint = await resolveCssPoint(controller, tabId, x, y).catch(() => null)
  const probe = probePoint
    ? await controller.executeJS(tabId, buildClickPointLabelProbeJs(probePoint.cssX, probePoint.cssY)).catch(() => null)
    : null
  if (probe && typeof probe === 'object') {
    const p = probe as { label?: unknown; inputLabel?: unknown; password?: unknown; editable?: unknown }
    // A password field is editable by definition; treat password===true as
    // editable even if the probe failed to set the flag.
    const editable = p.editable === true || p.password === true
    if (!editable) {
      // The focusing click lands on a button/link → the click is the action.
      const clickLabel = String(p.label || '')
      const clickHit = matchManualOnlyBrowserTarget(clickLabel)
      if (clickHit) {
        throw new ToolDomainError(
          'denied_manual_only',
          `坐标输入会先点击目标「${clickLabel.slice(0, 80)}」，命中 M1 规则（${clickHit.reason}）。请引导用户亲自完成这一步。`,
          { x, y, ruleId: clickHit.ruleId },
        )
      }
    } else {
      // Editable field: judge by field semantics (NOT its current value — a
      // draft containing「提交订单」must not false-trip), then password.
      const inputLabel = String(p.inputLabel || '')
      const fieldHit = matchManualOnlyBrowserTarget(inputLabel)
      if (fieldHit) {
        throw new ToolDomainError(
          'denied_manual_only',
          `坐标输入目标「${inputLabel.slice(0, 80)}」命中 M1 规则（${fieldHit.reason}）。请引导用户亲自完成这一步。`,
          { x, y, ruleId: fieldHit.ruleId },
        )
      }
      if (p.password === true && !opts.allowPasswordFill) {
        throw new ToolDomainError(
          'denied_pending_confirmation',
          '坐标输入目标是密码输入框。请在调用参数中说明目标（如「登录密码输入框」），经用户确认后执行。',
          { x, y, ruleId: 'm3-login-existing-account' },
        )
      }
    }
  }
  const point = await dispatchClickAt(controller, tabId, x, y)
  if (opts.clearBefore) {
    await clearFocusedInput(controller, tabId)
  }
  await controller.typeTextDirectly(tabId, text, { useShiftEnterForNewline: opts.useShiftEnter })
  if (opts.pressEnter) {
    await sendKeyStroke(controller, tabId, 'Enter')
  }
  await settleAfterAction(controller, tabId, abortSignal)
  return point
}

async function sendKeyStroke(
  controller: BrowserController,
  tabId: string | null,
  key: string,
  modifiers?: unknown,
): Promise<void> {
  const keyLabel = normalizeKeyLabel(key)
  const code = keyToCode(key)
  const vk = keyToVirtualCode(keyLabel)
  const mask = modifiersToMask(modifiers)
  const text = keyLabel.length === 1 ? keyLabel : keyLabel.toLowerCase() === 'enter' ? '\r' : undefined

  // EP1-I3 live-target net — send-keys is a keyboard bypass: a printable
  // keystroke lands in whatever field already has FOCUS, so character-by-
  // character typing could feed a captcha/password field no argument ever
  // named. Guard text-producing keys: a single char with NO command modifier
  // (Alt/Ctrl/Meta = bits 1|2|4) inserts a character — Shift (bit 8) is a
  // text modifier (Shift+a → 'A') so it must STILL be guarded. Command-key
  // combos (Ctrl+c / Meta+v / etc.) are shortcuts, and Enter/Tab/Escape are
  // navigation — those pass (pressing Enter after the USER typed their
  // credential is the user's own action completing). Both the
  // browser_send_keys tool and the workflow send_keys substep funnel through
  // here. Best-effort probe: empty/failed probe proceeds (visual channel).
  const COMMAND_MODIFIER_MASK = 0b0111 // Alt | Control | Meta
  if (keyLabel.length === 1 && (mask & COMMAND_MODIFIER_MASK) === 0) {
    const focusedProbe = await controller.executeJS(tabId, buildFocusedFieldProbeJs()).catch(() => null)
    if (focusedProbe && typeof focusedProbe === 'object') {
      const probed = focusedProbe as { inputLabel?: unknown; password?: unknown }
      const inputLabel = String(probed.inputLabel || '')
      const manualHit = matchManualOnlyBrowserTarget(inputLabel)
      if (manualHit) {
        throw new ToolDomainError(
          'denied_manual_only',
          `当前焦点字段「${inputLabel.slice(0, 80)}」命中 M1 规则（${manualHit.reason}）。请引导用户亲自完成这一步，不要逐键代输。`,
          { key: keyLabel, ruleId: manualHit.ruleId },
        )
      }
      if (probed.password === true) {
        throw new ToolDomainError(
          'denied_pending_confirmation',
          '当前焦点是密码输入框，不能逐键代输。请改用 browser_type 并在参数中说明目标（如「登录密码输入框」），经用户确认后执行。',
          { key: keyLabel, ruleId: 'm3-login-existing-account' },
        )
      }
    }
  }

  const modifierTriples: Array<{ key: string; code: string; vk: number; bit: number }> = [
    { key: 'Alt', code: 'AltLeft', vk: 18, bit: 1 },
    { key: 'Control', code: 'ControlLeft', vk: 17, bit: 2 },
    { key: 'Meta', code: 'MetaLeft', vk: 91, bit: 4 },
    { key: 'Shift', code: 'ShiftLeft', vk: 16, bit: 8 },
  ]

  for (const modifier of modifierTriples) {
    if ((mask & modifier.bit) !== modifier.bit) continue
    await controller.dispatchKey(tabId, {
      type: 'keyDown',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
    })
  }

  await controller.dispatchKey(tabId, {
    type: 'keyDown',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    text,
    modifiers: mask,
    isKeypad: false,
    unmodifiedText: text,
  })
  await controller.dispatchKey(tabId, {
    type: 'keyUp',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    modifiers: mask,
    isKeypad: false,
  })

  for (let i = modifierTriples.length - 1; i >= 0; i -= 1) {
    const modifier = modifierTriples[i]
    if ((mask & modifier.bit) !== modifier.bit) continue
    await controller.dispatchKey(tabId, {
      type: 'keyUp',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
    })
  }
}

async function clearFocusedInput(controller: BrowserController, tabId: string | null): Promise<void> {
  const selectAllMask = process.platform === 'darwin' ? 4 : 2
  await controller.dispatchKey(tabId, {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: selectAllMask,
  })
  await controller.dispatchKey(tabId, {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: selectAllMask,
  })
  await sendKeyStroke(controller, tabId, 'Backspace')
}

async function waitForLoadingStop(
  controller: BrowserController,
  tabId: string | null,
  timeoutMs = BROWSER_V2_STOP_LOADING_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    try {
      const done = await controller.executeJS(
        tabId,
        `(() => (document.readyState === 'interactive' || document.readyState === 'complete'))()`,
      ) as boolean
      if (done) return true
    } catch {
      // ignore polling errors
    }
    await sleepWithAbort(200, signal)
  }
  return false
}

async function settleAfterAction(
  controller: BrowserController,
  tabId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  await sleepWithAbort(BROWSER_V3_ACTION_SETTLE_MS, signal)
  await waitForLoadingStop(controller, tabId, 8_000, signal)
  await waitForReady(controller, tabId, 6_000, undefined, signal)
}

interface GeminiResponseProbe {
  responseDetected: boolean
  responseText: string
  loginRequired: boolean
  captchaRequired: boolean
  editableCount: number
  thinking: boolean
}

async function probeGeminiResponse(
  controller: BrowserController,
  tabId: string | null,
  userText: string,
): Promise<GeminiResponseProbe> {
  const userSnippet = userText.trim().replace(/\s+/g, ' ').slice(0, 24)
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const text = (document.body?.innerText || '')
        const loginRequired = /登录|登入|Sign in|Log in|Choose an account/i.test(text)
        const captchaRequired = /captcha|验证|人机|I am not a robot/i.test(text)
        const selectors = [
          '[data-message-author-role="model"]',
          '[data-test-id*="model"]',
          '.model-response',
          'message-content',
        ]
        let responseText = ''
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const clean = (s) =>
          normalize(s)
            .replace(/^Gemini\\s*PRO?/i, '')
            .replace(/Gemini 是一款 AI 工具，其回答未必正确无误。?/g, '')
            .replace(/Pro\\s*$/g, '')
            .trim()
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector))
          for (let i = nodes.length - 1; i >= 0; i -= 1) {
            const t = clean(nodes[i].textContent || '')
            if (t.length > 20) {
              responseText = t.slice(0, 500)
              break
            }
          }
          if (responseText) break
        }
        const userSnippet = ${JSON.stringify(userSnippet)}
        if (!responseText) {
          const lines = text
            .split('\\n')
            .map((line) => clean(line))
            .filter((line) => line.length > 14)
            .filter((line) => !/需要我为你做些什么|制作图片|创作音乐|创作视频|给我的一天注入活力|帮我学习|随便写点什么/.test(line))
            .filter((line) => !userSnippet || !line.includes(userSnippet))
          const maybe = lines.slice(-8).join('\\n').trim()
          responseText = maybe.slice(0, 500)
        }
        const editableCount = document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]').length
        const thinking = /thinking|正在思考|思考中|生成中|generating|回答中|撰写中|loading/i.test(text)
        const cleanedResponse = clean(responseText)
        const userEcho = userSnippet && cleanedResponse.includes(userSnippet)
        const weakResponse = cleanedResponse.length < 40
        return {
          responseDetected: Boolean(cleanedResponse && !weakResponse && !thinking && !userEcho),
          responseText: cleanedResponse,
          loginRequired,
          captchaRequired,
          editableCount,
          thinking,
        }
      })()
    `,
  ) as GeminiResponseProbe

  return {
    responseDetected: Boolean(result?.responseDetected),
    responseText: String(result?.responseText || ''),
    loginRequired: Boolean(result?.loginRequired),
    captchaRequired: Boolean(result?.captchaRequired),
    editableCount: Number(result?.editableCount || 0),
    thinking: Boolean(result?.thinking),
  }
}

interface GeminiEditableCandidate {
  x: number
  y: number
  score: number
  reason: string
}

async function probeGeminiEditableCandidates(
  controller: BrowserController,
  tabId: string | null,
): Promise<GeminiEditableCandidate[]> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width < 12 || rect.height < 12) return false
          const style = getComputedStyle(el)
          if (!style) return false
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0
        }
        const nodes = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
        const out = []
        for (const el of nodes) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) continue
          const rect = el.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          let score = 10
          const meta = [
            el.getAttribute('placeholder') || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('name') || '',
            el.getAttribute('id') || '',
            el.getAttribute('data-testid') || '',
            el.getAttribute('role') || '',
          ].join(' ').toLowerCase()
          if (/gemini|chat|message|prompt|ask|输入|提问/.test(meta)) score += 80
          if (rect.width > window.innerWidth * 0.35) score += 18
          if (rect.bottom > window.innerHeight * 0.6) score += 14
          if (el.tagName.toLowerCase() === 'textarea') score += 20
          out.push({
            x: Math.max(0, Math.min(999, Math.round((centerX / Math.max(1, window.innerWidth)) * 999))),
            y: Math.max(0, Math.min(999, Math.round((centerY / Math.max(1, window.innerHeight)) * 999))),
            score,
            reason: meta.slice(0, 120) || el.tagName.toLowerCase(),
          })
        }
        return out.sort((a, b) => b.score - a.score).slice(0, 6)
      })()
    `,
  ) as GeminiEditableCandidate[]

  if (!Array.isArray(result)) return []
  return result
}

interface GeminiSubmissionProbe {
  inputHasText: boolean
  inputLength: number
  sendButtonEnabled: boolean
  userEchoDetected: boolean
  thinking: boolean
}

async function probeGeminiSubmissionState(
  controller: BrowserController,
  tabId: string | null,
  text: string,
): Promise<GeminiSubmissionProbe> {
  const previewToken = text.trim().replace(/\s+/g, ' ').slice(0, 22)
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const getEditableText = (el) => {
          if (!el) return ''
          const tag = String(el.tagName || '').toLowerCase()
          if (tag === 'textarea' || tag === 'input') return String(el.value || '')
          return String(el.innerText || el.textContent || '')
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]'))
        let best = ''
        const active = document.activeElement
        if (active instanceof HTMLElement) {
          const activeRect = active.getBoundingClientRect()
          const activeStyle = window.getComputedStyle(active)
          const activeVisible =
            activeRect.width >= 20 &&
            activeRect.height >= 20 &&
            activeStyle &&
            activeStyle.display !== 'none' &&
            activeStyle.visibility !== 'hidden' &&
            Number(activeStyle.opacity || '1') > 0
          const activeTag = String(active.tagName || '').toLowerCase()
          const activeRole = (active.getAttribute('role') || '').toLowerCase()
          const activeEditable =
            activeVisible &&
            (activeTag === 'textarea' ||
              activeTag === 'input' ||
              active.isContentEditable ||
              activeRole === 'textbox' ||
              activeRole === 'combobox' ||
              activeRole === 'searchbox')
          if (activeEditable) {
            best = getEditableText(active)
          }
        }
        for (const el of editables) {
          if (!(el instanceof HTMLElement)) continue
          const rect = el.getBoundingClientRect()
          if (rect.width < 20 || rect.height < 20) continue
          const style = window.getComputedStyle(el)
          if (!style || style.display === 'none' || style.visibility === 'hidden') continue
          const value = getEditableText(el)
          if (value.length > best.length) best = value
        }
        const sendSelectors = [
          'button[aria-label*="send" i]',
          'button[aria-label*="发送" i]',
          'button[aria-label*="提交" i]',
          'button[aria-label*="发布" i]',
          'button[aria-label*="继续" i]',
          'button[aria-label*="search" i]',
          'button[aria-label*="回车" i]',
          'button[aria-label*="ask" i]',
          'button[aria-label*="发送消息" i]',
          'button[data-testid*="send" i]',
          'button[data-testid*="submit" i]',
          'button[data-testid*="publish" i]',
          'button[data-testid*="continue" i]',
          '[role="button"][aria-label*="send" i]',
          '[role="button"][aria-label*="发送" i]',
          'button[title*="send" i]',
          'button[title*="发送" i]',
          'button[title*="提交" i]',
          'button[title*="发布" i]',
          'button[title*="继续" i]',
          'button[mattooltip*="send" i]',
        ]
        const sendButtons = sendSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        const sendButtonEnabled = sendButtons.some((node) => {
          if (!(node instanceof HTMLElement)) return false
          const ariaDisabled = (node.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
          const disabled =
            (node instanceof HTMLButtonElement && node.disabled === true) ||
            node.hasAttribute('disabled')
          const style = window.getComputedStyle(node)
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
          return visible && !ariaDisabled && !disabled
        })
        const userSelectors = [
          '[data-message-author-role="user"]',
          '[data-author-role="user"]',
          '[data-role="user"]',
          '.message-user',
          '.user-message',
          '[class*="userMessage"]',
          '[class*="chat-user"]',
          '.user-query',
        ]
        const userNodes = userSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        const userEchoDetected = userNodes.some((node) => normalize(node.textContent || '').includes(${JSON.stringify(previewToken)}))
        const inputHasText = normalize(best).length > 0
        const bodyText = normalize(document.body?.innerText || '')
        const thinking = /thinking|正在思考|思考中|生成中|回答中|撰写中|responding|loading|写作中|处理中/.test(bodyText)
        return {
          inputHasText,
          inputLength: normalize(best).length,
          sendButtonEnabled,
          userEchoDetected,
          thinking,
        }
      })()
    `,
  ) as GeminiSubmissionProbe

  return {
    inputHasText: Boolean(result?.inputHasText),
    inputLength: Number(result?.inputLength || 0),
    sendButtonEnabled: Boolean(result?.sendButtonEnabled),
    userEchoDetected: Boolean(result?.userEchoDetected),
    thinking: Boolean(result?.thinking),
  }
}

function isSubmissionLikelyAccepted(probe: GeminiSubmissionProbe): boolean {
  if (probe.userEchoDetected) return true
  if (probe.thinking) return true
  if (!probe.inputHasText && !probe.sendButtonEnabled) return true
  if (probe.inputLength <= 2 && !probe.sendButtonEnabled) return true
  return false
}

async function clickGeminiSendButton(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ clicked: boolean; reason: string }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const selectors = [
          'button[aria-label*="send" i]',
          'button[aria-label*="发送" i]',
          'button[aria-label*="提交" i]',
          'button[aria-label*="发布" i]',
          'button[aria-label*="继续" i]',
          'button[aria-label*="search" i]',
          'button[data-testid*="send" i]',
          'button[data-testid*="submit" i]',
          'button[data-testid*="publish" i]',
          'button[data-testid*="continue" i]',
          '[role="button"][aria-label*="send" i]',
          '[role="button"][aria-label*="发送" i]',
          '[role="button"][aria-label*="提交" i]',
          '[role="button"][aria-label*="发布" i]',
          '[role="button"][aria-label*="继续" i]',
          'button[mattooltip*="send" i]',
          'button[title*="send" i]',
          'button[title*="发送" i]',
          'button[title*="提交" i]',
          'button[title*="发布" i]',
          'button[title*="继续" i]',
          'input[type="submit"]',
          'button',
          '[role="button"]',
          '[tabindex]',
        ]
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const getActiveEditable = () => {
          const nodes = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
          const active = document.activeElement
          if (active instanceof HTMLElement && visible(active)) {
            return active
          }
          let best = null
          let bestScore = -1
          for (const node of nodes) {
            if (!(node instanceof HTMLElement) || !visible(node)) continue
            const rect = node.getBoundingClientRect()
            let score = 0
            if (rect.bottom > window.innerHeight * 0.55) score += 8
            if (rect.width > window.innerWidth * 0.3) score += 6
            if (node.tagName.toLowerCase() === 'textarea') score += 4
            if (score > bestScore) {
              best = node
              bestScore = score
            }
          }
          return best
        }
        const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .filter((el) => visible(el))
          .filter((el) => {
            const element = el
            const ariaDisabled = (element.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
            const disabled = element instanceof HTMLButtonElement && element.disabled
            return !ariaDisabled && !disabled
          })
        if (candidates.length === 0) {
          return { clicked: false, reason: 'send_button_not_found' }
        }
        const activeEditable = getActiveEditable()
        const activeRect = activeEditable instanceof HTMLElement ? activeEditable.getBoundingClientRect() : null
        const activeParent = activeEditable instanceof HTMLElement ? activeEditable.parentElement : null
        const activeGrandParent = activeParent?.parentElement || null
        let best = candidates[0]
        let bestScore = -1
        for (const el of candidates) {
          const rect = el.getBoundingClientRect()
          let score = 0
          if (rect.bottom > window.innerHeight * 0.5) score += 4
          if (rect.right > window.innerWidth * 0.5) score += 4
          if (rect.width <= 64 && rect.height <= 64) score += 3
          const meta = (
            (el.getAttribute('aria-label') || '') + ' ' +
            (el.getAttribute('title') || '') + ' ' +
            (el.getAttribute('data-testid') || '') + ' ' +
            (el.getAttribute('class') || '') + ' ' +
            (el.textContent || '')
          ).toLowerCase()
          if (/send|发送|提交|发布|继续|search|搜索|ask|生成|go/.test(meta)) score += 10
          if (/icon|arrow|submit/.test(meta)) score += 2
          if (activeRect) {
            const dx = Math.abs(rect.left - activeRect.right)
            const dy = Math.abs((rect.top + rect.height / 2) - (activeRect.top + activeRect.height / 2))
            if (dx <= 180) score += 8
            if (dy <= 120) score += 6
            if (rect.left >= activeRect.left && rect.top >= activeRect.top - 60) score += 5
            if (rect.bottom >= activeRect.top && rect.top <= activeRect.bottom + 120) score += 4
          }
          if (activeParent && activeParent.contains(el) && el !== activeEditable) score += 7
          if (activeGrandParent && activeGrandParent.contains(el) && el !== activeEditable) score += 3
          if (score > bestScore) {
            best = el
            bestScore = score
          }
        }
        best.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        best.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
        if (typeof best.click === 'function') {
          best.click()
        } else {
          best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          best.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        return { clicked: true, reason: 'send_button_clicked' }
      })()
    `,
  ) as { clicked?: boolean; reason?: string }

  return {
    clicked: Boolean(result?.clicked),
    reason: String(result?.reason || 'unknown'),
  }
}

async function submitClosestFormOrContainer(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ submitted: boolean; reason: string }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
        let active = document.activeElement instanceof HTMLElement && visible(document.activeElement)
          ? document.activeElement
          : null
        if (!active) {
          let best = null
          let bestScore = -1
          for (const node of editables) {
            if (!(node instanceof HTMLElement) || !visible(node)) continue
            const rect = node.getBoundingClientRect()
            let score = 0
            if (rect.bottom > window.innerHeight * 0.55) score += 8
            if (rect.width > window.innerWidth * 0.25) score += 5
            if (node.tagName.toLowerCase() === 'textarea') score += 4
            if (score > bestScore) {
              best = node
              bestScore = score
            }
          }
          active = best
        }
        if (!(active instanceof HTMLElement)) {
          return { submitted: false, reason: 'no_active_editable' }
        }
        const form = active.closest('form')
        if (form instanceof HTMLFormElement) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit()
          } else {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
          }
          return { submitted: true, reason: 'closest_form_submit' }
        }
        const containers = [
          active.parentElement,
          active.parentElement?.parentElement,
          active.closest('[role="group"]'),
          active.closest('[role="dialog"]'),
          active.closest('section'),
        ].filter(Boolean)
        const activeRect = active.getBoundingClientRect()
        for (const container of containers) {
          if (!(container instanceof HTMLElement)) continue
          const buttons = Array.from(container.querySelectorAll('button,[role="button"],input[type="submit"]'))
            .filter((node) => visible(node) && node !== active)
          let best = null
          let bestScore = -1
          for (const button of buttons) {
            if (!(button instanceof HTMLElement)) continue
            const rect = button.getBoundingClientRect()
            let score = 0
            const meta = (
              (button.getAttribute('aria-label') || '') + ' ' +
              (button.getAttribute('title') || '') + ' ' +
              (button.getAttribute('data-testid') || '') + ' ' +
              (button.getAttribute('class') || '') + ' ' +
              (button.textContent || '')
            ).toLowerCase()
            if (/send|发送|提交|发布|继续|search|搜索|ask|生成|go/.test(meta)) score += 10
            if (Math.abs((rect.top + rect.height / 2) - (activeRect.top + activeRect.height / 2)) <= 120) score += 5
            if (rect.left >= activeRect.left - 32) score += 4
            if (rect.right >= activeRect.right - 24) score += 3
            if (score > bestScore) {
              best = button
              bestScore = score
            }
          }
          if (best instanceof HTMLElement) {
            if (typeof best.click === 'function') {
              best.click()
            } else {
              best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              best.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }
            return { submitted: true, reason: 'closest_container_button' }
          }
        }
        return { submitted: false, reason: 'no_form_or_container_submit' }
      })()
    `,
  ) as { submitted?: boolean; reason?: string }

  return {
    submitted: Boolean(result?.submitted),
    reason: String(result?.reason || 'unknown'),
  }
}

async function ensureGeminiSubmitted(
  controller: BrowserController,
  tabId: string | null,
  text: string,
  attempted: string[],
  signal?: AbortSignal,
): Promise<{ submitted: boolean; method: string; probe: GeminiSubmissionProbe }> {
  throwIfAborted(signal)
  let probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'already_submitted', probe }
  }

  attempted.push('submit-precheck-wait')
  await sleepWithAbort(320, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'already_submitted_pending', probe }
  }

  attempted.push('submit-enter')
  await sendKeyStroke(controller, tabId, 'Enter')
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'enter', probe }
  }

  attempted.push('submit-meta-enter')
  await sendKeyStroke(controller, tabId, 'Enter', ['meta'])
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'meta_enter', probe }
  }

  attempted.push('submit-ctrl-enter')
  await sendKeyStroke(controller, tabId, 'Enter', ['ctrl'])
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'ctrl_enter', probe }
  }

  attempted.push('submit-closest-form')
  const formSubmitted = await submitClosestFormOrContainer(controller, tabId)
  if (formSubmitted.submitted) {
    await sleepWithAbort(180, signal)
    probe = await probeGeminiSubmissionState(controller, tabId, text)
    if (isSubmissionLikelyAccepted(probe)) {
      return { submitted: true, method: formSubmitted.reason, probe }
    }
  }

  attempted.push('submit-send-button')
  const clicked = await clickGeminiSendButton(controller, tabId)
  await sleepWithAbort(220, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (clicked.clicked && isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: clicked.reason, probe }
  }

  attempted.push('submit-bottom-right-click')
  try {
    await dispatchClickAt(controller, tabId, 945, 930)
    await sleepWithAbort(140, signal)
    await sendKeyStroke(controller, tabId, 'Enter')
  } catch {
    // ignore and keep probing
  }
  await sleepWithAbort(240, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'bottom_right_click_enter', probe }
  }

  attempted.push('submit-send-key-fallback')
  await sendKeyStroke(controller, tabId, 'Enter')
  await sleepWithAbort(180, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'send_key_fallback_enter', probe }
  }

  return { submitted: false, method: clicked.reason, probe }
}

function cacheScreenshot(base64: string, width: number, height: number): string {
  const id = `browser-shot-${randomUUID()}`
  screenshotCache.set(id, { base64, width, height, createdAt: Date.now() })
  if (screenshotCache.size > SCREENSHOT_CACHE_MAX) {
    const stale = Array.from(screenshotCache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, screenshotCache.size - SCREENSHOT_CACHE_MAX)
    stale.forEach(([key]) => screenshotCache.delete(key))
  }
  return id
}

async function waitForReady(
  controller: BrowserController,
  tabId: string | null,
  timeoutMs = 8000,
  selector?: string,
  signal?: AbortSignal,
): Promise<{ ready: boolean; matchedSelector: boolean; elapsedMs: number }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    try {
      const state = await controller.executeJS(tabId, `
        (() => {
          const hasSelectorDeep = (selector) => {
            const queue = [document]
            const visited = new Set()
            while (queue.length) {
              const root = queue.shift()
              if (!root || visited.has(root)) continue
              visited.add(root)
              try {
                if (root.querySelector?.(selector)) return true
              } catch {
                // ignore invalid selector in a specific root
              }
              let nodes = []
              try {
                nodes = Array.from(root.querySelectorAll?.('*') || [])
              } catch {
                nodes = []
              }
              for (const node of nodes) {
                const shadow = node?.shadowRoot
                if (shadow && !visited.has(shadow)) queue.push(shadow)
              }
            }
            return false
          }
          const readyState = document.readyState || 'loading'
          const bodyTextLen = (document.body?.innerText || '').trim().length
          const matched = ${selector ? `hasSelectorDeep(${JSON.stringify(selector)})` : 'false'}
          return { readyState, bodyTextLen, matched }
        })()
      `) as { readyState?: string; bodyTextLen?: number; matched?: boolean }
      const readyState = state?.readyState || 'loading'
      const bodyTextLen = Number(state?.bodyTextLen || 0)
      const matched = Boolean(state?.matched)
      const baseReady = readyState === 'interactive' || readyState === 'complete'
      if (selector) {
        if (baseReady && matched) {
          return { ready: true, matchedSelector: true, elapsedMs: Date.now() - started }
        }
      } else if (baseReady && bodyTextLen > 0) {
        return { ready: true, matchedSelector: false, elapsedMs: Date.now() - started }
      }
    } catch {
      // ignore polling errors, keep retrying
    }
    await sleepWithAbort(250, signal)
  }
  return { ready: false, matchedSelector: false, elapsedMs: Date.now() - started }
}

async function extractSearchResults(
  controller: BrowserController,
  tabId: string | null,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const js = `
    (() => {
      const selectors = [
        'a h3',
        'h3 a',
        'article h2 a',
        '.result__a',
        '.b_algo h2 a',
        '.c-container h3 a',
      ]
      const links = new Map()
      for (const sel of selectors) {
        for (const node of Array.from(document.querySelectorAll(sel))) {
          const anchor = node.closest('a') || node
          if (!(anchor instanceof HTMLAnchorElement)) continue
          const href = anchor.href || ''
          const title = (node.textContent || anchor.textContent || '').trim()
          if (!href || !title) continue
          if (!/^https?:/i.test(href)) continue
          if (/google\\.com\\/search\\?|duckduckgo\\.com\\/\\?|bing\\.com\\/search\\?|baidu\\.com\\/s\\?/i.test(href)) continue
          if (!links.has(href)) {
            const block = anchor.closest('article,li,div') || anchor.parentElement || anchor
            const snippetNode = block.querySelector('p, .snippet, .result__snippet, .b_caption p, .c-abstract, .content')
            const snippet = (snippetNode?.textContent || '').trim().slice(0, 280)
            links.set(href, { title: title.slice(0, 120), url: href, snippet })
          }
          if (links.size >= 8) break
        }
        if (links.size >= 8) break
      }
      return Array.from(links.values())
    })()
  `
  const result = await controller.executeJS(tabId, js)
  if (!Array.isArray(result)) return []
  return result
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const row = item as Record<string, unknown>
      return {
        title: String(row.title || ''),
        url: String(row.url || ''),
        snippet: String(row.snippet || ''),
      }
    })
    .filter((row) => row.title && row.url)
}

function buildClickByTextJs(text: string, exact: boolean): string {
  return `
    (() => {
      ${buildTargetSemanticsLibraryJs()}
      const target = ${JSON.stringify(text)}
      const exact = ${exact ? 'true' : 'false'}
      const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const queue = [document]
      const visited = new Set()
      const all = []
      while (queue.length) {
        const root = queue.shift()
        if (!root || visited.has(root)) continue
        visited.add(root)
        let nodes = []
        try {
          nodes = Array.from(root.querySelectorAll('*'))
        } catch {
          nodes = []
        }
        for (const node of nodes) {
          all.push(node)
          const shadow = node?.shadowRoot
          if (shadow && !visited.has(shadow)) queue.push(shadow)
        }
      }

      const visible = (el) => {
        try {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          const style = window.getComputedStyle(el)
          if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0) return false
          return true
        } catch {
          return false
        }
      }

      const isClickable = (el) => {
        const tag = (el.tagName || '').toLowerCase()
        if (['a', 'button', 'summary'].includes(tag)) return true
        if (el instanceof HTMLInputElement && ['button', 'submit'].includes((el.type || '').toLowerCase())) return true
        const role = (el.getAttribute('role') || '').toLowerCase()
        if (['button', 'link', 'menuitem', 'option', 'tab'].includes(role)) return true
        if (typeof el.onclick === 'function') return true
        if (el.hasAttribute('onclick') || el.hasAttribute('data-testid')) return true
        return false
      }

      const candidates = all.filter((el) => el instanceof HTMLElement && visible(el) && isClickable(el))
      let matched = null
      for (const el of candidates) {
        const txt = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '')
        if (!txt) continue
        if ((exact && txt === target) || (!exact && txt.includes(target))) {
          matched = el
          break
        }
      }
      if (!matched) return 'Element by text not found: ' + target
      // EP1-I3 live-target net — the located element's clickable owner may be
      // a payment/captcha/改密 control even when the search text was generic.
      const __readyOwnerLabel = readyClickSemanticsLabel(matched)
      if (__readyOwnerLabel && READY_MANUAL_ONLY_PATTERNS.some((p) => p.test(__readyOwnerLabel))) {
        return { __readyManualOnlyBlocked: true, label: __readyOwnerLabel.slice(0, 80) }
      }
      matched.scrollIntoView({ block: 'center', behavior: 'instant' })
      matched.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      matched.click()
      return 'Clicked by text: ' + normalize(matched.textContent || matched.getAttribute('aria-label') || matched.getAttribute('title') || matched.tagName)
    })()
  `
}

function buildLocateTextTargetJs(text: string, exact: boolean, hrefContains = ''): string {
  return `
    (() => {
      const target = ${JSON.stringify(text)}
      const exact = ${exact ? 'true' : 'false'}
      const hrefContains = ${JSON.stringify(hrefContains)}
      const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const queue = [document]
      const visited = new Set()
      const all = []
      while (queue.length) {
        const root = queue.shift()
        if (!root || visited.has(root)) continue
        visited.add(root)
        let nodes = []
        try {
          nodes = Array.from(root.querySelectorAll('*'))
        } catch {
          nodes = []
        }
        for (const node of nodes) {
          all.push(node)
          const shadow = node?.shadowRoot
          if (shadow && !visited.has(shadow)) queue.push(shadow)
        }
      }

      const visible = (el) => {
        try {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          const style = window.getComputedStyle(el)
          if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0) return false
          return true
        } catch {
          return false
        }
      }

      const isClickable = (el) => {
        const tag = (el.tagName || '').toLowerCase()
        if (['a', 'button', 'summary'].includes(tag)) return true
        if (el instanceof HTMLInputElement && ['button', 'submit'].includes((el.type || '').toLowerCase())) return true
        const role = (el.getAttribute('role') || '').toLowerCase()
        if (['button', 'link', 'menuitem', 'option', 'tab'].includes(role)) return true
        if (typeof el.onclick === 'function') return true
        if (el.hasAttribute('onclick') || el.hasAttribute('data-testid')) return true
        return false
      }
      const hrefMatches = (el) => {
        if (!hrefContains) return true
        const anchor = el.closest ? el.closest('a[href]') : null
        const href = String((anchor || el).getAttribute?.('href') || '')
        return href.includes(hrefContains)
      }

      const candidates = all.filter((el) => el instanceof HTMLElement && visible(el) && isClickable(el))
      let matched = null
      if (hrefContains) {
        const hrefCandidates = all
          .filter((el) => el instanceof HTMLElement && visible(el) && (el.tagName || '').toLowerCase() === 'a')
          .filter((el) => String(el.getAttribute('href') || '').includes(hrefContains))
          .map((el) => {
            const rect = el.getBoundingClientRect()
            return { el, area: Math.max(0, rect.width) * Math.max(0, rect.height) }
          })
          .filter((item) => item.area > 16)
          .sort((a, b) => b.area - a.area)
        matched = hrefCandidates[0]?.el || null
      }
      const fallback = []
      if (!matched) {
        for (const el of candidates) {
          const txt = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '')
          if (!txt) continue
          if ((exact && txt === target) || (!exact && txt.includes(target))) {
            if (hrefMatches(el)) {
              matched = el
              break
            }
            fallback.push(el)
          }
        }
      }
      if (!matched && !hrefContains) matched = fallback[0] || null
      if (!matched) return { ok: false, error: 'Element by text not found: ' + target }
      if (hrefContains) {
        const anchor = matched.closest ? matched.closest('a[href]') : null
        if (anchor instanceof HTMLElement && visible(anchor)) matched = anchor
      }
      matched.scrollIntoView({ block: 'center', behavior: 'instant' })
      const rect = matched.getBoundingClientRect()
      const x = Math.max(0, Math.min(window.innerWidth, rect.left + rect.width / 2))
      const y = Math.max(0, Math.min(window.innerHeight, rect.top + rect.height / 2))
      if (hrefContains) {
        if (matched instanceof HTMLAnchorElement) {
          matched.setAttribute('target', '_self')
        }
      }
      const href = matched instanceof HTMLAnchorElement && matched.href ? matched.href : ''
      return {
        ok: true,
        text: normalize(matched.textContent || matched.getAttribute('aria-label') || matched.getAttribute('title') || matched.tagName),
        href,
        clickedDirect: false,
        cssX: x,
        cssY: y,
        width: window.innerWidth || 1,
        height: window.innerHeight || 1,
      }
    })()
  `
}

function buildSmartTypeJs(options: {
  target: string
  text: string
  clearFirst: boolean
  submit: boolean
  /** EP1-I3 live-target net — args carried a password cue (gate-confirmed). */
  allowPasswordFill?: boolean
}): string {
  const normalizedTarget = options.target.trim().toLowerCase()
  return `
    (() => {
      ${buildInputGuardSnippetJs(options.allowPasswordFill === true)}
      const target = ${JSON.stringify(normalizedTarget)}
      const text = ${JSON.stringify(options.text)}
      const clearFirst = ${options.clearFirst ? 'true' : 'false'}
      const submit = ${options.submit ? 'true' : 'false'}
      const normalize = (s) => (s || '').toLowerCase().replace(/\\s+/g, ' ').trim()

      const queue = [document]
      const visited = new Set()
      const all = []
      while (queue.length) {
        const root = queue.shift()
        if (!root || visited.has(root)) continue
        visited.add(root)
        let nodes = []
        try {
          nodes = Array.from(root.querySelectorAll('*'))
        } catch {
          nodes = []
        }
        for (const node of nodes) {
          all.push(node)
          const shadow = node?.shadowRoot
          if (shadow && !visited.has(shadow)) queue.push(shadow)
        }
      }

      const visible = (el) => {
        try {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          const style = window.getComputedStyle(el)
          if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0) return false
          return true
        } catch {
          return false
        }
      }

      const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
      const isEditable = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
        const isTextarea = el instanceof HTMLTextAreaElement
        const role = (el.getAttribute('role') || '').toLowerCase()
          const roleTextbox = role === 'textbox' || role === 'searchbox'
        const hasContentEditableAttr = el.hasAttribute('contenteditable')
        const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
        const isContentEditable =
          el.isContentEditable ||
          (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
        if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
        const tag = (el.tagName || '').toLowerCase()
        if ((tag === 'html' || tag === 'body') && !hasContentEditableAttr) return false
        if (el.getAttribute('aria-disabled') === 'true') return false
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.disabled || el.readOnly) return false
        }
        return visible(el)
      }

      const candidates = all.filter(isEditable)
      if (candidates.length === 0) return 'Smart target not found: no editable element'

      const targetTokens = target.split(' ').filter(Boolean)
      const textFields = (el) => {
        const attrs = [
          el.getAttribute('placeholder') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('name') || '',
          el.getAttribute('id') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-placeholder') || '',
          el.getAttribute('data-testid') || '',
          el.getAttribute('role') || '',
        ]
        const label = (() => {
          const id = el.getAttribute('id')
          if (id) {
            try {
              const l = document.querySelector('label[for="' + CSS.escape(id) + '"]')
              if (l) return l.textContent || ''
            } catch { /* ignore */ }
          }
          const p = el.closest('label')
          return p ? (p.textContent || '') : ''
        })()
        attrs.push(label)
        return normalize(attrs.join(' | '))
      }

      const score = (el) => {
        const merged = textFields(el)
        const rect = el.getBoundingClientRect()
        let s = 0

        if (target) {
          if (merged === target) s += 120
          if (merged.includes(target)) s += 70
          let tokenHit = 0
          for (const t of targetTokens) {
            if (merged.includes(t)) tokenHit += 1
          }
          s += tokenHit * 12
        } else {
          s += 20
        }

        if (/search|message|ask|prompt|chat|gemini|输入|搜索|提问|发送/.test(merged)) s += 30
        if (el instanceof HTMLTextAreaElement) s += 18
        if (el.isContentEditable) s += 14
        if ((el.getAttribute('role') || '').toLowerCase() === 'searchbox') s += 18

        const area = Math.max(1, rect.width * rect.height)
        s += Math.min(28, area / 18000)
        const fromBottom = Math.max(0, window.innerHeight - rect.bottom)
        s += Math.max(0, 10 - Math.min(10, fromBottom / 70))
        return s
      }

      let best = null
      let bestScore = -1
      for (const el of candidates) {
        const sc = score(el)
        if (sc > bestScore) {
          best = el
          bestScore = sc
        }
      }

      if (!best) return 'Smart target not found: score failed'

      // EP1-I3 live-target net — the scorer may have resolved a captcha or
      // password field the args never named.
      const __readyGuard = readyInputGuard(best)
      if (__readyGuard) return __readyGuard

      const focusAndClick = (el) => {
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }) } catch { /* ignore */ }
        try { el.focus({ preventScroll: true }) } catch { /* ignore */ }
        try { el.click?.() } catch { /* ignore */ }
      }

      const readText = (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return String(el.value || '')
        }
        return String(el.innerText || el.textContent || '')
      }

      const setText = (el, value) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const current = String(el.value || '')
          if (normalize(current) === normalize(value)) return
          if (clearFirst) el.value = ''
          el.value = value
          return
        }
        if (el.isContentEditable) {
          const current = String(el.innerText || el.textContent || '')
          if (normalize(current) === normalize(value)) return
          if (clearFirst) el.textContent = ''
          let inserted = false
          try {
            const selection = window.getSelection()
            if (selection) {
              const range = document.createRange()
              range.selectNodeContents(el)
              range.collapse(false)
              selection.removeAllRanges()
              selection.addRange(range)
            }
            inserted = document.execCommand('insertText', false, value)
          } catch {
            inserted = false
          }
          if (!inserted) {
            el.textContent = (clearFirst ? '' : (el.textContent || '')) + value
          }
          return
        }
        el.textContent = value
      }

      focusAndClick(best)
      const currentText = normalize(readText(best))
      const normalizedText = normalize(text)
      const alreadyHasSameText = Boolean(currentText && normalizedText && currentText === normalizedText)
      if (!alreadyHasSameText) {
        setText(best, text)
        try {
          best.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        } catch {
          best.dispatchEvent(new Event('input', { bubbles: true }))
        }
        best.dispatchEvent(new Event('change', { bubbles: true }))
      }

      if (submit) {
        const keyOpts = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }
        const down = new KeyboardEvent('keydown', keyOpts)
        const notCanceled = best.dispatchEvent(down)
        best.dispatchEvent(new KeyboardEvent('keypress', keyOpts))
        best.dispatchEvent(new KeyboardEvent('keyup', keyOpts))
        if (notCanceled) {
          const form = best.closest('form')
          if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit()
          }
        }
      }

      const idName = best.getAttribute('name') || best.getAttribute('id') || best.getAttribute('aria-label') || best.tagName
      if (alreadyHasSameText) {
        return 'Smart target already has same text: ' + idName
      }
      return 'Typed into smart target: ' + idName + ' (score=' + bestScore.toFixed(2) + ')'
    })()
  `
}

async function runWorkflowStep(
  controller: BrowserController,
  step: Record<string, unknown>,
  fallbackTabId: string | null,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal)
  const action = String(step.action || '').trim().toLowerCase()
  const tabId = typeof step.tab_id === 'string' && step.tab_id.trim() ? step.tab_id : fallbackTabId
  if (!action) return 'Error: workflow step missing action'

  if (action === 'navigate') {
    const url = String(step.url || '').trim()
    if (!url) return 'Error: workflow navigate missing url'
    const result = await controller.navigate(tabId, url)
    if (!result.success) return `Error: ${result.error || 'navigate failed'}`
    const waitResult = await waitForReady(controller, tabId, Number(step.timeout_ms || 8000), undefined, signal)
    return `Navigated: ${url} (ready=${waitResult.ready}, elapsed=${waitResult.elapsedMs}ms)`
  }

  if (action === 'search') {
    const query = String(step.query || '').trim()
    if (!query) return 'Error: workflow search missing query'
    const engine = (String(step.engine || 'auto') as SearchEngine)
    const selected = engine === 'auto' ? 'duckduckgo' : engine
    const nav = await controller.navigate(tabId, searchUrl(selected as SearchEngine, query))
    if (!nav.success) return `Error: ${nav.error || 'search navigate failed'}`
    await waitForReady(controller, tabId, Number(step.timeout_ms || 9000), undefined, signal)
    const rows = await extractSearchResults(controller, tabId)
    if (rows.length === 0) return `Search ${selected}: no parsed results for "${query}"`
    return `Search ${selected}: ${rows.map((r, i) => `${i + 1}. ${r.title} - ${r.url}`).join('\n')}`
  }

  if (action === 'wait') {
    const timeoutMs = Number(step.timeout_ms || 8000)
    const selector = typeof step.selector === 'string' ? step.selector : undefined
    const ready = await waitForReady(controller, tabId, timeoutMs, selector, signal)
    return `Wait done: ready=${ready.ready}, selectorMatched=${ready.matchedSelector}, elapsed=${ready.elapsedMs}ms`
  }

  if (action === 'click') {
    const selector = String(step.selector || '').trim()
    if (!selector) return 'Error: workflow click missing selector'
    // EP1-I3 live-target net — browser_run_workflow is not in the dispatch
    // confirmation policy, so the inner click is invisible to the gate; it
    // must re-check at the execution layer via the shared guarded entry.
    return await runGuardedSelectorClick(controller, tabId, selector)
  }

  if (action === 'click_text') {
    const text = String(step.text || '').trim()
    if (!text) return 'Error: workflow click_text missing text'
    const exact = step.exact === true
    // The text arg itself is the semantic the model chose to click — guard
    // it directly, and the located-element owner label is re-checked inside
    // buildClickByTextJs before the click fires.
    const textHit = matchManualOnlyBrowserTarget(text)
    if (textHit) {
      throw new ToolDomainError(
        'denied_manual_only',
        `workflow click_text 目标文本「${text.slice(0, 80)}」命中 M1 规则（${textHit.reason}）。请引导用户亲自完成这一步。`,
        { text, ruleId: textHit.ruleId },
      )
    }
    const located = await controller.executeJS(tabId, buildClickByTextJs(text, exact))
    throwIfLiveTargetGuardBlocked(located, { text, via: 'workflow_click_text' })
    return String(located)
  }

  if (action === 'click_at') {
    const x = Number(step.x)
    const y = Number(step.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: workflow click_at requires numeric x and y'
    const point = await runGuardedCoordinateClick(controller, tabId, x, y, signal)
    return `Clicked at normalized(${point.nx},${point.ny}) css(${point.cssX},${point.cssY})`
  }

  if (action === 'type') {
    const selector = String(step.selector || '').trim()
    const text = String(step.text || '')
    if (!selector) return 'Error: workflow type missing selector'
    const clearFirst = step.clear_first !== false
    const submit = step.submit === true
    // Workflow steps are model-authored and never pass through the dispatch
    // confirmation→release path, so there is no confirmed-cue: a password
    // field always reroutes (allowPasswordFill: false).
    return await runGuardedSelectorType(controller, tabId, selector, text, {
      clearFirst,
      allowPasswordFill: false,
      submit,
    })
  }

  if (action === 'type_at') {
    const x = Number(step.x)
    const y = Number(step.y)
    const text = String(step.text || '')
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: workflow type_at requires numeric x and y'
    if (!text) return 'Error: workflow type_at missing text'
    const clearBefore = step.clear_before_typing !== false
    const pressEnter = step.press_enter !== false
    const useShiftEnter = step.use_shift_enter_for_newline === true
    const point = await runGuardedCoordinateType(controller, tabId, x, y, text, {
      clearBefore,
      pressEnter,
      useShiftEnter,
      allowPasswordFill: false,
    }, signal)
    return `Typed at normalized(${point.nx},${point.ny}) css(${point.cssX},${point.cssY})`
  }

  if (action === 'scroll_at') {
    const x = Number(step.x ?? 500)
    const y = Number(step.y ?? 500)
    const direction = String(step.direction || '').toLowerCase()
    const magnitude = Math.max(40, Math.min(4000, Number(step.magnitude || 800)))
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      return 'Error: workflow scroll_at direction must be up/down/left/right'
    }
    const point = await resolveCssPoint(controller, tabId, x, y)
    const deltaY = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0
    const deltaX = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0
    await controller.dispatchMouse(tabId, {
      type: 'mouseWheel',
      x: point.cssX,
      y: point.cssY,
      deltaX,
      deltaY,
      button: 'none',
      buttons: 0,
    })
    return `Scrolled ${direction} at normalized(${point.nx},${point.ny})`
  }

  if (action === 'send_keys') {
    const key = String(step.key || '').trim()
    if (!key) return 'Error: workflow send_keys missing key'
    await sendKeyStroke(controller, tabId, key, step.modifiers)
    return `Sent key: ${key}`
  }

  if (action === 'read') {
    const text = await controller.getPageContent(tabId)
    return truncate(text, Number(step.max_chars || 6000))
  }

  if (action === 'execute_js') {
    const code = String(step.code || '')
    if (!code) return 'Error: workflow execute_js missing code'
    return String(await controller.executeJS(tabId, code))
  }

  if (action === 'compose') {
    const text = String(step.text || '')
    if (!text) return 'Error: workflow compose missing text'
    const target = String(step.target || '')
    const clearFirst = step.clear_first !== false
    const submit = step.submit !== false
    // EP1-I3 live-target net — workflow compose shares the smart-type guard;
    // workflow steps are model-authored, so there is no confirmed-cue path
    // (allowPasswordFill stays false) and markers must throw, not stringify.
    const rawWorkflowCompose = await controller.executeJS(tabId, buildSmartTypeJs({ target, text, clearFirst, submit }))
    throwIfLiveTargetGuardBlocked(rawWorkflowCompose, { target, via: 'workflow_compose' })
    return String(rawWorkflowCompose)
  }

  return `Error: unknown workflow action "${action}"`
}

function formatBrowserV2Error(prefix: string, error: unknown, attempted: string[]): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = normalizeErrorCode(error)
  return `${prefix}\nerror_code=${code}\nerror=${message}\nattempted=${attempted.join(' -> ')}`
}

async function runGeminiQuery(
  controller: BrowserController,
  text: string,
  tabId: string | null,
  waitResponseMs: number,
  signal?: AbortSignal,
): Promise<string> {
  log(`[browser-v3][phase] browser_query_gemini start wait=${waitResponseMs}`)
  const attempted: string[] = []
  let activeTabId = tabId
  let submitted = false
  let responseDetected = false
  let evidence: Record<string, unknown> = {}

  try {
    throwIfAborted(signal)
    attempted.push('ensure-tab')
    if (!activeTabId) {
      const tabs = controller.getTabList()
      activeTabId = tabs.find((tab) => tab.active)?.id || null
      if (!activeTabId) {
        const created = await controller.createTab('https://gemini.google.com')
        if (!created.success || !created.tabId) {
          return formatBrowserV2Error('[browser-v3][phase] create-tab failed', new Error(created.error || 'create tab failed'), attempted)
        }
        activeTabId = created.tabId
      }
    }

    attempted.push('navigate-gemini')
    const currentUrl = String(await controller.executeJS(activeTabId, 'window.location.href') || '')
    if (!/gemini\.google\.com/i.test(currentUrl)) {
      const navResult = await controller.navigate(activeTabId, 'https://gemini.google.com')
      if (!navResult.success) {
        return formatBrowserV2Error('[browser-v3][phase] navigate failed', new Error(navResult.error || 'navigate failed'), attempted)
      }
    }

    await sleepWithAbort(BROWSER_V2_WAIT_AFTER_NAV_MS, signal)
    await waitForLoadingStop(controller, activeTabId, BROWSER_V2_STOP_LOADING_TIMEOUT_MS, signal)

    attempted.push('compose-dom')
    const domResult = String(
      await controller.executeJS(
        activeTabId,
        buildSmartTypeJs({
          target: 'Gemini message input prompt 输入 提问 搜索',
          text,
          clearFirst: true,
          submit: false,
        }),
      ),
    )
    submitted = /^typed into smart target:/i.test(domResult)
    evidence.domResult = domResult

    if (submitted) {
      attempted.push('verify-submit-after-dom')
      const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
      submitted = submitState.submitted
      evidence.submitMethod = submitState.method
      evidence.submitProbe = submitState.probe
    }

    if (!submitted) {
      attempted.push('probe-editables')
      const candidates = await probeGeminiEditableCandidates(controller, activeTabId)
      evidence.candidateCount = candidates.length
      if (candidates.length > 0) {
        attempted.push('type-at-top-candidate')
        const top = candidates[0]
        const point = await dispatchClickAt(controller, activeTabId, top.x, top.y)
        await clearFocusedInput(controller, activeTabId)
        await controller.typeTextDirectly(activeTabId, text, { useShiftEnterForNewline: false })
        const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
        submitted = submitState.submitted
        evidence.submitMethod = submitState.method
        evidence.submitProbe = submitState.probe
        evidence.coordinate = {
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          reason: top.reason,
        }
      }
    }

    if (!submitted) {
      attempted.push('fallback-bottom-center')
      const point = await dispatchClickAt(controller, activeTabId, 500, 920)
      await clearFocusedInput(controller, activeTabId)
      await controller.typeTextDirectly(activeTabId, text, { useShiftEnterForNewline: false })
      const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
      submitted = submitState.submitted
      evidence.submitMethod = submitState.method
      evidence.submitProbe = submitState.probe
      evidence.coordinate = {
        normalized: { x: point.nx, y: point.ny },
        css: { x: point.cssX, y: point.cssY },
        reason: 'fallback-bottom-center',
      }
    }

    if (!submitted) {
      return JSON.stringify({
        phase: 'submit_failed',
        submitted: false,
        response_detected: false,
        evidence,
        attempted,
        next_step: 'retry with browser_type_at + browser_send_keys or browser_ask_user_takeover',
      }, null, 2)
    }

    attempted.push('detect-response')
    const startedAt = Date.now()
    const initialWindowMs = Math.max(8_000, waitResponseMs)
    const hardTimeoutMs = Math.min(180_000, initialWindowMs + 90_000)
    const hardDeadline = startedAt + hardTimeoutMs
    let deadline = startedAt + initialWindowMs
    let inExtendedWait = false
    let stableResponseHits = 0
    let lastProbe: GeminiResponseProbe | null = null
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      lastProbe = await probeGeminiResponse(controller, activeTabId, text)
      if (lastProbe.loginRequired || lastProbe.captchaRequired) {
        const phase = 'human_required'
        return JSON.stringify({
          phase,
          submitted,
          response_detected: false,
          evidence: {
            ...evidence,
            reason: lastProbe.loginRequired ? 'login_required' : 'captcha_required',
            editableCount: lastProbe.editableCount,
          },
          next_step: 'use browser_ask_user_takeover',
        }, null, 2)
      }
      if (lastProbe.responseDetected) {
        stableResponseHits += 1
        if (stableResponseHits >= 2) {
          responseDetected = true
          evidence = {
            ...evidence,
            responseSnippet: lastProbe.responseText.slice(0, 300),
            editableCount: lastProbe.editableCount,
            thinking: false,
          }
          break
        }
      } else {
        stableResponseHits = 0
      }

      if (lastProbe.thinking && Date.now() + 8_000 >= deadline && deadline < hardDeadline) {
        inExtendedWait = true
        const nextDeadline = Math.min(hardDeadline, Date.now() + 22_000)
        if (nextDeadline > deadline) {
          deadline = nextDeadline
          attempted.push('extended-wait-thinking')
        }
      } else if (!lastProbe.thinking && !lastProbe.responseDetected && Date.now() + 4_000 >= deadline && deadline < hardDeadline) {
        const nextDeadline = Math.min(hardDeadline, Date.now() + 12_000)
        if (nextDeadline > deadline) {
          deadline = nextDeadline
          attempted.push('extended-wait-probe')
        }
      }
      await sleepWithAbort(900, signal)
    }

    const phase = responseDetected ? 'done' : 'submitted_waiting'
    log(`[browser-v3][phase] browser_query_gemini phase=${phase} submitted=${submitted} response=${responseDetected} submitMethod=${String(evidence.submitMethod || 'unknown')} extended=${inExtendedWait}`)
    if (!responseDetected && lastProbe) {
      evidence = {
        ...evidence,
        editableCount: lastProbe.editableCount,
        thinking: lastProbe.thinking,
        probe: 'response_not_detected_within_timeout',
        elapsedMs: Date.now() - startedAt,
      }
    }
    return JSON.stringify({
      phase,
      submitted,
      response_detected: responseDetected,
      evidence,
      attempted,
    }, null, 2)
  } catch (error) {
    log(`[browser-v3][fallback] browser_query_gemini error=${error instanceof Error ? error.message : String(error)}`)
    return formatBrowserV2Error('[browser-v3][fallback] browser_query_gemini failed', error, attempted)
  }
}

async function isLikelyChatPage(controller: BrowserController, tabId: string | null): Promise<boolean> {
  try {
    const url = String(await controller.executeJS(tabId, 'window.location.href') || '')
    if (/(^https?:\/\/)?([^/]*\.)?(gemini\.google\.com|kimi\.moonshot\.cn|chatgpt\.com|claude\.ai|perplexity\.ai|doubao\.com|yuanbao\.tencent\.com|deepseek\.com)/i.test(url)) {
      return true
    }
    const probe = await controller.executeJS(
      tabId,
      `
        (() => {
          const hasEditable = document.querySelector('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]') !== null
          const hasSendButton = document.querySelector('button[aria-label*="send" i],button[aria-label*="发送" i],button[title*="send" i],button[title*="发送" i],button[data-testid*="send" i]') !== null
          const text = String(document.body?.innerText || '').toLowerCase()
          const hasChatKeyword = /chat|message|assistant|提问|对话|发送|输入/.test(text)
          return hasEditable && (hasSendButton || hasChatKeyword)
        })()
      `,
    )
    return Boolean(probe)
  } catch {
    return false
  }
}

interface ScopeAttachmentCandidate {
  attachmentId: string
  name: string
  path: string
  type: string
  size: number
  ext: string
  createdAt: string
}

interface ActionTargetCandidate {
  kind: 'input' | 'launcher' | 'dropzone' | 'text_button' | 'icon_button' | 'send_button' | 'close_button' | 'back_button' | 'prompt_input'
  label: string
  selectorHint?: string
  x?: number
  y?: number
  confidence: number
  evidence: string[]
  associatedInputSelector?: string
  hidden?: boolean
  accepts?: string
  multiple?: boolean
  focused?: boolean
  textLength?: number
  valuePreview?: string
  nearActiveInput?: boolean
  distanceToActiveInput?: number
}

interface ScopeUploadMemory {
  attachmentId: string
  attachmentPath: string
  pageKey: string
  uploadedAt: number
}

const recentScopeUploads = new Map<string, ScopeUploadMemory>()
const RECENT_SCOPE_UPLOAD_TTL_MS = 2 * 60 * 1000

async function listScopeAttachmentsForTool(sessionId?: string): Promise<ScopeAttachmentCandidate[]> {
  const scopeId = String(sessionId || '').trim()
  if (!scopeId) return []
  const repository = new AgentRepository()
  return repository
    .listConversationAttachments(scopeId)
    .then((items) => items
    .filter((item) => item.path && existsSync(item.path))
    .map((item) => ({
      attachmentId: item.attachment_id,
      name: item.name,
      path: item.path,
      type: String(item.type || 'other'),
      size: Number(item.size || 0),
      ext: String(item.ext || ''),
      createdAt: item.created_at,
    })))
}

function selectScopeAttachment(
  attachments: ScopeAttachmentCandidate[],
  args: Record<string, unknown>,
): { attachment?: ScopeAttachmentCandidate; ambiguous?: ScopeAttachmentCandidate[]; reason?: string } {
  if (attachments.length === 0) {
    return { reason: '当前会话没有可用附件。' }
  }
  const attachmentId = String(args.attachment_id || '').trim()
  const attachmentName = String(args.attachment_name || '').trim().toLowerCase()
  const latest = args.latest !== false

  if (attachmentId) {
    const match = attachments.find((item) => item.attachmentId === attachmentId)
    return match ? { attachment: match } : { reason: `未找到附件: ${attachmentId}` }
  }

  if (attachmentName) {
    const matches = attachments.filter((item) => item.name.toLowerCase().includes(attachmentName))
    if (matches.length === 1) return { attachment: matches[0] }
    if (matches.length > 1) return { ambiguous: matches }
    return { reason: `未找到名称匹配的附件: ${attachmentName}` }
  }

  if (latest) return { attachment: attachments[0] }
  return { ambiguous: attachments.slice(0, 6) }
}

async function getPageIdentity(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ title: string; url: string; activeElement: string }> {
  const result = await controller.executeJS(
    tabId,
    `(() => ({
      title: document.title || '',
      url: location.href || '',
      activeElement:
        String(document.activeElement?.tagName || '').toLowerCase() +
        ':' +
        String(
          document.activeElement?.getAttribute?.('aria-label') ||
          document.activeElement?.getAttribute?.('placeholder') ||
          document.activeElement?.id ||
          ''
        ),
    }))()`,
  ) as { title?: string; url?: string; activeElement?: string } | null
  return {
    title: String(result?.title || ''),
    url: String(result?.url || ''),
    activeElement: String(result?.activeElement || ''),
  }
}

interface WorkflowUploadProbe {
  complete: boolean
  evidence: string[]
  inputHasFiles: boolean
  previewVisible: boolean
  attachmentNameMatched: boolean
  removeActionVisible: boolean
}

interface WorkflowDomStateProbe {
  inputCandidateCount: number
  sendCandidateCount: number
  uploadCandidateCount: number
  modalVisible: boolean
  bodyStateText: string
}

interface WorkflowPromptSubmissionProbe {
  promptMatched: boolean
  promptFilled: boolean
  promptText: string
  generating: boolean
  submitEvidence: string[]
  sendButtonCount: number
  sendButtonDisabled: boolean
  uploadChipVisible: boolean
}

async function probeWorkflowUploadState(
  controller: BrowserController,
  tabId: string | null,
  attachmentName?: string,
): Promise<WorkflowUploadProbe> {
  const safeName = String(attachmentName || '').trim()
  const basename = safeName.replace(/\.[a-z0-9]{1,8}$/i, '').toLowerCase()
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width < 12 || rect.height < 12) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false
        return Number(style.opacity || '1') > 0
      }
      const attachmentNeedle = ${JSON.stringify(basename)}
      const bodyText = normalize(document.body?.innerText || '')
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter((node) => node instanceof HTMLInputElement)
      const inputHasFiles = fileInputs.some((node) => node.files && node.files.length > 0)
      const viewportW = Math.max(1, window.innerWidth || 0)
      const viewportH = Math.max(1, window.innerHeight || 0)
      const previewNodes = Array.from(document.querySelectorAll('img,video,[role="img"],canvas,.thumbnail,[class*="thumb"],[class*="preview"],[data-testid*="upload" i],[data-testid*="preview" i]'))
        .filter((node) => visible(node))
      const removeNodes = Array.from(document.querySelectorAll('button,[role="button"],span,div,a'))
        .filter((node) => visible(node))
        .map((node) => normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || ''))
        .filter((text) => /remove|delete|clear|close|移除|删除|清除|取消|×|x/.test(text))
      const uploadMarkers = /upload|uploaded|preview|thumbnail|附件|参考图|素材|已上传|原图|参考/.test(bodyText)
      const attachmentNameMatched = Boolean(attachmentNeedle && bodyText.includes(attachmentNeedle))
      const previewVisible = previewNodes.some((node) => {
        if (!(node instanceof HTMLElement)) return false
        const rect = node.getBoundingClientRect()
        const meta = normalize([
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          node.getAttribute?.('data-testid'),
          node.getAttribute?.('class'),
          node.textContent,
        ].filter(Boolean).join(' '))
        const looksLikeNamedPreview = !attachmentNeedle || meta.includes(attachmentNeedle) || /preview|thumbnail|附件|已上传|upload|参考图|素材/.test(meta)
        const smallPreviewCluster =
          rect.width >= 24 &&
          rect.height >= 24 &&
          rect.width <= Math.min(220, viewportW * 0.28) &&
          rect.height <= Math.min(220, viewportH * 0.28) &&
          rect.top >= viewportH * 0.55
        return looksLikeNamedPreview || smallPreviewCluster || uploadMarkers || removeNodes.length > 0
      })
      const evidence = []
      if (inputHasFiles) evidence.push('file_input_has_files')
      if (attachmentNameMatched) evidence.push('attachment_name_visible')
      if (previewVisible) evidence.push('preview_or_chip_visible')
      if (removeNodes.length > 0) evidence.push('remove_action_visible')
      return {
        complete: Boolean(inputHasFiles || attachmentNameMatched || previewVisible),
        evidence,
        inputHasFiles,
        previewVisible,
        attachmentNameMatched,
        removeActionVisible: removeNodes.length > 0,
      }
    })()`,
  ) as WorkflowUploadProbe | null

  return {
    complete: Boolean(result?.complete),
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    inputHasFiles: Boolean(result?.inputHasFiles),
    previewVisible: Boolean(result?.previewVisible),
    attachmentNameMatched: Boolean(result?.attachmentNameMatched),
    removeActionVisible: Boolean(result?.removeActionVisible),
  }
}

async function probeWorkflowDomState(
  controller: BrowserController,
  tabId: string | null,
): Promise<WorkflowDomStateProbe> {
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width < 10 || rect.height < 10) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false
        return Number(style.opacity || '1') > 0
      }
      const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
        .filter((node) => visible(node))
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],label,[tabindex]'))
        .filter((node) => visible(node))
      const sendCandidateCount = buttons.filter((node) => {
        const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
        return /send|提交|发送|继续|generate|生成|创作|run|go|发布/.test(meta)
      }).length
      const uploadCandidateCount = buttons.filter((node) => {
        const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
        return /upload|上传|附件|图片|素材|参考图|file|image|plus|add|导入|拖拽/.test(meta)
      }).length
      const modalVisible = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog,.modal,.drawer,.popup'))
        .some((node) => visible(node))
      const bodyStateText = normalize(document.body?.innerText || '').slice(0, 1200)
      return {
        inputCandidateCount: editables.length,
        sendCandidateCount,
        uploadCandidateCount,
        modalVisible,
        bodyStateText,
      }
    })()`,
  ) as WorkflowDomStateProbe | null

  return {
    inputCandidateCount: Number(result?.inputCandidateCount || 0),
    sendCandidateCount: Number(result?.sendCandidateCount || 0),
    uploadCandidateCount: Number(result?.uploadCandidateCount || 0),
    modalVisible: Boolean(result?.modalVisible),
    bodyStateText: String(result?.bodyStateText || ''),
  }
}

async function probeWorkflowPromptSubmissionState(
  controller: BrowserController,
  tabId: string | null,
  expectedPrompt: string,
): Promise<WorkflowPromptSubmissionProbe> {
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const expected = ${JSON.stringify(String(expectedPrompt || '').trim().toLowerCase())}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
        return true
      }
      const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
      const isEditable = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
        const isTextarea = el instanceof HTMLTextAreaElement
        const role = (el.getAttribute('role') || '').toLowerCase()
        const roleTextbox = role === 'textbox' || role === 'searchbox'
        const hasContentEditableAttr = el.hasAttribute('contenteditable')
        const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
        const isContentEditable =
          el.isContentEditable ||
          (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
        if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
        if (el.getAttribute('aria-disabled') === 'true') return false
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.disabled || el.readOnly) return false
        }
        return visible(el)
      }
      const editableText = (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || '')
        return String(el.innerText || el.textContent || '')
      }
      const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="searchbox"]'))
        .filter(isEditable)
      const promptCandidate = editables
        .map((el) => {
          const meta = normalize([
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            el.getAttribute('name'),
            el.getAttribute('id'),
            el.getAttribute('title'),
            el.getAttribute('data-testid'),
            el.getAttribute('class'),
          ].filter(Boolean).join(' '))
          const rect = el.getBoundingClientRect()
          let score = 0
          if (/prompt|提示|文案|描述|输入|message|chat|ask|生成|创作|内容/.test(meta)) score += 12
          if (el.tagName.toLowerCase() === 'textarea') score += 4
          if ((el instanceof HTMLElement) && el.isContentEditable) score += 3
          if (rect.bottom > window.innerHeight * 0.45) score += 3
          if (rect.width > window.innerWidth * 0.25) score += 2
          if (/时间|生成类型|操作类型|筛选|排序|search|搜索/.test(meta)) score -= 14
          if (rect.top < window.innerHeight * 0.38) score -= 8
          return { text: editableText(el), score }
        })
        .filter((item) => item.score >= 2)
        .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0]

      const promptText = normalize(promptCandidate?.text || '')
      const promptMatched =
        Boolean(expected) &&
        promptText.length >= Math.min(Math.max(12, Math.floor(expected.length * 0.4)), expected.length) &&
        (promptText === expected || promptText.includes(expected) || expected.includes(promptText))
      const promptFilled = Boolean(promptText)
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'))
        .filter(visible)
        .map((el) => {
          const meta = normalize([
            el.textContent,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('data-testid'),
            el.getAttribute('class'),
          ].filter(Boolean).join(' '))
          const disabled =
            (el instanceof HTMLButtonElement && el.disabled) ||
            (el instanceof HTMLInputElement && el.disabled) ||
            el.getAttribute('aria-disabled') === 'true'
          return { meta, disabled }
        })
      const sendButtons = buttons.filter((item) => /send|发送|提交|发布|继续|go|run|submit|generate|generating|生成|创作|开始/.test(item.meta))
      const sendButtonCount = sendButtons.length
      const sendButtonDisabled = sendButtons.length > 0 && sendButtons.every((item) => item.disabled)
      const bodyText = normalize(document.body?.innerText || '')
      const uploadChipVisible = /已上传|upload|preview|thumbnail|附件/.test(bodyText) && /remove|delete|移除|删除|清除/.test(bodyText)
      const submitEvidence = []
      if (/thinking|正在思考|思考中|生成中|creating|generating|uploading|上传中|处理中|responding|排队中/.test(bodyText)) {
        submitEvidence.push('page_processing_state')
      }
      return {
        promptMatched,
        promptFilled,
        promptText,
        generating: submitEvidence.length > 0,
        submitEvidence,
        sendButtonCount,
        sendButtonDisabled,
        uploadChipVisible,
      }
    })()`,
  ) as WorkflowPromptSubmissionProbe | null

  return {
    promptMatched: Boolean(result?.promptMatched),
    promptFilled: Boolean(result?.promptFilled),
    promptText: String(result?.promptText || ''),
    generating: Boolean(result?.generating),
    submitEvidence: Array.isArray(result?.submitEvidence) ? result.submitEvidence : [],
    sendButtonCount: Number(result?.sendButtonCount || 0),
    sendButtonDisabled: Boolean(result?.sendButtonDisabled),
    uploadChipVisible: Boolean(result?.uploadChipVisible),
  }
}

function buildScopeUploadKey(sessionId: string | undefined, pageIdentity: { title: string; url: string }): string {
  let normalizedPage = pageIdentity.title || 'unknown'
  try {
    const parsed = new URL(pageIdentity.url)
    normalizedPage = `${parsed.origin}${parsed.pathname}` || normalizedPage
  } catch {
    normalizedPage = pageIdentity.url || normalizedPage
  }
  return `${sessionId || 'global'}::${normalizedPage}`
}

async function locateActionTargets(
  controller: BrowserController,
  tabId: string | null,
  action: 'upload' | 'send' | 'close' | 'back' | 'input',
): Promise<ActionTargetCandidate[]> {
  if (action === 'upload') {
    const targets = await controller.findUploadTargets(tabId)
    return targets.map((item) => ({
      kind: item.kind,
      label: item.label,
      selectorHint: item.selectorHint,
      x: item.x,
      y: item.y,
      confidence: Number(item.confidence || 0),
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      associatedInputSelector: item.associatedInputSelector,
      hidden: item.hidden,
      accepts: item.accepts,
      multiple: item.multiple,
    }))
  }

  if (action === 'input') {
    const targets = await controller.executeJS(
      tabId,
      `
        (() => {
          const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false
            const rect = el.getBoundingClientRect()
            if (!rect || rect.width < 10 || rect.height < 10) return false
            const style = getComputedStyle(el)
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false
            if (Number(style.opacity || '1') <= 0) return false
            return true
          }
          const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
          const isEditable = (el) => {
            if (!(el instanceof HTMLElement)) return false
            const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
            const isTextarea = el instanceof HTMLTextAreaElement
            const role = (el.getAttribute('role') || '').toLowerCase()
            const roleTextbox = role === 'textbox' || role === 'combobox' || role === 'searchbox'
            const hasContentEditableAttr = el.hasAttribute('contenteditable')
            const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
            const isContentEditable =
              el.isContentEditable ||
              (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
            if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
            if (el.getAttribute('aria-disabled') === 'true') return false
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              if (el.disabled || el.readOnly) return false
            }
            return visible(el)
          }
          const extractLabel = (el) => {
            const attrs = [
              el.getAttribute('placeholder'),
              el.getAttribute('aria-label'),
              el.getAttribute('name'),
              el.getAttribute('id'),
              el.getAttribute('title'),
              el.getAttribute('data-testid'),
              el.getAttribute('class'),
            ].filter(Boolean)
            const id = el.getAttribute('id')
            if (id) {
              try {
                const linked = document.querySelector('label[for="' + CSS.escape(id) + '"]')
                if (linked?.textContent) attrs.push(linked.textContent)
              } catch {
                // ignore
              }
            }
            const parentLabel = el.closest('label')
            if (parentLabel?.textContent) attrs.push(parentLabel.textContent)
            return normalize(attrs.join(' '))
          }
          const active = document.activeElement instanceof HTMLElement && isEditable(document.activeElement)
            ? document.activeElement
            : null
          const readValue = (el) => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              return String(el.value || '')
            }
            return String(el.innerText || el.textContent || '')
          }
          const nodes = Array.from(document.querySelectorAll('textarea,input,[role="textbox"],[role="combobox"],[role="searchbox"],[contenteditable]'))
            .filter((node) => node instanceof HTMLElement)
            .filter((node) => isEditable(node))
          const out = nodes.map((node) => {
            const rect = node.getBoundingClientRect()
            const label = extractLabel(node)
            const value = normalize(readValue(node))
            const focused = !!active && active === node
            let score = 0
            if (/prompt|提示|描述|文案|内容|输入|message|chat|ask|search|搜索|生成|创作|正文/.test(label)) score += 14
            if (node.tagName.toLowerCase() === 'textarea') score += 6
            if ((node instanceof HTMLElement) && node.isContentEditable) score += 5
            if (rect.bottom > window.innerHeight * 0.4) score += 4
            if (rect.width > window.innerWidth * 0.22) score += 4
            if (rect.height >= 32) score += 2
            if (focused) score += 18
            if (value.length > 0) score += Math.min(6, value.length / 24)
            if (/时间|生成类型|操作类型|筛选|排序/.test(label)) score -= 16
            if (rect.top < window.innerHeight * 0.38) score -= 8
            return {
              kind: 'prompt_input',
              label,
              selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
              x: Math.max(0, Math.min(999, Math.round(((rect.left + rect.width / 2) / Math.max(1, window.innerWidth)) * 999))),
              y: Math.max(0, Math.min(999, Math.round(((rect.top + rect.height / 2) / Math.max(1, window.innerHeight)) * 999))),
              confidence: Math.min(0.99, 0.35 + score / 22),
              evidence: [label ? 'editable_label_match' : 'editable_visible', focused ? 'active_input' : '', value.length > 0 ? 'has_text' : ''].filter(Boolean),
              focused,
              textLength: value.length,
              valuePreview: value.slice(0, 80),
            }
          })
          return out
            .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
            .slice(0, 10)
        })()
      `,
    ) as ActionTargetCandidate[] | null

    return Array.isArray(targets) ? targets : []
  }

  const keywordMap: Record<'upload' | 'send' | 'close' | 'back', string[]> = {
    upload: ['upload'],
    send: ['send', '发送', '提交', '发布', '继续', '生成', 'go', 'ask', 'submit'],
    close: ['close', '关闭', '取消', '退出', 'dismiss', '×', 'x'],
    back: ['back', '返回', '上一步', '撤销', 'go back', '返回上一页'],
  }

  const targets = await controller.executeJS(
    tabId,
    `
      (() => {
        const action = ${JSON.stringify(action)}
        const keywords = ${JSON.stringify(keywordMap[action])}
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const isClickable = (el) => {
          const tag = String(el.tagName || '').toLowerCase()
          if (['button', 'a', 'summary'].includes(tag)) return true
          const role = (el.getAttribute('role') || '').toLowerCase()
          if (['button', 'link', 'tab', 'menuitem'].includes(role)) return true
          if (el instanceof HTMLInputElement && ['button', 'submit'].includes((el.type || '').toLowerCase())) return true
          return el.hasAttribute('onclick') || typeof el.onclick === 'function'
        }
        const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
        const isEditable = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
          const isTextarea = el instanceof HTMLTextAreaElement
          const role = (el.getAttribute('role') || '').toLowerCase()
          const roleTextbox = role === 'textbox' || role === 'combobox' || role === 'searchbox'
          const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
          const isContentEditable =
            el.isContentEditable ||
            (el.hasAttribute('contenteditable') && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
          if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
          if (el.getAttribute('aria-disabled') === 'true') return false
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.disabled || el.readOnly) return false
          }
          return visible(el)
        }
        const activeInput = action === 'send' && document.activeElement instanceof HTMLElement && isEditable(document.activeElement)
          ? document.activeElement
          : null
        const activeRect = activeInput ? activeInput.getBoundingClientRect() : null
        const activeForm = activeInput ? activeInput.closest('form') : null
        const out = []
        for (const node of Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"],summary,input[type="submit"],div,span'))) {
          if (!(node instanceof HTMLElement) || !visible(node)) continue
          const rect = node.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          const explicitClickable = isClickable(node)
          const meta = normalize([
            node.textContent,
            node.getAttribute('aria-label'),
            node.getAttribute('title'),
            node.getAttribute('data-testid'),
            node.getAttribute('class'),
          ].filter(Boolean).join(' ')).toLowerCase()
          if (!explicitClickable && !meta) continue
          const distanceToActiveInput = activeRect
            ? Math.round(Math.hypot(
              centerX - (activeRect.left + activeRect.width / 2),
              centerY - (activeRect.top + activeRect.height / 2),
            ))
            : undefined
          const nearActiveInput = action === 'send' && !!activeRect
            ? (
              (centerX >= activeRect.left - 160 && centerX <= activeRect.right + 260 && centerY >= activeRect.top - 90 && centerY <= activeRect.bottom + 220) ||
              Number(distanceToActiveInput || 0) <= Math.max(240, Math.min(window.innerWidth * 0.28, 360))
            )
            : false
          const sameFormAsActiveInput = action === 'send' && !!activeForm && activeForm.contains(node)
          const inNavigationLikeRegion = !!node.closest('nav,aside,[role="navigation"],header,[data-testid*="nav" i],[class*="sidebar" i],[class*="sider" i]')
          if (action === 'send') {
            const hugeSurface = rect.width > window.innerWidth * 0.42 || rect.height > window.innerHeight * 0.14
            const hugeText = meta.length > 42
            if (hugeSurface || hugeText) continue
            const likelyLeftNav = rect.left < window.innerWidth * 0.18 && rect.top < window.innerHeight * 0.72
            const weakGenerateOnly = /^生成$/.test(meta) || /(^|\\s)生成(\\s|$)/.test(meta)
            if (likelyLeftNav && weakGenerateOnly) continue
            const browserChromeLike = rect.top < window.innerHeight * 0.14 && rect.height <= 72
            if (browserChromeLike) continue
          }
          let score = 0
          let keywordHits = 0
          for (const keyword of keywords) {
            if (meta.includes(String(keyword).toLowerCase())) {
              score += 10
              keywordHits += 1
            }
          }
          if (!score && !explicitClickable) continue
          if (action === 'send') {
            if (rect.right > window.innerWidth * 0.68) score += 4
            if (rect.bottom > window.innerHeight * 0.62) score += 4
            if (rect.width <= 88 && rect.height <= 88) score += 3
            if (nearActiveInput) score += 18
            else if (activeRect) score -= 10
            if (sameFormAsActiveInput) score += 12
            if (inNavigationLikeRegion && !nearActiveInput) score -= 16
            if (/(灵感|资产|画布|会员|首页|模板|导航)/.test(meta)) score -= 12
            if (/(重新生成|再次生成|再试一次|try again|retry|历史|history)/.test(meta)) score -= 18
            if (rect.left < window.innerWidth * 0.2) score -= 10
            if (rect.top < window.innerHeight * 0.48 && rect.left < window.innerWidth * 0.35) score -= 10
            if (activeRect && rect.top < activeRect.top - 120) score -= 8
            if (activeRect && rect.left < activeRect.left - 220) score -= 6
            if (rect.bottom < window.innerHeight * 0.45 && !/(send|发送|提交|发布|go|run|submit)/.test(meta)) score -= 8
            if (!keywordHits && !nearActiveInput && !sameFormAsActiveInput) score -= 6
          }
          if (action === 'close') {
            const topRight = rect.right > window.innerWidth * 0.62 && rect.top < window.innerHeight * 0.35
            const explicitClose = /(close|关闭|取消|退出|dismiss|×|\bx\b)/.test(meta)
            if ((!topRight && !explicitClose) || rect.width > 120 || rect.height > 120) continue
          }
          if (action === 'send' && rect.bottom > window.innerHeight * 0.55) score += 4
          if (action === 'close' && rect.top < window.innerHeight * 0.35) score += 4
          if (action === 'back' && rect.left < window.innerWidth * 0.35) score += 4
          if (/icon|arrow|chevron|close|send|upload|attach|paperclip|plus|返回|关闭|发送|上传/.test(meta)) score += 2
          if (score <= 0) continue
          out.push({
            kind: action === 'send' ? 'send_button' : action === 'close' ? 'close_button' : action === 'back' ? 'back_button' : 'icon_button',
            label: normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || ''),
            selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
            x: Math.max(0, Math.min(999, Math.round((centerX / Math.max(1, window.innerWidth)) * 999))),
            y: Math.max(0, Math.min(999, Math.round((centerY / Math.max(1, window.innerHeight)) * 999))),
            confidence: Math.min(0.98, 0.28 + Math.max(0, score) / 28),
            evidence: [
              keywordHits > 0 ? 'keyword_match' : '',
              explicitClickable ? 'explicit_clickable' : '',
              nearActiveInput ? 'near_active_input' : '',
              sameFormAsActiveInput ? 'same_form_as_active_input' : '',
            ].filter(Boolean),
            nearActiveInput: nearActiveInput || undefined,
            distanceToActiveInput,
          })
        }
        return out
          .sort((a, b) =>
            Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
            Number(b.confidence || 0) - Number(a.confidence || 0) ||
            Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY)
          )
          .slice(0, 12)
      })()
    `,
  ) as ActionTargetCandidate[] | null

  return Array.isArray(targets) ? targets : []
}

function pickActiveInputTarget(targets: ActionTargetCandidate[]): ActionTargetCandidate | null {
  const focusedTargets = targets.filter((item) => item.focused)
  if (focusedTargets.length === 0) return null
  return [...focusedTargets].sort((a, b) =>
    Number(b.confidence || 0) - Number(a.confidence || 0) ||
    Number(b.textLength || 0) - Number(a.textLength || 0)
  )[0] || null
}

function rankTargetsNearAnchor(
  targets: ActionTargetCandidate[],
  anchor: ActionTargetCandidate | null,
): ActionTargetCandidate[] {
  const anchorX = Number(anchor?.x)
  const anchorY = Number(anchor?.y)
  if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) {
    return [...targets].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
  }

  return [...targets]
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item) => {
      const dx = Number(item.x) - anchorX
      const dy = Number(item.y) - anchorY
      const distance = Math.round(Math.hypot(dx, dy))
      const nearAnchor =
        Boolean(item.nearActiveInput) ||
        (dx >= -140 && dx <= 260 && dy >= -80 && dy <= 220) ||
        distance <= 280 ||
        (Number(item.x) >= 760 && Number(item.y) >= 700)
      return {
        ...item,
        nearActiveInput: nearAnchor,
        distanceToActiveInput: Number.isFinite(item.distanceToActiveInput)
          ? Number(item.distanceToActiveInput)
          : distance,
      }
    })
    .sort((a, b) =>
      Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
      Number(b.confidence || 0) - Number(a.confidence || 0) ||
      Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY)
    )
}

function pickBestActionTarget(
  targets: ActionTargetCandidate[],
  preferredKinds: ActionTargetCandidate['kind'][],
): ActionTargetCandidate | null {
  if (targets.length === 0) return null
  const ranked = [...targets].sort((a, b) => {
    const aKind = preferredKinds.includes(a.kind) ? 1 : 0
    const bKind = preferredKinds.includes(b.kind) ? 1 : 0
    if (aKind !== bKind) return bKind - aKind
    return Number(b.confidence || 0) - Number(a.confidence || 0)
  })
  return ranked[0] || null
}

async function clickActionTarget(
  controller: BrowserController,
  tabId: string | null,
  target: ActionTargetCandidate,
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; method: string }> {
  const canUseSelector = typeof target.selectorHint === 'string' &&
    target.selectorHint.length > 0 &&
    (target.selectorHint.startsWith('#') || target.selectorHint.includes('['))
  if (canUseSelector) {
    const result = await controller.executeJS(
      tabId,
      `
        (() => {
          const selector = ${JSON.stringify(target.selectorHint)}
          try {
            const node = document.querySelector(selector)
            if (!(node instanceof HTMLElement)) return { ok: false, method: 'selector_not_found' }
            node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
            node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
            if (typeof node.click === 'function') node.click()
            else {
              node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }
            return { ok: true, method: 'selector_click' }
          } catch (error) {
            return { ok: false, method: String(error || 'selector_click_failed') }
          }
        })()
      `,
    ) as { ok?: boolean; method?: string } | null
    if (result?.ok) {
      await settleAfterAction(controller, tabId, abortSignal)
      return { ok: true, method: String(result.method || 'selector_click') }
    }
  }
  if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
    await dispatchClickAt(controller, tabId, Number(target.x), Number(target.y))
    await settleAfterAction(controller, tabId, abortSignal)
    return { ok: true, method: 'coordinate_click' }
  }
  return { ok: false, method: 'no_clickable_target' }
}

async function attemptRecoverPageState(
  controller: BrowserController,
  tabId: string | null,
  signal?: AbortSignal,
): Promise<{ recovered: boolean; method: string }> {
  try {
    await sendKeyStroke(controller, tabId, 'Escape')
    await sleepWithAbort(160, signal)
    return { recovered: true, method: 'escape' }
  } catch {
    // continue
  }

  const closeTargets = await locateActionTargets(controller, tabId, 'close')
  const closeTarget = pickBestActionTarget(closeTargets, ['close_button', 'icon_button'])
  if (closeTarget) {
    const clicked = await clickActionTarget(controller, tabId, closeTarget, signal)
    if (clicked.ok) return { recovered: true, method: clicked.method }
  }

  const backTargets = await locateActionTargets(controller, tabId, 'back')
  const backTarget = pickBestActionTarget(backTargets, ['back_button', 'icon_button'])
  if (backTarget) {
    const clicked = await clickActionTarget(controller, tabId, backTarget, signal)
    if (clicked.ok) return { recovered: true, method: clicked.method }
  }

  const goBack = controller.goBack(tabId)
  if (goBack.success) {
    await settleAfterAction(controller, tabId, signal)
    return { recovered: true, method: 'browser_go_back' }
  }

  return { recovered: false, method: 'recover_failed' }
}

function chooseUploadTarget(
  targets: ActionTargetCandidate[],
  args: Record<string, unknown>,
): ActionTargetCandidate | null {
  if (targets.length === 0) return null
  const selector = String(args.selector || '').trim()
  const targetText = String(args.target || '').trim().toLowerCase()
  if (selector) {
    const bySelector = targets.find((item) => item.selectorHint === selector || item.associatedInputSelector === selector)
    if (bySelector) return bySelector
  }
  if (targetText) {
    const byLabel = targets
      .filter((item) => item.label.toLowerCase().includes(targetText))
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    if (byLabel[0]) return byLabel[0]
  }
  return pickBestActionTarget(targets, ['input', 'launcher', 'dropzone'])
}

async function verifyUploadState(
  controller: BrowserController,
  tabId: string | null,
  fileName: string,
): Promise<{ success: boolean; reason: string; evidence?: string[] }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const wanted = ${JSON.stringify(fileName.toLowerCase())}
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        const hasSelectedFile = inputs.some((input) => {
          if (!(input instanceof HTMLInputElement)) return false
          const files = Array.from(input.files || [])
          return files.some((file) => normalize(file.name).includes(wanted))
        })
        const pageText = normalize(document.body?.innerText || '')
        const hasMention = wanted ? pageText.includes(wanted) : false
        const viewportW = Math.max(1, window.innerWidth || 0)
        const viewportH = Math.max(1, window.innerHeight || 0)
        const previewLike = Array.from(document.querySelectorAll('img,video,[role="img"],canvas,.thumbnail,[class*="thumb"],[class*="preview"],[data-testid*="upload" i],[data-testid*="preview" i]'))
          .some((node) => {
            if (!(node instanceof HTMLElement)) return false
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            if (rect.width < 16 || rect.height < 16) return false
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
            const meta = normalize([
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
              node.getAttribute('data-testid'),
              node.getAttribute('class'),
              node.textContent,
            ].filter(Boolean).join(' '))
            const looksLikeNamedPreview = !wanted || meta.includes(wanted) || /preview|thumbnail|附件|已上传|upload/.test(meta)
            const smallPreviewCluster =
              rect.width >= 24 &&
              rect.height >= 24 &&
              rect.width <= Math.min(220, viewportW * 0.28) &&
              rect.height <= Math.min(220, viewportH * 0.28) &&
              rect.top >= viewportH * 0.55
            return looksLikeNamedPreview || smallPreviewCluster
          })
        const removeChip = Array.from(document.querySelectorAll('button,[role="button"],span,div'))
          .some((node) => {
            if (!(node instanceof HTMLElement)) return false
            const meta = normalize([
              node.textContent,
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
              node.getAttribute('data-testid'),
              node.getAttribute('class'),
            ].filter(Boolean).join(' '))
            return /remove|delete|删除|移除|clear|close/.test(meta) && (!wanted || pageText.includes(wanted))
          })
        const evidence = [
          hasSelectedFile ? 'input_files_changed' : '',
          hasMention ? 'page_text_updated' : '',
          previewLike ? 'preview_detected' : '',
          removeChip ? 'remove_chip_detected' : '',
        ].filter(Boolean)
        return {
          success: evidence.length > 0,
          reason:
            hasSelectedFile ? 'input_files_changed'
              : previewLike ? 'preview_detected'
                : removeChip ? 'remove_chip_detected'
                  : hasMention ? 'page_text_updated'
                    : 'no_upload_evidence',
          evidence,
        }
      })()
    `,
  ) as { success?: boolean; reason?: string; evidence?: string[] } | null
  return {
    success: Boolean(result?.success),
    reason: String(result?.reason || 'unknown'),
    evidence: Array.isArray(result?.evidence) ? result?.evidence : [],
  }
}

export async function executeBrowserTool(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
  abortSignal?: AbortSignal,
  sessionId?: string,
  leaseGate?: BrowserLeaseGate,
  currentUserText?: string,
  runtime?: AgentControlRuntime | null,
): Promise<string> {
  log(`executeBrowserTool: ${toolName} args=${JSON.stringify(args).slice(0, 200)}`)

  // WP3 — high-control platform script blacklist: on 小红书/抖音/微博/… do not
  // run script-hard tools / script params; only visible/DOM collection is
  // allowed (plan §4.4). Checked against the active tab's URL, before the lease
  // gate so a rejected tool never opens an action window.
  const candidateTargetUrls = resolveCandidateTargetUrls(args, controller)
  const highControlDenied = highControlScriptGuard(toolName, args, candidateTargetUrls)
  if (highControlDenied) {
    log(`Browser tool high-control-denied: ${toolName}`)
    return highControlDenied
  }

  const gate = beginLeaseGate(leaseGate, toolName, args)
  if (gate.deniedMessage !== null) {
    log(`Browser tool lease-denied: ${toolName} ${gate.deniedMessage}`)
    return gate.deniedMessage
  }

  try {
    throwIfAborted(abortSignal)
    switch (toolName) {
      case 'browser_navigate': {
        const url = args.url as string
        if (!url) return 'Error: url is required'
        // Tool-layer tab targeting (plan §7.8): navigate the given tab when set
        // (the scoped agent facade forces agentTabId), else the active tab.
        let navTabId = (args.tab_id as string) || null
        navTabId = (await resolveHighControlAgentTab(controller, args, {
          navigateToTarget: false,
          signal: abortSignal,
        })).tabId
        const allowRepeat = args.allow_repeat === true
        const duplicate = !allowRepeat ? findRecentBrowserAction(sessionId, 'navigate', url) : null
        const activeBefore = navTabId
          ? controller.getTabList().find((t) => t.id === navTabId)
          : controller.getActiveTab()
        if (duplicate && activePageLikelyMatchesTarget(activeBefore?.url, url)) {
          const secondsAgo = Math.max(1, Math.round((Date.now() - duplicate.updatedAt) / 1000))
          return `Skipped duplicate navigation to ${url}. The same navigation already succeeded ${secondsAgo}s ago and the current page still matches it. Read or verify the current page before navigating again.`
        }
        const result = await controller.navigate(navTabId, url)
        if (!result.success) return `Error: ${result.error}`
        rememberBrowserAction(sessionId, 'navigate', url)
        // Wait a moment for page to start loading
        await sleepWithAbort(1500, abortSignal)
        const tabs = controller.getTabList()
        const target = navTabId ? tabs.find((t) => t.id === navTabId) : tabs.find((t) => t.active)
        return `Navigated to ${url}\nCurrent page: ${target?.title || 'Loading...'} (${target?.url || url})`
      }

      case 'browser_search': {
        const query = args.query as string
        if (!query) return 'Error: query is required'
        const searchTabId = (args.tab_id as string) || null
        const allowRepeat = args.allow_repeat === true
        const duplicate = !allowRepeat ? findRecentBrowserAction(sessionId, 'search', query) : null
        // Duplicate-check must inspect the SEARCH tab, not the active tab, so a
        // targeted search (tab_id set) isn't skipped based on the user's page.
        const searchBefore = searchTabId
          ? controller.getTabList().find((t) => t.id === searchTabId)
          : controller.getActiveTab()
        if (duplicate && /search|google|bing|duckduckgo|baidu/i.test(String(searchBefore?.url || ''))) {
          const secondsAgo = Math.max(1, Math.round((Date.now() - duplicate.updatedAt) / 1000))
          return `Skipped duplicate search for "${query}". The same search already ran ${secondsAgo}s ago. Reuse the current results page or read it before searching again.`
        }
        const preferred = String(args.engine || 'auto').toLowerCase() as SearchEngine
        const engines: SearchEngine[] = preferred === 'auto'
          ? ['duckduckgo', 'google', 'bing', 'baidu']
          : [preferred, 'duckduckgo', 'google', 'bing', 'baidu']
        const uniq = Array.from(new Set(engines))

        const errors: string[] = []
        for (const engine of uniq) {
          const targetUrl = searchUrl(engine, query)
          const result = await controller.navigate(searchTabId, targetUrl)
          if (!result.success) {
            errors.push(`${engine}: ${result.error || 'navigate failed'}`)
            continue
          }
          rememberBrowserAction(sessionId, 'search', query)
          const waitResult = await waitForReady(controller, searchTabId, 10_000, undefined, abortSignal)
          const rows = await extractSearchResults(controller, searchTabId)
          if (rows.length > 0) {
            return [
              `Searched "${query}" via ${engine}`,
              `Page ready: ${waitResult.ready} (${waitResult.elapsedMs}ms)`,
              '',
              ...rows.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}${row.snippet ? `\n   ${row.snippet}` : ''}`),
            ].join('\n')
          }
          const content = await controller.getPageContent(searchTabId).catch(() => '')
          if (content.trim().length > 0) {
            return `Searched "${query}" via ${engine}\nNo structured results parsed, fallback page text:\n${truncate(content, 6000)}`
          }
          errors.push(`${engine}: no content`)
        }
        return `Search failed for "${query}". Tried: ${uniq.join(', ')}.\n${errors.join('\n')}`
      }

      case 'browser_get_tabs': {
        const tabs = controller.getTabList()
        if (tabs.length === 0) return 'No tabs open.'
        return tabs.map(t =>
          `${t.active ? '▶ ' : '  '}[${t.id}] ${t.title}\n    ${t.url}`
        ).join('\n')
      }

      case 'browser_read_page': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const content = await controller.getPageContent(tabId)
        if (!content || content.trim().length === 0) {
          return 'Page content is empty or still loading.'
        }
        return truncate(content)
      }

      case 'browser_read_page_map': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const maxBytes = typeof args.max_bytes === 'number' ? Math.max(1024, Math.min(65_536, args.max_bytes)) : undefined
        const payload = await captureAgentPageMap(controller, tabId, maxBytes)
        return JSON.stringify(payload, null, 2)
      }

      case 'browser_probe_readonly': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const requestedGeneration = Number(args.generation)
        const currentGeneration = currentBrowserPageMapGeneration(controller, tabId)
        if (!Number.isFinite(requestedGeneration) || requestedGeneration <= 0) {
          return JSON.stringify(agentBrowserError(
            'stale_page_map',
            'generation is required. Call browser_read_page_map first and pass its pageIdentity.generation.',
          ), null, 2)
        }
        if (currentGeneration === null || currentGeneration !== requestedGeneration) {
          return JSON.stringify(agentBrowserError(
            'stale_page_map',
            'Readonly probe requires a fresh page map generation. Call browser_read_page_map again.',
            { currentGeneration, requestedGeneration },
          ), null, 2)
        }
        const activeUrl = tabId
          ? controller.getTabList?.().find((tab) => tab.id === tabId)?.url
          : controller.getActiveTab?.()?.url
        const riskDecision = isHighControlPlatformText(activeUrl)
          ? 'fixed_scope_only'
          : 'allowed'
        const request = normalizeBrowserReadonlyProbeRequest({
          generation: requestedGeneration,
          query: args.query,
          scope: args.scope,
          maxNodes: args.max_nodes,
          includeHidden: args.include_hidden,
          riskDecision,
        })
        const result = await controller.executeJS(tabId, buildBrowserReadonlyProbeJs(request))
        return JSON.stringify(result, null, 2)
      }

      case 'browser_act_on_target': {
        const targetId = String(args.target_id || args.targetId || '').trim()
        const action = String(args.action || 'click') as AgentBrowserAction
        const value = args.value === undefined ? undefined : String(args.value)
        const disambiguation = String(args.disambiguation || '').trim()
        const readBack = String(args.read_back || args.readBack || 'delta') as AgentBrowserReadBack
        if (!targetId) return JSON.stringify(agentBrowserError('target_not_found', 'target_id is required'), null, 2)
        if (!['click', 'expand', 'choose', 'fill', 'hover'].includes(action)) {
          return JSON.stringify(agentBrowserError('target_not_found', `Unsupported action: ${String(args.action || '')}`), null, 2)
        }
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const parsed = parseTargetId(targetId)
        if (!parsed) {
          return JSON.stringify(agentBrowserError('target_not_found', `Malformed target id: ${targetId}`), null, 2)
        }
        const currentGeneration = currentBrowserPageMapGeneration(controller, tabId)
        if (currentGeneration === null) {
          return JSON.stringify(agentBrowserError(
            'stale_page_map',
            'No page map has been read for this tab. Call browser_read_page_map first.',
            { targetGeneration: parsed.generation },
          ), null, 2)
        }
        const liveProbe = await controller.executeJS(tabId, buildBrowserTargetProbeJs(parsed.node)) as {
          matchCount?: number
          disabled?: boolean
          target?: unknown
        } | null
        const gated = gateActOnTarget(
          { targetId, action, value, disambiguation, readBack },
          {
            currentGeneration,
            matchCount: Number(liveProbe?.matchCount || 0),
            candidates: liveProbe?.target ? [liveProbe.target] : [],
            ambiguityGroup: currentBrowserPageMapAmbiguity(controller, tabId, targetId),
          },
        )
        if (isAgentBrowserError(gated)) return JSON.stringify(gated, null, 2)
        if (!liveProbe) {
          return JSON.stringify(agentBrowserError(
            'target_not_found',
            `Target ${targetId} was not found on the current page.`,
            { targetId },
          ), null, 2)
        }
        if (liveProbe?.disabled === true) {
          return JSON.stringify(agentBrowserError(
            'target_not_found',
            `Target ${targetId} is disabled.`,
            { targetId, target: liveProbe.target },
          ), null, 2)
        }
        const targetRecord = liveProbe?.target && typeof liveProbe.target === 'object'
          ? liveProbe.target as { role?: string; name?: string; value?: string; states?: Record<string, unknown> }
          : null
        if (targetRecord?.states?.fileInput === true) {
          return JSON.stringify(agentBrowserError(
            'script_blocked',
            `Target ${targetId} is a file input. Use browser_upload_scope_attachment for file upload.`,
            { targetId, target: liveProbe.target },
          ), null, 2)
        }
        // EP1-I3 live-target net — the dispatch gate only saw the args; a
        // bare target_id legally carries no semantics. Re-check the REAL
        // element label against the M1 manual-only rules here, where the
        // live probe just resolved it. M1 is never confirmable → throw the
        // structured domain error (browser catch rethrows ToolDomainError).
        // For a fill/choose into an editable target the probe's `value` is the
        // field's CURRENT CONTENT — a draft holding「提交订单」must not
        // false-trip, so judge by name/role only; for click/expand/hover the
        // `value` is a control caption (input[type=submit]) and is included.
        const writesIntoField = action === 'fill' || action === 'choose'
        const liveLabel = (writesIntoField
          ? [targetRecord?.name, targetRecord?.role]
          : [targetRecord?.name, targetRecord?.value, targetRecord?.role]
        ).filter(Boolean).join(' ')
        const manualOnlyHit = matchManualOnlyBrowserTarget(liveLabel)
        if (manualOnlyHit) {
          throw new ToolDomainError(
            'denied_manual_only',
            `目标「${liveLabel.slice(0, 80)}」命中 M1 规则（${manualOnlyHit.reason}）。请引导用户亲自完成这一步，不要代替执行或绕过。`,
            { targetId, ruleId: manualOnlyHit.ruleId },
          )
        }
        // Password-field fill without a password cue in the args means the
        // dispatch gate never saw this as a login action (m3-login) — refuse
        // with reroute guidance instead of silently filling credentials. A
        // re-issued call that names the password field goes through the
        // normal confirm→release path and passes here (cue present).
        if (
          action === 'fill'
          && targetRecord?.states?.password === true
          && !argsCarryPasswordCue(JSON.stringify(args))
        ) {
          throw new ToolDomainError(
            'denied_pending_confirmation',
            `目标 ${targetId} 是密码输入框。请改用带 disambiguation 说明（如「登录密码输入框」）的调用重试，经用户确认后执行。`,
            { targetId, ruleId: 'm3-login-existing-account' },
          )
        }
        const before = readBack === 'none' ? null : await controller.executeJS(tabId, buildBrowserActionDeltaJs()).catch(() => null)
        const actionResult = await controller.executeJS(tabId, buildBrowserActOnTargetJs(parsed.node, action, value))
        await settleAfterAction(controller, tabId, abortSignal)
        const after = readBack === 'map'
          ? await captureAgentPageMap(controller, tabId)
          : readBack === 'none'
            ? null
            : await controller.executeJS(tabId, buildBrowserActionDeltaJs()).catch(() => null)
        const actionFailed = typeof actionResult === 'object' && actionResult !== null && (actionResult as { ok?: unknown }).ok === false
        const failureKind = actionFailed
          ? String((actionResult as { errorCode?: unknown }).errorCode || 'action_failed')
          : null
        return JSON.stringify({
          ok: !actionFailed,
          targetId,
          action,
          disambiguation: disambiguation || null,
          readBack,
          before,
          result: actionResult,
          after,
          changed: didBrowserActionChange(before, after),
          failureKind,
          nextSuggestedAction: actionFailed ? 'read map again' : 'read map again',
        }, null, 2)
      }

      case 'browser_click': {
        const selector = args.selector as string
        if (!selector) return 'Error: selector is required'
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        // EP1-I3 live-target net — a CSS selector carries no semantics the
        // dispatch gate could classify; the shared guarded entry judges the
        // real clickable owner and refuses M1 targets without clicking.
        return await runGuardedSelectorClick(controller, tabId, selector)
      }

      case 'browser_click_text': {
        const text = String(args.text || '').trim()
        if (!text) return 'Error: text is required'
        const exact = args.exact === true
        const hrefContains = String(args.href_contains || '').trim()
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const located = await controller.executeJS(tabId, buildLocateTextTargetJs(text, exact, hrefContains))
        if (!located || typeof located !== 'object') return String(located)
        const result = located as { ok?: boolean; error?: string; text?: string; href?: string; cssX?: number; cssY?: number; width?: number; height?: number }
        if (result.ok !== true) return result.error || `Element by text not found: ${text}`
        const width = Number(result.width || 1) || 1
        const height = Number(result.height || 1) || 1
        const x = Math.round((Number(result.cssX || 0) / width) * 1000)
        const y = Math.round((Number(result.cssY || 0) / height) * 1000)
        const point = await runGuardedCoordinateClick(controller, tabId, x, y, abortSignal)
        await settleAfterAction(controller, tabId, abortSignal)
        return JSON.stringify({
          ok: true,
          text: result.text || text,
          href: result.href || undefined,
          clickedDirect: false,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
        }, null, 2)
      }

      case 'browser_type': {
        const selector = args.selector as string
        const text = args.text as string
        if (!selector || text === undefined) return 'Error: selector and text are required'
        const clearFirst = args.clear_first !== false // default true
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        // EP1-I3 live-target net — an opaque selector can resolve to a
        // password or captcha field with no cue in the args. The shared
        // guarded entry checks the REAL field semantics (no value): M1 hits
        // refuse outright; unconfirmed password fills reroute — a re-issued
        // call naming the password field carries the cue and passes.
        return await runGuardedSelectorType(controller, tabId, selector, text, {
          clearFirst,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        })
      }

      case 'browser_type_smart': {
        const target = String(args.target || '').trim()
        const text = String(args.text || '')
        if (!target || text === undefined) return 'Error: target and text are required'
        const clearFirst = args.clear_first !== false
        const submit = args.submit === true
        const tabId = (args.tab_id as string) || null
        const shouldGuardSubmit = submit && await isLikelyChatPage(controller, tabId)
        const rawSmartType = await controller.executeJS(tabId, buildSmartTypeJs({
          target,
          text,
          clearFirst,
          submit: submit && !shouldGuardSubmit,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }))
        throwIfLiveTargetGuardBlocked(rawSmartType, { target })
        const result = String(rawSmartType)
        if (shouldGuardSubmit) {
          const attempted: string[] = ['type_smart_submit_guard']
          const submitState = await ensureGeminiSubmitted(controller, tabId, text, attempted, abortSignal)
          return `${result}\n[chat-submit-guard] submitted=${submitState.submitted} method=${submitState.method}`
        }
        return result
      }

      case 'browser_compose_message': {
        const text = String(args.text || '')
        if (!text) return 'Error: text is required'
        const target = String(args.target || '')
        const clearFirst = args.clear_first !== false
        const submit = args.submit !== false
        const tabId = (args.tab_id as string) || null
        const shouldGuardSubmit = submit && await isLikelyChatPage(controller, tabId)
        const rawCompose = await controller.executeJS(tabId, buildSmartTypeJs({
          target,
          text,
          clearFirst,
          submit: submit && !shouldGuardSubmit,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }))
        throwIfLiveTargetGuardBlocked(rawCompose, { target })
        const result = String(rawCompose)
        if (shouldGuardSubmit) {
          const attempted: string[] = ['compose_submit_guard']
          const submitState = await ensureGeminiSubmitted(controller, tabId, text, attempted, abortSignal)
          return `${result}\n[chat-submit-guard] submitted=${submitState.submitted} method=${submitState.method}`
        }
        return result
      }

      case 'browser_capture_viewport': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const mode = String(args.mode || 'viewport') as 'viewport' | 'clip' | 'full_page'
        const clipRaw = args.clip
        const clip = clipRaw && typeof clipRaw === 'object'
          ? {
            x: Number((clipRaw as Record<string, unknown>).x || 0),
            y: Number((clipRaw as Record<string, unknown>).y || 0),
            width: Number((clipRaw as Record<string, unknown>).width || 0),
            height: Number((clipRaw as Record<string, unknown>).height || 0),
          }
          : undefined
        const base64 = await controller.screenshotAdvanced(tabId, { mode, clip })
        const metrics = await controller.getViewportMetrics(tabId)
        const imageId = cacheScreenshot(base64, Math.round(metrics.width), Math.round(metrics.height))
        return JSON.stringify({
          image_id: imageId,
          width: Math.round(metrics.width),
          height: Math.round(metrics.height),
          mode,
        }, null, 2)
      }

      case 'browser_probe_workflow_state': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const prompt = String(args.prompt || '')
        const attachmentName = String(args.attachment_name || '')
        const includeCandidates = args.include_candidates !== false
        const visionAction = String(args.vision_action || '').trim() as '' | 'upload' | 'input' | 'send'
        const toolMeta = resolveToolContextMeta(controller, tabId)
        const { pageStateService } = createBrowserAgentHelpers(controller)
        const [identity, uploadState, promptState, domState] = await Promise.all([
          getPageIdentity(controller, tabId),
          probeWorkflowUploadState(controller, tabId, attachmentName),
          probeWorkflowPromptSubmissionState(controller, tabId, prompt),
          probeWorkflowDomState(controller, tabId),
        ])

        const base64 = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
        const metrics = await controller.getViewportMetrics(tabId)
        const imageId = cacheScreenshot(base64, Math.round(metrics.width), Math.round(metrics.height))

        let uploadTargets: ActionTargetCandidate[] = []
        let inputTargets: ActionTargetCandidate[] = []
        let sendTargets: ActionTargetCandidate[] = []
        let activeInputTarget: ActionTargetCandidate | null = null
        let nearbySendTargets: ActionTargetCandidate[] = []

        if (includeCandidates) {
          ;[uploadTargets, inputTargets] = await Promise.all([
            locateActionTargets(controller, tabId, 'upload'),
            locateActionTargets(controller, tabId, 'input'),
          ])
          activeInputTarget = pickActiveInputTarget(inputTargets)
          if (activeInputTarget) {
            sendTargets = rankTargetsNearAnchor(await locateActionTargets(controller, tabId, 'send'), activeInputTarget)
            nearbySendTargets = sendTargets.some((item) => Boolean(item.nearActiveInput))
              ? sendTargets.filter((item) => Boolean(item.nearActiveInput)).slice(0, 4)
              : sendTargets.slice(0, 2)
          } else {
            sendTargets = await locateActionTargets(controller, tabId, 'send')
          }
        }

        let visionCandidates: ActionTargetCandidate[] = []
        if (
          visionAction &&
          ['upload', 'input', 'send'].includes(visionAction) &&
          (
            (visionAction === 'upload' && !uploadState.complete && uploadTargets.length === 0) ||
            (visionAction === 'input' && !promptState.promptFilled && inputTargets.length === 0) ||
            (visionAction === 'send' && !promptState.generating && sendTargets.length === 0)
          )
        ) {
          const domCandidates =
            visionAction === 'upload'
              ? uploadTargets
              : visionAction === 'input'
                ? inputTargets
                : sendTargets
          const analysis = await analyzeViewportWithVision({
            action: visionAction,
            title: identity.title,
            url: identity.url,
            screenshotBase64: base64,
            domCandidates,
          })
          visionCandidates = Array.isArray(analysis.analysis?.targets)
            ? analysis.analysis.targets
                .filter((target) => Number.isFinite(target.x) && Number.isFinite(target.y))
                .map((target) => ({
                  kind: target.kind === 'upload_launcher' ? 'launcher' : target.kind === 'prompt_input' ? 'prompt_input' : 'icon_button',
                  label: target.label,
                  x: target.x,
                  y: target.y,
                  confidence: target.confidence,
                  evidence: [target.reason || 'vision_candidate'],
                }))
            : []
        }

        const pageState = pageStateService.composePageState({
          page: {
            url: identity.url,
            title: identity.title,
            domain: '',
            activeElement: identity.activeElement,
          },
          promptCandidate: prompt,
          attachmentName,
          upload: uploadState,
          prompt: promptState,
          dom: domState,
          candidates: includeCandidates
            ? {
              uploadTargets,
              inputTargets,
              activeInputTarget,
              nearbySendTargets,
              sendTargets,
            }
            : undefined,
        })

        return JSON.stringify({
          ok: true,
          ...toolMeta,
          latencyMs: Date.now() - startedAt,
          screenshot: {
            image_id: imageId,
            width: Math.round(metrics.width),
            height: Math.round(metrics.height),
            mode: 'viewport',
          },
          page: pageState.page,
          uploadState: pageState.upload,
          promptState: pageState.prompt,
          domState: pageState.dom,
          candidates: includeCandidates
            ? {
                uploadTargets: pageState.candidates.uploadTargets.slice(0, 6),
                inputTargets: pageState.candidates.inputTargets.slice(0, 6),
                activeInputTarget: pageState.candidates.activeInputTarget,
                nearbySendTargets: pageState.candidates.nearbySendTargets,
                sendTargets: pageState.candidates.sendTargets.slice(0, 6),
              }
            : undefined,
          visionCandidates,
          evidenceIds: uniqueStrings([
            ...uploadState.evidence,
            ...promptState.submitEvidence,
            ...(domState.bodyStateText ? ['body_state_observed'] : []),
            ...visionCandidates.flatMap((item) => item.evidence || []),
          ]),
        }, null, 2)
      }

      case 'browser_locate_action_targets': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const action = String(args.action || '').trim() as 'upload' | 'send' | 'close' | 'back'
        if (!['upload', 'send', 'close', 'back'].includes(action)) {
          return JSON.stringify({ ok: false, reason: 'invalid_action' }, null, 2)
        }
        const targets = await locateActionTargets(controller, tabId, action)
        const toolMeta = resolveToolContextMeta(controller, tabId)
        return JSON.stringify({
          ok: true,
          ...toolMeta,
          action,
          latencyMs: Date.now() - startedAt,
          count: targets.length,
          targets,
          evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
        }, null, 2)
      }

      case 'browser_locate_input_targets': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const target = String(args.target || '').trim().toLowerCase()
        const ranked = await locateActionTargets(controller, tabId, 'input')
        const targets = target
          ? [...ranked].sort((a, b) => {
            const aMatch = String(a.label || '').toLowerCase().includes(target) ? 1 : 0
            const bMatch = String(b.label || '').toLowerCase().includes(target) ? 1 : 0
            if (aMatch !== bMatch) return bMatch - aMatch
            return Number(b.confidence || 0) - Number(a.confidence || 0)
          })
          : ranked
        const activeTarget = pickActiveInputTarget(targets) || pickActiveInputTarget(ranked)
        const anchorTarget = activeTarget || targets[0] || null
        const rankedSendTargets = anchorTarget
          ? rankTargetsNearAnchor(await locateActionTargets(controller, tabId, 'send'), anchorTarget)
          : []
        const nearbySendTargets = rankedSendTargets.some((item) => Boolean(item.nearActiveInput))
          ? rankedSendTargets.filter((item) => Boolean(item.nearActiveInput)).slice(0, 4)
          : rankedSendTargets.slice(0, 2)
        const toolMeta = resolveToolContextMeta(controller, tabId)
        return JSON.stringify({
          ok: true,
          ...toolMeta,
          latencyMs: Date.now() - startedAt,
          count: targets.length,
          targets,
          active_target: activeTarget,
          nearby_send_targets: nearbySendTargets,
          evidenceIds: uniqueStrings([
            ...targets.flatMap((item) => item.evidence || []),
            ...nearbySendTargets.flatMap((item) => item.evidence || []),
          ]),
        }, null, 2)
      }

      case 'browser_analyze_viewport': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const action = String(args.action || '').trim() as 'upload' | 'send' | 'close' | 'back' | 'input'
        if (!['upload', 'send', 'close', 'back', 'input'].includes(action)) {
          return JSON.stringify({ ok: false, reason: 'invalid_action' }, null, 2)
        }
        const includeDomCandidates = args.include_dom_candidates !== false
        const domCandidates = includeDomCandidates
          ? await locateActionTargets(controller, tabId, action)
          : []
        const screenshot = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
        const identity = await getPageIdentity(controller, tabId)
        const analysis = await analyzeViewportWithVision({
          action,
          title: identity.title,
          url: identity.url,
          screenshotBase64: screenshot,
          domCandidates,
        })
        const toolMeta = resolveToolContextMeta(controller, tabId)
        return JSON.stringify({
          ok: analysis.ok,
          ...toolMeta,
          action,
          latencyMs: Date.now() - startedAt,
          reason: analysis.reason,
          analysis: analysis.analysis || null,
          domCandidates,
          evidenceIds: uniqueStrings([
            ...domCandidates.flatMap((item) => item.evidence || []),
            ...((analysis.analysis?.targets || []).map((item) => String(item.reason || ''))),
          ]),
        }, null, 2)
      }

      case 'browser_list_upload_targets': {
        const tabId = (args.tab_id as string) || null
        const targets = await controller.findUploadTargets(tabId)
        return JSON.stringify({
          count: targets.length,
          targets,
        }, null, 2)
      }

      case 'browser_upload_scope_attachment': {
        const startedAt = Date.now()
        const uploadMetaFor = (effectiveTabId: string | null) => ({
          ...resolveToolContextMeta(controller, effectiveTabId),
          latencyMs: Date.now() - startedAt,
        })
        const attachments = await listScopeAttachmentsForTool(sessionId)
        const selected = selectScopeAttachment(attachments, args)
        if (selected.reason) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(null),
            reason: selected.reason,
            candidates: attachments.slice(0, 6),
          }, null, 2)
        }
        if (selected.ambiguous && selected.ambiguous.length > 0) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(null),
            reason: '存在多个候选附件，请补充 attachment_id 或 attachment_name。',
            candidates: selected.ambiguous,
          }, null, 2)
        }
        const attachment = selected.attachment
        if (!attachment) {
          return JSON.stringify({ ok: false, ...uploadMetaFor(null), reason: '未能选择附件。' }, null, 2)
        }
        if (!existsSync(attachment.path)) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(null),
            reason: `附件文件不存在: ${attachment.path}`,
            attachment,
          }, null, 2)
        }

        const tabId = (args.tab_id as string) || null
        const pageIdentity = await getPageIdentity(controller, tabId)
        const uploadMemoryKey = buildScopeUploadKey(sessionId, pageIdentity)
        const rememberedUpload = recentScopeUploads.get(uploadMemoryKey)
        if (
          rememberedUpload &&
          rememberedUpload.attachmentId === attachment.attachmentId &&
          rememberedUpload.attachmentPath === attachment.path &&
          Date.now() - rememberedUpload.uploadedAt <= RECENT_SCOPE_UPLOAD_TTL_MS
        ) {
          const rememberedVerification = await verifyUploadState(controller, tabId, attachment.name)
          if (rememberedVerification.success) {
            return JSON.stringify({
              ok: true,
              ...uploadMetaFor(tabId),
              skipped: true,
              reason: 'attachment_already_uploaded_on_current_page',
              attachment: {
                attachmentId: attachment.attachmentId,
                name: attachment.name,
                path: attachment.path,
              },
              verification: rememberedVerification,
              evidenceIds: uniqueStrings(rememberedVerification.evidence || []),
            }, null, 2)
          }
        }
        const selector = typeof args.selector === 'string' ? args.selector : undefined
        const targetText = typeof args.target === 'string' ? args.target : undefined
        const hasCoords = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
        const mappedCoords = hasCoords
          ? await resolveCssPoint(controller, tabId, Number(args.x), Number(args.y))
          : null

        let targets = await locateActionTargets(controller, tabId, 'upload')
        let chosenTarget = chooseUploadTarget(targets, args)

        if (!chosenTarget && !selector && !targetText && !mappedCoords) {
          const identity = await getPageIdentity(controller, tabId)
          const screenshot = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
          const analyzed = await analyzeViewportWithVision({
            action: 'upload',
            title: identity.title,
            url: identity.url,
            screenshotBase64: screenshot,
            domCandidates: targets,
          })
          const visionTarget = analyzed.analysis?.targets?.[0]
          if (visionTarget && Number.isFinite(visionTarget.x) && Number.isFinite(visionTarget.y)) {
            chosenTarget = {
              kind: visionTarget.kind === 'upload_launcher' ? 'launcher' : 'icon_button',
              label: visionTarget.label,
              x: visionTarget.x,
              y: visionTarget.y,
              confidence: visionTarget.confidence,
              evidence: [visionTarget.reason || 'vision_candidate'],
            }
          }
        }

        if (chosenTarget && chosenTarget.kind !== 'input') {
          const openResult = await clickActionTarget(controller, tabId, chosenTarget, abortSignal)
          if (!openResult.ok) {
            const recovered = await attemptRecoverPageState(controller, tabId, abortSignal)
            return JSON.stringify({
              ok: false,
              ...uploadMetaFor(tabId),
              reason: 'failed_to_open_upload_path',
              attachment,
              target: chosenTarget,
              recovery: recovered,
              evidenceIds: uniqueStrings(chosenTarget?.evidence || []),
            }, null, 2)
          }
          await sleepWithAbort(220, abortSignal)
          targets = await locateActionTargets(controller, tabId, 'upload')
          const inputTarget = pickBestActionTarget(targets.filter((item) => item.kind === 'input'), ['input'])
          if (inputTarget) {
            chosenTarget = inputTarget
          }
        }

        const effectiveSelector = selector
          || chosenTarget?.associatedInputSelector
          || (chosenTarget?.kind === 'input' ? chosenTarget.selectorHint : undefined)

        const effectiveCoords = chosenTarget && Number.isFinite(chosenTarget.x) && Number.isFinite(chosenTarget.y)
          ? await resolveCssPoint(controller, tabId, Number(chosenTarget.x), Number(chosenTarget.y))
          : mappedCoords

        const setResult = await controller.setFileInputFiles(tabId, {
          files: [attachment.path],
          selector: effectiveSelector,
          target: targetText,
          x: effectiveCoords?.cssX,
          y: effectiveCoords?.cssY,
        })
        if (!setResult.ok) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(tabId),
            reason: '未找到可用的上传入口。',
            attachment,
            candidates: targets.slice(0, 8),
            target: setResult.targetDescription,
            evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
          }, null, 2)
        }

        await settleAfterAction(controller, tabId, abortSignal)
        const verification = await verifyUploadState(controller, tabId, attachment.name)
        const assignedNames = Array.isArray(setResult.assignedFileNames) ? setResult.assignedFileNames : []
        const fileAssigned = Boolean(setResult.filesAssigned) &&
          assignedNames.some((name) => String(name || '').toLowerCase().includes(attachment.name.toLowerCase()))
        const effectiveVerification = verification.success
          ? verification
          : fileAssigned
            ? {
              success: false,
              reason: 'input_files_assigned_pending_page_verification',
              evidence: uniqueStrings([...(verification.evidence || []), 'input_files_assigned']),
            }
            : verification
        if (effectiveVerification.success) {
          recentScopeUploads.set(uploadMemoryKey, {
            attachmentId: attachment.attachmentId,
            attachmentPath: attachment.path,
            pageKey: uploadMemoryKey,
            uploadedAt: Date.now(),
          })
        }
        return JSON.stringify({
          ok: effectiveVerification.success,
          ...uploadMetaFor(tabId),
          attachment: {
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            path: attachment.path,
          },
          chosenTarget,
          target: setResult.targetDescription,
          setResult: {
            filesAssigned: Boolean(setResult.filesAssigned),
            assignedFileNames: assignedNames,
          },
          verification: effectiveVerification,
          evidenceIds: uniqueStrings([
            ...(effectiveVerification.evidence || []),
            ...(chosenTarget?.evidence || []),
          ]),
        }, null, 2)
      }

      case 'browser_collect_images': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const keyword = String(args.keyword || '').trim().toLowerCase()
        const limit = Math.max(1, Math.min(60, Number(args.limit || 20)))
        const minWidth = Math.max(1, Math.min(4000, Number(args.min_width || 120)))
        const includeHidden = args.include_hidden === true
        const rows = await controller.executeJS(
          tabId,
          `
            (() => {
              const keyword = ${JSON.stringify(keyword)}
              const maxCount = ${JSON.stringify(limit)}
              const minWidth = ${JSON.stringify(minWidth)}
              const includeHidden = ${JSON.stringify(includeHidden)}
	              const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
	              const urlsFromSrcset = (srcset) => normalize(srcset).split(',').map((part) => normalize(part).split(/\\s+/)[0]).filter(Boolean)
	              const isXiaohongshu = /(^|\\.)xiaohongshu\\.com$/i.test(location.hostname)
	              const possibleXhsDetailRoot = isXiaohongshu ? document.querySelector('.note-container') : null
	              const xhsDetailRoot = possibleXhsDetailRoot && (
	                /\\/explore\\//i.test(location.pathname)
	                || possibleXhsDetailRoot.querySelector('.media-container img, .media-container video, .swiper img, .swiper video')
	              ) ? possibleXhsDetailRoot : null
	              const xhsMediaRoots = xhsDetailRoot
	                ? Array.from(xhsDetailRoot.querySelectorAll('.media-container, .note-slider, .swiper, .swiper-wrapper'))
	                  .filter((el) => el.querySelector('img,video'))
	                : []
              const xhsScopedMedia = Boolean(xhsDetailRoot && xhsMediaRoots.length > 0)
	              const roots = xhsDetailRoot ? (xhsMediaRoots.length > 0 ? xhsMediaRoots : [xhsDetailRoot]) : [document]
	              const queryAll = (selector) => roots.flatMap((root) => Array.from(root.querySelectorAll(selector)))
	              const isVisible = (el) => {
                if (!(el instanceof Element)) return false
                const rect = el.getBoundingClientRect()
                if (!rect || rect.width < minWidth || rect.height < 40) return false
                const style = getComputedStyle(el)
                if (!style) return false
                return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
              }
              const isTopHit = (el, rect) => {
                if (includeHidden) return true
                const points = [
                  [rect.left + rect.width / 2, rect.top + rect.height / 2],
                  [rect.left + rect.width / 2, rect.top + Math.min(rect.height - 1, Math.max(1, rect.height * 0.25))],
                  [rect.left + rect.width / 2, rect.top + Math.min(rect.height - 1, Math.max(1, rect.height * 0.75))],
                ]
                for (const [x, y] of points) {
                  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue
                  const top = document.elementFromPoint(x, y)
                  if (!top) continue
                  if (top === el || el.contains(top) || top.contains(el)) return true
                }
                return false
              }
              const items = []
              const seen = new Set()
              const push = (rawUrl, alt, width, height) => {
                const src = normalize(rawUrl)
                if (!src || !/^https?:\\/\\//i.test(src)) return
                if (seen.has(src)) return
                const w = Math.round(Number(width || 0))
                const h = Math.round(Number(height || 0))
                if ((w > 0 && w < minWidth) || (h > 0 && h < 40)) return
                const scoreText = (src + ' ' + normalize(alt)).toLowerCase()
                if (keyword && !scoreText.includes(keyword)) return
                seen.add(src)
                items.push({ url: src, alt: normalize(alt), width: w, height: h })
              }
              const videos = []
              const videoSeen = new Set()
              const cleanMediaUrl = (rawUrl) => {
                let value = normalize(rawUrl)
                for (let i = 0; i < 2; i += 1) {
                  value = value
                    .replaceAll('\\\\u002F', '/')
                    .replaceAll('\\\\u002f', '/')
                    .replaceAll('\\\\/', '/')
                }
                try { value = decodeURIComponent(value) } catch {}
                value = value.replace(/&amp;/g, '&')
                while (/[)\\],.;]$/.test(value)) value = value.slice(0, -1)
                return value
              }
              const isDirectVideoUrl = (rawUrl) => {
                const src = cleanMediaUrl(rawUrl)
                if (!/^https?:\\/\\//i.test(src)) return false
                const lower = src.toLowerCase()
                if (/\\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(lower)) return false
                return /(?:^|[.-])sns-video[.-]/i.test(lower)
                  || /\\.(?:mp4|m4v|mov|webm|m3u8)(?:[?#]|$)/i.test(lower)
              }
              const pushVideo = (rawUrl, rawPoster, width, height) => {
                if (videos.length >= maxCount) return
                const src = cleanMediaUrl(rawUrl)
                const poster = cleanMediaUrl(rawPoster)
                if (src && !isDirectVideoUrl(src)) return
                if (!src && !poster) return
                const key = src || \`poster:\${poster}\`
                if (videoSeen.has(key)) return
                videoSeen.add(key)
                videos.push({
                  url: src,
                  posterUrl: poster,
                  width: Math.round(Number(width || 0)),
                  height: Math.round(Number(height || 0)),
                })
              }
              const urlsFromText = (text) => {
                const normalizedText = cleanMediaUrl(text)
                const urls = []
                const pattern = /https?:\\/\\/[^"'\\\\<>\\s]+/gi
                let match = null
                while ((match = pattern.exec(normalizedText)) && urls.length < maxCount) {
                  urls.push(match[0])
                }
                return urls
              }
              const carouselExpectedCount = (() => {
                if (!xhsDetailRoot) return 0
                const totals = []
                const pushTotal = (value) => {
                  const n = Number(value)
                  if (Number.isFinite(n) && n > 1 && n <= maxCount) totals.push(n)
                }
                const textSources = [
                  xhsDetailRoot.textContent || '',
                  ...Array.from(xhsDetailRoot.querySelectorAll('[aria-label], [title], [data-count], [data-total], [class*="pagination" i], [class*="indicator" i]'))
                    .map((node) => [
                      node.textContent || '',
                      node.getAttribute('aria-label') || '',
                      node.getAttribute('title') || '',
                      node.getAttribute('data-count') || '',
                      node.getAttribute('data-total') || '',
                    ].join(' ')),
                ].map(normalize)
                for (const text of textSources) {
                  let match = null
                  const slashPattern = /(?:^|[^0-9])(\\d{1,2})\\s*\\/\\s*(\\d{1,2})(?:[^0-9]|$)/g
                  while ((match = slashPattern.exec(text))) pushTotal(match[2])
                  const totalPatterns = [
                    /共\\s*(\\d{1,2})\\s*(?:张|圖|图|pics?|images?)/gi,
                    /(\\d{1,2})\\s*(?:张|圖|图)\\s*(?:图片|照片|图集)/g,
                  ]
                  for (const pattern of totalPatterns) {
                    while ((match = pattern.exec(text))) pushTotal(match[1])
                  }
                }
                const bulletCount = Array.from(xhsDetailRoot.querySelectorAll('[class*="bullet" i], [class*="dot" i], [class*="indicator" i]'))
                  .filter((node) => {
                    if (!(node instanceof Element)) return false
                    const rect = node.getBoundingClientRect()
                    const style = getComputedStyle(node)
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
                  }).length
                if (bulletCount > 1 && bulletCount <= maxCount) totals.push(bulletCount)
                return totals.length > 0 ? Math.max(...totals) : 0
              })()
              const hasCarouselSignal = Boolean(xhsDetailRoot && (
                carouselExpectedCount > 1
                || xhsDetailRoot.querySelectorAll('.swiper-slide, [class*="slide" i], [class*="swiper" i] img, [class*="carousel" i] img').length > 1
                || xhsDetailRoot.querySelector('[class*="next" i], [aria-label*="下一" i], [aria-label*="next" i], [class*="pagination" i], [class*="indicator" i]')
              ))
	              const imgs = queryAll('img')
              for (const img of imgs) {
                if (!(img instanceof HTMLImageElement)) continue
                const alt = normalize(img.alt || img.getAttribute('title') || '')
                const rect = img.getBoundingClientRect()
                const visible = isVisible(img)
                if (!xhsScopedMedia) {
                  if (!visible && !includeHidden) continue
                  if (visible && !isTopHit(img, rect)) continue
                }
                const width = img.naturalWidth || img.width || rect.width || 0
                const height = img.naturalHeight || img.height || rect.height || 0
                const candidates = [
                  img.currentSrc,
                  img.src,
                  img.getAttribute('data-src'),
                  img.getAttribute('data-original'),
                  img.getAttribute('data-lazy-src'),
                  ...urlsFromSrcset(img.srcset || img.getAttribute('data-srcset') || ''),
                ]
                for (const candidate of candidates) push(candidate, alt, width, height)
                if (items.length >= maxCount) break
              }
	              if (includeHidden && items.length < maxCount) {
	                for (const source of queryAll('source[srcset]')) {
                  for (const candidate of urlsFromSrcset(source.getAttribute('srcset') || '')) {
                    push(candidate, source.getAttribute('type') || '', 0, 0)
                    if (items.length >= maxCount) break
                  }
                  if (items.length >= maxCount) break
                }
              }
	              if (!xhsDetailRoot && includeHidden && items.length < maxCount) {
	                for (const meta of Array.from(document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], link[rel="image_src"]'))) {
                  push(meta.getAttribute('content') || meta.getAttribute('href') || '', meta.getAttribute('property') || meta.getAttribute('name') || '', 0, 0)
                  if (items.length >= maxCount) break
	                }
              }
              for (const video of queryAll('video')) {
                  if (!(video instanceof HTMLVideoElement)) continue
                  const rect = video.getBoundingClientRect()
                  const visible = isVisible(video)
                  if (!xhsScopedMedia) {
                    if (!visible && !includeHidden) continue
                    if (visible && !isTopHit(video, rect)) continue
                  }
                  const sourceUrls = Array.from(video.querySelectorAll('source'))
                    .map((source) => source instanceof HTMLSourceElement ? source.src || source.getAttribute('src') || '' : '')
                  const candidates = [
                    video.currentSrc,
                    video.src,
                    video.getAttribute('src'),
                    ...sourceUrls,
                  ].filter(Boolean)
                  const direct = candidates.find((candidate) => isDirectVideoUrl(candidate)) || candidates[0] || ''
                  pushVideo(
                    direct,
                    video.poster || video.getAttribute('poster') || '',
                    video.videoWidth || rect.width || 0,
                    video.videoHeight || rect.height || 0,
                  )
                }
              if ((isXiaohongshu || includeHidden) && videos.length < maxCount) {
                for (const node of Array.from(document.querySelectorAll('[src], [data-src], [href]'))) {
                  if (!(node instanceof Element)) continue
                  for (const attr of ['src', 'data-src', 'href']) {
                    const candidate = node.getAttribute(attr) || ''
                    if (isDirectVideoUrl(candidate)) pushVideo(candidate, '', 0, 0)
                    if (videos.length >= maxCount) break
                  }
                  if (videos.length >= maxCount) break
                }
              }
              if ((isXiaohongshu || includeHidden) && videos.length < maxCount) {
                for (const script of Array.from(document.querySelectorAll('script'))) {
                  for (const candidate of urlsFromText(script.textContent || '')) {
                    if (isDirectVideoUrl(candidate)) pushVideo(candidate, '', 0, 0)
                    if (videos.length >= maxCount) break
                  }
                  if (videos.length >= maxCount) break
                }
              }
              if (videos.length < maxCount) {
                try {
                  const entries = performance && typeof performance.getEntriesByType === 'function'
                    ? performance.getEntriesByType('resource')
                    : []
                  for (const entry of entries) {
                    const candidate = entry && typeof entry.name === 'string' ? entry.name : ''
                    if (isDirectVideoUrl(candidate)) pushVideo(candidate, '', 0, 0)
                    if (videos.length >= maxCount) break
                  }
                } catch {}
              }
              if (xhsDetailRoot && videos.length === 0 && items.length === 0) {
                const videoMarker = queryAll('[poster], source, canvas, [class*="video" i], [class*="player" i], [class*="play" i], [class*="poster" i]')
                  .find((node) => {
                    if (!(node instanceof Element)) return false
                    const meta = normalize([
                      node.getAttribute('class'),
                      node.getAttribute('aria-label'),
                      node.getAttribute('title'),
                      node.getAttribute('poster'),
                      node.getAttribute('src'),
                    ].filter(Boolean).join(' ')).toLowerCase()
                    return /video|player|play|poster|xgplayer/.test(meta)
                  })
                if (videoMarker) {
                  const rect = videoMarker instanceof HTMLElement ? videoMarker.getBoundingClientRect() : null
                  pushVideo(
                    videoMarker.getAttribute('src') || '',
                    videoMarker.getAttribute('poster') || '',
                    rect?.width || 0,
                    rect?.height || 0,
                  )
                }
              }
              return { images: items, videos, scope: xhsDetailRoot ? 'xiaohongshu-detail' : 'document', expectedImageCount: carouselExpectedCount || undefined, hasCarouselSignal }
            })()
          `,
        ) as { images?: Array<{ url?: string; alt?: string; width?: number; height?: number }>; videos?: Array<{ url?: string; posterUrl?: string; width?: number; height?: number }>; scope?: string; expectedImageCount?: number; hasCarouselSignal?: boolean } | Array<{ url?: string; alt?: string; width?: number; height?: number }> | null

        const structuredRows = !Array.isArray(rows) && rows ? rows : null
        const rawImages = Array.isArray(rows) ? rows : Array.isArray(structuredRows?.images) ? structuredRows.images : []
        const videos = Array.isArray(structuredRows?.videos)
          ? structuredRows.videos
            .map((item) => ({
              url: String(item.url || ''),
              posterUrl: String(item.posterUrl || ''),
              width: Number(item.width || 0),
              height: Number(item.height || 0),
            }))
          : []
        const images = rawImages
          .map((item) => ({
            url: String(item.url || ''),
            alt: String(item.alt || ''),
            width: Number(item.width || 0),
            height: Number(item.height || 0),
          }))
          .filter((item) => item.url.length > 0)
        const expectedImageCount = Number(structuredRows?.expectedImageCount)

        return JSON.stringify({
          count: images.length,
          images,
          videoCount: videos.length,
          videos,
          ...(typeof structuredRows?.scope === 'string' ? { scope: structuredRows.scope } : {}),
          ...(Number.isFinite(expectedImageCount) && expectedImageCount > 0
            ? { expectedImageCount }
            : {}),
          ...(structuredRows?.hasCarouselSignal === true ? { hasCarouselSignal: true } : {}),
        }, null, 2)
      }

      case 'browser_resolve_video': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const tabs = controller.getTabList()
        const tab = (tabId ? tabs.find((item) => item.id === tabId) : null)
          || tabs.find((item) => item.active)
          || tabs[0]
          || null
        const effectiveTabId = tabId || tab?.id || null
        const pageUrl = String(args.page_url || args.url || tab?.url || '').trim()
        const videoUrl = String(args.video_url || '').trim()
        const posterUrl = String(args.poster_url || '').trim()
        const title = String(args.title || tab?.title || '').trim()
        const sources = Array.isArray(args.sources)
          ? args.sources.map((item) => String(item || '').trim()).filter(Boolean)
          : []

        if (!pageUrl && !videoUrl && sources.length === 0) {
          return 'Error: page_url, video_url or sources is required'
        }

        const video = (await resolveFastCardVideo({
          target: {
            kind: 'video',
            pageUrl,
            pageTitle: tab?.title || title || undefined,
            domain: pageUrl ? safeHostname(pageUrl) : undefined,
            tabId: effectiveTabId,
            capturedAt: Date.now(),
            ...(videoUrl ? { videoUrl } : {}),
            ...(posterUrl ? { posterUrl } : {}),
            ...(title ? { title } : {}),
            ...(sources.length > 0 ? { sources } : {}),
          },
        })).video

        return JSON.stringify({
          ok: video.parseStatus !== 'failed',
          video,
        }, null, 2)
      }

      case 'browser_download_urls': {
        const rawUrls = Array.isArray(args.urls) ? args.urls : []
        // EP2 dogfood gap 1 — keep downloads ON the collection chain: if this
        // scope already discovered an image gallery, raw URL downloads orphan
        // the files from the collection card. Redirect to the chained tool;
        // an explicitly unrelated download passes with the declaration flag.
        if (args.unrelated_to_collection !== true) {
          const chained = await findScopeImageGallerySourceTask(controller, sessionId)
          if (chained) {
            return JSON.stringify({
              ok: false,
              errorCode: 'use_collected_media_download',
              message: `本会话已有图片采集任务 ${chained.taskId}（已发现 ${mediaUrlsFromVisibleCollectTask(chained).length} 张）。保存这些图片必须用 browser_download_collected_media(source_task_id) 让下载结果回到采集卡；只有与该采集无关的下载才可以传 unrelated_to_collection: true 继续使用本工具。`,
              sourceTaskId: chained.taskId,
              suggestedNextTool: 'browser_download_collected_media',
            }, null, 2)
          }
        }
        return await downloadUrlsToDirectory(controller, {
          urls: rawUrls.map((item) => String(item || '')),
          directory: String(args.directory || '~/Documents'),
          filenamePrefix: String(args.filename_prefix || 'download'),
          overwrite: args.overwrite === true,
          tabId: (args.tab_id as string) || null,
        })
      }

      case 'browser_download_collected_media': {
        const sourceTaskId = String(args.source_task_id || '').trim()
        if (!sourceTaskId) return 'Error: source_task_id is required'
        const directory = String(args.directory || '').trim()
        if (!directory) return 'Error: directory is required'

        const sourceTask = await controller.getTask(sourceTaskId)
        const sourcePayload = typeof (controller as { getTaskPayload?: (taskId: string) => Record<string, unknown> | null }).getTaskPayload === 'function'
          ? ((controller as { getTaskPayload: (taskId: string) => Record<string, unknown> | null }).getTaskPayload(sourceTaskId) || null)
          : null
        if (!sourceTask) {
          return JSON.stringify({
            ok: false,
            errorCode: 'source_task_missing',
            message: `source_task_id ${sourceTaskId} 不存在，无法下载已发现图片。`,
            sourceTaskId,
          }, null, 2)
        }
        const sourceScopeId = stringField(sourcePayload?.scopeId)
        if (sessionId && sourceScopeId && sourceScopeId !== sessionId) {
          return JSON.stringify({
            ok: false,
            errorCode: 'stale_source_task_scope',
            message: `source_task_id ${sourceTaskId} 属于另一个会话，不能接力下载。请使用本轮 browser_visible_collect 返回的 source_task_id。`,
            sourceTaskId,
          }, null, 2)
        }
        if (!isImageGallerySourceTask(sourceTask, sourcePayload)) {
          return JSON.stringify({
            ok: false,
            errorCode: 'source_task_not_image_gallery',
            message: `source_task_id ${sourceTaskId} 不是 browser_visible_collect(image_gallery) 任务，不能用图片下载接力。`,
            sourceTaskId,
            kind: sourceTask.kind,
          }, null, 2)
        }
        if (!isCompleteSourceTask(sourceTask)) {
          const result = resultObject(sourceTask)
          return JSON.stringify({
            ok: false,
            errorCode: 'source_task_not_complete',
            message: `source_task_id ${sourceTaskId} 的图片发现还未完整完成，请先继续发现或明确只下载已发现图片。`,
            sourceTaskId,
            discoveryStatus: sourceTaskDiscoveryStatus(sourceTask),
            continueTaskId: typeof result?.continueTaskId === 'string' ? result.continueTaskId : sourceTaskId,
          }, null, 2)
        }
        const urls = mediaUrlsFromVisibleCollectTask(sourceTask)
        if (urls.length === 0) {
          return JSON.stringify({
            ok: false,
            errorCode: 'source_task_has_no_media',
            message: `source_task_id ${sourceTaskId} 没有可下载的图片 URL。`,
            sourceTaskId,
          }, null, 2)
        }
        const result = resultObject(sourceTask)
        const referer = stringField(result?.targetUrl) || stringField(sourcePayload?.url)
        const output = await downloadUrlsToDirectory(controller, {
          urls,
          directory,
          filenamePrefix: String(args.filename_prefix || 'image'),
          overwrite: args.overwrite === true,
          referer,
        })
        if (output.startsWith('Error:')) return output
        const parsed = JSON.parse(output) as Record<string, unknown>
        // EP2 dogfood gap 2 — completion must reconcile discovered/saved/
        // failed/remaining. A page-claimed total (expected_total) that
        // exceeds the discovered set means undiscovered images remain: this
        // is PARTIAL, never "完成".
        const saved = Number(parsed.success || 0)
        const failed = Number(parsed.failed || 0)
        const discovered = urls.length
        const expectedTotal = Number.isFinite(Number(args.expected_total)) && Number(args.expected_total) > 0
          ? Number(args.expected_total)
          : null
        const undiscovered = expectedTotal !== null ? Math.max(0, expectedTotal - discovered) : 0
        const remaining = undiscovered + Math.max(0, discovered - saved - failed)
        const completion = remaining > 0 || failed > 0 ? 'partial' : 'complete'
        // EP2 dogfood gap 3 — downloads flow BACK to the source task so the
        // collection card's numbers move (saved/failed/remaining visible).
        try {
          await (controller as unknown as {
            recordCollectedMediaDownload?: (taskId: string, summary: Record<string, unknown>) => Promise<unknown>
          }).recordCollectedMediaDownload?.(sourceTaskId, {
            discovered, saved, failed, remaining,
            directory: String(parsed.directory || directory),
            expectedTotal,
          })
        } catch { /* progress write-back must not fail the download result */ }
        return JSON.stringify({
          ok: saved > 0,
          completion,
          sourceTaskId,
          mediaCandidateCount: discovered,
          discovered,
          saved,
          failedCount: failed,
          remaining,
          expectedTotal,
          guidance: completion === 'partial'
            ? `已保存已发现的 ${saved} 张${failed > 0 ? `（${failed} 张失败）` : ''}${undiscovered > 0 ? `，页面声称共 ${expectedTotal} 张，仍有 ${undiscovered} 张未发现/未加载——请继续发现后再下载，不要宣告完成` : ''}。`
            : `已保存全部已发现的 ${saved} 张。`,
          ...parsed,
        }, null, 2)
      }

      case 'browser_click_at': {
        const x = Number(args.x)
        const y = Number(args.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        // EP1-I3 live-target net — shared guarded entry probes the target
        // under the point; clicking a non-editable M1 target is refused
        // before any mouse event, focusing an editable field is allowed,
        // and an unresolvable probe proceeds (visual channel stays usable).
        const point = await runGuardedCoordinateClick(controller, tabId, x, y, abortSignal)
        return JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          viewport: { width: point.width, height: point.height },
        }, null, 2)
      }

      case 'browser_type_at': {
        const x = Number(args.x)
        const y = Number(args.y)
        const text = String(args.text || '')
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        if (!text) return 'Error: text is required'
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const pressEnter = args.press_enter !== false
        const clearBeforeTyping = args.clear_before_typing !== false
        const useShiftEnter = args.use_shift_enter_for_newline === true
        // EP1-I3 live-target net — shared guarded entry: non-editable M1
        // target → the focusing click is itself refused; editable field →
        // judged by field semantics (NOT its current value) + password cue.
        const point = await runGuardedCoordinateType(controller, tabId, x, y, text, {
          clearBefore: clearBeforeTyping,
          pressEnter,
          useShiftEnter,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }, abortSignal)
        return JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          submitted: pressEnter,
          text_length: text.length,
        }, null, 2)
      }

      case 'browser_scroll_at': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const x = Number(args.x ?? 500)
        const y = Number(args.y ?? 500)
        const direction = String(args.direction || '').toLowerCase()
        if (!['up', 'down', 'left', 'right'].includes(direction)) {
          return 'Error: direction must be up/down/left/right'
        }
        const magnitude = Math.max(40, Math.min(4000, Number(args.magnitude || 800)))
        const point = await resolveCssPoint(controller, tabId, x, y)
        const deltaY = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0
        const deltaX = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0
        await controller.dispatchMouse(tabId, {
          type: 'mouseWheel',
          x: point.cssX,
          y: point.cssY,
          deltaX,
          deltaY,
          button: 'none',
          buttons: 0,
        })
        return `Scrolled ${direction} at normalized(${point.nx},${point.ny})`
      }

      case 'browser_send_keys': {
        const tabId = (args.tab_id as string) || null
        const key = String(args.key || '').trim()
        if (!key) return 'Error: key is required'
        await sendKeyStroke(controller, tabId, key, args.modifiers)
        return `Sent key: ${key}`
      }

      case 'browser_ask_user_takeover': {
        const callToAction = String(args.call_to_action || '').trim()
        if (!callToAction) return 'Error: call_to_action is required'
        const details = String(args.details || '')
        const timeoutSec = Math.max(30, Math.min(1200, Number(args.timeout_sec || 300)))
        log(`[browser-v3][human-required] action=${callToAction} timeout=${timeoutSec}s`)
        return JSON.stringify({
          phase: 'human_required',
          takeover_state: 'submitted',
          call_to_action: callToAction,
          details,
          timeout_sec: timeoutSec,
          next_step: 'wait for user takeover result: submitted|skipped|timeout',
        }, null, 2)
      }

      case 'browser_query_gemini': {
        const text = String(args.text || '').trim()
        if (!text) return 'Error: text is required'
        const tabId = (args.tab_id as string) || null
        const waitResponseMs = Math.max(6000, Math.min(120_000, Number(args.wait_response_ms || 35_000)))
        return await runGeminiQuery(controller, text, tabId, waitResponseMs, abortSignal)
      }

      case 'browser_wait': {
        const timeoutMs = Number(args.timeout_ms || 8000)
        const selector = typeof args.selector === 'string' ? args.selector : undefined
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const ready = await waitForReady(controller, tabId, Math.max(500, Math.min(timeoutMs, 30_000)), selector, abortSignal)
        return `Wait result: ready=${ready.ready}, selectorMatched=${ready.matchedSelector}, elapsed=${ready.elapsedMs}ms`
      }

      case 'browser_wait_for_condition': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const result = await controller.waitForCondition(tabId, {
          condition: String(args.condition || 'page_readable') as never,
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          customJs: typeof args.custom_js === 'string' ? args.custom_js : undefined,
          timeoutMs: Number(args.timeout_ms || 0) || undefined,
          checkIntervalMs: Number(args.check_interval_ms || 0) || undefined,
          stableIterations: Number(args.stable_iterations || 0) || undefined,
        })
        return JSON.stringify(result, null, 2)
      }

      case 'browser_extract_structured': {
        const template = String(args.template || 'article_list') as never
        const url = String(args.url || '').trim()
        let tabId = (args.tab_id as string) || null
        const scoped = await resolveHighControlAgentTab(controller, args, { signal: abortSignal })
        tabId = scoped.tabId
        const fields = Array.isArray(args.fields)
          ? (args.fields
              .filter((item) => item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string')
              .map((item) => item as BrowserStructuredFieldMapping))
          : undefined
        const options = {
          template,
          itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
          fields,
          limit: Number(args.limit || 0) || undefined,
          minWidth: Number(args.min_width || 0) || undefined,
          customScript: typeof args.custom_script === 'string' ? args.custom_script : undefined,
        }
        const result = url && !scoped.redirected
          ? await controller.extractStructuredFromUrl(url, options)
          : await controller.extractStructured(tabId, options)
        return JSON.stringify(result, null, 2)
      }

      case 'browser_scroll_collect': {
        const template = String(args.template || 'card_list') as never
        const url = String(args.url || '').trim()
        let tabId = (args.tab_id as string) || null
        if (url) {
          const opened = await controller.openForCaptureTarget(url)
          if (!opened.success || !opened.tabId) {
            return `Error: ${opened.error || 'failed to open target'}`
          }
          tabId = opened.tabId
        }
        const result = await controller.scrollCollect(tabId, {
          template,
          itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
          limit: Number(args.limit || 0) || undefined,
          maxScrolls: Number(args.max_scrolls || 0) || undefined,
          scrollDelayMs: Number(args.scroll_delay_ms || 0) || undefined,
          customScript: typeof args.custom_script === 'string' ? args.custom_script : undefined,
        })
        return JSON.stringify(result, null, 2)
      }

      case 'browser_start_task': {
        const kind = String(args.kind || '').trim()
        if (!kind) return 'Error: kind is required'
        const payload = args.payload && typeof args.payload === 'object' ? args.payload as Record<string, unknown> : {}
        const result = await controller.startTask({
          kind: kind as never,
          payload,
        })
        return JSON.stringify(result, null, 2)
      }

      case 'browser_get_task': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        const result = await controller.getTask(taskId)
        const resumedCollection = result ? await startCollectionFromCompletedVisibleTask(controller, result, sessionId) : null
        if (resumedCollection) return JSON.stringify(resumedCollection, null, 2)
        if (!result && taskId.startsWith('task-')) {
          return JSON.stringify({
            taskId,
            status: 'wrong_id_type',
            message: 'browser_get_task 只能查询 browser-task-*。这是聊天任务或锁持有者 id，请使用 browser_collect_notes / browser_visible_collect 返回的 taskId。',
          }, null, 2)
        }
        return JSON.stringify(result ? enrichBrowserTaskPayload(result) : { taskId, status: 'missing' }, null, 2)
      }

      case 'browser_resume_task': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        let current: BrowserCapabilityTaskHandle | null = null
        try {
          current = await controller.getTask(taskId)
        } catch (error) {
          log(`browser_resume_task getTask failed taskId=${taskId}: ${error instanceof Error ? error.message : String(error)}`)
          current = null
        }
        const resumedCollection = current ? await startCollectionFromCompletedVisibleTask(controller, current, sessionId) : null
        if (resumedCollection) return JSON.stringify(resumedCollection, null, 2)
        const result = await controller.resumeTask(taskId)
        return JSON.stringify(result || { taskId, status: 'missing' }, null, 2)
      }

      case 'browser_cancel_task': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        const result = await controller.cancelTask(taskId)
        if (!result && taskId.startsWith('task-')) {
          return JSON.stringify({
            taskId,
            status: 'wrong_id_type',
            message: 'browser_cancel_task 只能取消 browser-task-*。这是聊天任务或锁持有者 id，请使用浏览器任务返回的 taskId。',
          }, null, 2)
        }
        return JSON.stringify(result || { taskId, status: 'missing' }, null, 2)
      }

      case 'browser_aggregate_results': {
        const items = Array.isArray(args.items) ? args.items as Array<Record<string, unknown>> : []
        const result = controller.aggregateResults(items as never, {
          mergeStrategy: typeof args.merge_strategy === 'string' ? args.merge_strategy as 'concat' | 'dedupe' : undefined,
          sortBy: typeof args.sort_by === 'string' ? args.sort_by as 'title' | 'link' | 'source' : undefined,
        })
        return JSON.stringify(result, null, 2)
      }

      case 'browser_download_gallery': {
        const url = String(args.url || '').trim()
        if (!url) return 'Error: url is required'
        const result = await controller.startTask({
          kind: 'scroll_collect',
          payload: {
            url,
            template: 'image_gallery',
            download: true,
            directory: typeof args.directory === 'string' ? args.directory : undefined,
            limit: Number(args.limit || 0) || undefined,
            maxScrolls: Number(args.max_scrolls || 0) || undefined,
            retryFailed: args.retry_failed === true,
          },
        })
        return JSON.stringify(result, null, 2)
      }

      case 'browser_research_topic': {
        const query = String(args.query || '').trim()
        if (!query) return 'Error: query is required'
        const result = await controller.startTask({
          kind: 'research',
          payload: {
            query,
            urls: Array.isArray(args.urls) ? args.urls : undefined,
            maxPages: Number(args.max_pages || 0) || undefined,
            limitPerPage: Number(args.limit_per_page || 0) || undefined,
            template: typeof args.template === 'string' ? args.template : undefined,
          },
        })
        return JSON.stringify(result, null, 2)
      }

      case 'browser_run_workflow': {
        const stepsRaw = args.steps
        if (!Array.isArray(stepsRaw)) return 'Error: steps must be an array'
        const tabId = (args.tab_id as string) || null
        const continueOnError = args.continue_on_error === true
        const lines: string[] = []
        for (let index = 0; index < stepsRaw.length; index += 1) {
          const step = stepsRaw[index]
          if (!step || typeof step !== 'object') {
            lines.push(`Step ${index + 1}: Error: invalid step`)
            if (!continueOnError) break
            continue
          }
          const result = await runWorkflowStep(controller, step as Record<string, unknown>, tabId, abortSignal)
          lines.push(`Step ${index + 1}: ${result}`)
          if (!continueOnError && result.startsWith('Error:')) {
            break
          }
        }
        return truncate(lines.join('\n'))
      }

      case 'browser_execute_js': {
        const code = args.code as string
        if (!code) return 'Error: code is required'
        const tabId = (args.tab_id as string) || null
        log(`Executing JS: ${code.slice(0, 100)}`)
        const result = await controller.executeJS(tabId, code)
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return truncate(resultStr ?? 'undefined')
      }

      case 'browser_visible_collect': {
        // Reuse the same full target-URL set as the script guard (active tab,
        // tab_id, url) so high-control rate limits can't be bypassed via tab_id.
        const highControl = candidateTargetUrls.some((u) => isHighControlPlatformText(u))
        const payload = {
          url: typeof args.url === 'string' ? args.url : undefined,
          tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
          template: typeof args.template === 'string' ? args.template : undefined,
          itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
          maxItems: Number(args.max_items || 0) || undefined,
          maxRounds: Number(args.max_rounds || 0) || undefined,
          maxDurationMs: Number(args.max_duration_ms || 0) || undefined,
          userExpectedTotal: Number(args.user_expected_total || 0) || undefined,
          outputRootDir: typeof args.output_root_dir === 'string' && args.output_root_dir.trim()
            ? args.output_root_dir.trim()
            : undefined,
          // High-control platforms get conservative default rate/volume limits
          // (plan §4.4) applied in the runner.
          highControl,
          // Fallback for non-controller tests/hosts. Production controllers use
          // startVisibleCollection, which rewrites these to agent-view.
          surface: leaseGate?.surface,
          leaseId: leaseGate?.leaseId ?? undefined,
        }
        const startVisibleCollection = (controller as { startVisibleCollection?: (payload: Record<string, unknown>, scopeId?: string) => Promise<unknown> }).startVisibleCollection
        const result = startVisibleCollection
          ? await startVisibleCollection.call(controller, payload, sessionId)
          : await controller.startTask({ kind: 'visible_collect', payload })
        return JSON.stringify(result, null, 2)
      }

      case 'browser_collect_notes': {
        // Dispatch a background note-collection sub-agent (plan §3.3). The main
        // agent either supplies a frozen source_task_id from browser_visible_collect
        // or a direct planned list; source_task_id is the stronger contract so
        // the model cannot accidentally drop targets while restating the list.
        const sourceTaskId = String(args.source_task_id || '').trim()
        const expectedCount = Math.max(0, Number(args.expected_count || 0) || 0)
        const requestedStrategy = String(args.strategy || '').trim()
        const requestedOutputRootDir = normalizedPathField(args.output_root_dir)
        const rawNotes = Array.isArray(args.notes) ? args.notes as Array<Record<string, unknown>> : []
        const allowPartial = args.allow_partial === true
        const partialConsent = sourceTaskId
          ? collectionConsentStore.hasConsent('partial_collection', sessionId || '', sourceTaskId)
          : false
        let notes = normalizeCollectionTargets(rawNotes)
        let sourceTask: BrowserCapabilityTaskHandle | null = null
        let effectiveSourceTaskId = sourceTaskId
        if (sourceTaskId) {
          sourceTask = await controller.getTask(sourceTaskId)
          const frozenNotes = targetsFromTask(sourceTask)
          if (!sourceTask) return `Error: source_task_id ${sourceTaskId} 不存在，无法接力采集。`
          const sourcePayload = typeof (controller as { getTaskPayload?: (taskId: string) => Record<string, unknown> | null }).getTaskPayload === 'function'
            ? ((controller as { getTaskPayload: (taskId: string) => Record<string, unknown> | null }).getTaskPayload(sourceTaskId) || null)
            : null
          const mismatch = sourceTaskHandoffMismatch(sourceTaskId, sourcePayload, resultObject(sourceTask), sessionId, requestedOutputRootDir)
          if (mismatch) {
            log(`browser_collect_notes refusal ${mismatch.errorCode} sourceTaskId=${sourceTaskId}`)
            return JSON.stringify({
              ok: false,
              ...mismatch,
              sourceTaskId,
            }, null, 2)
          }
          if (frozenNotes.length === 0) {
            return `Error: source_task_id ${sourceTaskId} 没有可接力的冻结目标清单。`
          }
          if (!isCompleteSourceTask(sourceTask) && !partialConsent) {
            const status = sourceTaskDiscoveryStatus(sourceTask)
            const result = resultObject(sourceTask)
            const stopReason = String(result?.stopReason || sourceTask.status || 'unknown')
            const continueTaskId = typeof result?.continueTaskId === 'string' ? result.continueTaskId : sourceTaskId
            const pendingConsentRequest = collectionConsentStore.createPendingRequest({
              scopeId: sessionId || '',
              sourceTaskId,
              consentKind: 'partial_collection',
            })
            const message = `source_task_id ${sourceTaskId} 的发现清单不是完整全量（discoveryStatus=${status}, stopReason=${stopReason}, 已冻结 ${frozenNotes.length} 条）。请先用 browser_resume_task 继续发现：${continueTaskId}；如果用户明确只采当前这部分，需要先完成部分采集确认。`
            await upsertCollectionConsentProjection(runtime, pendingConsentRequest, message)
            log(`browser_collect_notes refusal partial_collection sourceTaskId=${sourceTaskId}`)
            return JSON.stringify({
              ok: false,
              errorCode: 'partial_collection_consent_required',
              message,
              sourceTaskId,
              continueTaskId,
              frozenCount: frozenNotes.length,
              allowPartialIgnored: allowPartial,
              pendingConsentRequest,
            }, null, 2)
          }
          if (notes.length > 0 && notes.length !== frozenNotes.length) {
            return `Error: browser_collect_notes 数量不一致：source_task_id ${sourceTaskId} 有 ${frozenNotes.length} 条，传入 notes 有 ${notes.length} 条。请直接使用 source_task_id 接力。`
          }
          notes = frozenNotes
        }
        if (notes.length === 0) {
          return 'Error: browser_collect_notes 需要 source_task_id，或至少一条带 http(s) URL 的 notes。'
        }
        if (!sourceTaskId) {
          const largerFrozen = await findLargerRecentFrozenCollection(controller, notes)
          if (largerFrozen && !collectionConsentStore.hasConsent('partial_collection', sessionId || '', largerFrozen.taskId)) {
            const pendingConsentRequest = collectionConsentStore.createPendingRequest({
              scopeId: sessionId || '',
              sourceTaskId: largerFrozen.taskId,
              consentKind: 'partial_collection',
            })
            const message = `browser_collect_notes 检测到最近的 browser_visible_collect (${largerFrozen.taskId}) 已冻结 ${largerFrozen.count} 条目标，但当前只传入 ${notes.length} 条。请改用 source_task_id 接力；若用户明确只要部分采集，需要先完成部分采集确认。`
            await upsertCollectionConsentProjection(runtime, pendingConsentRequest, message)
            log(`browser_collect_notes refusal partial_collection recentFrozen=${largerFrozen.taskId}`)
            return JSON.stringify({
              ok: false,
              errorCode: 'partial_collection_consent_required',
              message,
              sourceTaskId: largerFrozen.taskId,
              frozenCount: largerFrozen.count,
              requestedCount: notes.length,
              allowPartialIgnored: allowPartial,
              pendingConsentRequest,
            }, null, 2)
          }
          const missingUrls = missingUserProvidedUrls(notes, currentUserText || '')
          if (missingUrls.length > 0) {
            log(`browser_collect_notes refusal url_provenance_required missing=${missingUrls.length}`)
            return JSON.stringify({
              ok: false,
              errorCode: 'url_provenance_required',
              message: 'browser_collect_notes 直接接收 URL 列表时，必须确认这些 URL 来自当前用户消息原文或用户显式选择的会话资源；当前缺少可证明来源的 URL。',
              missingUrls,
            }, null, 2)
          }
        }
        if (expectedCount > 0 && notes.length !== expectedCount) {
          return `Error: browser_collect_notes 数量不一致：预期 ${expectedCount} 条，实际冻结清单 ${notes.length} 条。`
        }
        const requestedMaxNotes = Math.max(0, Number(args.max_notes || 0) || 0)
        if (requestedMaxNotes > 0 && requestedMaxNotes < notes.length) {
          notes = notes.slice(0, requestedMaxNotes)
        }
        const stopConditions: Record<string, number> = {}
        if (requestedMaxNotes > 0) stopConditions.maxNotes = requestedMaxNotes
        if (Number(args.max_duration_ms || 0) > 0) stopConditions.maxDurationMs = Number(args.max_duration_ms)
        if (Number(args.max_consecutive_failures || 0) > 0) stopConditions.maxConsecutiveFailures = Number(args.max_consecutive_failures)
        const profileUrl = String(args.target_profile_url || '').trim()
          || (typeof resultObject(sourceTask)?.targetUrl === 'string' ? String(resultObject(sourceTask)?.targetUrl) : '')
        let profileSlug = 'profile'
        try {
          profileSlug = new URL(profileUrl).pathname.split('/').filter(Boolean).pop() || 'profile'
        } catch {
          // silent-catch: non-URL profile strings use the default output slug.
        }
        const outputRootDir = typeof args.output_root_dir === 'string' && args.output_root_dir.trim()
          ? expandHomePath(args.output_root_dir.trim())
          : join(homedir(), 'Documents', 'Ready采集', sanitizeFilename(profileSlug, 'profile'))
        if (!effectiveSourceTaskId) {
          const createSyntheticVisibleCollection = (controller as {
            createSyntheticVisibleCollection?: (payload: {
              targets: BrowserCollectionTarget[]
              targetUrl?: string
              outputRootDir?: string
              sourceMessageIds?: string[]
            }, scopeId?: string) => BrowserCapabilityTaskHandle | Promise<BrowserCapabilityTaskHandle>
          }).createSyntheticVisibleCollection
          if (typeof createSyntheticVisibleCollection !== 'function') {
            return JSON.stringify({
              ok: false,
              errorCode: 'synthetic_source_not_ready',
              message: 'browser_collect_notes 直接 URL 列表已通过来源校验，但当前浏览器控制器未注册 synthetic source task 入口，不能启动无 source_task_id 的采集。',
            }, null, 2)
          }
          sourceTask = await createSyntheticVisibleCollection.call(controller, {
            targets: notes,
            targetUrl: profileUrl,
            outputRootDir,
            sourceMessageIds: ['current-turn'],
          }, sessionId)
          effectiveSourceTaskId = sourceTask.taskId
        }
        const targetHost = targetHostForCollection(profileUrl, notes)
        const highControlCollection = isHighControlPlatformText(profileUrl) || notes.some((note) => isHighControlPlatformText(note.url))
        const strategy = requestedStrategy === 'card_loop'
          ? 'card_loop'
          : requestedStrategy === 'url_batch'
            ? 'url_batch'
            : highControlCollection ? 'card_loop' : 'url_batch'
        if (highControlCollection && strategy === 'url_batch') {
          const hasDowngradeConsent = effectiveSourceTaskId
            ? collectionConsentStore.hasConsent('high_control_url_batch_downgrade', sessionId || '', effectiveSourceTaskId, targetHost)
            : false
          if (!hasDowngradeConsent) {
            const pendingConsentRequest = effectiveSourceTaskId
              ? collectionConsentStore.createPendingRequest({
                  scopeId: sessionId || '',
                  sourceTaskId: effectiveSourceTaskId,
                  consentKind: 'high_control_url_batch_downgrade',
                  targetHost,
                  warningText: '该目标命中高风控平台，url_batch 会硬跳详情页，可能触发验证或丢失自然浏览上下文。',
                })
              : undefined
            const message = '该目标命中高风控平台，不能在没有明确降级确认的情况下使用 url_batch 硬跳详情页。请改用 strategy=card_loop，或先完成高风控 URL 批处理降级确认。'
            await upsertCollectionConsentProjection(runtime, pendingConsentRequest, message)
            log(`browser_collect_notes refusal high_control_url_batch sourceTaskId=${effectiveSourceTaskId || ''} host=${targetHost}`)
            return JSON.stringify({
              ok: false,
              errorCode: 'high_control_url_batch_denied',
              message,
              strategy,
              sourceTaskId: effectiveSourceTaskId,
              targetHost,
              pendingConsentRequest,
            }, null, 2)
          }
        }
        const plan = {
          targetProfileUrl: profileUrl,
          strategy,
          notes: buildCollectionPlanNotes(notes),
          ...(expectedCount > 0 ? { expectedCount } : {}),
          ...(effectiveSourceTaskId ? { sourceTaskId: effectiveSourceTaskId } : {}),
          outputRootDir,
          ...(Object.keys(stopConditions).length > 0 ? { stopConditions } : {}),
        }
        // Pass the agent's session/scope so the background task projects into
        // THIS conversation's chat (plan §3.2). sessionId ≈ scopeId.
        const startCardLoopCollection = (controller as { startCardLoopCollection?: (plan: Record<string, unknown>, scopeId?: string) => Promise<unknown> }).startCardLoopCollection
        const result = strategy === 'card_loop'
          ? startCardLoopCollection
            ? await startCardLoopCollection.call(controller, plan, sessionId)
            : {
                ok: false,
                errorCode: 'card_loop_not_ready',
                message: 'card_loop runner 未注册；不能把高风控采集静默降级为 url_batch。',
                strategy,
              }
          : await controller.startNoteCollection(plan, sessionId)
        return JSON.stringify(result, null, 2)
      }

      case 'browser_confirm_collection_consent': {
        const requestId = String(args.request_id || '').trim()
        const confirmedVia = String(args.confirmed_via || '').trim()
        if (!requestId) {
          return JSON.stringify({
            ok: false,
            errorCode: 'collection_consent_request_id_required',
            message: 'browser_confirm_collection_consent 需要 request_id。',
          }, null, 2)
        }
        if (confirmedVia !== 'ask_user_questions' && confirmedVia !== 'ui_action') {
          return JSON.stringify({
            ok: false,
            errorCode: 'collection_consent_via_invalid',
            message: 'confirmed_via 必须是 ask_user_questions 或 ui_action。',
          }, null, 2)
        }
        const record = collectionConsentStore.confirmPendingRequest(requestId, confirmedVia)
        if (!record) {
          return JSON.stringify({
            ok: false,
            errorCode: 'collection_consent_request_not_found',
            message: `找不到可确认的浏览器采集确认请求：${requestId}`,
            requestId,
          }, null, 2)
        }
        await clearCollectionConsentProjection(runtime, record)
        return JSON.stringify({ ok: true, record }, null, 2)
      }

      case 'browser_go_back': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goBack(tabId)
        if (!result.success) return `Error: ${result.error}`
        return 'Navigated back.'
      }

      default:
        return `Unknown browser tool: ${toolName}`
    }
  } catch (error) {
    // EP1-T4-2 (browser pilot) — let structured domain errors flow to the
    // dispatcher's error contract (errorKind + envelope) instead of being
    // flattened to a string. No browser handler throws ToolDomainError at
    // HEAD, so this is purely the forward migration path; plain throws keep
    // the legacy string shape below.
    if (error instanceof ToolDomainError) throw error
    const msg = error instanceof Error ? error.message : String(error)
    log(`Browser tool error: ${msg}`)
    return `Error executing ${toolName}: ${msg}`
  } finally {
    gate.end()
  }
}
