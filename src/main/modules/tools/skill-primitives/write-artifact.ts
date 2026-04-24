/**
 * Handler for `skill_write_artifact`.
 *
 * Writes a string (utf-8 or base64) into the per-skill artifact root. Path
 * validation goes through `path-sandbox.ts`. The dispatch layer wraps throws
 * into ToolExecutionOutput via the tool-executor error contract (§6.11) so
 * handlers are free to surface sandbox rejections as plain throws.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tool-error-metrics'
import {
  PathSandboxError,
  assertNotReservedPath,
  resolveWithinRoot,
} from './path-sandbox'
import { defaultLookupSkillRoots, type LookupSkillRoots } from './root-resolver'

/**
 * Hard cap on bytes a single write_artifact call can emit. Protects the app
 * from a runaway LLM deciding to serialize a 10GB blob. Conservative default;
 * embedded skills that legitimately need more should split across chunks.
 */
export const WRITE_ARTIFACT_HARD_CAP_BYTES = 50 * 1024 * 1024 // 50 MB

export interface WriteArtifactArgs {
  relativePath: string
  content: string
  encoding?: 'utf-8' | 'base64'
}

export interface WriteArtifactHandlerDeps {
  skillId: string
  lookupSkillRoots?: LookupSkillRoots
}

export async function executeWriteArtifact(
  args: WriteArtifactArgs,
  deps: WriteArtifactHandlerDeps,
): Promise<ToolExecutionOutput> {
  const lookup = deps.lookupSkillRoots || defaultLookupSkillRoots
  const roots = lookup(deps.skillId)
  if (!roots) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_write_artifact',
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
    absPath = resolveWithinRoot(roots.artifactRoot, args.relativePath)
    assertNotReservedPath(absPath)
  } catch (error) {
    if (error instanceof PathSandboxError) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_write_artifact',
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

  const encoding = args.encoding || 'utf-8'
  const buffer = encoding === 'base64'
    ? Buffer.from(args.content, 'base64')
    : Buffer.from(args.content, 'utf-8')

  if (buffer.length > WRITE_ARTIFACT_HARD_CAP_BYTES) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_write_artifact',
      reason: 'size_limit',
      requestedBytes: buffer.length,
      hardCapBytes: WRITE_ARTIFACT_HARD_CAP_BYTES,
    })
    throw new ToolDomainError(
      'size_limit',
      `skill_write_artifact content exceeds hard cap (${buffer.length} > ${WRITE_ARTIFACT_HARD_CAP_BYTES} bytes).`,
      {
        relativePath: args.relativePath,
        requestedBytes: buffer.length,
        hardCapBytes: WRITE_ARTIFACT_HARD_CAP_BYTES,
      },
    )
  }

  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, buffer)

  logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveUsed, {
    primitive: 'skill_write_artifact',
    skillId: roots.skillId,
    bytes: buffer.length,
  })

  return createToolExecutionOutput(
    `Wrote ${buffer.length} bytes to ${absPath}`,
    {
      shape: 'json',
      data: {
        absolutePath: absPath,
        bytesWritten: buffer.length,
        encoding,
        artifactRoot: roots.artifactRoot,
      },
    },
  )
}
