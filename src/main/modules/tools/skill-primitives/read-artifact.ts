/**
 * Handler for `skill_read_artifact`. Reads up to `maxBytes` from the per-skill
 * artifact root. Truncation is explicit in the structured payload so the LLM
 * can tell when it only saw a prefix. Missing file surfaces as a structured
 * ToolDomainError('not_found', …) by way of the dispatch layer.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tool-error-metrics'
import { PathSandboxError, resolveReadableWithinAnyRoot } from './path-sandbox'
import { defaultLookupSkillRoots, type LookupSkillRoots } from './root-resolver'

const DEFAULT_MAX_BYTES = 32_768
const HARD_CAP_BYTES = 1_048_576

export interface ReadArtifactArgs {
  relativePath: string
  maxBytes?: number
}

export interface ReadArtifactHandlerDeps {
  skillId: string
  lookupSkillRoots?: LookupSkillRoots
  /**
   * Stage 5 — additional read-only roots beyond the per-skill `artifactRoot`,
   * derived from the active TurnFrame skill slice (current task `outputDir`,
   * parent dir of `runStatePath`, etc.). Allows the LLM to read live task
   * artifacts that live outside `<outputsRoot>/<skillId>/` without falling
   * back to `skill_run_shell cat`. The primary artifact root is always tried
   * first so existing relative-path semantics are preserved.
   *
   * Phase 3 (skill-child-loop) — the dispatcher in `skills-tools.ts` now
   * sources this list from `ToolRuntimeContext.activeFrame.activeArtifactRoots`
   * first (same-turn live signal), falling back to `resolveActiveSkillContext`.
   * This parameter remains the legacy plumbing surface — keep it.
   * TODO(skill-child-loop): drop fallback after child-run path is stable.
   */
  additionalAllowedReadRoots?: string[]
}

export async function executeReadArtifact(
  args: ReadArtifactArgs,
  deps: ReadArtifactHandlerDeps,
): Promise<ToolExecutionOutput> {
  const lookup = deps.lookupSkillRoots || defaultLookupSkillRoots
  const roots = lookup(deps.skillId)
  if (!roots) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_read_artifact',
      reason: 'missing_skill',
      skillId: deps.skillId || null,
    })
    throw new ToolDomainError(
      'missing_skill',
      `Skill "${deps.skillId}" is not registered; cannot resolve artifact root.`,
      { skillId: deps.skillId || null },
    )
  }

  // Build the candidate root list: per-skill artifactRoot first (existing
  // relative-path semantics keep working), then any additional read-only
  // roots declared by the active TurnFrame skill slice.
  const additionalRoots = Array.isArray(deps.additionalAllowedReadRoots)
    ? deps.additionalAllowedReadRoots.filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    : []
  const candidateRoots = [roots.artifactRoot, ...additionalRoots]

  let absPath: string
  try {
    absPath = resolveReadableWithinAnyRoot(candidateRoots, args.relativePath)
  } catch (error) {
    if (error instanceof PathSandboxError) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_read_artifact',
        reason: error.reason,
        relativePath: args.relativePath,
        attemptedRoots: candidateRoots,
      })
      throw new ToolDomainError(error.reason, error.message, {
        relativePath: args.relativePath,
        artifactRoot: roots.artifactRoot,
        attemptedRoots: candidateRoots,
      })
    }
    throw error
  }

  if (!existsSync(absPath)) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_read_artifact',
      reason: 'not_found',
      relativePath: args.relativePath,
    })
    throw new ToolDomainError(
      'not_found',
      `Artifact not found: ${args.relativePath}`,
      { relativePath: args.relativePath, absolutePath: absPath },
    )
  }

  const stats = statSync(absPath)
  if (!stats.isFile()) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_read_artifact',
      reason: 'not_a_file',
      relativePath: args.relativePath,
    })
    throw new ToolDomainError(
      'not_a_file',
      `Artifact path is not a regular file: ${args.relativePath}`,
      { relativePath: args.relativePath, absolutePath: absPath },
    )
  }

  const requestedMax = typeof args.maxBytes === 'number' && args.maxBytes > 0
    ? Math.min(args.maxBytes, HARD_CAP_BYTES)
    : DEFAULT_MAX_BYTES
  const totalBytes = stats.size
  const readLen = Math.min(totalBytes, requestedMax)

  const fd = openSync(absPath, 'r')
  try {
    const buf = Buffer.alloc(readLen)
    readSync(fd, buf, 0, readLen, 0)
    const text = buf.toString('utf-8')
    const truncated = totalBytes > readLen

    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveUsed, {
      primitive: 'skill_read_artifact',
      skillId: roots.skillId,
      bytesRead: readLen,
      truncated,
    })

    return createToolExecutionOutput(text, {
      shape: 'json',
      data: {
        absolutePath: absPath,
        bytesRead: readLen,
        totalBytes,
        truncated,
        content: text,
      },
    })
  } finally {
    closeSync(fd)
  }
}
