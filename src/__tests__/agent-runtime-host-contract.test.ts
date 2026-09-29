import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function assertMatchesAll(
  content: string,
  expectations: Array<{ label: string; pattern: RegExp }>,
): void {
  for (const expectation of expectations) {
    assert.match(content, expectation.pattern, expectation.label)
  }
}

// P6-F1 测试随引擎退役摘除（P6f dormant 边界 + Phase C C4，2026-07-05）：
// "DirectChat 不得保留 host callbacks" 的负向断言在 direct-chat.ts 删除后失去
// 对象；requestSimpleText / ExecutionLoopOrchestrator / HostCapabilityDispatcher
// 的复活由 check-directchat-turnengine-dormant-boundary 的存在性合同与全 src/main
// import/构造扫描拦截。

test('production ownership keeps Codex as the only sender and DomainAdapterHost outside the core', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const codexHost = readWorkspaceFile('src/main/modules/agent-control/runtime-core/codex-host-orchestrator.ts')
  const contracts = readWorkspaceFile('src/main/modules/agent-control/contracts/run-contracts.ts')

  assertMatchesAll(contracts, [
    {
      label: 'phase3 should add a distinct execution turn result contract',
      pattern: /export interface ExecutionTurnResult/,
    },
  ])

  assertMatchesAll(runtime, [
    {
      label: 'runtime should construct the Codex host',
      pattern: /this\.orchestrator = new CodexHostOrchestrator\(/,
    },
    {
      label: 'runtime should construct the Codex coordinator without a legacy switch',
      pattern: /this\.runCoordinator = new RunCoordinator\(\{[\s\S]*?executeCodexPrepared:/,
    },
  ])
  assert.doesNotMatch(runtime, /codexProductRunPreparer|codexPreparationInput/)
  assert.match(codexHost, /export class CodexHostOrchestrator/)
  assert.match(codexHost, /private readonly domainAdapterHost = new DomainAdapterHost\(\)/)
  assert.doesNotMatch(codexHost, /AgentSdkRuntime|ReadyAgentOrchestrator|sendMessage\(/)
})
