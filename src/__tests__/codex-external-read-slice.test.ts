import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertPreparedCodexExternalReadSlice,
  externalReadResourceAuthority,
  parseCodexExternalReadSliceRequest,
  prepareFeishuExternalReadSlice,
  prepareLarkExternalReadSlice,
  readLarkCliAuthReadback,
} from '../main/modules/agent-control/codex-runtime/codex-external-read-slice'
import { resolveFrozenDesktopExecutableAuthority } from '../main/modules/skills-runtime/desktop-executable-authority'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { digestFeishuChannelSnapshot } from '../main/modules/tools/feishu-tools'

const digest = 'a'.repeat(64)

test('parses only an explicit trusted external-read slice envelope', () => {
  assert.equal(parseCodexExternalReadSliceRequest({ unrelated: true }), null)
  const parsed = parseCodexExternalReadSliceRequest({
    codexExternalReadSlice: {
      kind: 'feishu_typed_read',
      channelId: 'channel-1',
      docToken: 'doc-token',
      docType: 'docx',
      logicalResourceId: 'feishu:doc-token',
      currentVersion: 'v1',
      currentDigest: digest,
      policyEpoch: 1,
    },
  })
  assert.equal(parsed?.kind, 'feishu_typed_read')
  assert.throws(
    () => parseCodexExternalReadSliceRequest({
      codexExternalReadSlice: {
        kind: 'lark_cli_read',
        docRef: 'x; curl bad',
        logicalResourceId: 'lark:bad',
        currentVersion: 'v1',
        currentDigest: digest,
        policyEpoch: 1,
      },
    }),
    /codex_external_read_slice_invalid/,
  )
})

test('Lark document preparation stops after an invalid auth readback', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-lark-auth-invalid-'))
  const fixturePath = join(fixtureRoot, 'fixture-cli')
  try {
    writeFileSync(fixturePath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-1; else echo invalid; fi\n')
    chmodSync(fixturePath, 0o755)
    const executableAuthority = await resolveFrozenDesktopExecutableAuthority({
      program: fixturePath,
    })
    await assert.rejects(
      readLarkCliAuthReadback({ executableAuthority, env: { PATH: '' } }),
      /codex_external_read_lark_auth_required/,
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('a Lark CLI that never answers is reported as unavailable, not as a missing login', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-lark-auth-hang-'))
  const fixturePath = join(fixtureRoot, 'fixture-cli')
  try {
    writeFileSync(fixturePath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-1; else /bin/sleep 5; fi\n')
    chmodSync(fixturePath, 0o755)
    const executableAuthority = await resolveFrozenDesktopExecutableAuthority({
      program: fixturePath,
    })
    await assert.rejects(
      readLarkCliAuthReadback({ executableAuthority, env: { PATH: '' }, timeoutMs: 200 }),
      /codex_external_read_lark_cli_unavailable/,
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('prepares exact Feishu read authority only when the channel and sidecar are available', () => {
  const channelIdentityDigest = digestFeishuChannelSnapshot({
    id: 'channel-1',
    type: 'feishu-app',
    enabled: true,
    config: { appId: 'app-1', appSecret: 'secret-1' },
  })
  const request = parseCodexExternalReadSliceRequest({
    codexExternalReadSlice: {
      kind: 'feishu_typed_read',
      channelId: 'channel-1',
      docToken: 'doc-token',
      docType: 'docx',
      logicalResourceId: 'feishu:doc-token',
      currentVersion: 'v1',
      currentDigest: digest,
      policyEpoch: 1,
    },
  })
  assert.ok(request?.kind === 'feishu_typed_read')
  assert.throws(
    () => prepareFeishuExternalReadSlice({
      request,
      sidecarRunning: false,
      channelIdentityDigest,
    }),
    /codex_external_read_feishu_unavailable/,
  )
  const prepared = prepareFeishuExternalReadSlice({
    request,
    sidecarRunning: true,
    channelIdentityDigest,
  })
  assert.deepEqual(prepared.allowedToolNames, ['feishu_doc_read'])
  assert.deepEqual(prepared.kind === 'feishu_typed_read' ? prepared.authority : null, {
    channelId: 'channel-1',
    docToken: 'doc-token',
    docType: 'docx',
    allowedToolName: 'feishu_doc_read',
    channelIdentityDigest,
    expectedResultDigest: digest,
  })
  assert.doesNotThrow(() => assertPreparedCodexExternalReadSlice(prepared))
})

test('Lark read preparation binds one doc fetch argv to a direct native payload', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-lark-slice-'))
  const skillRoot = join(fixtureRoot, 'lark-doc')
  const siblingRoot = join(fixtureRoot, 'lark-shared')
  mkdirSync(join(skillRoot, 'references'), { recursive: true })
  mkdirSync(siblingRoot, { recursive: true })
  writeFileSync(join(skillRoot, 'SKILL.md'), 'lark-doc')
  writeFileSync(join(siblingRoot, 'SKILL.md'), 'lark-shared')
  writeFileSync(join(skillRoot, 'references/lark-doc-fetch.md'), 'fetch')
  try {
  const request = parseCodexExternalReadSliceRequest({
    codexExternalReadSlice: {
      kind: 'lark_cli_read',
      docRef: 'Z1FjExampleToken',
      logicalResourceId: 'lark:Z1FjExampleToken',
      currentVersion: 'latest',
      currentDigest: digest,
      policyEpoch: 1,
    },
  })
  assert.ok(request?.kind === 'lark_cli_read')
  const executableAuthority = await resolveFrozenDesktopExecutableAuthority({
    program: '/bin/echo',
    directPayloadRequired: true,
  })
  const authSafe = {
    identity: 'user' as const,
    verified: true as const,
    userStatus: 'ready' as const,
    userAvailable: true as const,
    userVerified: true as const,
    tokenStatus: 'valid' as const,
    principalDigest: 'c'.repeat(64),
    scopeDigest: 'b'.repeat(64),
    executableReadbackDigest: executableAuthority.authorityDigest,
  }
  const authReadback = { ...authSafe, authReadbackDigest: digestCanonicalJson(authSafe) }
  const prepared = prepareLarkExternalReadSlice({
    request,
    skillRoot,
    siblingReadRoots: [siblingRoot],
    executableAuthority,
    authReadback,
  })
  assert.ok(prepared.kind === 'lark_cli_read')
  assert.deepEqual(prepared.allowedToolNames, ['skill_read_artifact', 'skill_run_shell'])
  assert.deepEqual(prepared.requiredMethod.allowedArgv, [[
    'docs', '+fetch',
    '--doc', 'Z1FjExampleToken',
    '--as', 'user',
    '--doc-format', 'markdown',
    '--detail', 'simple',
    '--revision-id', '-1',
    '--scope', 'full',
    '--format', 'json',
  ]])
  assert.equal(prepared.requiredMethod.executableAuthority.payloadPath, prepared.requiredMethod.executableAuthority.spawnPath)
  assert.equal(prepared.requiredMethod.executableAuthority.wrapperExecutionForbidden, true)
  assert.doesNotThrow(() => assertPreparedCodexExternalReadSlice(prepared))
  assert.deepEqual(prepared.requiredResources.map((resource) => resource.logicalPath), [
    'lark-doc/SKILL.md',
    'lark-shared/SKILL.md',
    'lark-doc/references/lark-doc-fetch.md',
  ])
  assert.throws(
    () => assertPreparedCodexExternalReadSlice({
      ...prepared,
      methodConstraintDigest: 'f'.repeat(64),
    }),
    /codex_external_read_slice_digest_invalid/,
  )

  writeFileSync(join(siblingRoot, 'SKILL.md'), 'lark-shared-v2')
  const dependencyChanged = prepareLarkExternalReadSlice({
    request,
    skillRoot,
    siblingReadRoots: [siblingRoot],
    executableAuthority,
    authReadback,
  })
  assert.ok(dependencyChanged.kind === 'lark_cli_read')
  assert.equal(dependencyChanged.methodConstraintDigest, prepared.methodConstraintDigest)
  assert.notEqual(dependencyChanged.dependencySnapshotDigest, prepared.dependencySnapshotDigest)
  assert.deepEqual(
    externalReadResourceAuthority(dependencyChanged),
    externalReadResourceAuthority(prepared),
  )

  const principalSafe = { ...authSafe, principalDigest: 'd'.repeat(64) }
  const principalChanged = prepareLarkExternalReadSlice({
    request,
    skillRoot,
    siblingReadRoots: [siblingRoot],
    executableAuthority,
    authReadback: {
      ...principalSafe,
      authReadbackDigest: digestCanonicalJson(principalSafe),
    },
  })
  assert.ok(principalChanged.kind === 'lark_cli_read')
  assert.equal(principalChanged.methodConstraintDigest, dependencyChanged.methodConstraintDigest)
  assert.notEqual(principalChanged.dependencySnapshotDigest, dependencyChanged.dependencySnapshotDigest)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
