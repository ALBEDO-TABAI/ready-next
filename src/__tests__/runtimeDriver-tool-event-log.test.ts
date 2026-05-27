import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const DRIVER_PATH = resolve(process.cwd(), 'src/renderer/modules/agent/runtimeDriver.ts')
const PRELOAD_PATH = resolve(process.cwd(), 'src/preload/index.ts')
const TURN_ENGINE_PATH = resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts')
const DIRECT_CHAT_PATH = resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts')
const AGENT_SDK_RUNTIME_PATH = resolve(process.cwd(), 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts')
const CAPABILITY_CONTROLLER_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/domain-adapters/run-capability-controller.ts',
)
const IPC_HANDLER_PATH = resolve(
  process.cwd(),
  'src/main/modules/claude-bridge/ipc/tool-event-group.ts',
)
const LOG_HELPER_PATH = resolve(process.cwd(), 'src/main/modules/tools/tool-event-log.ts')

describe('G-Z12 runtimeDriver 事件接入 ready-tools.log', () => {
  const driverSource = readFileSync(DRIVER_PATH, 'utf8')

  it('runtimeDriver 定义了 logToolEvent 辅助函数并通过 window.electronAPI.tools 发送', () => {
    assert.match(driverSource, /const logToolEvent = \(payload: \{/, 'logToolEvent 辅助函数缺失')
    assert.match(
      driverSource,
      /window\.electronAPI\.tools\?\.logToolEvent\?\.\(/,
      'logToolEvent 必须调用 window.electronAPI.tools.logToolEvent',
    )
  })

  it('runtimeDriver 在 dispatch / duplicate / cancel / self-rescue / watchdog / ack 6 个节点打点', () => {
    const types: Array<'dispatch' | 'ack' | 'watchdog' | 'cancel' | 'self-rescue' | 'duplicate'> = [
      'dispatch',
      'ack',
      'watchdog',
      'cancel',
      'self-rescue',
      'duplicate',
    ]
    for (const type of types) {
      // 允许两种写法：`type: 'xxx'` 直接字面量，或 `? 'xxx' :` 三元选取
      const re = new RegExp(`['"]${type}['"]`)
      assert.match(driverSource, re, `缺少 runtimeDriver 事件打点：${type}`)
    }
  })

  it('runtimeDriver 在 ack / watchdog / cancel / self-rescue 中携带 elapsedMs', () => {
    // 粗略做法：确保至少有 3 处 elapsedMs 出现在 logToolEvent 调用附近
    const matches = driverSource.match(/elapsedMs:\s*(Date\.now\(\)|budgetMs|(now\s*-\s*existing\.queuedAt))/g)
    assert.ok(matches && matches.length >= 3, 'ack/watchdog/cancel/self-rescue 至少有 3 处需要 elapsedMs 打点')
  })

  it('preload 白名单暴露 tools.logToolEvent 并通过 tools:logToolEvent 通道发送', () => {
    const preloadSource = readFileSync(PRELOAD_PATH, 'utf8')
    assert.match(preloadSource, /logToolEvent:\s*\(payload:/)
    assert.match(preloadSource, /ipcRenderer\.send\('tools:logToolEvent', payload\)/)
    assert.match(preloadSource, /tools:\s*toolsAPI/)
  })

  it('主进程 IPC 监听 tools:logToolEvent 并写入 ready-tools.log', () => {
    const ipcSource = readFileSync(IPC_HANDLER_PATH, 'utf8')
    assert.match(ipcSource, /ipcMain\.on\('tools:logToolEvent'/)
    assert.match(ipcSource, /appendToolEventLog\(/)
    const helperSource = readFileSync(LOG_HELPER_PATH, 'utf8')
    // Stage J log-lifecycle migrated tool-event log creation from
    // `getLogPath('ready-tools.log')` to the rotating-logger helper.
    assert.match(helperSource, /createRotatingLogger\('ready-tools\.log'\)/)
    assert.match(helperSource, /runtimeDriver type=/)
  })

  it('主进程能力裁决同步写入 ready-tools.log', () => {
    const turnEngineSource = readFileSync(TURN_ENGINE_PATH, 'utf8')
    const capabilityControllerSource = readFileSync(CAPABILITY_CONTROLLER_PATH, 'utf8')
    const helperSource = readFileSync(LOG_HELPER_PATH, 'utf8')
    assert.match(helperSource, /appendToolCapabilityLog/)
    assert.match(turnEngineSource, /appendToolCapabilityLog\(preparedCapabilityLogLine\)/)
    assert.match(turnEngineSource, /appendToolCapabilityLog\(effectiveCapabilityLogLine\)/)
    const directChatSource = readFileSync(DIRECT_CHAT_PATH, 'utf8')
    assert.match(directChatSource, /appendToolCapabilityLog\(`\[tool_capability\] stage=direct_chat_tool_loop/)
    const agentSdkRuntimeSource = readFileSync(AGENT_SDK_RUNTIME_PATH, 'utf8')
    assert.match(agentSdkRuntimeSource, /stage=sdk_runtime_default_tools/)
    assert.match(agentSdkRuntimeSource, /visibleCapabilityGroups=\$\{capabilityResolution\.visibleCapabilityGroupIds/)
    assert.match(capabilityControllerSource, /visibleCapabilityGroups=/)
  })
})
