import assert from 'node:assert/strict'
import test from 'node:test'

import { parseSkillSourceInput, type SkillSource } from '../shared/skill-source-types'

function expectGithub(input: string): Extract<SkillSource, { kind: 'github' }> {
  const result = parseSkillSourceInput(input)
  assert.ok(result.ok, `expected ${input} to parse, got: ${result.ok ? '' : result.reason}`)
  assert.equal(result.source.kind, 'github')
  return result.source as Extract<SkillSource, { kind: 'github' }>
}

test('parses a full github repo URL into owner/repo', () => {
  const source = expectGithub('https://github.com/op7418/guizang-ppt-skill')
  assert.equal(source.owner, 'op7418')
  assert.equal(source.repo, 'guizang-ppt-skill')
  assert.equal(source.ref, undefined)
  assert.equal(source.subdir, undefined)
})

test('parses a github /tree/<ref>/<subdir> URL into ref + subdir', () => {
  const source = expectGithub('https://github.com/acme/monorepo/tree/v1.2.0/skills/my-skill')
  assert.equal(source.owner, 'acme')
  assert.equal(source.repo, 'monorepo')
  assert.equal(source.ref, 'v1.2.0')
  assert.equal(source.subdir, 'skills/my-skill')
})

test('parses a scheme-less github.com URL', () => {
  const source = expectGithub('github.com/op7418/guizang-ppt-skill')
  assert.equal(source.owner, 'op7418')
  assert.equal(source.repo, 'guizang-ppt-skill')
})

test('parses bare owner/repo shorthand', () => {
  const source = expectGithub('op7418/guizang-ppt-skill')
  assert.equal(source.owner, 'op7418')
  assert.equal(source.repo, 'guizang-ppt-skill')
})

test('strips a trailing .git suffix', () => {
  const source = expectGithub('https://github.com/acme/widgets.git')
  assert.equal(source.repo, 'widgets')
})

test('trims surrounding whitespace before parsing', () => {
  const source = expectGithub('  https://github.com/acme/widgets  ')
  assert.equal(source.owner, 'acme')
  assert.equal(source.repo, 'widgets')
})

test('parses a direct .tar.gz URL as a tarball source', () => {
  const result = parseSkillSourceInput('https://example.com/downloads/my-skill-1.0.0.tar.gz')
  assert.ok(result.ok)
  assert.equal(result.source.kind, 'tarball')
  if (result.source.kind === 'tarball') {
    assert.equal(result.source.url, 'https://example.com/downloads/my-skill-1.0.0.tar.gz')
  }
})

test('parses a .tgz URL as a tarball source', () => {
  const result = parseSkillSourceInput('https://example.com/pkg.tgz')
  assert.ok(result.ok)
  assert.equal(result.source.kind, 'tarball')
})

test('rejects a remote install-doc URL (not a downloadable source)', () => {
  const result = parseSkillSourceInput('https://redskill.xiaohongshu.net/install.md')
  assert.equal(result.ok, false)
})

test('rejects a scheme-less host/path that is not owner/repo (owner has dots)', () => {
  // Without this guard, `redskill.xiaohongshu.net/install.md` would be misread as
  // owner=redskill.xiaohongshu.net repo=install.md.
  const result = parseSkillSourceInput('redskill.xiaohongshu.net/install.md')
  assert.equal(result.ok, false)
})

test('rejects empty input', () => {
  assert.equal(parseSkillSourceInput('').ok, false)
  assert.equal(parseSkillSourceInput('   ').ok, false)
})

test('rejects a non-github, non-tarball https URL', () => {
  assert.equal(parseSkillSourceInput('https://gitlab.com/acme/widgets').ok, false)
})
