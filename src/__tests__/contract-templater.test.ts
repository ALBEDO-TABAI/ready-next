/**
 * B-arch-2 — Restricted templater contract tests.
 *
 * Covers:
 * - whitelisted variable resolution (skill/agent/spawn/output_dir/env)
 * - env allowlist (HOME / XDG_CONFIG_HOME only)
 * - rejection of unknown variables
 * - JSON-stringification of array variables (e.g. ${agent.fallback_chain})
 * - injection-attempt rejection or literal-treatment ({{ }}, <%= %>, ${exec()},
 *   ${process.env.X}, $(whoami), ${{constructor...}})
 * - JSON pointer writes that create intermediate objects
 * - preserve_existing=true vs false semantics
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TemplateError,
  applyJsonPointer,
  makeTemplateContext,
  renderConfigFileContent,
  renderTemplate,
  resolveVariable,
  type TemplateContext,
} from '../main/modules/skills-runtime/contract-templater'

function makeCtx(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    skill: { id: 'video-expert-analyzer-vnext', name: 'VEA vnext', assetRoot: '/skills/vea' },
    agent: {
      model_id: 'kimi-k2',
      provider: 'kimi',
      api_key: 'sk-test-do-not-leak',
      base_url: 'https://api.example.com/v1',
      fallback_chain: ['kimi/k2', 'anthropic/opus'],
    },
    spawn: { job_id: 'abcd1234', tmp_dir: '/tmp/spawn-1', timestamp: '2026-04-25T00:00:00.000Z' },
    output_dir: '/tmp/out',
    ...overrides,
  }
}

// --- resolveVariable ---------------------------------------------------------

test('resolveVariable resolves every whitelisted scalar', () => {
  const ctx = makeCtx()
  assert.equal(resolveVariable('skill.id', ctx), 'video-expert-analyzer-vnext')
  assert.equal(resolveVariable('skill.name', ctx), 'VEA vnext')
  assert.equal(resolveVariable('skill.assetRoot', ctx), '/skills/vea')
  assert.equal(resolveVariable('agent.model_id', ctx), 'kimi-k2')
  assert.equal(resolveVariable('agent.provider', ctx), 'kimi')
  assert.equal(resolveVariable('agent.api_key', ctx), 'sk-test-do-not-leak')
  assert.equal(resolveVariable('agent.base_url', ctx), 'https://api.example.com/v1')
  assert.equal(resolveVariable('spawn.job_id', ctx), 'abcd1234')
  assert.equal(resolveVariable('spawn.tmp_dir', ctx), '/tmp/spawn-1')
  assert.equal(resolveVariable('spawn.timestamp', ctx), '2026-04-25T00:00:00.000Z')
  assert.equal(resolveVariable('output_dir', ctx), '/tmp/out')
})

test('resolveVariable JSON-stringifies array values', () => {
  const ctx = makeCtx()
  assert.equal(resolveVariable('agent.fallback_chain', ctx), '["kimi/k2","anthropic/opus"]')
})

test('resolveVariable allows env.HOME and env.XDG_CONFIG_HOME', () => {
  const ctx = makeCtx()
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  try {
    process.env.HOME = '/Users/test'
    process.env.XDG_CONFIG_HOME = '/Users/test/.config'
    assert.equal(resolveVariable('env.HOME', ctx), '/Users/test')
    assert.equal(resolveVariable('env.XDG_CONFIG_HOME', ctx), '/Users/test/.config')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
  }
})

test('resolveVariable rejects env.PATH and other env vars', () => {
  const ctx = makeCtx()
  assert.throws(() => resolveVariable('env.PATH', ctx), (err: unknown) => {
    return err instanceof TemplateError && err.variable === 'env.PATH'
  })
  assert.throws(() => resolveVariable('env.SECRET', ctx), TemplateError)
})

test('resolveVariable rejects unknown variable roots and unknown leaves', () => {
  const ctx = makeCtx()
  assert.throws(() => resolveVariable('unknown.field', ctx), TemplateError)
  assert.throws(() => resolveVariable('skill.does_not_exist', ctx), TemplateError)
  assert.throws(() => resolveVariable('process.env', ctx), TemplateError)
})

test('resolveVariable rejects indexing into output_dir leaf', () => {
  const ctx = makeCtx()
  assert.throws(() => resolveVariable('output_dir.subpath', ctx), TemplateError)
})

test('resolveVariable rejects an object-valued path (must be scalar or array)', () => {
  const ctx = makeCtx()
  assert.throws(() => resolveVariable('agent', ctx), TemplateError)
  assert.throws(() => resolveVariable('skill', ctx), TemplateError)
})

// --- renderTemplate ----------------------------------------------------------

test('renderTemplate substitutes well-formed expressions', () => {
  const ctx = makeCtx()
  const out = renderTemplate(
    '/Users/x/.config/${skill.id}/config.json -> ${agent.model_id}',
    ctx,
  )
  assert.equal(
    out,
    '/Users/x/.config/video-expert-analyzer-vnext/config.json -> kimi-k2',
  )
})

test('renderTemplate returns plain strings unchanged', () => {
  const ctx = makeCtx()
  assert.equal(renderTemplate('no variables here', ctx), 'no variables here')
  assert.equal(renderTemplate('', ctx), '')
})

test('renderTemplate throws on the first unknown variable', () => {
  const ctx = makeCtx()
  assert.throws(() => renderTemplate('${skill.id}/${unknown.x}', ctx), TemplateError)
})

test('renderTemplate rejects ${exec(...)} as residual ${... that did not match var grammar', () => {
  const ctx = makeCtx()
  assert.throws(() => renderTemplate(`call ${'${exec(\'rm -rf /\')}'}`, ctx), TemplateError)
})

test('renderTemplate rejects ${{constructor.constructor(\'return process\')()}}', () => {
  const ctx = makeCtx()
  assert.throws(
    () =>
      renderTemplate(
        // The double-brace form opens with `${{` which is not valid var grammar.
        // Either the regex won't match (-> residual ${ -> reject) or unknown-var.
        'attempt: ${{constructor.constructor(\'return process\')()}}',
        ctx,
      ),
    TemplateError,
  )
})

test('renderTemplate rejects ${process.env.HOME} (process root not whitelisted)', () => {
  const ctx = makeCtx()
  assert.throws(() => renderTemplate('${process.env.HOME}', ctx), TemplateError)
})

test('renderTemplate treats $(whoami) as literal (no ${ opening)', () => {
  const ctx = makeCtx()
  // POSIX command substitution $(...) has no `${` opener, so we leave it
  // as text. The renderer never evaluates it; downstream consumers decide.
  assert.equal(renderTemplate('$(whoami) ${skill.id}', ctx), '$(whoami) video-expert-analyzer-vnext')
})

test('renderTemplate treats {{eval}} and <%= %> as literal text', () => {
  const ctx = makeCtx()
  assert.equal(renderTemplate('{{eval}}/<%= x %>', ctx), '{{eval}}/<%= x %>')
})

test('renderTemplate rejects ${} with empty body', () => {
  const ctx = makeCtx()
  // `${}` does not match the var-name regex; residual `${` triggers the second pass.
  assert.throws(() => renderTemplate('foo ${} bar', ctx), TemplateError)
})

// --- makeTemplateContext -----------------------------------------------------

test('makeTemplateContext mints fresh job_id and tmp_dir each call', () => {
  const a = makeTemplateContext({
    skill: { id: 's', name: 'S', assetRoot: '/x' },
    agent: {
      model_id: 'm',
      provider: 'p',
      api_key: 'k',
      base_url: 'http://b',
      fallback_chain: [],
    },
  })
  const b = makeTemplateContext({
    skill: { id: 's', name: 'S', assetRoot: '/x' },
    agent: {
      model_id: 'm',
      provider: 'p',
      api_key: 'k',
      base_url: 'http://b',
      fallback_chain: [],
    },
  })
  assert.match(a.spawn.job_id, /^[0-9a-f]{8}$/)
  assert.match(b.spawn.job_id, /^[0-9a-f]{8}$/)
  assert.notEqual(a.spawn.job_id, b.spawn.job_id)
  assert.ok(a.spawn.tmp_dir.includes(a.spawn.job_id))
  assert.ok(typeof a.spawn.timestamp === 'string' && a.spawn.timestamp.length > 0)
})

test('makeTemplateContext defensively copies fallback_chain', () => {
  const chain = ['a', 'b']
  const ctx = makeTemplateContext({
    skill: { id: 's', name: 'S', assetRoot: '/x' },
    agent: {
      model_id: 'm',
      provider: 'p',
      api_key: 'k',
      base_url: 'http://b',
      fallback_chain: chain,
    },
  })
  chain.push('c')
  assert.deepEqual(ctx.agent.fallback_chain, ['a', 'b'])
})

// --- applyJsonPointer --------------------------------------------------------

test('applyJsonPointer creates intermediate objects', () => {
  const target: Record<string, unknown> = {}
  applyJsonPointer(target, '/a/b/c', 'value')
  assert.deepEqual(target, { a: { b: { c: 'value' } } })
})

test('applyJsonPointer overwrites existing leaf', () => {
  const target: Record<string, unknown> = { x: { y: 'old' } }
  applyJsonPointer(target, '/x/y', 'new')
  assert.deepEqual(target, { x: { y: 'new' } })
})

test('applyJsonPointer replaces non-object intermediates with fresh objects', () => {
  const target: Record<string, unknown> = { x: 'scalar' }
  applyJsonPointer(target, '/x/y', 1)
  assert.deepEqual(target, { x: { y: 1 } })
})

test('applyJsonPointer accepts arbitrary value types', () => {
  const target: Record<string, unknown> = {}
  applyJsonPointer(target, '/list', [1, 2, 3])
  applyJsonPointer(target, '/flag', true)
  applyJsonPointer(target, '/n', 42)
  assert.deepEqual(target, { list: [1, 2, 3], flag: true, n: 42 })
})

test('applyJsonPointer rejects pointers without leading slash', () => {
  assert.throws(() => applyJsonPointer({}, 'a/b', 1), TemplateError)
  assert.throws(() => applyJsonPointer({}, '', 1), TemplateError)
})

test('applyJsonPointer rejects empty segments', () => {
  assert.throws(() => applyJsonPointer({}, '/a//b', 1), TemplateError)
  assert.throws(() => applyJsonPointer({}, '/', 1), TemplateError)
})

// --- renderConfigFileContent -------------------------------------------------

test('renderConfigFileContent (json, preserve_existing=true) keeps untouched fields', () => {
  const ctx = makeCtx()
  const existing = JSON.stringify({
    auto_scoring: { preferred_model: 'old', extra_field: 'keepme' },
    other_top: { keep: true },
  })
  const out = renderConfigFileContent(
    {
      format: 'json',
      preserve_existing: true,
      fields: {
        '/auto_scoring/preferred_model': '${agent.model_id}',
      },
    },
    existing,
    ctx,
  )
  const parsed = JSON.parse(out) as Record<string, unknown>
  const autoScoring = parsed['auto_scoring'] as Record<string, unknown>
  assert.equal(autoScoring['preferred_model'], 'kimi-k2')
  assert.equal(autoScoring['extra_field'], 'keepme')
  assert.deepEqual(parsed['other_top'], { keep: true })
})

test('renderConfigFileContent (json, preserve_existing=false) yields only declared fields', () => {
  const ctx = makeCtx()
  const existing = JSON.stringify({
    auto_scoring: { preferred_model: 'old', extra_field: 'should_disappear' },
  })
  const out = renderConfigFileContent(
    {
      format: 'json',
      preserve_existing: false,
      fields: {
        '/auto_scoring/preferred_model': '${agent.model_id}',
      },
    },
    existing,
    ctx,
  )
  const parsed = JSON.parse(out) as Record<string, unknown>
  assert.deepEqual(parsed, { auto_scoring: { preferred_model: 'kimi-k2' } })
})

test('renderConfigFileContent rewrites array fields as real JSON arrays, not strings', () => {
  const ctx = makeCtx()
  const out = renderConfigFileContent(
    {
      format: 'json',
      fields: {
        '/auto_scoring/fallback_models': '${agent.fallback_chain}',
      },
    },
    null,
    ctx,
  )
  const parsed = JSON.parse(out) as Record<string, unknown>
  const autoScoring = parsed['auto_scoring'] as Record<string, unknown>
  assert.deepEqual(autoScoring['fallback_models'], ['kimi/k2', 'anthropic/opus'])
})

test('renderConfigFileContent works with null existingContent (creates fresh object)', () => {
  const ctx = makeCtx()
  const out = renderConfigFileContent(
    {
      format: 'json',
      preserve_existing: true,
      fields: {
        '/a/b': '${skill.id}',
      },
    },
    null,
    ctx,
  )
  const parsed = JSON.parse(out) as Record<string, unknown>
  const a = parsed['a'] as Record<string, unknown>
  assert.equal(a['b'], 'video-expert-analyzer-vnext')
})

test('renderConfigFileContent with malformed existing JSON falls back to fresh object', () => {
  const ctx = makeCtx()
  const out = renderConfigFileContent(
    {
      format: 'json',
      preserve_existing: true,
      fields: { '/x': '${skill.id}' },
    },
    'not valid json {',
    ctx,
  )
  const parsed = JSON.parse(out) as Record<string, unknown>
  assert.equal(parsed['x'], 'video-expert-analyzer-vnext')
})

test('renderConfigFileContent (yaml) round-trips a simple object', () => {
  const ctx = makeCtx()
  const out = renderConfigFileContent(
    {
      format: 'yaml',
      fields: {
        '/auto_scoring/preferred_model': '${agent.model_id}',
      },
    },
    null,
    ctx,
  )
  // YAML output should contain the model id under the nested path.
  assert.match(out, /auto_scoring:/)
  assert.match(out, /preferred_model: kimi-k2/)
})

test('renderConfigFileContent throws unsupported_format for toml/ini', () => {
  const ctx = makeCtx()
  assert.throws(
    () =>
      renderConfigFileContent(
        { format: 'toml', fields: { '/x': 'y' } },
        null,
        ctx,
      ),
    /unsupported_format/,
  )
  assert.throws(
    () =>
      renderConfigFileContent(
        { format: 'ini', fields: { '/x': 'y' } },
        null,
        ctx,
      ),
    /unsupported_format/,
  )
})

test('renderConfigFileContent does not leak api_key through error messages', () => {
  const ctx = makeCtx()
  // Force an error by referencing an unknown variable; ensure the agent's
  // api_key value never appears in the thrown message.
  try {
    renderConfigFileContent(
      { format: 'json', fields: { '/x': '${unknown.var}' } },
      null,
      ctx,
    )
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof Error)
    assert.ok(!err.message.includes('sk-test-do-not-leak'))
  }
})
