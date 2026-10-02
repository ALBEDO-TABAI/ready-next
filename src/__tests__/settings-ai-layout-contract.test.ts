import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('ai settings panel separates the model list from the second-level editor', () => {
  // 合同随实现同步：2026-07-05 Settings.tsx 面板拆分，AI 面板锚点移至 settings/AISettingsPanel.tsx 与 settings/settings-shared.tsx（三文件都扫，断言不变量不动）。
  const settingsPage = [
    readWorkspaceFile('src/renderer/pages/Settings.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/AISettingsPanel.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/settings-shared.tsx'),
  ].join('\n')

  assert.match(settingsPage, /OpenAI/)
  assert.match(settingsPage, /Anthropic/)
  assert.match(settingsPage, /Gemini/)
  assert.match(settingsPage, /自定义/)
  assert.match(settingsPage, /模型入口列表/)
  assert.match(settingsPage, /添加模型/)
  assert.match(settingsPage, /profileDetailOpen/)
  assert.match(settingsPage, /openProfileDetail/)
  assert.match(settingsPage, /返回模型列表/)
  assert.match(settingsPage, /配置/)
  assert.match(settingsPage, /编辑 \{selectedProfile\.name\}/)
  assert.match(settingsPage, /role="tablist"/)
  assert.match(settingsPage, /aria-label="模型配置分区"/)
  assert.match(settingsPage, /showInChatSwitcher/)
  assert.match(settingsPage, /在切换面板显示/)
  assert.match(settingsPage, /模型列表/)
  assert.match(settingsPage, /defaultModelOptions/)
  assert.match(settingsPage, /先添加模型 ID/)
  assert.match(settingsPage, /添加模型 ID/)
  assert.match(settingsPage, /设为默认/)
  assert.match(settingsPage, /能力分组/)
  assert.doesNotMatch(settingsPage, /合并窗口/)
  assert.doesNotMatch(settingsPage, /agent_message_coalesce_(?:enabled|window_ms)/)
  assert.match(settingsPage, /自定义服务缺少明确上下文窗口/)
  assert.match(settingsPage, /单次最大输出 token/)
  assert.match(settingsPage, /maxOutputTokensOverride/)
  assert.doesNotMatch(settingsPage, /模型与上下文/)
  assert.doesNotMatch(settingsPage, /对话发送/)
  // 2026-07 设置页收敛：容器统一宽度与内边距，AI 区加宽职责移入
  // AISettingsPanel 自身（详情 880 / 列表 1120），isAiSection 分支退场。
  // 2026-10-02 视觉重整：内容贴近导航左对齐并随窗口舒展（上限 1360，左右留白 clamp 等比放大）。
  assert.match(settingsPage, /maxWidth: 1360/)
  assert.doesNotMatch(settingsPage, /isAiSection/)
  assert.match(settingsPage, /maxWidth: profileDetailOpen \? 880 : 1120/)
  assert.match(settingsPage, /padding: '40px clamp\(48px, 4\.5vw, 88px\) 80px'/)
  assert.match(settingsPage, /gridTemplateColumns: 'minmax\(360px,1\.6fr\) minmax\(160px,\.55fr\) 120px 88px'/)
  assert.doesNotMatch(settingsPage, /isCustomModelInput/)
  assert.doesNotMatch(settingsPage, /模型 ID，如 gpt-5\.4/)
  assert.doesNotMatch(settingsPage, /2xl:grid-cols/)
})
