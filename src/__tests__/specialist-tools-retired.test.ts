import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_INTERACTION_TOOL_NAMES,
  getAgentInteractionAnthropicTools,
  getAgentInteractionOpenAITools,
} from '../main/modules/tools/agent-interaction-tool-defs'
import { AGENT_INTERACTION_SCHEMAS } from '../main/modules/tools/schemas/agent-interaction-schemas'

const retired = new Set([
  'propose_specialist_blueprint',
  'confirm_specialist_blueprint',
  'rename_specialist_agent',
])

test('agent_interaction exposes only structured questions and completion criteria', () => {
  assert.deepEqual(AGENT_INTERACTION_TOOL_NAMES, ['ask_user_questions', 'declare_completion_criteria'])
  const anthropicNames = getAgentInteractionAnthropicTools().map((tool) => String(tool.name))
  const openAINames = getAgentInteractionOpenAITools().map((tool) => String((tool.function as { name: string }).name))
  assert.deepEqual(anthropicNames, AGENT_INTERACTION_TOOL_NAMES)
  assert.deepEqual(openAINames, AGENT_INTERACTION_TOOL_NAMES)
  for (const name of retired) {
    assert.equal(anthropicNames.includes(name), false)
    assert.equal(openAINames.includes(name), false)
    assert.equal(name in AGENT_INTERACTION_SCHEMAS, false)
  }
})
