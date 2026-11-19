import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AppSettingsRepository } from '../main/modules/repositories/app-settings-repository'
import { ReadySettingsModelGatewayCredentialStore } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  CodexModelGateway,
  type CodexModelGatewayBinding,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

const E3_CANDIDATE_PATHS = [
  'assets/codex-runtime/contracts/binding-schema.json',
  'assets/codex-runtime/contracts/runtime-contracts.json',
  'assets/codex-runtime/evidence/e0-runtime-manifest.json',
  'assets/codex-runtime/runtime-manifest.json',
  'docs/code-health/large-file-health-log.md',
  'package.json',
  'scripts/__tests__/codex-runtime-e0-contracts.test.cjs',
  'scripts/codex-runtime/check-source.cjs',
  'scripts/codex-runtime/contract-lib.cjs',
  'src/__tests__/codex-model-gateway-adversarial.test.ts',
  'src/__tests__/codex-model-gateway-authority-native.test.ts',
  'src/__tests__/codex-binding-repository-native.test.ts',
  'src/__tests__/codex-model-gateway-contract.test.ts',
  'src/__tests__/codex-model-gateway-real-provider.e2e.ts',
  'src/__tests__/codex-model-gateway-sidecar.e2e.ts',
  'src/__tests__/codex-runtime-host-boundary.test.ts',
  'src/__tests__/codex-sidecar-crash-recovery.e2e.ts',
  'src/__tests__/codex-sidecar-process-lease.e2e.ts',
  'src/__tests__/codex-sidecar-supervisor.test.ts',
  'src/main/modules/repositories/app-settings-repository.ts',
  'src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts',
  'src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts',
  'src/main/modules/agent-control/codex-runtime/codex-model-gateway-authority.ts',
  'src/main/modules/agent-control/codex-runtime/codex-model-gateway-chat.ts',
  'src/main/modules/agent-control/codex-runtime/codex-model-gateway-contract.ts',
  'src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts',
  'src/main/modules/agent-control/codex-runtime/codex-runtime-host.ts',
  'src/main/modules/agent-control/codex-runtime/codex-sidecar-session.ts',
  'src/main/modules/agent-control/codex-runtime/codex-sidecar-supervisor.ts',
  'src/main/modules/migrations.ts',
  'src/shared/ai-capability-groups.ts',
  'src/shared/ai-providers.ts',
] as const

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = resolve(root, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function readCandidateIdentity(options: { requireFrozenBoundary: boolean }): {
  candidateDigest: string
  candidateFileCount: number
  dirtyFileCount: number
  gitHead: string
  modelGatewayContractDigest: string
} {
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
  const hash = createHash('sha256')
  const providerDependencyPaths = filesUnder(resolve(repositoryRoot, 'src/shared/ai-providers'))
    .map((path) => relative(repositoryRoot, path))
  const gatewayDependencyPaths = filesUnder(resolve(repositoryRoot, 'src/main/modules/agent-control/codex-runtime'))
    .filter((path) => /^codex-(?:model-gateway|provider-|zai-responses)/.test(basename(path)))
    .map((path) => relative(repositoryRoot, path))
  // The binding repository's façade is a candidate path; the modules it delegates to are part of it.
  const bindingRepositoryPaths = filesUnder(resolve(repositoryRoot, 'src/main/modules/agent-control/codex-runtime/binding-repository'))
    .map((path) => relative(repositoryRoot, path))
  const candidatePaths = [...new Set([
    ...E3_CANDIDATE_PATHS, ...providerDependencyPaths, ...gatewayDependencyPaths, ...bindingRepositoryPaths,
  ])].sort()
  const candidatePathSet = new Set(candidatePaths)
  const dirtyPaths = [...new Set([
    ...execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).split('\n'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).split('\n'),
  ].filter(Boolean))].sort()
  if (options.requireFrozenBoundary) {
    assert.deepEqual(
      dirtyPaths.filter((path) => !candidatePathSet.has(path)),
      [],
      'paid proof forbids dirty or untracked files outside the frozen E3 candidate',
    )
  }
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  hash.update('__git_head__')
  hash.update('\0')
  hash.update(gitHead)
  hash.update('\0')
  for (const relativePath of candidatePaths) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(readFileSync(resolve(repositoryRoot, relativePath)))
    hash.update('\0')
  }
  const manifest = JSON.parse(readFileSync(
    resolve(repositoryRoot, 'assets/codex-runtime/runtime-manifest.json'),
    'utf8',
  )) as { modelGatewayContractDigest?: unknown }
  const contracts = JSON.parse(readFileSync(
    resolve(repositoryRoot, 'assets/codex-runtime/contracts/runtime-contracts.json'),
    'utf8',
  )) as { modelGatewayContract?: unknown }
  assert.equal(typeof manifest.modelGatewayContractDigest, 'string')
  const recomputedContractDigest = digestCanonicalJson(contracts.modelGatewayContract)
  assert.equal(manifest.modelGatewayContractDigest, recomputedContractDigest)
  return {
    candidateDigest: hash.digest('hex'),
    candidateFileCount: candidatePaths.length,
    dirtyFileCount: dirtyPaths.length,
    gitHead,
    modelGatewayContractDigest: recomputedContractDigest,
  }
}

test('E3 candidate identity calculation is deterministic without contacting a Provider', () => {
  const candidateIdentity = readCandidateIdentity({ requireFrozenBoundary: false })
  assert.deepEqual(
    readCandidateIdentity({ requireFrozenBoundary: false }),
    candidateIdentity,
  )
  assert.ok(E3_CANDIDATE_PATHS.some((path) => path === 'src/shared/ai-providers.ts'))
  assert.ok(candidateIdentity.candidateFileCount > E3_CANDIDATE_PATHS.length)
  console.log(`E3_CANDIDATE_IDENTITY ${JSON.stringify(candidateIdentity)}`)
})

test('real configured Provider returns one successful response through the gateway without retry', async (t) => {
  if (process.env.READY_CODEX_E3_REAL !== '1') {
    t.skip('set READY_CODEX_E3_REAL=1 with READY_CODEX_REAL_DB_PATH to run one external call')
    return
  }
  if (skipIfSqliteUnavailable(t, 'Codex real provider gateway database')) return
  const candidateIdentity = readCandidateIdentity({ requireFrozenBoundary: true })
  const expectedCandidateDigest = String(process.env.READY_CODEX_E3_EXPECTED_CANDIDATE_DIGEST || '')
  assert.ok(expectedCandidateDigest, 'paid proof requires the approved frozen E3 candidate digest')
  assert.equal(
    candidateIdentity.candidateDigest,
    expectedCandidateDigest,
    'paid proof must run against the approved frozen E3 candidate',
  )
  const databasePath = String(process.env.READY_CODEX_REAL_DB_PATH || '')
  assert.ok(databasePath)
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  const settings = new AppSettingsRepository(() => ({
    getSetting(key: string) {
      return db.prepare(`SELECT value FROM settings WHERE key = ?`).get<{ value: string }>(key)?.value
    },
    setSetting() { throw new Error('readonly_settings_write_forbidden') },
    getRawDb() { return null },
  }))
  const workspace = settings.getAIWorkspace()
  const profile = workspace.profiles.find((candidate) => candidate.id === workspace.activeProfileId)
  assert.ok(profile)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: profile.id,
    config: profile.config,
    maxRetries: 0,
  })
  assert.equal(
    created.snapshot.wireApi,
    'chat/completions',
    `paid E3 proof requires the non-Responses Chat lane; active profile ${profile.id} uses ${created.snapshot.wireApi}`,
  )
  const request: Record<string, unknown> = {
    model: 'ready-e0-model',
    instructions: 'Return the requested verification token and nothing else.',
    input: [{
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'Reply exactly READY_E3_OK' }],
    }],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: {
      summary: 'auto',
      ...(created.snapshot.reasoningEffort ? { effort: created.snapshot.reasoningEffort } : {}),
    },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'thread-real-e3',
    store: false,
    stream: true,
    client_metadata: {
      'x-codex-installation-id': 'ready-e3-proof-installation',
      session_id: 'thread-real-e3',
      'x-codex-window-id': 'thread-real-e3:0',
      turn_id: 'turn-real-e3',
      thread_id: 'thread-real-e3',
      root_turn_id: 'turn-real-e3',
      'x-codex-turn-metadata': JSON.stringify({
        installation_id: 'ready-e3-proof-installation', session_id: 'thread-real-e3',
        thread_id: 'thread-real-e3', turn_id: 'turn-real-e3', window_id: 'thread-real-e3:0',
        root_turn_id: 'turn-real-e3', agent_name: '/root', request_kind: 'turn',
        sandbox: process.platform === 'win32' ? 'windows_sandbox' : 'seatbelt', sandbox_mode: 'read-only', auto_review_enabled: false,
        node_repl_auto_review_required: false, node_repl_disabled: false,
        turn_started_at_unix_ms: 1, window_number: 0, context_window_id: 'context-window-1',
        analytics_enabled: false, model: 'ready-e0-model',
        readyRunId: 'run-real-e3', toolSurfaceDigest: digestCanonicalJson([]),
        turnContractDigest: 'turn-contract-real-e3',
        upstreamProfileSnapshotDigest: created.snapshotDigest,
      }),
    },
  }
  let upstreamAttempts = 0
  const credentialStore = new ReadySettingsModelGatewayCredentialStore(settings)
  const activeCredential = await credentialStore.resolve({
    credentialReferenceId: created.snapshot.credentialReferenceId,
    snapshot: created.snapshot,
  })
  const gateway = new CodexModelGateway({
    onUpstreamAttempt() { upstreamAttempts += 1 },
    authority: {
      async resolve(input) {
        const binding: CodexModelGatewayBinding = {
          kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
          snapshotDigest: created.snapshotDigest, toolSurfaceDigest: digestCanonicalJson([]), requestToolsDigest: digestCanonicalJson([]),
          turnContractDigest: 'turn-contract-real-e3',
          instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
          additionalContextDigest: digestCanonicalJson([]),
          deliveredUserTail: [],
          forceToolFreeFinalization: false,
          allowedToolNames: [],
        }
        input.validate(binding)
        return binding
      },
    },
    credentials: credentialStore,
  })
  const startedAt = Date.now()
  try {
    const address = await gateway.start()
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${address.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    })
    const headersAt = Date.now()
    assert.equal(response.status, 200, response.statusText)
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let stream = ''
    let firstDeltaAt: number | null = null
    let deltaBeforeTerminal = false
    let deltas = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      stream += decoder.decode(next.value, { stream: true })
      const currentDeltas = stream.split('\n')
        .filter((line) => line.startsWith('data: '))
        .flatMap((line) => {
          try {
            const event = JSON.parse(line.slice(6)) as { type?: string; delta?: string }
            return event.type === 'response.output_text.delta' && typeof event.delta === 'string'
              ? [event.delta] : []
          } catch {
            return []
          }
        })
        .join('')
      if (firstDeltaAt === null && currentDeltas) {
        deltaBeforeTerminal = !/event: response\.(?:completed|incomplete|failed)\b/.test(stream)
        assert.equal(
          deltaBeforeTerminal,
          true,
          'paid proof requires a text delta in an earlier read than the terminal event',
        )
        firstDeltaAt = Date.now()
      }
      deltas = currentDeltas
    }
    stream += decoder.decode()
    assert.ok(firstDeltaAt, 'paid proof requires an observable streamed text delta')
    assert.match(deltas, /READY_E3_OK/)
    assert.match(stream, /response\.completed/)
    assert.ok(!activeCredential || !stream.includes(activeCredential))
    const postCandidateIdentity = readCandidateIdentity()
    assert.deepEqual(postCandidateIdentity, candidateIdentity)
    const receipt = {
      ...candidateIdentity,
      providerId: created.snapshot.providerId,
      profileId: created.snapshot.profileId,
      model: created.snapshot.model,
      wireApi: created.snapshot.wireApi,
      status: response.status,
      upstreamRequestId: response.headers.get('x-ready-upstream-request-id'),
      headersMs: headersAt - startedAt,
      firstDeltaMs: firstDeltaAt - startedAt,
      deltaBeforeTerminal,
      totalMs: Date.now() - startedAt,
      outputDigest: createHash('sha256').update(deltas).digest('hex'),
      expectedTokenPresent: deltas.includes('READY_E3_OK'),
      retryCount: upstreamAttempts - 1,
    }
    assert.equal(receipt.retryCount, 0)
    console.log(`E3_REAL_PROVIDER_RECEIPT ${JSON.stringify(receipt)}`)
  } finally {
    await gateway.stop().catch(() => undefined)
    db.close()
  }
})
