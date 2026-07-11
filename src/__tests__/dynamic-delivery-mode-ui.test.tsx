import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import ChatInput from '../renderer/components/agent/ChatInput'
import { BehaviorSection } from '../renderer/components/agent-system/AgentSettingsHub'

const common = {
  inputValue: 'hello', isStreaming: false, attachmentsCount: 0, hasUserMessages: false,
  pendingSendCount: 0, pendingSendCountdown: 0, isDragOver: false, contextUsage: null,
  composerShellStyle: {}, filePool: [], filePoolCount: 0, currentAgent: 'butler',
  currentAgentAvatar: 'R', currentAgentDisplayName: 'Ready', agents: [], isChannelScope: false,
  onInputChange: () => undefined, onSend: () => undefined, onStop: () => undefined,
  onUndo: () => undefined, onPickFiles: () => undefined, onAgentSelect: () => undefined,
  onSkillReference: () => undefined, onReferenceSelect: () => undefined,
  renderAttachmentIcon: () => null, ModelSelector: () => null,
  onThoroughOverrideChange: () => undefined,
}

test('settings exposes standard/adaptive and composer exposes a compact one-shot Boost control', () => {
  const settings = renderToStaticMarkup(createElement(BehaviorSection))
  assert.match(settings, /data-ready-delivery-mode="true"/)
  assert.match(settings, /标准/)
  assert.match(settings, /自适应/)
  assert.match(settings, /<option value="adaptive" selected="">自适应<\/option>/)
  const composer = renderToStaticMarkup(createElement(ChatInput, { ...common, thoroughOverride: true }))
  assert.match(composer, /data-ready-delivery-thorough="true"/)
  assert.match(composer, /aria-pressed="true"/)
  assert.match(composer, />Boost<\/button>/)
  assert.match(composer, /height:26px/)
  assert.doesNotMatch(composer, />彻底<\/button>/)
})
