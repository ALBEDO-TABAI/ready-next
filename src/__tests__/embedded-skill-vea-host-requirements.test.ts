/**
 * B Phase 4 (host-contract) — VEA host_requirements smoke test.
 *
 * Asserts the video-expert-analyzer manifest's `host_requirements` block
 * compiles via SkillHostRequirementsSchema and surfaces on the
 * SkillDefinition as `hostRequirements` (camelCase per skill-compiler
 * convention; manifest stays snake_case to match the rest of the contract).
 *
 * The hardcoded paths and values here are load-bearing: SkillHostController
 * uses them to inject ${agent.*} into VEA's config dir
 * (`~/.config/video-expert-analyzer-vnext/...` — note the dir name carries
 * the `-vnext` suffix even though the skill id no longer does, because
 * `pipeline_enhanced.py:80` reads that path literally).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'video-expert-analyzer')

test('VEA manifest exposes host_requirements with VEA-specific config path', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const hr = def.hostRequirements
  assert.ok(hr, 'hostRequirements must be present on the SkillDefinition')

  const configFile = hr!.spawn_context?.config_file
  assert.ok(configFile, 'spawn_context.config_file must be present')
  assert.equal(
    configFile!.path,
    '~/.config/video-expert-analyzer-vnext/config.json',
    'config path is hardcoded to the legacy vnext dir read by pipeline_enhanced.py:80',
  )
  assert.equal(configFile!.format, 'json')
  assert.equal(configFile!.preserve_existing, true, 'must merge into the user existing config, not clobber it')
})

test('VEA manifest declares wc allowlist extension and long-running default timeout', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const hr = def.hostRequirements
  assert.ok(hr)

  assert.deepEqual(
    hr!.shell_allowlist_extensions,
    ['wc'],
    'wc is needed by VEA scripts (subtitle line counting); not in the base allowlist',
  )
  assert.equal(
    hr!.default_action_timeout_ms,
    10_800_000,
    'VEA pipeline can span long child-run phases and must not be cut off at the old 1h cap',
  )
})

test('VEA manifest opts into sentinel_file status detection on run_state.json', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const sd = def.hostRequirements!.status_detection
  assert.ok(sd, 'status_detection must be present')
  assert.equal(sd!.method, 'sentinel_file')
  assert.equal(sd!.file_path, '${output_dir}/run_state.json')
  assert.equal(sd!.json_field, 'status')
  assert.deepEqual(
    sd!.blocked_values,
    ['blocked', 'pending_review', 'awaiting_input'],
    'matches the staged-pipeline blocking states',
  )
})

test('VEA manifest registers config dir for uninstall lifecycle cleanup', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const lifecycle = def.hostRequirements!.lifecycle
  assert.ok(lifecycle, 'lifecycle must be present so uninstall removes spawned config dir')
  assert.deepEqual(lifecycle!.on_uninstall_remove, ['~/.config/video-expert-analyzer-vnext'])
})

test('VEA manifest declares spawned model input modes from Ready agent truth', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const secondary = def.hostRequirements!.spawn_context?.secondary_files?.[0]
  assert.ok(secondary, 'spawn_context.secondary_files[0] must create the VEA model catalog')
  assert.match(
    secondary!.content_template,
    /"input":\$\{agent\.input_modes\}/,
    'spawned VEA model catalog must not hard-code image input support',
  )
  assert.doesNotMatch(
    secondary!.content_template,
    /"input":\["text","image"\]/,
    'hard-coded text+image support would bypass provider vision preflight truth',
  )
})

test('VEA manifest declares child-loop ownership instead of relying on core hard-coded action tables', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })

  assert.deepEqual(def.childLoop?.actions, [
    'video_expert_pipeline',
    'video_expert_ai_analyze',
  ])
})
