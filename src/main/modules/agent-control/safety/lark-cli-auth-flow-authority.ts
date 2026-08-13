import { randomUUID } from 'node:crypto'

import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import {
  inspectLarkCliAuthCommand,
  inspectLarkCliAuthQrcodeCommand,
  isLarkCliEvidenceCommand,
  isMinimalLarkCliScope,
} from './lark-cli-command-policy'
import { readScopeContextEpoch } from '../session/scope-context-epoch'

const AUTH_FLOW_TTL_MS = 30 * 60 * 1000

type PendingAuthFlow = {
  messageVisibilityEpoch?: number
  deviceCode: string
  handle: string
  verificationUrl: string
  executableAuthorityDigest: string
  expiresAt: number
  expiryTimer: ReturnType<typeof setTimeout>
}

type PendingMissingScopeEvidence = {
  messageVisibilityEpoch?: number
  scopes: Set<string>
  executableAuthorityDigest: string
  expiresAt: number
  expiryTimer: ReturnType<typeof setTimeout>
}

const pendingAuthFlows = new Map<string, PendingAuthFlow>()
const pendingMissingScopeEvidence = new Map<string, PendingMissingScopeEvidence>()

function flowKey(sessionId: string, skillId: string): string {
  return `${sessionId}\u0000${skillId}`
}

function pruneExpired(now: number): void {
  for (const [key, flow] of pendingAuthFlows) {
    if (flow.expiresAt <= now) {
      clearTimeout(flow.expiryTimer)
      pendingAuthFlows.delete(key)
    }
  }
  for (const [key, evidence] of pendingMissingScopeEvidence) {
    if (evidence.expiresAt <= now) {
      clearTimeout(evidence.expiryTimer)
      pendingMissingScopeEvidence.delete(key)
    }
  }
}

function clearMissingScopeEvidence(key: string): void {
  const evidence = pendingMissingScopeEvidence.get(key)
  if (evidence) clearTimeout(evidence.expiryTimer)
  pendingMissingScopeEvidence.delete(key)
}

function parseMissingScopes(output: ToolExecutionOutput): string[] {
  const data = output.data as Record<string, unknown> | undefined
  if (typeof data?.exitCode !== 'number' || data.exitCode === 0) return []
  const candidates: string[] = []
  for (const channel of [data.stdout, data.stderr]) {
    if (typeof channel !== 'string' || channel.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(channel)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const body = parsed as Record<string, unknown>
    const error = body.error
    if (body.ok !== false || !error || typeof error !== 'object' || Array.isArray(error)) continue
    const detail = error as Record<string, unknown>
    if (detail.type !== 'authorization' || detail.subtype !== 'missing_scope') continue
    if (!Array.isArray(detail.missing_scopes) || detail.missing_scopes.length !== 1) continue
    const scope = detail.missing_scopes[0]
    if (typeof scope === 'string' && isMinimalLarkCliScope(scope)) candidates.push(scope)
  }
  return candidates.length === 1 ? candidates : []
}

function rememberMissingScopeEvidence(input: {
  sessionId: string
  skillId: string
  command: string
  output: ToolExecutionOutput
  executableAuthorityDigest: string
  now: number
  ttlMs: number
  messageVisibilityEpoch?: number
}): void {
  const durable = readScopeContextEpoch(input.sessionId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return
  if (durable.kind === 'open' && input.messageVisibilityEpoch !== durable.messageVisibilityEpoch) return
  if (!isLarkCliEvidenceCommand(input.command)) return
  const scopes = parseMissingScopes(input.output)
  if (scopes.length === 0) return
  const key = flowKey(input.sessionId, input.skillId)
  clearMissingScopeEvidence(key)
  const expiresAt = input.now + input.ttlMs
  const expiryTimer = setTimeout(() => {
    if (pendingMissingScopeEvidence.get(key)?.expiresAt === expiresAt) pendingMissingScopeEvidence.delete(key)
  }, input.ttlMs)
  expiryTimer.unref?.()
  pendingMissingScopeEvidence.set(key, {
    ...(durable.kind === 'open'
      ? { messageVisibilityEpoch: durable.messageVisibilityEpoch }
      : Number.isSafeInteger(input.messageVisibilityEpoch)
        ? { messageVisibilityEpoch: input.messageVisibilityEpoch }
        : {}),
    scopes: new Set(scopes),
    executableAuthorityDigest: input.executableAuthorityDigest,
    expiresAt,
    expiryTimer,
  })
}

function hasMatchingMissingScopeEvidence(input: {
  sessionId: string
  skillId: string
  scope: string
  executableAuthorityDigest: string
  now: number
  messageVisibilityEpoch?: number
}): boolean {
  const durable = readScopeContextEpoch(input.sessionId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return false
  if (durable.kind === 'open' && input.messageVisibilityEpoch !== durable.messageVisibilityEpoch) return false
  pruneExpired(input.now)
  const evidence = pendingMissingScopeEvidence.get(flowKey(input.sessionId, input.skillId))
  return Boolean(
    evidence
    && evidence.expiresAt > input.now
    && (durable.kind !== 'open' || evidence.messageVisibilityEpoch === durable.messageVisibilityEpoch)
    && evidence.executableAuthorityDigest === input.executableAuthorityDigest
    && evidence.scopes.has(input.scope),
  )
}

function replaceSensitiveValue(value: unknown, sensitive: string, handle: string): unknown {
  if (typeof value === 'string') return value.split(sensitive).join(handle)
  if (Array.isArray(value)) return value.map((item) => replaceSensitiveValue(item, sensitive, handle))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, replaceSensitiveValue(item, sensitive, handle)]),
  )
}

export function redactLarkCliAuthSecret(
  output: ToolExecutionOutput,
  sensitive: string,
  handle: string,
): ToolExecutionOutput {
  return replaceSensitiveValue(output, sensitive, handle) as ToolExecutionOutput
}

function findDeviceCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeviceCode(item)
      if (found) return found
    }
    return null
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'device_code' || key === 'deviceCode') && typeof item === 'string' && item.trim()) {
      return item.trim()
    }
    const found = findDeviceCode(item)
    if (found) return found
  }
  return null
}

function findVerificationUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVerificationUrl(item)
      if (found) return found
    }
    return null
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'verification_url' || key === 'verificationUrl') && typeof item === 'string' && item.trim()) {
      const candidate = item.trim()
      try {
        const parsed = new URL(candidate)
        if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) return candidate
      } catch {
        return null
      }
    }
    const found = findVerificationUrl(item)
    if (found) return found
  }
  return null
}

export function rememberLarkCliAuthInitiation(input: {
  sessionId: string
  skillId: string
  command: string
  output: ToolExecutionOutput
  executableAuthorityDigest: string
  now?: number
  ttlMs?: number
  messageVisibilityEpoch?: number
}): ToolExecutionOutput | null {
  const durable = readScopeContextEpoch(input.sessionId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return null
  if (durable.kind === 'open' && input.messageVisibilityEpoch !== durable.messageVisibilityEpoch) return null
  if (inspectLarkCliAuthCommand(input.command)?.phase !== 'initiate') return null
  const data = input.output.data as Record<string, unknown> | undefined
  if (data?.exitCode !== 0 || typeof data.stdout !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data.stdout)
  } catch {
    return null
  }
  const deviceCode = findDeviceCode(parsed)
  const verificationUrl = findVerificationUrl(parsed)
  if (!deviceCode || !verificationUrl) return null
  const now = input.now ?? Date.now()
  pruneExpired(now)
  const handle = `ready-lark-auth-${randomUUID()}`
  const key = flowKey(input.sessionId, input.skillId)
  const previous = pendingAuthFlows.get(key)
  if (previous) clearTimeout(previous.expiryTimer)
  const ttlMs = input.ttlMs ?? AUTH_FLOW_TTL_MS
  const expiryTimer = setTimeout(() => {
    if (pendingAuthFlows.get(key)?.handle === handle) pendingAuthFlows.delete(key)
  }, ttlMs)
  expiryTimer.unref?.()
  pendingAuthFlows.set(key, {
    ...(durable.kind === 'open'
      ? { messageVisibilityEpoch: durable.messageVisibilityEpoch }
      : Number.isSafeInteger(input.messageVisibilityEpoch)
        ? { messageVisibilityEpoch: input.messageVisibilityEpoch }
        : {}),
    deviceCode,
    handle,
    verificationUrl,
    executableAuthorityDigest: input.executableAuthorityDigest,
    expiresAt: now + ttlMs,
    expiryTimer,
  })
  return redactLarkCliAuthSecret(input.output, deviceCode, handle)
}

export function consumeLarkCliAuthCompletion(input: {
  sessionId: string
  skillId: string
  command: string
  executableAuthorityDigest: string
  now?: number
  messageVisibilityEpoch?: number
}): string | null {
  const durable = readScopeContextEpoch(input.sessionId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return null
  if (durable.kind === 'open' && input.messageVisibilityEpoch !== durable.messageVisibilityEpoch) return null
  const authCommand = inspectLarkCliAuthCommand(input.command)
  if (authCommand?.phase !== 'complete') return null
  const key = flowKey(input.sessionId, input.skillId)
  const pending = pendingAuthFlows.get(key)
  if (!pending) return null
  if (durable.kind === 'open' && pending.messageVisibilityEpoch !== durable.messageVisibilityEpoch) return null
  const now = input.now ?? Date.now()
  pruneExpired(now)
  if (pending.expiresAt <= now) {
    clearTimeout(pending.expiryTimer)
    pendingAuthFlows.delete(key)
    return null
  }
  if (pending.handle !== authCommand.deviceCode) {
    return null
  }
  if (pending.executableAuthorityDigest !== input.executableAuthorityDigest) return null
  clearTimeout(pending.expiryTimer)
  pendingAuthFlows.delete(key)
  return pending.deviceCode
}

function hasMatchingLarkCliAuthQrcodeFlow(input: {
  sessionId: string
  skillId: string
  verificationUrl: string
  executableAuthorityDigest: string
  now: number
  messageVisibilityEpoch?: number
}): boolean {
  const durable = readScopeContextEpoch(input.sessionId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return false
  if (durable.kind === 'open' && input.messageVisibilityEpoch !== durable.messageVisibilityEpoch) return false
  pruneExpired(input.now)
  const pending = pendingAuthFlows.get(flowKey(input.sessionId, input.skillId))
  return Boolean(
    pending
    && pending.expiresAt > input.now
    && (durable.kind !== 'open' || pending.messageVisibilityEpoch === durable.messageVisibilityEpoch)
    && pending.verificationUrl === input.verificationUrl
    && pending.executableAuthorityDigest === input.executableAuthorityDigest,
  )
}

export type LarkCliAuthorizedExecutionResult =
  | { ok: true; output: ToolExecutionOutput }
  | { ok: false; errorKind: 'authorization_denied' | 'program_failed'; message: string }

export async function executeLarkCliCommandWithAuthAuthority(input: {
  sessionId: string | null
  skillId: string
  command: string
  executableAuthorityDigest: string
  execute: (command: string) => Promise<ToolExecutionOutput>
  now?: number
  ttlMs?: number
  messageVisibilityEpoch?: number
}): Promise<LarkCliAuthorizedExecutionResult> {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? AUTH_FLOW_TTL_MS
  const sessionId = input.sessionId
  const authCommand = inspectLarkCliAuthCommand(input.command)
  const qrcodeCommand = inspectLarkCliAuthQrcodeCommand(input.command)
  if (authCommand?.phase === 'blocking') {
    return {
      ok: false,
      errorKind: 'authorization_denied',
      message: '飞书 CLI 授权命令不符合专用通道的固定格式。',
    }
  }
  if (authCommand?.phase === 'initiate') {
    if (!sessionId || !hasMatchingMissingScopeEvidence({
      sessionId,
      skillId: input.skillId,
      scope: authCommand.scope,
      executableAuthorityDigest: input.executableAuthorityDigest,
      now,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
    })) {
      return {
        ok: false,
        errorKind: 'authorization_denied',
        message: '飞书 CLI 只能申请上一条真实文档命令明确报告缺失的单一最小权限。请先执行目标只读或 dry-run 命令。',
      }
    }
  }
  if (
    qrcodeCommand
    && (
      !sessionId
      || !qrcodeCommand.verificationUrl
      || !hasMatchingLarkCliAuthQrcodeFlow({
        sessionId,
        skillId: input.skillId,
        verificationUrl: qrcodeCommand.verificationUrl,
        executableAuthorityDigest: input.executableAuthorityDigest,
        now,
        messageVisibilityEpoch: input.messageVisibilityEpoch,
      })
    )
  ) {
    return {
      ok: false,
      errorKind: 'authorization_denied',
      message: '飞书 CLI 只能展示当前 Ready 会话刚刚发起的同一份授权二维码。请重新发起授权。',
    }
  }

  let executionCommand = input.command
  let authDeviceCode: string | null = null
  if (authCommand?.phase === 'complete') {
    const deviceCode = sessionId && consumeLarkCliAuthCompletion({
      sessionId,
      skillId: input.skillId,
      command: input.command,
      executableAuthorityDigest: input.executableAuthorityDigest,
      now,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
    })
    if (!deviceCode) {
      return {
        ok: false,
        errorKind: 'authorization_denied',
        message: '飞书 CLI 授权完成请求必须来自当前会话上一轮发起的同一份授权。请重新发起授权并等待用户确认。',
      }
    }
    executionCommand = input.command.replace(authCommand.deviceCode, deviceCode)
    authDeviceCode = deviceCode
  }

  let output = await input.execute(executionCommand)
  if (authCommand?.phase === 'complete' && authDeviceCode) {
    output = redactLarkCliAuthSecret(output, authDeviceCode, authCommand.deviceCode)
  } else if (authCommand?.phase === 'initiate') {
    if (!sessionId) {
      return {
        ok: false,
        errorKind: 'authorization_denied',
        message: '飞书 CLI 分步授权必须绑定当前 Ready 会话。',
      }
    }
    const safeOutput = rememberLarkCliAuthInitiation({
      sessionId,
      skillId: input.skillId,
      command: input.command,
      output,
      executableAuthorityDigest: input.executableAuthorityDigest,
      now,
      ttlMs,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
    })
    if (!safeOutput) {
      return {
        ok: false,
        errorKind: 'program_failed',
        message: '飞书 CLI 未返回可继续的分步授权信息，不能进入凭据写入阶段。',
      }
    }
    clearMissingScopeEvidence(flowKey(sessionId, input.skillId))
    output = safeOutput
  } else if (sessionId) {
    clearMissingScopeEvidence(flowKey(sessionId, input.skillId))
    rememberMissingScopeEvidence({
      sessionId,
      skillId: input.skillId,
      command: input.command,
      output,
      executableAuthorityDigest: input.executableAuthorityDigest,
      now,
      ttlMs,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
    })
  }
  return { ok: true, output }
}

export function clearLarkCliAuthFlowsForTests(): void {
  for (const flow of pendingAuthFlows.values()) clearTimeout(flow.expiryTimer)
  pendingAuthFlows.clear()
  for (const evidence of pendingMissingScopeEvidence.values()) clearTimeout(evidence.expiryTimer)
  pendingMissingScopeEvidence.clear()
}

export function clearLarkCliAuthFlowsForSession(sessionId: string): void {
  const prefix = `${String(sessionId || '').trim()}\u0000`
  if (prefix === '\u0000') return
  for (const [key, flow] of pendingAuthFlows) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(flow.expiryTimer)
    pendingAuthFlows.delete(key)
  }
  for (const [key, evidence] of pendingMissingScopeEvidence) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(evidence.expiryTimer)
    pendingMissingScopeEvidence.delete(key)
  }
}

export function getPendingLarkCliAuthFlowCountForTests(): number {
  return pendingAuthFlows.size
}

export function getPendingLarkCliMissingScopeEvidenceCountForTests(): number {
  return pendingMissingScopeEvidence.size
}

export function getPendingLarkCliMissingScopeEvidenceForTests(
  sessionId: string,
  skillId: string,
): { scopes: string[]; executableAuthorityDigest: string; expiresAt: number } | null {
  const evidence = pendingMissingScopeEvidence.get(flowKey(sessionId, skillId))
  return evidence
    ? {
        scopes: [...evidence.scopes],
        executableAuthorityDigest: evidence.executableAuthorityDigest,
        expiresAt: evidence.expiresAt,
      }
    : null
}
