/**
 * Phase C C2 合同（2026-07-05，docs/superpowers/plans/2026-07-05-C-directchat-retirement-implementation.md）
 * —— DomainAdapterHost 与 DirectChatEngine 的装配平移对账。
 *
 * 为什么是源码结构合同而不是行为测试：两个模块的装配图都值导入 electron
 * 邻域（direct-chat.ts 值导入 BrowserController→ipc-handler→electron；
 * 双方构造时真实 new 出 8 个域适配器与 DB-backed store），纯 Node 测试
 * 进程无法 import 构造后比对实例——这正是测试规约"行为测试无法证明的
 * 硬合同"许可的结构测试场景。行为面由 verify:stability 全链 + C3 切换后
 * 的既有行为套件覆盖。
 *
 * 合同三条：
 * 1. 适配器装配序列逐位相等（含 Research 首位——护
 *    check-research-adapter-registered-in-host.cjs 的语义前提）；
 * 2. 引擎的活闭包接线在 host 中逐一存在（装配厂平移完整性）；
 * 3. 引擎的暗线符号在 host 中零出现（合同 §0 判决：暗线只能删，
 *    不得借平移复活）。
 *
 * C4 引擎删除后：ENGINE 文件读取分支自动退场（existsSync 守卫），
 * 本测试退化为 host 单侧的接线+反暗线合同，无需重锚。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ENGINE = join(ROOT, 'src/main/modules/claude-bridge/direct-chat.ts')
const HOST = join(ROOT, 'src/main/modules/agent-control/domain-adapters/domain-adapter-host.ts')

function extractAdapterSequence(source: string, file: string): string[] {
  const marker = source.indexOf('this.domainAdapters = [')
  assert.ok(marker >= 0, `${file}: domainAdapters assembly array not found`)
  const tail = source.slice(marker)
  const close = tail.indexOf(']')
  assert.ok(close > 0, `${file}: domainAdapters array not closed`)
  const block = tail.slice(0, close)
  const names = [...block.matchAll(/new\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1])
  assert.ok(names.length > 0, `${file}: no adapter constructions found in assembly array`)
  return names
}

const LIVE_WIRES = [
  // BrowserTaskPlanner 闭包组
  'getSessionAttachmentHints',
  'getSessionAttachmentResourceList',
  'getSessionAttachmentResources',
  'getIncomingAttachmentHints',
  'getTabContext',
  // SkillContextOrchestrator 装配
  'resolveSkillToolByAction',
  'resolveSkillToolByName',
  // document pipeline 的 runtime 两闭包 + 子任务运行时 + widget 租约
  'getConversationScope',
  'publishScopeRunEvent',
  'createSubtaskRuntime',
  'acquireWidgetEditLease',
  'resolveWidgetEditLease',
  // 执行客户端三件套的共享传输闭包
  'fetchWithTimeout',
  'serializeMessages',
]

// 合同 §0 判决为暗线的符号——host 中出现即违约（借平移复活旧路径）。
const DARK_WIRES = [
  'setSidecarManager',
  'sidecarManager',
  'setRunCleanupRegistry',
  'runCleanupRegistry',
  'TOOL_SYSTEM_PROMPT',
  'registerSessionAbortSource',
  'unregisterSessionAbortSource',
  'stopGeneration',
  'maxToolIterations',
  'getAIConfig',
  'setSystemPrompt',
  'resolveContinuationState',
  'DesignToolLoopOrchestrator',
]

test('DomainAdapterHost mirrors the engine adapter assembly sequence (Research first)', () => {
  const hostSrc = readFileSync(HOST, 'utf8')
  const hostSeq = extractAdapterSequence(hostSrc, 'domain-adapter-host.ts')
  assert.equal(hostSeq[0], 'ResearchDomainAdapter', 'Research adapter must stay first (W1.6 gate semantics)')
  if (existsSync(ENGINE)) {
    const engineSrc = readFileSync(ENGINE, 'utf8')
    const engineSeq = extractAdapterSequence(engineSrc, 'direct-chat.ts')
    assert.deepEqual(hostSeq, engineSeq, 'host adapter assembly must match engine order exactly during coexistence')
  } else {
    // C4 之后引擎已删：host 单侧钉死八适配器全家福，防静默丢装配。
    assert.deepEqual(hostSeq, [
      'ResearchDomainAdapter',
      'MapDomainAdapter',
      'BrowserDomainAdapter',
      'DocumentDomainAdapter',
      'SkillDomainAdapter',
      'RSSDomainAdapter',
      'CalendarDomainAdapter',
      'FeishuDomainAdapter',
    ])
  }
})

test('DomainAdapterHost carries every live closure wire from the engine assembly', () => {
  const hostSrc = readFileSync(HOST, 'utf8')
  for (const wire of LIVE_WIRES) {
    assert.ok(hostSrc.includes(wire), `live wire missing in host: ${wire}`)
  }
})

test('DomainAdapterHost resurrects none of the adjudicated dark wires', () => {
  // 注释剥离后扫描：文件头文档允许点名暗线（那是合同说明），代码里出现才违约。
  const hostSrc = readFileSync(HOST, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '')
  for (const wire of DARK_WIRES) {
    assert.ok(!hostSrc.includes(wire), `dark wire resurrected in host: ${wire}`)
  }
})

test('DomainAdapterHost keeps the newSession live side-effects as resetSession', () => {
  const hostSrc = readFileSync(HOST, 'utf8')
  assert.ok(/resetSession\(name: string\): void \{\s*this\.documentTaskPipelineExecutor\.clearSessionCache\(name\)\s*this\.widgetEditLeaseStore\.release\(name\)\s*\}/m.test(hostSrc),
    'resetSession must carry exactly the two live side-effects (clearSessionCache + lease release)')
})
