/**
 * Handler for `skill_read_artifact`. Reads up to `maxBytes` from the per-skill
 * artifact root, active task read roots, or the skill's read-only bundled asset
 * root. Truncation is explicit in the structured payload so the LLM can tell
 * when it only saw a prefix. Missing file surfaces as a structured
 * ToolDomainError('not_found', …) by way of the dispatch layer.
 */

import { existsSync, lstatSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tools-runtime/tool-error-metrics'
import { PathSandboxError, resolveReadableWithinRoot } from './path-sandbox'
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
   * Stage M (M4+M5) — the dispatcher in `skills-tools.ts` sources this list
   * **only** from `ToolRuntimeContext.activeFrame.activeArtifactRoots`. The
   * legacy `resolveActiveSkillContext` fallback was retired after the
   * resolver seeded `frame.activeArtifactRoots` from the same paths (M0a)
   * and every framePatch emitter that carries roots also emits a matching
   * contextModifier (M5a). This parameter remains the legacy plumbing
   * surface so handlers don't need to re-resolve roots themselves.
   */
  additionalAllowedReadRoots?: string[]
  additionalAllowedReadRootKinds?: Record<string, 'sibling_asset' | 'sibling_output'>
}

interface ReadArtifactPathResolution {
  absPath: string
  matchedRoot: string
  attemptedRoots: string[]
  attemptedPaths: string[]
}

function resolveReadableExistingWithinAnyRoot(roots: string[], path: string): ReadArtifactPathResolution {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new PathSandboxError(
      'no_root_match',
      'No sandbox roots configured for read access',
    )
  }

  const attemptedRoots: string[] = []
  const attemptedPaths: string[] = []
  let firstMissingPath: string | null = null
  let lastPathEscape: PathSandboxError | null = null

  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue
    attemptedRoots.push(root)
    try {
      const candidate = resolveReadableWithinRoot(root, path)
      attemptedPaths.push(candidate)
      if (existsSync(candidate)) {
        return { absPath: candidate, matchedRoot: root, attemptedRoots, attemptedPaths }
      }
      firstMissingPath ??= candidate
    } catch (error) {
      if (error instanceof PathSandboxError && error.reason === 'path_escape') {
        lastPathEscape = error
        continue
      }
      throw error
    }
  }

  if (firstMissingPath) {
    return { absPath: firstMissingPath, matchedRoot: attemptedRoots[0] || '', attemptedRoots, attemptedPaths }
  }
  if (attemptedRoots.length <= 1 && lastPathEscape) {
    throw lastPathEscape
  }
  throw new PathSandboxError(
    'no_root_match',
    `Path ${typeof path === 'string' ? path : '(invalid)'} is not inside any of the allowed roots: ${attemptedRoots.join(', ') || '(none)'}`,
  )
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
  // relative-path semantics keep working), then any active TurnFrame read
  // roots, then the skill's read-only bundled assets (SKILL.md, references/*,
  // templates/*). Writes still resolve only against artifactRoot.
  const additionalRoots = Array.isArray(deps.additionalAllowedReadRoots)
    ? deps.additionalAllowedReadRoots.filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    : []
  const candidateRoots = Array.from(new Set([roots.artifactRoot, ...additionalRoots, roots.assetRoot]))

  let resolution: ReadArtifactPathResolution
  try {
    resolution = resolveReadableExistingWithinAnyRoot(candidateRoots, args.relativePath)
  } catch (error) {
    if (error instanceof PathSandboxError) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_read_artifact',
        reason: error.reason,
        relativePath: args.relativePath,
        attemptedRoots: candidateRoots,
      })
      // P1-a (2026-07-03) — a no_root_match on an ABSOLUTE user path (e.g. a
      // collection report the browser engine wrote to the user's authorized
      // dir) is not the skill's file to read: redirect to file_read_excerpt,
      // which honors the user's authorized roots. Keeps the sandbox intact
      // while turning a dead error into an actionable one so the agent doesn't
      // loop or mis-report a completed collection.
      const looksAbsoluteUserPath = typeof args.relativePath === 'string' && /^\/|^[A-Za-z]:[\\/]/.test(args.relativePath.trim())
      const hint = error.reason === 'no_root_match' && looksAbsoluteUserPath
        ? `${error.message}。该路径不在技能沙箱内；若是用户授权目录里的文件（如采集产物、报告），请改用 file_read_excerpt 读取，而不是 skill_read_artifact。`
        : error.message
      throw new ToolDomainError(error.reason, hint, {
        relativePath: args.relativePath,
        artifactRoot: roots.artifactRoot,
        attemptedRoots: candidateRoots,
        ...(error.reason === 'no_root_match' && looksAbsoluteUserPath ? { suggestedTool: 'file_read_excerpt' } : {}),
      })
    }
    throw error
  }

  const absPath = resolution.absPath
  if (!existsSync(absPath)) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_read_artifact',
      reason: 'not_found',
      relativePath: args.relativePath,
    })
    throw new ToolDomainError(
      'not_found',
      `Artifact not found: ${args.relativePath}`,
      {
        relativePath: args.relativePath,
        absolutePath: absPath,
        attemptedRoots: resolution.attemptedRoots,
        attemptedPaths: resolution.attemptedPaths,
      },
    )
  }

  // Stage T W7.2 — refuse to read a path that is itself a symlink, even when
  // the realpath would still land inside the sandbox. lstatSync sees the link
  // itself; statSync follows it. The path-sandbox `realpathSync` check
  // rejects symlinks pointing OUT of the sandbox, but a symlink that loops
  // back inside still bypasses the LLM's mental model of "I asked to read
  // file X" so we refuse it here.
  const requestedPath = isAbsolute(args.relativePath)
    ? args.relativePath
    : resolve(resolution.matchedRoot, args.relativePath)
  const linkStats = lstatSync(requestedPath)
  if (linkStats.isSymbolicLink()) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_read_artifact',
      reason: 'symlink_rejected',
      relativePath: args.relativePath,
    })
    throw new ToolDomainError(
      'symlink_rejected',
      `Refusing to read symlink: ${args.relativePath}`,
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
    const matchedRootKind = resolution.matchedRoot === roots.artifactRoot
      ? 'primary'
      : resolution.matchedRoot === roots.assetRoot
        ? 'asset'
        : deps.additionalAllowedReadRootKinds?.[resolution.matchedRoot] || 'sibling_output'

    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveUsed, {
      primitive: 'skill_read_artifact',
      skillId: roots.skillId,
      bytesRead: readLen,
      truncated,
      matchedRootKind,
    })

    return createToolExecutionOutput(text, {
      shape: 'json',
      data: {
        absolutePath: absPath,
        bytesRead: readLen,
        totalBytes,
        truncated,
        matchedRootKind,
        content: text,
      },
    })
  } finally {
    closeSync(fd)
  }
}
