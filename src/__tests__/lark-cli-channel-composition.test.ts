import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

test.before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})
test.after(() => __setScopeContextEpochDatabaseForTests(null))

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import {
  __setSkillsRuntimeManagerForTests,
  type SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import {
  __setLarkCliRunShellExecutorForTests,
} from '../main/modules/tools/skills-tools'
import {
  clearSkillTaskProjection,
  readSkillTaskProjection,
} from '../main/modules/agent-control/skills/skill-task-tracker'
import {
  _resetEphemeralExecutionStoreForTests,
  getEphemeralExecutionStore,
} from '../main/modules/tools/skill-primitives/ephemeral-execution-store'
import { FrozenCallStore } from '../main/modules/agent-control/safety/frozen-call-store'
import {
  _resetFrozenCallBridgeForTests,
  registerFrozenCallStore,
} from '../main/modules/agent-control/safety/frozen-call-bridge'
import {
  FROZEN_CALL_CONFIRM_OPTION,
  FROZEN_CALL_QUESTION_ID,
} from '../main/modules/agent-control/safety/frozen-call-confirmation'
import { getAskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'
import {
  clearLarkCliAuthFlowsForTests,
  getPendingLarkCliMissingScopeEvidenceCountForTests,
} from '../main/modules/agent-control/safety/lark-cli-auth-flow-authority'
import { createFrozenCallAuditDb } from './helpers/frozen-call-audit-db'

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const startedAt = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('production Lark CLI dispatch keeps authorization secret in memory through ask, confirmation, and readback', async () => {
  const sessionId = 'lark-cli-production-composition'
  const scope = 'docs:document.content:read'
  const deviceSecret = 'production-device-secret'
  const verificationUrl = 'https://example.test/verify'
  const embeddedSkillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'lark-cli')
  const compiled = compileSkillDefinition({ folderPath: embeddedSkillRoot, source: 'embedded' })
  const skill = {
    ...compiled,
    installed: true,
    installStatePath: '',
    managedPath: embeddedSkillRoot,
  }
  const metrics: AgentMetricEvent[] = []
  const executedCommands: string[] = []
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'lark-cli',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_run_shell', 'skill_read_artifact', 'skill_ask_user'],
    source: 'explicit',
    reason: 'production_composition_test',
  })
  const context: ToolContext = {
    invoker: 'model',
    sessionId,
    scopeId: sessionId,
    runId: 'run-lark-cli-production-composition',
    allowedToolNames: new Set(['skill_run_shell', 'skill_read_artifact', 'skill_ask_user']),
    authorization,
  }

  clearLarkCliAuthFlowsForTests()
  clearSkillTaskProjection(sessionId)
  _resetEphemeralExecutionStoreForTests()
  getAskUserQuestionsStore().clear()
  registerFrozenCallStore(new FrozenCallStore(createFrozenCallAuditDb()))
  __setMetricSinkForTests((event) => metrics.push(event))
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [skill],
    getRuntimeEnv: () => ({ PATH: '/usr/bin:/bin' }),
    getRuntimeBinDir: () => null,
    getSharedVenvBinDir: () => null,
  } as unknown as SkillsRuntimeManager)
  __setLarkCliRunShellExecutorForTests(async ({
    command,
    executableAuthority,
    persistOverflowArtifacts,
  }) => {
    assert.equal(executableAuthority.program, 'lark-cli')
    executedCommands.push(command)
    if (command.startsWith('lark-cli docs +fetch')) {
      return createToolExecutionOutput('missing scope', {
        shape: 'json',
        data: {
          exitCode: 1,
          stdout: JSON.stringify({
            ok: false,
            error: {
              type: 'authorization',
              subtype: 'missing_scope',
              missing_scopes: [scope],
            },
          }),
        },
      })
    }
    if (command.includes('auth login --scope')) {
      assert.equal(persistOverflowArtifacts, false)
      return createToolExecutionOutput('authorization initiated', {
        shape: 'json',
        data: {
          exitCode: 0,
          stdout: JSON.stringify({ device_code: deviceSecret, verification_url: verificationUrl }),
        },
      })
    }
    if (command.includes('auth qrcode')) {
      assert.equal(command, `lark-cli auth qrcode "${verificationUrl}" --ascii`)
      assert.equal(persistOverflowArtifacts, false)
      return createToolExecutionOutput('██ READY QR ██', {
        shape: 'json',
        data: { exitCode: 0, stdout: '██ READY QR ██' },
      })
    }
    if (command.includes('auth login --device-code')) {
      assert.match(command, new RegExp(deviceSecret))
      assert.doesNotMatch(command, /ready-lark-auth-/)
      assert.equal(persistOverflowArtifacts, false)
      return createToolExecutionOutput('authorization complete', {
        shape: 'json',
        data: { exitCode: 0, stdout: JSON.stringify({ ok: true }) },
      })
    }
    if (command === 'lark-cli auth status --json --verify') {
      assert.equal(persistOverflowArtifacts, false)
      return createToolExecutionOutput('verified', {
        shape: 'json',
        data: { exitCode: 0, stdout: JSON.stringify({ verified: true }) },
      })
    }
    throw new Error(`unexpected command: ${command}`)
  })

  try {
    const probe = await executeToolCall('skill_run_shell', {
      command: 'lark-cli docs +fetch --doc "https://example.test/docx/fixture" --as user',
    }, context)
    assert.equal(probe.data?.exitCode, 1)
    assert.equal(getPendingLarkCliMissingScopeEvidenceCountForTests(), 1)

    const initiated = await executeToolCall('skill_run_shell', {
      command: `lark-cli auth login --scope "${scope}" --no-wait --json`,
    }, context)
    const initiatedJson = JSON.stringify(initiated)
    assert.doesNotMatch(initiatedJson, new RegExp(deviceSecret))
    assert.match(initiatedJson, new RegExp(verificationUrl))
    const handle = initiatedJson.match(/ready-lark-auth-[0-9a-f-]+/)?.[0]
    assert.ok(handle)

    const qr = await executeToolCall('skill_run_shell', {
      command: `lark-cli auth qrcode "${verificationUrl}" --ascii`,
    }, context)
    assert.match(qr.text, /READY QR/)

    const askPromise = executeToolCall('skill_ask_user', {
      question: '授权链接和字符二维码已经显示。完成授权后请选择继续。',
      options: ['已完成授权'],
    }, context)
    const pendingAsk = await waitFor(() => getEphemeralExecutionStore().list()
      .find((entry) => entry.sessionId === sessionId) || null)
    assert.equal(getEphemeralExecutionStore().resolve(pendingAsk.executionId, '已完成授权'), true)
    const askOutput = await askPromise
    assert.equal(askOutput.data?.answer, '已完成授权')

    const completionPromise = executeToolCall('skill_run_shell', {
      command: `lark-cli auth login --device-code "${handle}" --json`,
    }, context)
    const confirmationCard = await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
    assert.match(confirmationCard.questions[0]?.question || '', /skill_run_shell/)
    assert.doesNotMatch(JSON.stringify({
      cardId: confirmationCard.cardId,
      sessionId: confirmationCard.sessionId,
      questions: confirmationCard.questions,
    }), new RegExp(deviceSecret))
    getAskUserQuestionsStore().resolve(confirmationCard.cardId, {
      answers: [{ id: FROZEN_CALL_QUESTION_ID, answer: FROZEN_CALL_CONFIRM_OPTION }],
      answeredAt: Date.now(),
    })
    const completed = await completionPromise
    assert.equal(completed.data?.exitCode, 0)
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(deviceSecret))

    const readback = await executeToolCall('skill_run_shell', {
      command: 'lark-cli auth status --json --verify',
    }, context)
    assert.match(String(readback.data?.stdout), /"verified":true/)
    assert.equal(executedCommands.length, 5)
    assert.match(executedCommands[3] || '', new RegExp(deviceSecret))

    const projection = readSkillTaskProjection({ sessionId, skillId: 'lark-cli' })
    assert.ok(projection)
    assert.doesNotMatch(JSON.stringify(projection), new RegExp(deviceSecret))
    assert.doesNotMatch(JSON.stringify(metrics), new RegExp(deviceSecret))
  } finally {
    clearLarkCliAuthFlowsForTests()
    clearSkillTaskProjection(sessionId)
    getEphemeralExecutionStore().clear()
    getAskUserQuestionsStore().clear()
    __setLarkCliRunShellExecutorForTests(null)
    __setSkillsRuntimeManagerForTests(null)
    __setMetricSinkForTests(null)
    _resetFrozenCallBridgeForTests()
  }
})
