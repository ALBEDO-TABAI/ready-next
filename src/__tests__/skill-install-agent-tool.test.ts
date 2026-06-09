import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import { EMBEDDED_SKILL_IDS } from '../main/modules/skills-runtime/manifest'
import type { FetchLike } from '../main/modules/skills-runtime/skill-source-registry'
import {
  executeInstallSkill,
  type InstallSkillDeps,
} from '../main/modules/tools/builtins/install-skill'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('skill-install-agent-tool declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill-install-agent-tool transitive sqlite load')
})

const execFileAsync = promisify(execFile)

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const SKILL_MD = ['---', 'name: My Skill', 'license: MIT', '---', '# My Skill', 'advisory content'].join('\n')

async function makeTarGz(layout: Record<string, string>, topEntry: string): Promise<Buffer> {
  const work = scratch('ready-agent-src-')
  try {
    for (const [relPath, content] of Object.entries(layout)) {
      const full = join(work, relPath)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    const out = join(scratch('ready-agent-out-'), 'archive.tar.gz')
    await execFileAsync('tar', ['-czf', out, '-C', work, topEntry])
    return readFileSync(out)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function serve(buffer: Buffer): FetchLike {
  return async () => new Response(buffer, { headers: { 'content-length': String(buffer.length) } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeManager(): { manager: SkillsRuntimeManager; cleanup: () => void } {
  const runtimeRoot = scratch('ready-agent-rt-')
  const embeddedRoot = scratch('ready-agent-embedded-')
  return {
    manager: new SkillsRuntimeManager({ runtimeRoot, embeddedSkillsRoot: embeddedRoot, startBackgroundTasks: false }),
    cleanup: () => {
      rmSync(runtimeRoot, { recursive: true, force: true })
      rmSync(embeddedRoot, { recursive: true, force: true })
    },
  }
}

// Wrap the real manager so the handler (which calls resolveSkillSource /
// installSkillFromSource with no inject) still drives the test's fake fetch.
function makeDeps(
  manager: SkillsRuntimeManager,
  opts: { resolveFetch?: FetchLike; installFetch?: FetchLike } = {},
): InstallSkillDeps {
  return {
    manager: {
      resolveSkillSource: (input) =>
        manager.resolveSkillSource(input, opts.resolveFetch ? { fetchImpl: opts.resolveFetch } : {}),
      installSkillFromSource: (request) =>
        manager.installSkillFromSource(request, undefined, opts.installFetch ? { fetchImpl: opts.installFetch } : {}),
    },
  }
}

function jsonData(output: { shape: string; data: Record<string, unknown> | null }): Record<string, unknown> {
  assert.equal(output.shape, 'json', 'the tool must return structured JSON')
  assert.ok(output.data, 'structured data must be present')
  return output.data as Record<string, unknown>
}

test('phase 1 resolves read-only, returns needsConfirmation, and does NOT install', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const deps = makeDeps(manager)
    // A direct tarball needs no network to resolve (no ref pin / repo metadata).
    const output = await executeInstallSkill(
      { instruction: 'https://example.com/pack.tar.gz' },
      deps,
    )
    const data = jsonData(output)

    assert.equal(data.needsConfirmation, true)
    assert.equal(data.installable, true)
    assert.ok(data.source && (data.source as { kind?: string }).kind === 'tarball')
    assert.equal(
      manager.listSkills().some((s) => s.source === 'custom'),
      false,
      'the resolve phase must never install',
    )
  } finally {
    cleanup()
  }
})

test('phase 1 surfaces concrete risk reasons for a look-alike / typosquat install doc', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const bundledId = [...EMBEDDED_SKILL_IDS][0]
    const docText = [
      `# 安装 ${bundledId}-260324 技能`,
      '从 https://github.com/op7418/guizang-ppt-skill 获取真实技能。',
    ].join('\n')
    const resolveFetch: FetchLike = async (url) => {
      if (url.includes('redskill.xiaohongshu.net')) {
        return new Response(docText, { headers: { 'content-type': 'text/markdown' } })
      }
      if (url.includes('/commits')) return jsonResponse([{ sha: 'deadbeefdead0002' }])
      if (url.includes('/repos/')) return jsonResponse({ default_branch: 'main', license: { spdx_id: 'MIT' } })
      return new Response('not found', { status: 404 })
    }
    const output = await executeInstallSkill(
      { instruction: 'https://redskill.xiaohongshu.net/install.md' },
      makeDeps(manager, { resolveFetch }),
    )
    const data = jsonData(output)

    assert.equal(data.needsConfirmation, true)
    assert.equal(data.riskTier, 'untrusted')
    const reasons = new Set((data.riskReasons as Array<{ reason: string }>).map((r) => r.reason))
    assert.ok(reasons.has('look-alike-domain'), 'xiaohongshu.net ≠ .com must flag look-alike')
    assert.ok(reasons.has('typosquat-of-bundled-skill'), 'the version-suffixed bundled name must flag a typosquat')
    assert.ok(reasons.has('indirect-install-doc'), 'the indirect install doc must be flagged')
    // The human-facing text must carry the concrete details for ask_user_questions.
    assert.match(output.text, /xiaohongshu\.net/)
  } finally {
    cleanup()
  }
})

test('phase 2 installs with trustAck after echoing the resolved source, registering the skill', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const buffer = await makeTarGz({ 'pkg/SKILL.md': SKILL_MD }, 'pkg')
    const deps = makeDeps(manager, { installFetch: serve(buffer) })

    const resolved = jsonData(await executeInstallSkill({ instruction: 'https://example.com/pack.tar.gz' }, deps))
    assert.equal(resolved.installable, true)

    const installOutput = await executeInstallSkill(
      { source: resolved.source, requestId: resolved.requestId, trustAck: true },
      deps,
    )
    const installData = jsonData(installOutput)

    assert.equal(installData.installed, true)
    assert.equal(installData.phase, 'done')
    // id derives from the SKILL.md frontmatter `name:` ("My Skill" → "my-skill"),
    // not the `pkg/` tarball wrapper folder.
    assert.equal(installData.skillId, 'my-skill')
    assert.ok(
      manager.listSkills().some((s) => s.id === 'my-skill' && s.source === 'custom'),
      'the confirmed install must register a listable custom skill',
    )
  } finally {
    cleanup()
  }
})

test('a trustAck call with no usable source fails loudly instead of installing', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const deps = makeDeps(manager)
    await assert.rejects(
      () => executeInstallSkill({ trustAck: true }, deps),
      /source/i,
    )
    assert.equal(manager.listSkills().some((s) => s.source === 'custom'), false)
  } finally {
    cleanup()
  }
})

test('the resolve phase requires an instruction', async () => {
  const { manager, cleanup } = makeManager()
  try {
    await assert.rejects(
      () => executeInstallSkill({ instruction: '   ' }, makeDeps(manager)),
      /instruction/i,
    )
  } finally {
    cleanup()
  }
})
