/**
 * Handler for `skill_write_artifact`.
 *
 * Writes a string (utf-8 or base64) into the per-skill artifact root. Path
 * validation goes through `path-sandbox.ts`. The dispatch layer wraps throws
 * into ToolExecutionOutput via the tool-executor error contract (§6.11) so
 * handlers are free to surface sandbox rejections as plain throws.
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { markSkillHandoffOutputCompleted } from '../../agent-control/skills/skill-agent-handoff'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tools-runtime/tool-error-metrics'
import {
  PathSandboxError,
  assertNotReservedPath,
  resolveWithinRoot,
  resolveWritableWithinRoot,
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
  mode?: 'overwrite' | 'append'
}

export interface WriteArtifactHandlerDeps {
  skillId: string
  lookupSkillRoots?: LookupSkillRoots
  additionalAllowedWriteTargets?: Array<{
    root: string
    relativePath: string
    receiptPath?: string
    taskName?: string
  }>
}

function firstPathSegment(relativePath: string): string | null {
  const clean = relativePath.replace(/\\/g, '/').trim()
  const first = clean.split('/').find(Boolean)
  return first || null
}

function resolveAdditionalWriteTarget(
  relativePath: string,
  targets: WriteArtifactHandlerDeps['additionalAllowedWriteTargets'],
): { absolutePath: string; target: NonNullable<WriteArtifactHandlerDeps['additionalAllowedWriteTargets']>[number] } | null {
  if (!Array.isArray(targets) || targets.length === 0) return null
  if (isAbsolute(relativePath)) return null
  const requestedNamespace = firstPathSegment(relativePath)
  const targetNamespaces = new Set<string>()
  for (const target of targets) {
    const targetNamespace = firstPathSegment(target?.relativePath || '')
    if (targetNamespace) targetNamespaces.add(targetNamespace)
    try {
      const requested = resolveWithinRoot(target.root, relativePath)
      const allowed = resolveWithinRoot(target.root, target.relativePath)
      if (requested === allowed) return { absolutePath: requested, target }
    } catch (error) {
      if (error instanceof PathSandboxError && error.reason === 'path_escape') continue
      throw error
    }
  }
  if (requestedNamespace && targetNamespaces.has(requestedNamespace)) {
    throw new PathSandboxError(
      'no_root_match',
      `Path ${relativePath} is not inside any writable skill artifact target`,
    )
  }
  return null
}

function writePathErrorMessage(error: PathSandboxError, inputPath: unknown, artifactRoot: string): string {
  const rawPath = typeof inputPath === 'string' ? inputPath.trim() : ''
  const suggestedName = basename(rawPath) || 'output.md'
  if (error.reason === 'home_path') {
    return `relativePath 不能使用 ~/ 家目录前缀。artifact 根是 ${artifactRoot}；请改用相对路径，例如 "${suggestedName}"。`
  }
  if (error.reason === 'absolute_path') {
    return `relativePath 不能是绝对路径。artifact 根是 ${artifactRoot}；请改用相对路径，例如 "${suggestedName}"。`
  }
  if (error.reason === 'path_escape' && rawPath && isAbsolute(rawPath)) {
    return `这个绝对路径不在当前 skill artifact 根内，不能直接写入。artifact 根是 ${artifactRoot}；请先写入相对路径，例如 "${suggestedName}"，如需保存到用户文件夹再导出。`
  }
  return error.message
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
  let handoffTarget: NonNullable<WriteArtifactHandlerDeps['additionalAllowedWriteTargets']>[number] | null = null
  try {
    const additionalTarget = resolveAdditionalWriteTarget(args.relativePath, deps.additionalAllowedWriteTargets)
    absPath = additionalTarget?.absolutePath || resolveWritableWithinRoot(roots.artifactRoot, args.relativePath)
    handoffTarget = additionalTarget?.target || null
    assertNotReservedPath(absPath)
  } catch (error) {
    if (error instanceof PathSandboxError) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_write_artifact',
        reason: error.reason,
        relativePath: args.relativePath,
      })
      throw new ToolDomainError(error.reason, writePathErrorMessage(error, args.relativePath, roots.artifactRoot), {
        relativePath: args.relativePath,
        artifactRoot: roots.artifactRoot,
      })
    }
    throw error
  }

  // Stage T W7.2 — refuse to OVERWRITE an existing path that is itself a
  // symlink. `path-sandbox.assertNotReservedPath` already blocked reserved
  // filenames; this gate is the symlink companion. We check with lstatSync
  // (not statSync) so we see the link itself rather than its target. Targets
  // pointing OUT of the sandbox were already rejected by `resolveWithinRoot`;
  // this rejects in-sandbox symlinks too because clobbering a link surprises
  // the LLM's mental model of "write file X".
  if (existsSync(absPath)) {
    const linkStats = lstatSync(absPath)
    if (linkStats.isSymbolicLink()) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_write_artifact',
        reason: 'symlink_rejected',
        relativePath: args.relativePath,
      })
      throw new ToolDomainError(
        'symlink_rejected',
        `Refusing to overwrite symlink: ${args.relativePath}`,
        { relativePath: args.relativePath, absolutePath: absPath },
      )
    }
  }

  const encoding = args.encoding || 'utf-8'
  const mode = args.mode === 'append' ? 'append' : 'overwrite'
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
  if (mode === 'append') {
    appendFileSync(absPath, buffer)
  } else {
    writeFileSync(absPath, buffer)
  }
  if (handoffTarget?.receiptPath && handoffTarget.taskName) {
    markSkillHandoffOutputCompleted({
      receiptPath: handoffTarget.receiptPath,
      taskName: handoffTarget.taskName,
      outputPath: absPath,
    })
  }

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
        mode,
        artifactRoot: roots.artifactRoot,
      },
    },
  )
}
