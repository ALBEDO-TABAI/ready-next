/**
 * EP1-I3-1 — Action confirmation policy (四态闸门首批静态表).
 *
 * Design source: docs/agent-evolution/05-意图理解与行动确认设计明细.md §3.1/§3.2.
 * Contract:      docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md (EP1-I3-1).
 *
 * Static mapping `tool name + argument feature → confirmation mode`,
 * consulted by the dispatch gate in tool-executor.ts AFTER all admission
 * checks (registration / authorization / internal visibility / allowlist /
 * input validation):
 *
 *   M1 — the user must perform the action by hand; the agent refuses and
 *        guides (05 §3.1: 改密码最终提交 / 绕过验证码、安全拦截页 / 支付最终确认).
 *   M2 — confirm before EVERY execution; pre-approval can never waive it.
 *   M3 — pre-approval COULD waive the confirmation, but the object-level
 *        authorization fact it requires (工单 I-auth, 阶段二) does not exist
 *        yet, so phase 1 degrades M3 to the SAME confirm path as M2 — see
 *        actionForMode(). This module reads NO intent fields: TurnFrame's
 *        start/continue/check/cancel is too coarse to prove "user approved
 *        THIS action on THIS object" (Codex review P1#1).
 *   M4 — always allowed. Also the default for tools outside the first batch.
 *
 * Confirmation hygiene (05 §3.2, phase-1 subset):
 *   - Third-party content (web pages / emails / docs) never unlocks M2/M3.
 *     Nothing here consults page content, and model-asserted flags (e.g.
 *     `file_organize_apply.confirmed`) do not downgrade a mode — the model
 *     can fabricate them.
 *   - NO confirmation caching in phase 1: this resolver is a pure function
 *     of (toolName, args) with zero session/object memory, so the same hit
 *     resolves to `confirm` every time. The only reusable artifact is a
 *     single frozen call's one-shot release token (I3-2), which is scoped
 *     to that one frozen call — never across calls or objects.
 */

import { consumeAuthorizationFact, type AuthActionCategory } from './authorization-fact-store'
// Phase M（2026-07-05）—— 外部 MCP 工具的动态确认映射读口（静态表枚举不了
// 外部工具名；mcp/registry 无反向依赖，导入方向安全）。
import { getMcpToolAnnotations } from '../../mcp/registry'

export type ConfirmationMode = 'M1' | 'M2' | 'M3' | 'M4'

export type ConfirmationGateAction = 'manual_only' | 'confirm' | 'allow'

export interface ConfirmationGateDecision {
  mode: ConfirmationMode
  action: ConfirmationGateAction
  ruleId: string
  /** 05 §3.1 design row the rule implements — keeps table ↔ design 一一对应. */
  designRef: string
  reason: string
}

interface ConfirmationRule {
  id: string
  designRef: string
  mode: ConfirmationMode
  tools: ReadonlySet<string>
  /** Argument-feature predicate; absent = the rule matches unconditionally. */
  when?: (args: Record<string, unknown>, argsText: string) => boolean
  reason: string
}

// Browser interaction tools that can press/submit things on a page.
// `browser_act_on_target` is in BOTH sets: its action enum spans
// click/expand/choose AND fill — a payment confirm or password fill routed
// through a page-map target id must hit the same rules as the plain
// click/type tools (textual cues come from value/disambiguation, the same
// trust level as click_text's text argument).
const CLICK_TOOLS = ['browser_click', 'browser_click_text', 'browser_click_at', 'browser_act_on_target'] as const

// Browser destructive target patterns. The browser execution layer uses them
// as code-owned destructive anchors and returns grant_required unless a future
// Power grant matches the target.
const PAYMENT_FINAL_PATTERN =
  /确认支付|立即支付|确认付款|立即付款|提交订单|确认下单|确认转账|pay\s*now|confirm\s*(payment|purchase|order)|place\s*order/i
// Final submit of a password/credential change.
const PASSWORD_CHANGE_FINAL_PATTERN =
  /确认修改密码|保存新密码|确认新密码|提交新密码|(confirm|save|submit)\s*new\s*password|update\s*password/i
// Captcha / human-verification interaction.
const CAPTCHA_PATTERN =
  /验证码|滑块|人机验证|安全验证|captcha|recaptcha|hcaptcha|verification\s*code/i
// M4 carve-out — cookie consent clicks.
const COOKIE_CONSENT_PATTERN =
  /cookie|接受所有|全部接受|仅必要|accept\s*all|reject\s*all|only\s*necessary/i
// M2 feature — outbound content that looks like credentials / identity data.
const SENSITIVE_CONTENT_PATTERN =
  /密码|口令|私钥|身份证|银行卡|信用卡|passwords?|passwd|api[_-]?key|secret|token|credential|credit\s*card|cvv|passport/i
// Password-field cue detection for browser execution-layer password fills.
const PASSWORD_FIELD_PATTERN = /password|passwd|密码/i

const FIRST_BATCH_RULES: readonly ConfirmationRule[] = [
  // --- M4 carve-outs ------------------------------------------------------
  {
    id: 'm4-cookie-consent',
    designRef: '05 §3.1 M4 — Cookie 同意',
    mode: 'M4',
    tools: new Set(CLICK_TOOLS),
    when: (_args, text) =>
      COOKIE_CONSENT_PATTERN.test(text) && !PAYMENT_FINAL_PATTERN.test(text),
    reason: 'Cookie 同意属常规页面疏通操作',
  },
  // --- M2 — 每次执行前确认，预批准无效 -------------------------------------
  {
    id: 'm2-run-setup-command',
    designRef: '2026-07-13 CLI 授权桥接 — 本机命令执行',
    mode: 'M2',
    tools: new Set(['run_setup_command']),
    // `confirmAck` is only the tool's phase selector. It is model-authored
    // input and therefore cannot prove that the user approved this command.
    when: (args) => args.confirmAck === true,
    reason: '将在本机执行安装或配置命令，可能下载代码或修改本机环境',
  },
  {
    id: 'm2-delete-data',
    designRef: '05 §3.1 M2 — 删除文件/数据',
    mode: 'M2',
    tools: new Set(['calendar_delete_event', 'feishu_calendar_delete_event']),
    reason: '删除用户数据不可逆',
  },
  {
    id: 'm2-overwrite-existing-file',
    designRef: '05 §3.1 M2 — 删除文件/数据（overwrite=true 即销毁目标文件）',
    mode: 'M2',
    // W10-F6（2026-07-11 dogfood）：skill_export_artifact 带 overwrite=true 可在
    // workspaceRoots 白名单内无确认整文件覆写用户文档（正门 document 工具重重设防、
    // 侧门导出一路绿灯的失衡写面），并入同一"覆盖即销毁"确认规则。
    tools: new Set(['file_rename', 'file_move', 'skill_export_artifact']),
    when: (args) => args.overwrite === true,
    reason: '覆盖已有文件会销毁其当前内容',
  },
  {
    id: 'm2-batch-irreversible-apply',
    designRef: '05 §3.1 M2 — 批量不可逆操作（>N 项移动）',
    mode: 'M2',
    // `confirmed`/`confirmedVia` are model-asserted arguments — they are NOT
    // user-confirmation evidence and never downgrade this rule (确认卫生).
    tools: new Set(['file_organize_apply']),
    reason: '批量文件整理一次落盘多项移动',
  },
  {
    id: 'm2-send-sensitive',
    designRef: '05 §3.1 M2 — 对外发送含敏感数据',
    mode: 'M2',
    tools: new Set(['feishu_message_send', 'feishu_message_reply']),
    when: (_args, text) => SENSITIVE_CONTENT_PATTERN.test(text),
    reason: '外发内容疑似包含凭据或身份敏感信息',
  },
  // --- M3 — 预批准有效（阶段一无 I-auth，一律降级走确认卡） -----------------
  {
    id: 'm3-upload-file',
    designRef: '05 §3.1 M3 — 上传指定文件',
    mode: 'M3',
    tools: new Set(['feishu_file_upload']),
    reason: '把本地文件上传到外部系统',
  },
  {
    id: 'm3-send-external',
    designRef: '05 §3.1 M3 — 对外发送普通内容',
    mode: 'M3',
    tools: new Set(['feishu_message_send', 'feishu_message_reply']),
    reason: '对外发送消息会即时送达他人',
  },
  // --- M4 — 永远放行（显式列出设计条目；其余工具走默认放行） ----------------
  {
    id: 'm4-downloads',
    designRef: '05 §3.1 M4 — 下载文件',
    mode: 'M4',
    tools: new Set([
      'browser_download_urls',
      'browser_download_gallery',
      'browser_download_collected_media',
      'feishu_file_download',
    ]),
    reason: '下载到本地不影响外部状态',
  },
]

// ---------------------------------------------------------------------------
// Browser live-target destructive anchors. The dispatch gate above can only
// see ARGUMENTS; page-map target_id / CSS selector / coordinates may carry no
// semantic text. Browser execution re-checks these patterns against the REAL
// element text/label and reports grant_required when a Power grant is needed.
// ---------------------------------------------------------------------------

export interface BrowserDestructiveTargetMatch {
  ruleId: string
  designRef: string
  reason: string
}

const BROWSER_DESTRUCTIVE_TARGET_RULES: ReadonlyArray<{ pattern: RegExp } & BrowserDestructiveTargetMatch> = [
  {
    pattern: PAYMENT_FINAL_PATTERN,
    ruleId: 'browser-power-payment-final',
    designRef: 'Power Browser destructive — 支付最终确认',
    reason: '支付/下单确认属于代码枚举的破坏性浏览器动作',
  },
  {
    pattern: PASSWORD_CHANGE_FINAL_PATTERN,
    ruleId: 'browser-power-password-change-final',
    designRef: 'Power Browser destructive — 改凭据最终提交',
    reason: '修改密码/凭据属于代码枚举的破坏性浏览器动作',
  },
  {
    pattern: CAPTCHA_PATTERN,
    ruleId: 'browser-power-access-control-interaction',
    designRef: 'Power Browser destructive — 访问控制/安全检查交互',
    reason: '验证码/安全检查/访问控制交互需要单独授权与审计',
  },
]

/** Match the REAL element text/label against the browser destructive target list. */
export function matchBrowserDestructiveTarget(targetText: string | null | undefined): BrowserDestructiveTargetMatch | null {
  const text = String(targetText || '')
  if (!text) return null
  for (const rule of BROWSER_DESTRUCTIVE_TARGET_RULES) {
    if (rule.pattern.test(text)) {
      const { pattern: _pattern, ...match } = rule
      return match
    }
  }
  return null
}

/**
 * Regex sources for embedding the same destructive target semantics into in-page scripts
 * (browser_click's single-roundtrip click script). Single pattern source —
 * the in-page copy is generated from these, never hand-written.
 */
export const BROWSER_DESTRUCTIVE_TARGET_REGEX_SOURCES: readonly string[] =
  BROWSER_DESTRUCTIVE_TARGET_RULES.map((rule) => rule.pattern.source)

/**
 * True when the call's own arguments already carry a password cue — meaning
 * the dispatch gate upstream classified it (m3-login) and the call only
 * reached execution through the confirm→release path (or a host invoker).
 * The browser-layer password net uses this to stay loop-free: cue present →
 * proceed; cue absent but live target IS a password field → refuse with
 * reroute guidance.
 */
export function argsCarryPasswordCue(argsText: string): boolean {
  return PASSWORD_FIELD_PATTERN.test(argsText)
}

function actionForMode(mode: ConfirmationMode): ConfirmationGateAction {
  switch (mode) {
    case 'M1':
      return 'manual_only'
    case 'M2':
    case 'M3':
      // Phase 1: M3 degrades to M2 — the I-auth object-level authorization
      // fact does not exist yet, so pre-approval cannot be proven. The
      // degradation lives HERE (not in the executor) so no caller can
      // special-case M3, and tests can pin that M2/M3 share one path.
      return 'confirm'
    case 'M4':
      return 'allow'
  }
}

function collectArgsText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? ''
  } catch {
    return ''
  }
}

/**
 * Resolve the confirmation gate decision for one tool dispatch. Pure
 * function of (toolName, args) — deliberately NO context/frame/intent
 * parameter, so a confirmation cache or intent-based pre-approval cannot
 * be wired in without changing this signature (and tripping the I3-1
 * source pin in action-confirmation-policy.test.ts).
 */
/** EP2-I-auth — M3 rule → action category + object ref extraction from the
 *  validated args. Null object = not consumable (fact lookup needs the
 *  object; default-deny keeps the confirm path). login rules carry no site
 *  identity in type-tool args yet — a known boundary, they stay confirm. */
const M3_RULE_CATEGORY: Record<string, AuthActionCategory> = {
  'm3-login-existing-account': 'login',
  'm3-upload-file': 'upload',
  'm3-send-external': 'send_external',
  'm3-risky-site-collection': 'collect_risky_site',
}

function m3ObjectRefOf(ruleId: string, args: Record<string, unknown>): string | null {
  if (ruleId === 'm3-upload-file') {
    const path = args.file_path ?? args.path ?? args.filePath
    return typeof path === 'string' && path ? path : null
  }
  if (ruleId === 'm3-send-external') {
    const target = args.chat_id ?? args.receive_id ?? args.recipient
    return typeof target === 'string' && target ? target : null
  }
  if (ruleId === 'm3-risky-site-collection') {
    const url = args.url ?? args.target_url ?? args.profile_url ?? args.target_profile_url
    return typeof url === 'string' && url ? url : null
  }
  return null // login: page identity not present in args (known boundary)
}

/** EP2-I-auth — the grant candidate a session-effective confirmation would
 *  mint for an M3 rule (null = rule has no canonical object in args; the
 *  card then offers no session-effective option). */
export function m3GrantCandidateOf(
  ruleId: string,
  args: Record<string, unknown>,
): { actionCategory: AuthActionCategory; objectRef: string } | null {
  const category = M3_RULE_CATEGORY[ruleId]
  if (!category) return null
  const objectRef = m3ObjectRefOf(ruleId, args)
  return objectRef ? { actionCategory: category, objectRef } : null
}

export function resolveConfirmationGate(
  toolName: string,
  args: Record<string, unknown>,
  opts: { scopeId?: string | null } = {},
): ConfirmationGateDecision {
  const argsText = collectArgsText(args)
  for (const rule of FIRST_BATCH_RULES) {
    if (!rule.tools.has(toolName)) continue
    if (rule.when && !rule.when(args, argsText)) continue
    // EP2-I-auth — M3 pre-approval: the ONE consumption point. M1/M2 never
    // consult; consumption skips ONLY the confirmation card — every
    // admission check before dispatch still runs (预批准 ≠ 提权).
    if (rule.mode === 'M3' && opts.scopeId) {
      const category = M3_RULE_CATEGORY[rule.id]
      const objectRef = category ? m3ObjectRefOf(rule.id, args) : null
      if (category && objectRef && consumeAuthorizationFact({
        scopeId: opts.scopeId,
        actionCategory: category,
        objectRef,
      })) {
        return {
          mode: 'M3',
          action: 'allow',
          ruleId: rule.id,
          designRef: rule.designRef,
          reason: `对象级预批准命中（${category}），免确认放行；admission 检查照常`,
        }
      }
    }
    return {
      mode: rule.mode,
      action: actionForMode(rule.mode),
      ruleId: rule.id,
      designRef: rule.designRef,
      reason: rule.reason,
    }
  }
  // Phase M（2026-07-05，调研切面 2 关键治理缺口）—— 外部 MCP 工具的动态
  // 映射：静态表天然枚举不了外部工具名，此前一律落 default-M4 无条件放行。
  // 规则：server 声明 readOnlyHint 才免确认；未声明只读的一律 M2 保守确认
  // （destructiveHint 只影响文案不影响档位）；带 mcp_ 前缀但注册表查无此名
  // 同样 M2（防御纵深——执行层会再拒 unregistered，但闸门不赌执行层）。
  if (toolName.startsWith('mcp_')) {
    const annotations = getMcpToolAnnotations(toolName)
    if (annotations?.readOnlyHint === true) {
      return {
        mode: 'M4',
        action: 'allow',
        ruleId: 'mcp-readonly-declared',
        designRef: 'Phase M §块4 — 外部工具 readOnlyHint 声明只读',
        reason: '外部 MCP 工具声明只读（readOnlyHint），按 M4 放行',
      }
    }
    return {
      mode: 'M2',
      action: 'confirm',
      ruleId: 'mcp-external-write-default',
      designRef: 'Phase M §块4 — 外部工具未声明只读默认保守确认',
      reason: annotations?.destructiveHint === true
        ? '外部 MCP 工具声明具有破坏性（destructiveHint），执行前需确认'
        : '外部 MCP 工具未声明只读，按 M2 保守确认',
    }
  }
  return {
    mode: 'M4',
    action: 'allow',
    ruleId: 'default-unlisted',
    designRef: '05 §3.1 M4 — 只读操作/未列入首批清单的工具',
    reason: '工具不在首批确认清单内，按 M4 放行',
  }
}
