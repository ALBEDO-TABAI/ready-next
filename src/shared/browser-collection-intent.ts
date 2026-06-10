/**
 * Browser-collection intent + exposure subset (plan §4.0/§4.1, WP1).
 *
 * Decouples "expose browser collection tools" from the deterministic
 * browser-workflow decision mode (the research-style self-serve model). When a
 * message expresses collection/download intent on a web/platform surface, the
 * browser tool groups become visible — WITHOUT flipping browserDecisionMode —
 * and are then narrowed to a curated collection subset so high-risk script /
 * form-write tools are not exposed on the self-serve surface.
 *
 * Pure module — no Electron, no IO. The SDK checks the predicate over the
 * PRIMARY instruction text (so platform words inside context markers don't
 * falsely trigger) plus an explicit "### 浏览页面引用" reference marker, and
 * keeps the exposure alive across follow-up turns via stepCollectionIntentTtl.
 */

/**
 * The collection subset exposed when browser tools are surfaced by collection
 * intent (NOT by a browser_workflow decision). Navigation / read / collect /
 * download / task-control only. Deliberately excludes execute_js, run_workflow,
 * and form-write/transmit tools (type/compose/send/upload) — those stay gated
 * behind the deterministic workflow path. (plan §4.0)
 */
export const BROWSER_COLLECTION_SUBSET_TOOL_NAMES: readonly string[] = [
  'browser_navigate',
  'browser_search',
  'browser_get_tabs',
  'browser_read_page',
  'browser_capture_viewport',
  'browser_scroll_at',
  'browser_click_text',
  'browser_wait',
  'browser_wait_for_condition',
  'browser_collect_images',
  'browser_resolve_video',
  'browser_extract_structured',
  'browser_scroll_collect',
  'browser_visible_collect',
  'browser_collect_notes',
  'browser_download_urls',
  'browser_download_collected_media',
  'browser_aggregate_results',
  'browser_get_task',
  'browser_resume_task',
  'browser_cancel_task',
  'browser_ask_user_takeover',
]

const BROWSER_COLLECTION_SUBSET_SET = new Set(BROWSER_COLLECTION_SUBSET_TOOL_NAMES)

export function isBrowserCollectionSubsetTool(toolName: string): boolean {
  return BROWSER_COLLECTION_SUBSET_SET.has(toolName)
}

export const BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_NAMES: readonly string[] = [
  'browser_visible_collect',
  'browser_collect_notes',
  'browser_download_collected_media',
  'browser_get_task',
  'browser_resume_task',
  'browser_cancel_task',
  'browser_ask_user_takeover',
]

const BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_SET = new Set(BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_NAMES)

export function isBrowserBatchCollectionWorkflowTool(toolName: string): boolean {
  return BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_SET.has(toolName)
}

// High-risk-control / login-walled platforms where collection is the primary
// value. Used both for intent detection and (downstream) for the execution-layer
// script blacklist (plan §4.4).
const PLATFORM_PATTERN =
  /(?:小红书|xiaohongshu|xhslink|抖音|douyin|tiktok|微博|weibo|哔哩哔哩|b\s*站|bilibili|知乎|zhihu|小红书|快手|kuaishou|instagram|小红书)/i

const EXPLICIT_BROWSER_SURFACE =
  /(?:用浏览器|浏览器里|用我的登录态|登录态|打开网页|开(?:一个)?(?:独立)?网页|这个(?:网页|页面|链接|博主|主页)|当前(?:网页|页面)|网页里|\brpa\b|这个号|这个账号)/i

const COLLECTION_VERB = /(?:采集|抓取|爬取|爬|收集|下载|保存|整理|批量|扒)/
// Deliberately excludes bare 图片/照片/封面 — those are ambiguous with local
// file operations ("把这张图片下载到本地"), so on their own they must NOT expose
// browser. Image collection still triggers via a platform name or an explicit
// browser surface (which are checked separately).
const WEB_OBJECT =
  /(?:页面|网页|帖子|笔记|视频|短视频|评论|博主|主页|账号|feed|信息流|图集|动态|作品|话题|标签)/

const BATCH_CONTENT_OBJECT =
  /(?:笔记|帖子|作品|动态|短视频|视频|图集|内容|页面|卡片|列表|信息流|feed)/

const BATCH_SCOPE_SIGNAL =
  /(?:每篇|逐篇|一篇篇|逐个|每个|全部|所有|全量|批量|多篇|多条|主页|账号|博主|列表|信息流|feed|冻结目标清单|后台采集|逐篇采集)/

// Strong document signals that should keep the turn in document mode even when
// it mentions images/downloads (avoids mis-exposing browser on doc tasks).
const STRONG_DOCUMENT_SIGNAL =
  /(?:@\[[^\]]*\.(?:md|markdown|txt|docx?|pdf)\]|widget|show-widget|当前文档|这篇文档|文稿|原文|段落|章节|大纲|改写|润色|排版|格式化|插入到文档|写入文档|追加到文档|markdown)/i

/**
 * True when the message expresses browser collection/download intent on a web
 * or platform surface, and is not a document-anchored task. (plan §4.1)
 */
export function resolveBrowserCollectionIntent(text: string | null | undefined): boolean {
  const t = String(text || '')
  if (!t.trim()) return false

  const hasPlatform = PLATFORM_PATTERN.test(t)
  const hasExplicitBrowser = EXPLICIT_BROWSER_SURFACE.test(t)
  const hasCollectionOnWeb = COLLECTION_VERB.test(t) && WEB_OBJECT.test(t)

  // Document signal wins ONLY when there is no platform/explicit-browser surface.
  // "把小红书的图保存到文档" still exposes browser (platform present); "把这张图
  // 保存到 @[x.md]" does not.
  if (STRONG_DOCUMENT_SIGNAL.test(t) && !hasPlatform && !hasExplicitBrowser) {
    return false
  }

  return hasPlatform || hasExplicitBrowser || hasCollectionOnWeb
}

export function resolveBrowserBatchCollectionIntent(text: string | null | undefined): boolean {
  const t = String(text || '')
  if (!resolveBrowserCollectionIntent(t)) return false
  return (
    (BATCH_SCOPE_SIGNAL.test(t) && BATCH_CONTENT_OBJECT.test(t))
    || /(?:主页|账号|博主|这个号).{0,32}(?:笔记|帖子|作品|动态|短视频|视频|内容)/i.test(t)
    || /(?:笔记|帖子|作品|动态|短视频|视频|内容).{0,32}(?:每篇|逐篇|全部|所有|全量|批量|多篇|多条)/i.test(t)
  )
}

/** Platform pattern reused by the execution-layer high-control policy (§4.4). */
export function isHighControlPlatformText(text: string | null | undefined): boolean {
  return PLATFORM_PATTERN.test(String(text || ''))
}

const BARE_CONTINUATION_PATTERN =
  /(?:继续|接着|接续|重试|再试|再来|再跑|再采|go on|continue|retry|keep going|try again|resume|carry on)/i

/**
 * True when the instruction is just a short "continue / retry" follow-up
 * ("继续" / "重试一下" / "再试一次") with no task content of its own.
 *
 * @deprecated S4-1 — runtime exposure decisions now go through
 * `shared/agent-followup-intent.ts` (four-way classifier with negation guard
 * and status-question coverage). Kept only for legacy callers/tests.
 */
export function isBareContinuationInstruction(text: string | null | undefined): boolean {
  const t = String(text || '').trim()
  if (!t || t.length > 24) return false
  return BARE_CONTINUATION_PATTERN.test(t)
}

/**
 * Per-session collection-intent TTL step (continuity across follow-up turns).
 * A turn that expresses intent refreshes the TTL to `ttlTurns`; otherwise it
 * decays by one. `recent` is true when this turn — or a recent turn within the
 * window — had intent, so a bare follow-up ("再试一次") keeps the tools exposed
 * until the window decays to zero. Pure — the caller owns the per-session map.
 */
export function stepCollectionIntentTtl(
  priorTtl: number,
  currentHasIntent: boolean,
  ttlTurns: number,
): { recent: boolean; nextTtl: number } {
  const recent = priorTtl > 0 || currentHasIntent
  const nextTtl = currentHasIntent ? ttlTurns : Math.max(0, priorTtl - 1)
  return { recent, nextTtl }
}

export { PLATFORM_PATTERN as HIGH_CONTROL_PLATFORM_PATTERN }
