import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildGithubCodeloadUrl,
  extractCandidateSkillNames,
  extractCandidateSourcesFromDoc,
  fetchGithubRepoMetadata,
  resolveGithubRefToSha,
  resolveSkillTarballUrl,
  type FetchLike,
} from '../main/modules/skills-runtime/skill-source-registry'
import type { SkillSource } from '../shared/skill-source-types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('resolveGithubRefToSha pins an explicit ref via the commits/{ref} endpoint', async () => {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    return jsonResponse({ sha: 'deadbeefcafe' })
  }
  const result = await resolveGithubRefToSha('op7418', 'guizang-ppt-skill', 'main', fetchImpl)
  assert.equal(result.sha, 'deadbeefcafe')
  assert.equal(result.usedRef, 'main')
  assert.ok(calls[0].includes('/repos/op7418/guizang-ppt-skill/commits/main'))
})

test('resolveGithubRefToSha uses the latest default-branch commit when ref is absent', async () => {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    return jsonResponse([{ sha: 'aaa111' }, { sha: 'bbb222' }])
  }
  const result = await resolveGithubRefToSha('acme', 'widgets', undefined, fetchImpl)
  assert.equal(result.sha, 'aaa111')
  assert.ok(calls[0].includes('/commits?per_page=1'))
})

test('resolveGithubRefToSha throws on a non-ok response', async () => {
  const fetchImpl: FetchLike = async () => new Response('not found', { status: 404 })
  await assert.rejects(() => resolveGithubRefToSha('acme', 'missing', 'main', fetchImpl), /HTTP 404/)
})

test('fetchGithubRepoMetadata returns license + default branch, and nulls on failure', async () => {
  const ok: FetchLike = async () => jsonResponse({ default_branch: 'main', license: { spdx_id: 'AGPL-3.0' } })
  assert.deepEqual(await fetchGithubRepoMetadata('op7418', 'guizang-ppt-skill', ok), {
    defaultBranch: 'main',
    licenseSpdx: 'AGPL-3.0',
  })

  const boom: FetchLike = async () => {
    throw new Error('network down')
  }
  assert.deepEqual(await fetchGithubRepoMetadata('acme', 'widgets', boom), {
    defaultBranch: null,
    licenseSpdx: null,
  })
})

const PINNED_GITHUB: SkillSource = { kind: 'github', owner: 'op7418', repo: 'guizang-ppt-skill', ref: 'deadbeef' }
const neverProbe = async (): Promise<number | null> => null

test('resolveSkillTarballUrl pins the overseas codeload archive for the overseas source', async () => {
  const resolved = await resolveSkillTarballUrl(PINNED_GITHUB, 'overseas', neverProbe)
  assert.equal(resolved.mirror, 'overseas')
  assert.equal(resolved.url, buildGithubCodeloadUrl('op7418', 'guizang-ppt-skill', 'deadbeef'))
})

test('resolveSkillTarballUrl wraps the github archive URL through the domestic mirror', async () => {
  const resolved = await resolveSkillTarballUrl(PINNED_GITHUB, 'domestic', neverProbe, {
    mirrorPrefix: 'https://ghproxy.example.cn/',
  })
  assert.equal(resolved.mirror, 'domestic')
  assert.ok(resolved.url.startsWith('https://ghproxy.example.cn/https://github.com/op7418/guizang-ppt-skill/archive/deadbeef.tar.gz'))
})

test('resolveSkillTarballUrl auto-switch picks the fastest reachable endpoint', async () => {
  // domestic faster than overseas -> domestic wins.
  const fastDomestic = await resolveSkillTarballUrl(PINNED_GITHUB, 'auto', async (url) =>
    url.includes('codeload') ? 300 : 40,
  )
  assert.equal(fastDomestic.mirror, 'domestic')

  // overseas reachable, domestic unreachable -> overseas wins.
  const overseasOnly = await resolveSkillTarballUrl(PINNED_GITHUB, 'auto', async (url) =>
    url.includes('codeload') ? 120 : null,
  )
  assert.equal(overseasOnly.mirror, 'overseas')

  // nothing reachable -> falls back to overseas so the fetch surfaces a real error.
  const fallback = await resolveSkillTarballUrl(PINNED_GITHUB, 'auto', neverProbe)
  assert.equal(fallback.mirror, 'overseas')
})

test('resolveSkillTarballUrl passes a direct tarball through unchanged', async () => {
  const source: SkillSource = { kind: 'tarball', url: 'https://example.com/pkg.tar.gz' }
  const resolved = await resolveSkillTarballUrl(source, 'domestic', neverProbe)
  assert.equal(resolved.mirror, 'direct')
  assert.equal(resolved.url, 'https://example.com/pkg.tar.gz')
})

test('resolveSkillTarballUrl rejects an unpinned github source and registry sources', async () => {
  await assert.rejects(
    () => resolveSkillTarballUrl({ kind: 'github', owner: 'a', repo: 'b' }, 'auto', neverProbe),
    /commit SHA/,
  )
  await assert.rejects(
    () => resolveSkillTarballUrl({ kind: 'registry', id: 'foo' }, 'auto', neverProbe),
    /Phase 2/,
  )
})

test('extractCandidateSourcesFromDoc pulls github + tarball URLs from an install doc as data', () => {
  const doc = [
    '# Install RedSkill',
    'Run our installer, or fetch the real skill from https://github.com/op7418/guizang-ppt-skill.',
    'Mirror tarball: https://example.com/skills/pack.tgz ',
    'Visit github.com/acme/widgets for more.',
    'Unrelated prose with no link.',
  ].join('\n')
  const sources = extractCandidateSourcesFromDoc(doc)
  const kinds = sources.map((s) => s.kind).sort()
  assert.deepEqual(kinds, ['github', 'github', 'tarball'])
  assert.ok(sources.some((s) => s.kind === 'github' && s.repo === 'guizang-ppt-skill'))
  assert.ok(sources.some((s) => s.kind === 'github' && s.repo === 'widgets'))
  assert.ok(sources.some((s) => s.kind === 'tarball'))
})

test('extractCandidateSkillNames finds kebab-case skill tokens for typosquat checks', () => {
  const names = extractCandidateSkillNames('请安装 video-expert-analyzer-260324 技能，它来自 redskill 商店')
  assert.ok(names.includes('video-expert-analyzer-260324'))
})
