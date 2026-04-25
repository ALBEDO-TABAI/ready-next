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

  let absPath: string
  try {
    absPath = resolveReadableWithinRoot(roots.artifactRoot, args.relativePath)
  } catch (error) {
    if (error instanceof PathSandboxError) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_read_artifact',
        reason: error.reason,
        relativePath: args.relativePath,
      })
      throw new ToolDomainError(error.reason, error.message, {
        relativePath: args.relativePath,
        artifactRoot: roots.artifactRoot,
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
