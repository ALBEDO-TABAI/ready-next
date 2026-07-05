/**
 * D18-c（真机第十四轮实锚）—— closed shadow host 内部真实按钮定位。
 *
 * 背景：`<xhs-publish-btn>` 这类自定义元素把真实按钮藏在 closed shadow root
 * 里，JS 侧 elementFromPoint / 遍历一律只能看到 host；而 host 的包围盒可能
 * 横跨整个底部按钮组（「暂存离开」+「发布」），rect 中心点落在两个按钮之间
 * 的死区——第十四轮升级点击 css=(569,851) 点空即此。
 *
 * CDP 的 DOM 域看的是组合树（composed tree），`DOM.getNodeForLocation` 能
 * 命中 closed shadow root 内部的最深节点，`DOM.resolveNode` 拿到的直接引用
 * 不受 closed 限制（closed 只挡从外部遍历，不挡直接引用上的求值）。据此在
 * host rect 内水平采样命中测试，读出每个采样点下的真实可交互控件文本，
 * 与 map 目标名/模型 disambiguation 匹配后选出真按钮的坐标。
 *
 * 纯确定性代码，无 LLM 参与；CDP 不可用或扫描失败时调用方回退 rect 中心
 * （旧行为），永不比现状更差。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'

export interface ShadowHitCandidate {
  cssX: number
  cssY: number
  tag: string
  role: string
  text: string
  /** 命中的是真实可交互控件（button/a/[role=button]/cursor:pointer），而非 host 本身或空白容器 */
  interactive: boolean
  /** 命中节点就是自定义 host（dash tag）——等于没穿进去 */
  isHost: boolean
}

export interface ShadowHitScanResult {
  /** 选中的可信点击点（CSS 像素）；null = 无法唯一定位，调用方按 candidates 决策 */
  point: { cssX: number; cssY: number } | null
  /** 选中依据 */
  via: 'name_match' | 'disambiguation_match' | 'single_interactive' | null
  matchedText: string | null
  /** 去重后的可交互候选（按采样序），供升级放弃时回给模型自行 click_at */
  candidates: ShadowHitCandidate[]
  skippedReason?: 'cdp_unavailable' | 'scan_failed' | 'no_interactive_hit'
}

type CdpSend = (tabId: string | null, method: string, params?: Record<string, unknown>) => Promise<unknown>

function resolveCdpSend(controller: BrowserController): CdpSend | null {
  const send = (controller as unknown as { sendCdpCommand?: CdpSend }).sendCdpCommand
  return typeof send === 'function' ? send.bind(controller) : null
}

/** 命中节点 → 最近可交互控件身份读取（在直接引用上求值，closed root 内有效）。 */
const HIT_NODE_DESCRIBE_FN = `function() {
  let el = this;
  if (el && el.nodeType === 3) el = el.parentElement;
  if (!el || el.nodeType !== 1) return null;
  let cur = el;
  let interactive = null;
  for (let i = 0; cur && i < 6; i += 1) {
    const tag = String(cur.tagName || '').toLowerCase();
    const role = (cur.getAttribute && cur.getAttribute('role')) || '';
    let pointer = false;
    try { pointer = getComputedStyle(cur).cursor === 'pointer'; } catch (e) {}
    if (tag === 'button' || tag === 'a' || role === 'button' || pointer) { interactive = cur; break; }
    if (cur.parentElement) { cur = cur.parentElement; continue; }
    const root = cur.getRootNode ? cur.getRootNode() : null;
    cur = root && root.host ? root.host : null;
  }
  const pick = interactive || el;
  const tag = String(pick.tagName || '').toLowerCase();
  return {
    tag,
    role: (pick.getAttribute && pick.getAttribute('role')) || '',
    text: String(pick.innerText || pick.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    interactive: Boolean(interactive),
    isHost: tag.indexOf('-') !== -1,
  };
}`

async function describeNodeAtPoint(
  send: CdpSend,
  tabId: string | null,
  cssX: number,
  cssY: number,
): Promise<Omit<ShadowHitCandidate, 'cssX' | 'cssY'> | null> {
  const located = await send(tabId, 'DOM.getNodeForLocation', {
    x: Math.round(cssX),
    y: Math.round(cssY),
    includeUserAgentShadowDOM: false,
  }) as { backendNodeId?: number } | null
  const backendNodeId = Number(located?.backendNodeId)
  if (!Number.isFinite(backendNodeId) || backendNodeId <= 0) return null
  const resolved = await send(tabId, 'DOM.resolveNode', { backendNodeId }) as {
    object?: { objectId?: string }
  } | null
  const objectId = resolved?.object?.objectId
  if (!objectId) return null
  try {
    const evaluated = await send(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: HIT_NODE_DESCRIBE_FN,
      returnByValue: true,
    }) as { result?: { value?: unknown } } | null
    const value = evaluated?.result?.value
    if (!value || typeof value !== 'object') return null
    const v = value as { tag?: unknown; role?: unknown; text?: unknown; interactive?: unknown; isHost?: unknown }
    return {
      tag: String(v.tag || ''),
      role: String(v.role || ''),
      text: String(v.text || ''),
      interactive: v.interactive === true,
      isHost: v.isHost === true,
    }
  } finally {
    void send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

/**
 * 在 closed shadow host 的 rect 内做水平命中扫描，返回真实内部按钮的点击点。
 *
 * 匹配优先级：候选文本 == map 目标名 → 候选文本出现在 disambiguation 里 →
 * 全场唯一可交互候选。多个候选且无匹配时不选点（宁可不点也不能点到
 * 「暂存离开」这类反向按钮），把候选连坐标交回模型。
 */
export async function scanClosedShadowHostForClickPoint(
  controller: BrowserController,
  tabId: string | null,
  rect: { left: number; top: number; width: number; height: number },
  viewport: { vw: number; vh: number },
  expect: { targetName: string; disambiguation: string },
): Promise<ShadowHitScanResult> {
  const send = resolveCdpSend(controller)
  if (!send) return { point: null, via: null, matchedText: null, candidates: [], skippedReason: 'cdp_unavailable' }
  const midY = rect.top + rect.height / 2
  const fractions = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9, 0.275, 0.725, 0.05, 0.95]
  const points = fractions
    .map((f) => ({ cssX: rect.left + rect.width * f, cssY: midY }))
    .filter((p) => p.cssX >= 0 && p.cssX < viewport.vw && p.cssY >= 0 && p.cssY < viewport.vh)
  if (points.length === 0) {
    return { point: null, via: null, matchedText: null, candidates: [], skippedReason: 'scan_failed' }
  }
  const hits: ShadowHitCandidate[] = []
  try {
    await send(tabId, 'DOM.enable', {})
    await send(tabId, 'DOM.getDocument', { depth: 0 })
    for (const p of points) {
      try {
        const described = await describeNodeAtPoint(send, tabId, p.cssX, p.cssY)
        if (described) hits.push({ ...described, cssX: p.cssX, cssY: p.cssY })
      } catch {
        // 单点失败继续扫（页面滚动/节点回收等瞬态）
      }
    }
  } catch {
    return { point: null, via: null, matchedText: null, candidates: [], skippedReason: 'scan_failed' }
  } finally {
    void send(tabId, 'DOM.disable', {}).catch(() => undefined)
  }
  // 只把"穿进了 host 内部的可交互控件"当候选；按文本分组去重，组内取
  // 采样点均值让点击落在控件中部而不是边缘。
  const groups = new Map<string, { sample: ShadowHitCandidate; xs: number[] }>()
  for (const hit of hits) {
    if (!hit.interactive || hit.isHost) continue
    const key = `${hit.text}|${hit.tag}`
    const existing = groups.get(key)
    if (existing) existing.xs.push(hit.cssX)
    else groups.set(key, { sample: hit, xs: [hit.cssX] })
  }
  const candidates = [...groups.values()].map(({ sample, xs }) => ({
    ...sample,
    cssX: xs.reduce((a, b) => a + b, 0) / xs.length,
  }))
  if (candidates.length === 0) {
    return { point: null, via: null, matchedText: null, candidates: [], skippedReason: 'no_interactive_hit' }
  }
  // 匹配必须唯一才选点：disambiguation 可能同时提到两个候选（"暂存离开
  // 旁边的发布按钮"），非唯一命中一律交回模型裁决，绝不按采样序赌。
  const targetName = expect.targetName.trim()
  const disambiguation = expect.disambiguation.trim()
  const nameMatches = candidates.filter((c) => c.text && targetName && c.text === targetName)
  if (nameMatches.length === 1) {
    const m = nameMatches[0]
    return { point: { cssX: m.cssX, cssY: m.cssY }, via: 'name_match', matchedText: m.text, candidates }
  }
  const disambiguationMatches = candidates.filter((c) => c.text && c.text.length >= 1 && c.text.length <= 40
    && disambiguation.includes(c.text))
  if (disambiguationMatches.length === 1) {
    const m = disambiguationMatches[0]
    return { point: { cssX: m.cssX, cssY: m.cssY }, via: 'disambiguation_match', matchedText: m.text, candidates }
  }
  if (candidates.length === 1) {
    return {
      point: { cssX: candidates[0].cssX, cssY: candidates[0].cssY },
      via: 'single_interactive',
      matchedText: candidates[0].text || null,
      candidates,
    }
  }
  return { point: null, via: null, matchedText: null, candidates }
}
