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
import type { SkillSource } from '../shared/skill-source-types'

const execFileAsync = promisify(execFile)

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// A benign SKILL.md-only folder → reference/advisory skill (requiresPython=false,
// no venv). Its content must pass the security scanner in importCustomSkill.
const SKILL_MD = ['---', 'name: My Skill', 'license: MIT', '---', '# My Skill', 'advisory content'].join('\n')

async function makeTarGz(layout: Record<string, string>, topEntry: string): Promise<Buffer> {
  const work = scratch('ready-install-src-')
  try {
    for (const [relPath, content] of Object.entries(layout)) {
      const full = join(work, relPath)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    const out = join(scratch('ready-install-out-'), 'archive.tar.gz')
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

// Construct a manager whose embedded-skills root is an empty dir so listSkills()
// reflects ONLY custom installs (the typosquat check still reads the real
// EMBEDDED_SKILL_IDS constant, which is independent of this override).
function makeManager(): { manager: SkillsRuntimeManager; cleanup: () => void } {
  const runtimeRoot = scratch('ready-install-rt-')
  const embeddedRoot = scratch('ready-install-embedded-')
  return {
    manager: new SkillsRuntimeManager({ runtimeRoot, embeddedSkillsRoot: embeddedRoot, startBackgroundTasks: false }),
    cleanup: () => {
      rmSync(runtimeRoot, { recursive: true, force: true })
      rmSync(embeddedRoot, { recursive: true, force: true })
    },
  }
}

const TARBALL: SkillSource = { kind: 'tarball', url: 'https://example.com/pack.tar.gz' }

test('installSkillFromSource fetches a tarball into staging and registers the advisory skill', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const buffer = await makeTarGz({ 'pkg/SKILL.md': SKILL_MD }, 'pkg')
    const phases: string[] = []
    const status = await manager.installSkillFromSource(
      { requestId: 'req-ok', source: TARBALL, trustAck: true },
      (update) => phases.push(update.phase),
      { fetchImpl: serve(buffer) },
    )

    assert.equal(status.phase, 'done')
    // The id must come from the SKILL.md frontmatter `name:` ("My Skill" → "my-skill"),
    // NOT the `pkg/` tarball wrapper folder the staging extractor hands the importer.
    assert.equal(status.skillId, 'my-skill')
    assert.equal(status.progressPercent, 100)
    assert.equal(status.requiresPython, false)
    assert.equal(status.error, null)
    assert.ok(phases.includes('downloading') && phases.includes('installing') && phases.includes('done'))

    const registered = manager.listSkills().find((skill) => skill.id === 'my-skill')
    assert.ok(registered, 'the installed skill must be registered + listable')
    assert.equal(registered?.source, 'custom')
  } finally {
    cleanup()
  }
})

test('installSkillFromSource refuses to install without an explicit trust acknowledgement', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const buffer = await makeTarGz({ 'pkg/SKILL.md': SKILL_MD }, 'pkg')
    await assert.rejects(
      () => manager.installSkillFromSource(
        { requestId: 'req-no-ack', source: TARBALL, trustAck: false },
        undefined,
        { fetchImpl: serve(buffer) },
      ),
      /trustAck|未确认|未授权/,
    )
    // Nothing should have been registered.
    assert.equal(manager.listSkills().some((skill) => skill.source === 'custom'), false)
  } finally {
    cleanup()
  }
})

test('cancelSkillInstall aborts the in-flight install and does not register the skill', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const buffer = await makeTarGz({ 'pkg/SKILL.md': SKILL_MD }, 'pkg')
    // Start the install; the body runs synchronously up to the first await (URL
    // resolve) and registers the AbortController before yielding to us.
    const pending = manager.installSkillFromSource(
      { requestId: 'req-cancel', source: TARBALL, trustAck: true },
      undefined,
      { fetchImpl: serve(buffer) },
    )
    const cancelled = manager.cancelSkillInstall('req-cancel')
    assert.equal(cancelled.phase, 'cancelled')

    const settled = await pending
    assert.equal(settled.phase, 'cancelled')
    assert.equal(settled.error, null)
    assert.equal(manager.listSkills().some((skill) => skill.source === 'custom'), false)
  } finally {
    cleanup()
  }
})

test('resolveSkillSource pins a GitHub ref to a commit SHA and flags an AGPL license as community', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/commits')) return jsonResponse([{ sha: 'cafebabecafe0001' }])
      if (/\/repos\/op7418\/guizang-ppt-skill$/.test(new URL(url).pathname)) {
        return jsonResponse({ default_branch: 'main', license: { spdx_id: 'AGPL-3.0' } })
      }
      return new Response('not found', { status: 404 })
    }
    const resolution = await manager.resolveSkillSource('https://github.com/op7418/guizang-ppt-skill', { fetchImpl })

    assert.equal(resolution.installable, true)
    assert.equal(resolution.source?.kind, 'github')
    assert.equal(resolution.source && resolution.source.kind === 'github' ? resolution.source.ref : null, 'cafebabecafe0001')
    assert.equal(resolution.provenance?.commitSha, 'cafebabecafe0001')
    assert.equal(resolution.license, 'AGPL-3.0')
    assert.equal(resolution.risk.tier, 'community')
    assert.ok(resolution.risk.reasons.some((r) => r.reason === 'restrictive-license'))
  } finally {
    cleanup()
  }
})

test('resolveSkillSource treats a look-alike store page as an install doc and surfaces concrete risks', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const bundledId = [...EMBEDDED_SKILL_IDS][0]
    const docText = [
      `# 安装 ${bundledId}-260324 技能`,
      '运行我们的安装器，或从 https://github.com/op7418/guizang-ppt-skill 获取真实技能。',
    ].join('\n')
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('redskill.xiaohongshu.net')) {
        return new Response(docText, { headers: { 'content-type': 'text/markdown' } })
      }
      if (url.includes('/commits')) return jsonResponse([{ sha: 'deadbeefdead0002' }])
      if (url.includes('/repos/')) return jsonResponse({ default_branch: 'main', license: { spdx_id: 'MIT' } })
      return new Response('not found', { status: 404 })
    }
    const resolution = await manager.resolveSkillSource('https://redskill.xiaohongshu.net/install.md', { fetchImpl })

    assert.equal(resolution.viaInstallDoc, true)
    assert.equal(resolution.source?.kind, 'github', 'the real download address is mined from the doc as DATA')
    const reasons = new Set(resolution.risk.reasons.map((r) => r.reason))
    assert.ok(reasons.has('look-alike-domain'), 'xiaohongshu.net ≠ .com must flag look-alike')
    assert.ok(reasons.has('typosquat-of-bundled-skill'), `${bundledId}-260324 must flag a typosquat`)
    assert.ok(reasons.has('indirect-install-doc'))
    assert.equal(resolution.risk.tier, 'untrusted')
  } finally {
    cleanup()
  }
})
