import assert from 'node:assert/strict'
import test from 'node:test'

import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'

test('memory capability exposes only the new read-only Ready search tool', () => {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const definitions = defaultToolRegistry.getToolDefinitionsForGroup('memory', undefined, authorization)

  assert.deepEqual(definitions.map((definition) => definition.name), ['ready_memory_search'])
  assert.deepEqual(definitions.map((definition) => definition.kind), ['read'])
  for (const provider of ['anthropic', 'openai'] as const) {
    const schemas = defaultToolRegistry.getToolSchemasForGroup('memory', provider, undefined, authorization)
    assert.deepEqual(
      schemas.map((schema) => provider === 'anthropic'
        ? schema.name
        : (schema.function as Record<string, unknown> | undefined)?.name),
      ['ready_memory_search'],
    )
    assert.doesNotMatch(JSON.stringify(schemas), /memory_(?:create|update|list_recent)/)
  }
})
