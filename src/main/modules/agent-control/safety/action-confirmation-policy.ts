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
 *   M3 — defaults to confirmation, but a persisted conversation mode or an
 *        exact object-level authorization fact may waive rules that opt in.
 *        This module still reads NO model-authored intent/approval fields.
 *   M4 — always allowed. Also the default for tools outside the first batch.
 *
 * Confirmation hygiene (05 §3.2, phase-1 subset):
 *   - Third-party content (web pages / emails / docs) never unlocks M2/M3.
 *     Nothing here consults page content, and model-asserted flags (e.g.
 *     `file_organize_apply.confirmed`) do not downgrade a mode — the model
 *     can fabricate them.
 *   - NO decision-result cache: each dispatch re-evaluates the frozen
 *     conversation mode and, where applicable, consumes one exact
 *     object-level authorization fact. A frozen call's release token stays
 *     one-shot and never crosses calls or objects.
 */

import { consumeAuthorizationFact, type AuthActionCategory } from './authorization-fact-store'
// Phase M（2026-07-05）—— 外部 MCP 工具的动态确认映射读口（静态表枚举不了
// 外部工具名；mcp/registry 无反向依赖，导入方向安全）。
import { getMcpToolAnnotations } from '../../mcp/registry'
import {
  classifyLarkCliCommand,
  isAnyLarkCliAuthCommand,
  isDelegableLarkCliOnlineWrite,
  larkCliOutboundContentValues,
} from './lark-cli-command-policy'
import {
  parseActionAuthorizationMode,
  type ActionAuthorizationMode,
} from '../../../../shared/action-authorization-mode'

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
  when?: (
    args: Record<string, unknown>,
    argsText: string,
    opts: ConfirmationGateOptions,
  ) => boolean
  reason: string
  delegatedBy?: Exclude<ActionAuthorizationMode, 'ask'>
}

interface ConfirmationGateOptions {
  scopeId?: string | null
  messageVisibilityEpoch?: number
  actionAuthorizationMode?: ActionAuthorizationMode
  larkCliExecutableVersion?: string | null
}

// M2 feature — outbound content that looks like credentials / identity data.
// Keep resource identifiers such as `file_token` out of this check; only
// actual body values are scanned for Lark CLI calls below.
const SENSITIVE_CONTENT_PATTERN =
  /密码|口令|私钥|身份证|银行卡|信用卡|passwords?|passwd|api[_-]?key|(?:app|client)[_-]?secret|private[_-]?key|(?:access|refresh|api)[_-]?token|credential|authorization\s*:\s*bearer\s+\S+|\btoken\s*[:=]\s*[A-Za-z0-9._-]{8,}|credit\s*card|cvv|passport|BEGIN\s+(?:OPENSSH\s+|RSA\s+|EC\s+)?PRIVATE\s+KEY|\bsk-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/i
const KNOWN_WRITE_TOOLS_REQUIRING_CONFIRMATION = new Set([
  'calendar_create_event', 'calendar_update_event',
  'rss_add_source',
  'feishu_calendar_create_event', 'feishu_calendar_update_event',
  'feishu_doc_create', 'feishu_doc_update',
])

function collectOutboundStringLeaves(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectOutboundStringLeaves(item, output))
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectOutboundStringLeaves(item, output))
  }
}

function collectDisplayedTextRuns(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDisplayedTextRuns(item, output))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (key === 'text' && typeof item === 'string') output.push(item)
    else collectDisplayedTextRuns(item, output)
  }
}

function feishuDisplayedContentCandidates(args: Record<string, unknown>): string[] {
  const candidates: string[] = []
  if (args.msg_type === 'post' && args.content && typeof args.content === 'object') {
    for (const locale of Object.values(args.content as Record<string, unknown>)) {
      if (!locale || typeof locale !== 'object' || Array.isArray(locale)) continue
      const record = locale as Record<string, unknown>
      const textRuns: string[] = []
      collectDisplayedTextRuns(record.content, textRuns)
      const title = typeof record.title === 'string' ? record.title : ''
      candidates.push(`${title}${textRuns.join('')}`, `${title}\n${textRuns.join('\n')}`)
    }
  }
  if (typeof args.title === 'string' && args.content !== undefined) {
    const textRuns: string[] = []
    collectDisplayedTextRuns(args.content, textRuns)
    const content = typeof args.content === 'string'
      ? args.content
      : textRuns.join('')
    candidates.push(`${args.title}${content}`, `${args.title}\n${content}`)
  }
  return candidates
}

function outboundContentCandidates(value: unknown): string[] {
  const leaves: string[] = []
  const displayedTextRuns: string[] = []
  collectOutboundStringLeaves(value, leaves)
  collectDisplayedTextRuns(value, displayedTextRuns)
  const raw = collectArgsText(value && typeof value === 'object'
    ? value as Record<string, unknown>
    : { value })
  return [
    raw,
    ...leaves,
    leaves.join(''),
    leaves.join('\n'),
    displayedTextRuns.join(''),
    displayedTextRuns.join('\n'),
    ...feishuDisplayedContentCandidates(value && typeof value === 'object'
      ? value as Record<string, unknown>
      : { value }),
  ]
}

function sensitiveLarkCliOutboundCandidates(args: Record<string, unknown>): string[] {
  const values = [
    ...larkCliOutboundContentValues(args.command),
    typeof args.stdin === 'string' ? args.stdin : '',
  ]
  return [...values, values.join(''), values.join('\n')]
}

const FIRST_BATCH_RULES: readonly ConfirmationRule[] = [
  {
    id: 'm1-lark-cli-unsupported-domain',
    designRef: '2026-08-13 Ready 专用飞书 CLI 通道 — 文档、表格、云空间与日历只读',
    mode: 'M1',
    tools: new Set(['skill_run_shell']),
    when: (args) => classifyLarkCliCommand(args.command) === 'unsupported_domain',
    reason: 'Ready 的飞书 CLI 专用通道只允许文档、表格、云空间与日历只读查询',
  },
  {
    id: 'm1-lark-cli-local-management',
    designRef: '2026-08-09 Ready 专用飞书 CLI 通道 — 禁止改写共享 CLI 身份与安装状态',
    mode: 'M1',
    tools: new Set(['skill_run_shell']),
    when: (args) => classifyLarkCliCommand(args.command) === 'local_management',
    reason: 'Ready 的飞书任务通道不得切换共享 profile、改写 CLI 配置、更新 CLI 或退出用户登录',
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
    id: 'm2-install-skill-apply',
    designRef: '2026-08-10 对话级行动授权 — 技能安装始终逐次确认',
    mode: 'M2',
    tools: new Set(['install_skill']),
    // `trustAck` only selects the write phase. It is model-authored and is
    // never evidence that the user approved the frozen source.
    when: (args) => args.trustAck === true,
    reason: '将下载、检查并安装新的 Ready 技能，必须逐次确认具体来源',
  },
  {
    id: 'm2-install-mcp-apply',
    designRef: '2026-08-10 对话级行动授权 — MCP 配置变更始终逐次确认',
    mode: 'M2',
    tools: new Set(['install_mcp_server']),
    // `confirmAck` is a phase selector, not user authority. Removing a
    // server also mutates the persisted local configuration.
    when: (args) => args.confirmAck === true || args.action === 'remove',
    reason: '将修改本机 MCP 配置并启动、重连或移除本地服务，必须逐次确认',
  },
  {
    id: 'm2-skill-patch-config',
    designRef: '2026-08-10 对话级行动授权 — 本机技能配置变更始终逐次确认',
    mode: 'M2',
    tools: new Set(['skill_patch_config']),
    reason: '将修改或删除本机技能配置，必须逐次确认具体目标和变更内容',
  },
  {
    id: 'm2-lark-cli-auth-write',
    designRef: '2026-08-10 对话级行动授权 — 认证写入始终逐次确认',
    mode: 'M2',
    tools: new Set(['skill_run_shell']),
    when: (args) => isAnyLarkCliAuthCommand(args.command)
      && classifyLarkCliCommand(args.command) === 'external_write',
    reason: '将通过飞书 CLI 写入本机授权凭据；授权时请先确认已在飞书页面完成操作',
  },
  {
    id: 'm2-sensitive-outbound',
    designRef: '2026-08-10 对话级行动授权 — 敏感内容外发始终逐次确认',
    mode: 'M2',
    tools: new Set(['skill_run_shell']),
    when: (args) => sensitiveLarkCliOutboundCandidates(args)
      .some((candidate) => SENSITIVE_CONTENT_PATTERN.test(candidate)),
    reason: '外发内容疑似包含凭据或身份敏感信息',
  },
  {
    id: 'm2-sensitive-feishu-outbound',
    designRef: '2026-08-10 对话级行动授权 — 敏感内容外发始终逐次确认',
    mode: 'M2',
    tools: new Set([
      'feishu_doc_create', 'feishu_doc_update',
      'feishu_message_send', 'feishu_message_reply',
      'feishu_calendar_create_event', 'feishu_calendar_update_event',
    ]),
    when: (args) => outboundContentCandidates(args)
      .some((candidate) => SENSITIVE_CONTENT_PATTERN.test(candidate)),
    reason: '外发内容疑似包含凭据或身份敏感信息',
  },
  {
    id: 'm2-send-im-file',
    designRef: '2026-08-10 对话级行动授权 — 本地文件外发始终逐次确认',
    mode: 'M2',
    tools: new Set(['skill_send_im_file']),
    reason: '将把本地文件发送到外部聊天，必须逐次确认',
  },
  {
    id: 'm3-lark-cli-online-write',
    designRef: '2026-08-10 对话级行动授权 — 普通在线文档写入可由 Ready 代决',
    mode: 'M3',
    tools: new Set(['skill_run_shell']),
    when: (args, _argsText, opts) => isDelegableLarkCliOnlineWrite(
      args.command,
      args.stdin,
      opts.larkCliExecutableVersion,
    ),
    reason: '将通过飞书 CLI 修改在线文档、表格或云空间内容',
    delegatedBy: 'auto',
  },
  {
    id: 'm2-lark-cli-external-write',
    designRef: '2026-08-09 Ready 专用飞书 CLI 通道 — 高风险或本地落盘逐次确认',
    mode: 'M2',
    tools: new Set(['skill_run_shell']),
    when: (args) => classifyLarkCliCommand(args.command) === 'external_write',
    reason: '将通过飞书 CLI 执行高风险写入或本地落盘操作',
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
  // --- M2 — local file uploads are always per-call -------------------------
  {
    id: 'm2-upload-file',
    designRef: '2026-08-10 对话级行动授权 — 任意本地文件上传始终逐次确认',
    mode: 'M2',
    tools: new Set(['feishu_file_upload']),
    reason: '本地路径的内容可能在两次调用之间变化，上传必须逐次确认',
  },
  {
    id: 'm2-feishu-rich-message',
    designRef: '2026-08-10 对话级行动授权 — 无法重建显示顺序的消息逐次确认',
    mode: 'M2',
    tools: new Set(['feishu_message_send', 'feishu_message_reply']),
    when: (args) => args.msg_type !== 'text' && args.msg_type !== 'post',
    reason: '卡片或未知消息结构无法可靠重建收件人看到的完整内容，必须逐次确认',
  },
  // --- M3 — 默认确认；只有规则显式声明的对话模式或对象授权可免确认 ---------
  {
    id: 'm3-send-external',
    designRef: '05 §3.1 M3 — 对外发送普通内容',
    mode: 'M3',
    tools: new Set(['feishu_message_send', 'feishu_message_reply']),
    when: (args) => args.msg_type === 'text' || args.msg_type === 'post',
    reason: '对外发送消息会即时送达他人',
    delegatedBy: 'full',
  },
  // --- M4 — 永远放行（显式列出设计条目；其余工具走默认放行） ----------------
  {
    id: 'm4-downloads',
    designRef: '05 §3.1 M4 — 下载文件',
    mode: 'M4',
    tools: new Set([
      'browser_download',
      'browser_archive',
      'feishu_file_download',
    ]),
    reason: '下载到本地不影响外部状态',
  },
]

function actionForMode(mode: ConfirmationMode): ConfirmationGateAction {
  switch (mode) {
    case 'M1':
      return 'manual_only'
    case 'M2':
    case 'M3':
      // Default ask mode keeps M3 on the same confirmation path as M2.
      // Explicit delegation and exact object facts are handled before this
      // fallback, so callers cannot invent a separate bypass.
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
 * Resolve the confirmation gate decision for one tool dispatch. The only
 * cross-call inputs are a persisted scope mode and an exact authorization
 * fact; context/frame/model intent never authorizes an action.
 */
/** EP2-I-auth — M3 rule → action category + object ref extraction from the
 *  validated args. Null object = not consumable (fact lookup needs the
 *  object; default-deny keeps the confirm path). login rules carry no site
 *  identity in type-tool args yet — a known boundary, they stay confirm. */
const M3_RULE_CATEGORY: Record<string, AuthActionCategory> = {
  'm3-login-existing-account': 'login',
  'm3-send-external': 'send_external',
  'm3-risky-site-collection': 'collect_risky_site',
}

function m3ObjectRefOf(ruleId: string, args: Record<string, unknown>): string | null {
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
  opts: ConfirmationGateOptions = {},
): ConfirmationGateDecision {
  const argsText = collectArgsText(args)
  for (const rule of FIRST_BATCH_RULES) {
    if (!rule.tools.has(toolName)) continue
    if (rule.when && !rule.when(args, argsText, opts)) continue
    const authorizationMode = parseActionAuthorizationMode(opts.actionAuthorizationMode)
    const delegated = rule.delegatedBy === 'auto'
      ? authorizationMode === 'auto' || authorizationMode === 'full'
      : rule.delegatedBy === 'full' && authorizationMode === 'full'
    if (delegated && (rule.mode === 'M2' || rule.mode === 'M3')) {
      return {
        mode: rule.mode,
        action: 'allow',
        ruleId: rule.id,
        designRef: rule.designRef,
        reason: `${authorizationMode} 对话授权模式允许该类普通动作；其他 admission 检查照常`,
      }
    }
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
        messageVisibilityEpoch: opts.messageVisibilityEpoch,
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
  if (KNOWN_WRITE_TOOLS_REQUIRING_CONFIRMATION.has(toolName)) {
    return {
      mode: 'M2',
      action: 'confirm',
      ruleId: 'known-write-default',
      designRef: '2026-08-10 对话级行动授权 — 已知写工具默认确认',
      reason: '这是已知写操作，但没有更窄的可委托规则',
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
