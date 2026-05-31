/**
 * Handler for the `install_skill` agent tool (capability group `skill_install`).
 *
 * Two-phase, confirm-gated, single-pipeline remote skill install — the agent
 * front door that mirrors the SkillsCenterPanel URL front door. Both funnel
 * into the manager's single installer, which enforces `trustAck === true`.
 *
 *   Phase 1 (no trustAck): `{ instruction }` → manager.resolveSkillSource → a
 *     read-only descriptor with concrete risk reasons. NEVER installs. The model
 *     is told (via the tool description) to surface those risks through
 *     `ask_user_questions` and obtain explicit user approval.
 *   Phase 2 (trustAck:true): `{ source, trustAck:true }` echoed back after the
 *     user approved → manager.installSkillFromSource. The echoed source mirrors
 *     how the renderer front door carries its resolved `source` back; the host
 *     still gates on `trustAck`.
 *
 * Electron-free + injectable so it runs under `tsx --test`: the manager is
 * passed in via deps (the executor wires `getSkillsRuntimeManager()`).
 */

import { randomUUID } from 'node:crypto'

import type {
  ModelSource,
  SkillInstallProvenance,
  SkillInstallRequest,
  SkillInstallStatus,
  SkillSource,
  SkillSourceResolution,
} from '../../../../shared/skill-source-types'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../tool-errors'

// Structurally satisfied by the real SkillsRuntimeManager. Kept narrow so the
// handler depends only on the two methods it calls and stays test-injectable.
export interface InstallSkillManagerLike {
  resolveSkillSource(input: string, options?: { requestId?: string }): Promise<SkillSourceResolution>
  installSkillFromSource(request: SkillInstallRequest): Promise<SkillInstallStatus>
}

export interface InstallSkillDeps {
  manager: InstallSkillManagerLike
}

export interface InstallSkillArgs {
  instruction?: unknown
  source?: unknown
  downloadSource?: unknown
  provenance?: unknown
  requestId?: unknown
  trustAck?: unknown
}

function normalizeModelSource(value: unknown): ModelSource | undefined {
  return value === 'auto' || value === 'domestic' || value === 'overseas' ? value : undefined
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

// Defensively reconstruct a typed SkillSource from the model-echoed object.
// Returns null when the shape is unusable so phase 2 fails loudly instead of
// installing something underspecified.
function normalizeEchoedSource(value: unknown): SkillSource | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.kind === 'github') {
    const owner = asTrimmedString(raw.owner)
    const repo = asTrimmedString(raw.repo)
    if (!owner || !repo) return null
    const ref = asTrimmedString(raw.ref)
    const subdir = asTrimmedString(raw.subdir)
    return {
      kind: 'github',
      owner,
      repo,
      ...(ref ? { ref } : {}),
      ...(subdir ? { subdir } : {}),
    }
  }
  if (raw.kind === 'tarball') {
    const url = asTrimmedString(raw.url)
    if (!url || !/^https?:\/\//i.test(url)) return null
    const sha256 = asTrimmedString(raw.sha256)
    return { kind: 'tarball', url, ...(sha256 ? { sha256 } : {}) }
  }
  return null
}

function normalizeProvenance(value: unknown): SkillInstallProvenance | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const commitSha = asTrimmedString(raw.commitSha)
  const sha256 = asTrimmedString(raw.sha256)
  if (!commitSha && !sha256) return null
  return {
    ...(commitSha ? { commitSha } : {}),
    ...(sha256 ? { sha256 } : {}),
  }
}

function describeSource(source: SkillSource | null): string {
  if (!source) return '（未解析出来源）'
  if (source.kind === 'github') {
    const base = `GitHub ${source.owner}/${source.repo}`
    const ref = source.ref ? `@${source.ref.slice(0, 12)}` : ''
    const sub = source.subdir ? ` 子目录 ${source.subdir}` : ''
    return `${base}${ref}${sub}`
  }
  if (source.kind === 'tarball') return `压缩包 ${source.url}`
  return 'registry 来源'
}

export async function executeInstallSkill(
  args: InstallSkillArgs,
  deps: InstallSkillDeps,
): Promise<ToolExecutionOutput> {
  const manager = deps.manager
  const trustAck = args.trustAck === true

  // ---- Phase 2: confirmed install -----------------------------------------
  if (trustAck) {
    const source = normalizeEchoedSource(args.source)
    if (!source) {
      throw new ToolDomainError(
        'input_validation',
        '带 trustAck 的安装阶段缺少有效的 source；请先用阶段 1（只传 instruction）解析，并把返回的 source 原样回传。',
      )
    }
    const request: SkillInstallRequest = {
      requestId: asTrimmedString(args.requestId) ?? randomUUID(),
      source,
      downloadSource: normalizeModelSource(args.downloadSource),
      trustAck: true,
      provenance: normalizeProvenance(args.provenance),
    }
    const status = await manager.installSkillFromSource(request)
    const installed = status.phase === 'done'
    const text = installed
      ? `已安装技能：${status.skillId ?? '(未知 id)'}（来源：${describeSource(source)}）`
      : `安装未完成（阶段：${status.phase}）${status.error ? `：${status.error}` : ''}`
    return createToolExecutionOutput(text, {
      shape: 'json',
      data: {
        installed,
        phase: status.phase,
        skillId: status.skillId,
        license: status.license,
        requiresPython: status.requiresPython,
        error: status.error,
        lastMessage: status.lastMessage,
      },
    })
  }

  // ---- Phase 1: read-only resolve (NEVER installs) ------------------------
  const instruction = asTrimmedString(args.instruction)
  if (!instruction) {
    throw new ToolDomainError(
      'input_validation',
      '解析阶段需要 instruction（用户的安装诉求或 GitHub/.tar.gz 链接）。',
    )
  }

  const resolution = await manager.resolveSkillSource(instruction)
  const reasons = resolution.risk.reasons
  const nextStep = !resolution.installable
    ? '该来源不可安装，请把 reason 告知用户并停止，不要进入安装阶段。'
    : '请用 ask_user_questions 把 riskReasons 的每条 detail 讲清楚再让用户决定；用户明确同意后，再用 install_skill({ source, trustAck:true }) 回传 source 完成安装。'

  const riskLine = reasons.length
    ? `风险（${resolution.risk.tier}）：${reasons.map((r) => r.detail).join('；')}`
    : `风险等级：${resolution.risk.tier}（未发现具体风险项）`
  const text = [
    `已只读解析（未安装）。来源：${describeSource(resolution.source)}`,
    riskLine,
    resolution.license ? `许可证：${resolution.license}` : null,
    `下一步：${nextStep}`,
  ].filter(Boolean).join('\n')

  return createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      needsConfirmation: true,
      installable: resolution.installable,
      reason: resolution.reason,
      requestId: resolution.requestId,
      source: resolution.source,
      provenance: resolution.provenance,
      riskTier: resolution.risk.tier,
      riskReasons: reasons,
      requiresPython: resolution.requiresPython,
      license: resolution.license,
      viaInstallDoc: resolution.viaInstallDoc,
      candidates: resolution.candidates,
      nextStep,
    },
  })
}
