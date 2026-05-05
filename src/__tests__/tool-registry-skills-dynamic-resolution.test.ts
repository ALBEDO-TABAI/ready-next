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

// =============================================================================
// Stage 4 W0 — Fallback observability baseline (W4 protection)
// =============================================================================
// W4 adds `skill_tool_dynamic_lookup_failed` metric at the innermost layer of
// 8 fallback paths (6 in tool-registry, 2 in skills-tools). These tests pin
// CURRENT behavior: silent catch + null/static return, no metric emit. W4
// commit will add the metric in the same commit as the test that verifies
// it — keeping W0 honest (no .skip, no future-only assertion).

test('Stage 4 W0: tool-registry currently catches dynamic-resolution errors and falls back to buildStaticSkillToolDefinition silently (no skill_tool_dynamic_lookup_failed metric)', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: per v6 plan §4 W4, the innermost emit + 60s throttle are added in W4 commit. W0 pins that the metric does NOT yet exist anywhere in tool-registry source so W4's addition is observable.
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/tool-registry.ts'), 'utf8')
  // Current behavior: at least one catch falls back to buildStaticSkillToolDefinition.
  assert.match(
    source,
    /catch[\s\S]{0,200}buildStaticSkillToolDefinition/,
    'tool-registry currently has at least one catch block that falls through to buildStaticSkillToolDefinition without metric emit',
  )
  // skill_tool_dynamic_lookup_failed must NOT be referenced before W4.
  assert.doesNotMatch(
    source,
    /skill_tool_dynamic_lookup_failed/,
    'skill_tool_dynamic_lookup_failed must not exist before W4 — W4 commit adds it as the innermost-only fallback metric',
  )
})

test('Stage 4 W0: skills-tools currently catches manager errors and falls back to PRIMITIVE_TOOL_DEFS / null silently (no skill_tool_dynamic_lookup_failed metric)', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: per v6 plan §4 W4, findSkillToolByNameForExecutionDetailed is the new wrapper added in W4 (existing legacy signature stays def|null). W0 pins that detailed wrapper does not yet exist and metric is unreferenced.
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/tools/skills-tools.ts'), 'utf8')
  // The wrapper must NOT exist before W4.
  assert.doesNotMatch(
    source,
    /findSkillToolByNameForExecutionDetailed/,
    'findSkillToolByNameForExecutionDetailed must not exist before W4 — W4 commit adds the structured wrapper alongside the legacy signature',
  )
  assert.doesNotMatch(
    source,
    /skill_tool_dynamic_lookup_failed/,
    'skill_tool_dynamic_lookup_failed must not exist in skills-tools before W4',
  )
  // Current behavior: findSkillToolByNameForExecution returns SkillToolDef | null and catches via try/catch.
  assert.match(
    source,
    /export function findSkillToolByNameForExecution\(toolName: string\): SkillToolDef \| null/,
    'findSkillToolByNameForExecution legacy signature (def|null) must remain — W4 keeps it unchanged and adds Detailed wrapper',
  )
})
