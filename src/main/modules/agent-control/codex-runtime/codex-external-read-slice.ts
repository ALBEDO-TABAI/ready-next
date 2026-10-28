import { z } from 'zod'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, statSync } from 'node:fs'

import type { FeishuReadAuthority } from '../../tools/feishu-tools'
import type { FrozenDesktopExecutableAuthority } from '../../skills-runtime/desktop-executable-authority'
import { executeFrozenDesktopExecutable } from '../../skills-runtime/desktop-executable-authority'
import { canonicalJson, digestCanonicalJson } from './codex-model-gateway-contract'

const nonEmpty = z.string().trim().min(1)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const resourceIdentitySchema = z.object({
  logicalResourceId: nonEmpty,
  currentVersion: nonEmpty,
  currentDigest: digest,
  policyEpoch: z.number().int().positive(),
}).strict()

const feishuRequestSchema = resourceIdentitySchema.extend({
  kind: z.literal('feishu_typed_read'),
  channelId: nonEmpty,
  docToken: nonEmpty,
  docType: z.enum(['doc', 'docx', 'sheet', 'bitable']),
}).strict()

const larkRequestSchema = resourceIdentitySchema.extend({
  kind: z.literal('lark_cli_read'),
  docRef: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/),
}).strict()

export const codexExternalReadSliceRequestSchema = z.discriminatedUnion('kind', [
  feishuRequestSchema,
  larkRequestSchema,
])

export type CodexExternalReadSliceRequest = z.infer<typeof codexExternalReadSliceRequestSchema>

export type PreparedCodexExternalReadSlice =
  | Readonly<{
      kind: 'feishu_typed_read'
      logicalResourceId: string
      currentVersion: string
      currentDigest: string
      policyEpoch: number
      methodConstraintDigest: string
      dependencySnapshotDigest: string
      allowedToolNames: readonly ['feishu_doc_read']
      authority: FeishuReadAuthority
    }>
  | Readonly<{
      kind: 'lark_cli_read'
      logicalResourceId: string
      currentVersion: string
      currentDigest: string
      policyEpoch: number
      methodConstraintDigest: string
      dependencySnapshotDigest: string
      allowedToolNames: readonly ['skill_read_artifact', 'skill_run_shell']
      skillId: 'lark-doc'
      docRef: string
      skillRoot: string
      siblingReadRoots: readonly string[]
      requiredResources: readonly Readonly<{
        logicalPath: string
        rootKind: 'selected_skill' | 'sibling_skill'
        relativePath: string
        sha256: string
        fileIdentity: Readonly<{
          device: string
          inode: string
          size: number
          mode: number
          mtimeMs: number
        }>
      }>[]
      authReadback: LarkCliAuthReadback
      requiredMethod: Readonly<{
        methodId: 'lark-doc-fetch'
        commandName: 'lark-cli'
        allowedArgv: readonly (readonly string[])[]
        expectedStdoutSha256: string
        executableAuthority: FrozenDesktopExecutableAuthority
      }>
    }>

export type LarkCliAuthReadback = Readonly<{
  identity: 'user'
  verified: true
  userStatus: 'ready'
  userAvailable: true
  userVerified: true
  tokenStatus: 'valid'
  principalDigest: string
  scopeDigest: string
  authReadbackDigest: string
  executableReadbackDigest: string
}>

export function parseCodexExternalReadSliceRequest(value: unknown): CodexExternalReadSliceRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = (value as Record<string, unknown>).codexExternalReadSlice
  if (candidate === undefined) return null
  const parsed = codexExternalReadSliceRequestSchema.safeParse(candidate)
  if (!parsed.success) throw new Error('codex_external_read_slice_invalid')
  return parsed.data
}

export function externalReadResourceReference(slice: PreparedCodexExternalReadSlice) {
  return {
    logicalResourceId: slice.logicalResourceId,
    currentVersion: slice.currentVersion,
    currentDigest: slice.currentDigest,
    supersedesVersion: null,
    policyEpoch: slice.policyEpoch,
  }
}

export function externalReadResourceAuthority(slice: PreparedCodexExternalReadSlice) {
  const common = {
    kind: slice.kind,
    logicalResourceId: slice.logicalResourceId,
    currentVersion: slice.currentVersion,
    currentDigest: slice.currentDigest,
    policyEpoch: slice.policyEpoch,
  }
  return slice.kind === 'feishu_typed_read'
    ? {
        ...common,
        channelId: slice.authority.channelId,
        docToken: slice.authority.docToken,
        docType: slice.authority.docType,
      }
    : {
        ...common,
        docRef: slice.docRef,
      }
}

export function assertPreparedCodexExternalReadSlice(
  value: unknown,
): asserts value is PreparedCodexExternalReadSlice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex_external_read_slice_preparation_invalid')
  }
  const record = value as Record<string, unknown>
  const common = resourceIdentitySchema.extend({
    methodConstraintDigest: digest,
    dependencySnapshotDigest: digest,
    allowedToolNames: z.array(nonEmpty).min(1),
  })
  if (record.kind === 'feishu_typed_read') {
    const parsed = common.extend({
      kind: z.literal('feishu_typed_read'),
      authority: z.object({
        channelId: nonEmpty,
        docToken: nonEmpty,
        docType: z.enum(['doc', 'docx', 'sheet', 'bitable']),
        allowedToolName: z.literal('feishu_doc_read'),
        channelIdentityDigest: digest,
        expectedResultDigest: digest,
      }).strict(),
    }).strict().parse(record)
    if (canonicalJson(parsed.allowedToolNames) !== canonicalJson(['feishu_doc_read'])) {
      throw new Error('codex_external_read_slice_tool_policy_invalid')
    }
    if (parsed.authority.expectedResultDigest !== parsed.currentDigest) {
      throw new Error('codex_external_read_slice_resource_policy_invalid')
    }
    const expectedDigests = digestPreparedExternalReadSliceMethod(
      parsed as unknown as UnsealedFeishuExternalReadSlice,
    )
    if (parsed.methodConstraintDigest !== expectedDigests.methodConstraintDigest
      || parsed.dependencySnapshotDigest !== expectedDigests.dependencySnapshotDigest) {
      throw new Error('codex_external_read_slice_digest_invalid')
    }
    return
  }
  if (record.kind === 'lark_cli_read') {
    const parsed = common.extend({
      kind: z.literal('lark_cli_read'),
      skillId: z.literal('lark-doc'),
      docRef: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/),
      skillRoot: nonEmpty,
      siblingReadRoots: z.array(nonEmpty),
      requiredResources: z.array(z.object({
        logicalPath: nonEmpty,
        rootKind: z.enum(['selected_skill', 'sibling_skill']),
        relativePath: nonEmpty,
        sha256: digest,
        fileIdentity: z.object({
          device: nonEmpty,
          inode: nonEmpty,
          size: z.number().nonnegative(),
          mode: z.number().int().nonnegative(),
          mtimeMs: z.number().nonnegative(),
        }).strict(),
      }).strict()).length(3),
      authReadback: z.object({
        identity: z.literal('user'),
        verified: z.literal(true),
        userStatus: z.literal('ready'),
        userAvailable: z.literal(true),
        userVerified: z.literal(true),
        tokenStatus: z.literal('valid'),
        principalDigest: digest,
        scopeDigest: digest,
        authReadbackDigest: digest,
        executableReadbackDigest: digest,
      }).strict(),
      requiredMethod: z.object({
        methodId: z.literal('lark-doc-fetch'),
        commandName: z.literal('lark-cli'),
        allowedArgv: z.array(z.array(z.string())).min(1),
        expectedStdoutSha256: digest,
        executableAuthority: z.object({
          program: nonEmpty,
          outerPath: nonEmpty,
          realPath: nonEmpty,
          payloadPath: nonEmpty,
          payloadSha256: digest,
          fileIdentity: z.object({
            device: nonEmpty,
            inode: nonEmpty,
            size: z.number().nonnegative(),
            mode: z.number().int().nonnegative(),
            mtimeMs: z.number().nonnegative(),
          }).strict(),
          launcherChain: z.array(z.object({
            kind: z.enum(['payload', 'interpreter']),
            path: nonEmpty,
            realPath: nonEmpty,
            sha256: digest,
            fileIdentity: z.object({
              device: nonEmpty,
              inode: nonEmpty,
              size: z.number().nonnegative(),
              mode: z.number().int().nonnegative(),
              mtimeMs: z.number().nonnegative(),
            }).strict(),
          }).strict()).min(1),
          launchPath: nonEmpty,
          spawnPath: nonEmpty,
          launchPrefixArgs: z.array(z.string()),
          version: nonEmpty,
          wrapperExecutionForbidden: z.literal(true),
          autoInstallForbidden: z.literal(true),
          authorityDigest: digest,
        }).strict(),
      }).strict(),
    }).strict().parse(record)
    if (canonicalJson(parsed.allowedToolNames) !== canonicalJson([
      'skill_read_artifact',
      'skill_run_shell',
    ])) throw new Error('codex_external_read_slice_tool_policy_invalid')
    if (canonicalJson(parsed.requiredResources.map((resource) => ({
      logicalPath: resource.logicalPath,
      rootKind: resource.rootKind,
      relativePath: resource.relativePath,
    }))) !== canonicalJson([
      { logicalPath: 'lark-doc/SKILL.md', rootKind: 'selected_skill', relativePath: 'SKILL.md' },
      { logicalPath: 'lark-shared/SKILL.md', rootKind: 'sibling_skill', relativePath: 'SKILL.md' },
      {
        logicalPath: 'lark-doc/references/lark-doc-fetch.md',
        rootKind: 'selected_skill',
        relativePath: 'references/lark-doc-fetch.md',
      },
    ])) throw new Error('codex_external_read_slice_resource_policy_invalid')
    if (parsed.requiredMethod.executableAuthority.payloadPath
      !== parsed.requiredMethod.executableAuthority.spawnPath
      || parsed.requiredMethod.executableAuthority.launchPath
        !== parsed.requiredMethod.executableAuthority.spawnPath
      || parsed.requiredMethod.executableAuthority.launcherChain.length !== 1
      || parsed.requiredMethod.executableAuthority.launchPrefixArgs.length !== 0
      || parsed.authReadback.executableReadbackDigest
        !== parsed.requiredMethod.executableAuthority.authorityDigest
      || parsed.requiredMethod.expectedStdoutSha256 !== parsed.currentDigest
      || parsed.authReadback.authReadbackDigest !== digestCanonicalJson({
        identity: parsed.authReadback.identity,
        verified: parsed.authReadback.verified,
        userStatus: parsed.authReadback.userStatus,
        userAvailable: parsed.authReadback.userAvailable,
        userVerified: parsed.authReadback.userVerified,
        tokenStatus: parsed.authReadback.tokenStatus,
        principalDigest: parsed.authReadback.principalDigest,
        scopeDigest: parsed.authReadback.scopeDigest,
        executableReadbackDigest: parsed.authReadback.executableReadbackDigest,
      })) {
      throw new Error('codex_external_read_slice_executable_policy_invalid')
    }
    const expectedDigests = digestPreparedExternalReadSliceMethod(
      parsed as unknown as UnsealedLarkExternalReadSlice,
    )
    if (parsed.methodConstraintDigest !== expectedDigests.methodConstraintDigest
      || parsed.dependencySnapshotDigest !== expectedDigests.dependencySnapshotDigest) {
      throw new Error('codex_external_read_slice_digest_invalid')
    }
    return
  }
  throw new Error('codex_external_read_slice_preparation_invalid')
}

type UnsealedFeishuExternalReadSlice = Omit<
  Extract<PreparedCodexExternalReadSlice, { kind: 'feishu_typed_read' }>,
  'methodConstraintDigest' | 'dependencySnapshotDigest'
>
type UnsealedLarkExternalReadSlice = Omit<
  Extract<PreparedCodexExternalReadSlice, { kind: 'lark_cli_read' }>,
  'methodConstraintDigest' | 'dependencySnapshotDigest'
>

export function digestPreparedExternalReadSliceMethod(
  slice: UnsealedFeishuExternalReadSlice | UnsealedLarkExternalReadSlice,
): { methodConstraintDigest: string; dependencySnapshotDigest: string } {
  if (slice.kind === 'feishu_typed_read') {
    return {
      methodConstraintDigest: digestCanonicalJson({
        kind: slice.kind,
        allowedToolNames: slice.allowedToolNames,
        authority: {
          channelId: slice.authority.channelId,
          docToken: slice.authority.docToken,
          docType: slice.authority.docType,
          allowedToolName: slice.authority.allowedToolName,
        },
      }),
      dependencySnapshotDigest: digestCanonicalJson({
        provider: 'ready_connector:feishu',
        channelIdentityDigest: slice.authority.channelIdentityDigest,
      }),
    }
  }
  return {
    methodConstraintDigest: digestCanonicalJson({
      kind: slice.kind,
      allowedToolNames: slice.allowedToolNames,
      skillId: slice.skillId,
      requiredResources: slice.requiredResources.map((resource) => ({
        logicalPath: resource.logicalPath,
        rootKind: resource.rootKind,
        relativePath: resource.relativePath,
      })),
      methodId: slice.requiredMethod.methodId,
      commandName: slice.requiredMethod.commandName,
      allowedArgv: slice.requiredMethod.allowedArgv,
    }),
    dependencySnapshotDigest: digestCanonicalJson({
      skillRoot: slice.skillRoot,
      siblingReadRoots: slice.siblingReadRoots,
      requiredResourceIdentities: slice.requiredResources.map((resource) => ({
        logicalPath: resource.logicalPath,
        sha256: resource.sha256,
        fileIdentity: resource.fileIdentity,
      })),
      executableAuthority: slice.requiredMethod.executableAuthority,
      authReadback: slice.authReadback,
    }),
  }
}

export function prepareFeishuExternalReadSlice(input: {
  request: Extract<CodexExternalReadSliceRequest, { kind: 'feishu_typed_read' }>
  sidecarRunning: boolean
  channelIdentityDigest: string | null
}): PreparedCodexExternalReadSlice {
  if (!input.sidecarRunning || !input.channelIdentityDigest || !digest.safeParse(input.channelIdentityDigest).success) {
    throw new Error('codex_external_read_feishu_unavailable')
  }
  const unsealed: UnsealedFeishuExternalReadSlice = {
    kind: 'feishu_typed_read',
    logicalResourceId: input.request.logicalResourceId,
    currentVersion: input.request.currentVersion,
    currentDigest: input.request.currentDigest,
    policyEpoch: input.request.policyEpoch,
    allowedToolNames: ['feishu_doc_read'],
    authority: {
      channelId: input.request.channelId,
      docToken: input.request.docToken,
      docType: input.request.docType,
      allowedToolName: 'feishu_doc_read',
      channelIdentityDigest: input.channelIdentityDigest,
      expectedResultDigest: input.request.currentDigest,
    },
  }
  const digests = digestPreparedExternalReadSliceMethod(unsealed)
  const prepared = Object.freeze({ ...unsealed, ...digests })
  assertPreparedCodexExternalReadSlice(prepared)
  return prepared
}

export function prepareLarkExternalReadSlice(input: {
  request: Extract<CodexExternalReadSliceRequest, { kind: 'lark_cli_read' }>
  skillRoot: string
  siblingReadRoots: readonly string[]
  executableAuthority: FrozenDesktopExecutableAuthority
  authReadback: LarkCliAuthReadback
}): PreparedCodexExternalReadSlice {
  const snapshotResource = (
    logicalPath: string,
    rootKind: 'selected_skill' | 'sibling_skill',
    root: string,
    relativePath: string,
  ) => {
    const absolutePath = `${root}/${relativePath}`
    const link = lstatSync(absolutePath)
    if (link.isSymbolicLink()) throw new Error('codex_external_read_lark_resource_symlink_rejected')
    const stats = statSync(absolutePath)
    if (!stats.isFile()) throw new Error('codex_external_read_lark_resources_unavailable')
    return {
      logicalPath,
      rootKind,
      relativePath,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
      fileIdentity: {
        device: String(stats.dev),
        inode: String(stats.ino),
        size: stats.size,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
      },
    }
  }
  if (input.siblingReadRoots.length !== 1) {
    throw new Error('codex_external_read_lark_resources_unavailable')
  }
  const requiredResources = [
    snapshotResource('lark-doc/SKILL.md', 'selected_skill', input.skillRoot, 'SKILL.md'),
    snapshotResource('lark-shared/SKILL.md', 'sibling_skill', input.siblingReadRoots[0], 'SKILL.md'),
    snapshotResource(
      'lark-doc/references/lark-doc-fetch.md',
      'selected_skill',
      input.skillRoot,
      'references/lark-doc-fetch.md',
    ),
  ]
  const unsealed: UnsealedLarkExternalReadSlice = {
    kind: 'lark_cli_read',
    logicalResourceId: input.request.logicalResourceId,
    currentVersion: input.request.currentVersion,
    currentDigest: input.request.currentDigest,
    policyEpoch: input.request.policyEpoch,
    allowedToolNames: ['skill_read_artifact', 'skill_run_shell'],
    skillId: 'lark-doc',
    docRef: input.request.docRef,
    skillRoot: input.skillRoot,
    siblingReadRoots: [...input.siblingReadRoots],
    requiredResources,
    authReadback: input.authReadback,
    requiredMethod: {
      methodId: 'lark-doc-fetch',
      commandName: 'lark-cli',
      allowedArgv: [[
        'docs', '+fetch',
        '--doc', input.request.docRef,
        '--as', 'user',
        '--doc-format', 'markdown',
        '--detail', 'simple',
        '--revision-id', '-1',
        '--scope', 'full',
        '--format', 'json',
      ]],
      expectedStdoutSha256: input.request.currentDigest,
      executableAuthority: input.executableAuthority,
    },
  }
  const digests = digestPreparedExternalReadSliceMethod(unsealed)
  const prepared = Object.freeze({ ...unsealed, ...digests })
  assertPreparedCodexExternalReadSlice(prepared)
  return prepared
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export async function readLarkCliAuthReadback(input: {
  executableAuthority: FrozenDesktopExecutableAuthority
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<LarkCliAuthReadback> {
  const result = await executeFrozenDesktopExecutable({
    authority: input.executableAuthority,
    args: ['auth', 'status', '--json', '--verify'],
    env: {
      ...(input.env || process.env),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
    timeoutMs: input.timeoutMs ?? 15_000,
  })
  // A CLI that never started or was killed says nothing about the login; do not send the user to re-authorize.
  if (result.outcome !== 'exited') throw new Error('codex_external_read_lark_cli_unavailable')
  let payload: Record<string, unknown> | null = null
  try {
    payload = asRecord(JSON.parse(result.stdout || result.stderr))
  } catch {
    // silent-catch: non-JSON auth status output leaves payload null, which fails the check below as codex_external_read_lark_auth_required
    payload = null
  }
  const identities = asRecord(payload?.identities)
  const user = asRecord(identities?.user)
  const safe = {
    identity: payload?.identity,
    verified: payload?.verified,
    userStatus: user?.status,
    userAvailable: user?.available,
    userVerified: user?.verified,
    tokenStatus: user?.tokenStatus,
    principalDigest: digestCanonicalJson(typeof user?.openId === 'string' ? user.openId : ''),
    scopeDigest: digestCanonicalJson(typeof user?.scope === 'string' ? user.scope : ''),
    executableReadbackDigest: result.executableReadbackDigest,
  }
  if (result.exitCode !== 0
    || safe.identity !== 'user'
    || safe.verified !== true
    || safe.userStatus !== 'ready'
    || safe.userAvailable !== true
    || safe.userVerified !== true
    || safe.tokenStatus !== 'valid'
    || typeof user?.openId !== 'string'
    || !user.openId.trim()) {
    throw new Error('codex_external_read_lark_auth_required')
  }
  const readback = {
    ...safe,
    identity: 'user' as const,
    verified: true as const,
    userStatus: 'ready' as const,
    userAvailable: true as const,
    userVerified: true as const,
    tokenStatus: 'valid' as const,
    authReadbackDigest: digestCanonicalJson(safe),
  }
  return Object.freeze(readback)
}
