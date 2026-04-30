/**
 * Regression test for the bundled-production skills-tool resolution bug.
 *
 * A previous implementation used `createRequire(import.meta.url)` + relative
 * path lazy-require to load `../tools/skills-tools` at call time. After
 * electron-vite bundled the main process into `out/main/index.js`, that
 * `createRequire` resolved against the bundle directory and silently failed
 * with:
 *
 *   Cannot find module '../tools/skills-tools'
 *   Require stack: - .../out/main/index.js
 *
 * The registry caught the error and fell back to `STATIC_SKILL_TOOL_NAMES`,
 * which lists 14 hardcoded skill tools. User-installed custom skills (e.g.
 * `skill_novel_writer_system_read_skill`) were never surfaced to the model —
 * so even after every upstream gate (preferredSkillToolNames, arbitration,
 * intent classification) was fixed, the tool literally did not exist in the
 * registry for the model to call.
 *
 * These assertions pin the source-level contract that prevents a future
 * refactor from re-introducing the relative-path lazy-require pattern.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { ToolRegistry } from '../main/modules/agent-control/tool-registry'

test('tool-registry imports skills-tools / system-tools at module top (not via lazyRequire)', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: electron-vite bundle safety depends on static import topology rather than runtime registry output
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/tool-registry.ts'), 'utf8')

  assert.match(
    source,
    /^import \{[\s\S]*?getSkillAnthropicTools,[\s\S]*?getSkillOpenAITools,[\s\S]*?\} from '\.\.\/tools\/skills-tools'$/m,
    'skills-tools must be imported at module top so electron-vite inlines it into the bundle',
  )
  assert.match(
    source,
    /^import \{ getSystemAnthropicTools, getSystemOpenAITools \} from '\.\.\/tools\/system-tools'$/m,
    'system-tools must be imported at module top so electron-vite inlines it into the bundle',
  )
})

test('tool-registry has no lazyRequire or createRequire invocation', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: bundled production regressed specifically through createRequire/lazyRequire topology
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/tool-registry.ts'), 'utf8')

  // Allow "createRequire" to appear only inside comments (we intentionally
  // leave a forensic explanation behind). Strip // and /* */ comments first.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.doesNotMatch(
    stripped,
    /lazyRequire/,
    'lazyRequire is forbidden — bundled production cannot resolve relative paths via createRequire(import.meta.url)',
  )
  assert.doesNotMatch(
    stripped,
    /createRequire\s*\(/,
    'createRequire is forbidden in tool-registry — use top-level static imports so electron-vite inlines the module',
  )
})

test('tool-registry falls back to static skills definitions and schemas when dynamic resolution fails', () => {
  const registry = new ToolRegistry({
    __testGroupProviders: {
      skills: {
        staticToolNames: ['skill_static_fallback_read_skill'],
        getToolDefinitions: () => {
          throw new Error('dynamic definitions unavailable')
        },
      },
    },
  })

  const definitions = registry.getToolDefinitionsResolutionForGroup('skills')
  assert.equal(definitions.usedStaticFallback, true)
  assert.equal(definitions.error, 'dynamic definitions unavailable')
  assert.deepEqual(definitions.definitions.map((tool) => tool.name), ['skill_static_fallback_read_skill'])

  const schemas = registry.getToolSchemasResolutionForGroup('skills', 'openai')
  assert.equal(schemas.usedStaticFallback, true)
  assert.deepEqual(schemas.tools.map((tool) => (tool.function as { name: string }).name), [
    'skill_static_fallback_read_skill',
  ])
})
