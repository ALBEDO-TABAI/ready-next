import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessSkillSourceRisk,
  type SkillRiskReason,
  type SkillSource,
} from '../shared/skill-source-types'

const BUNDLED = ['video-expert-analyzer', 'video-copy-analyzer', 'lets-go-rss', 'deep-research']

function reasonSet(...args: Parameters<typeof assessSkillSourceRisk>): Set<SkillRiskReason> {
  return new Set(assessSkillSourceRisk(...args).reasons.map((r) => r.reason))
}

test('a pinned github.com source with a permissive license is trusted', () => {
  const source: SkillSource = { kind: 'github', owner: 'op7418', repo: 'guizang-ppt-skill', ref: 'main' }
  const assessment = assessSkillSourceRisk({
    source,
    hasCommitPin: true,
    license: 'MIT',
    bundledSkillIds: BUNDLED,
  })
  assert.equal(assessment.tier, 'trusted')
  assert.equal(assessment.reasons.length, 0)
})

test('the redskill store incantation is untrusted with concrete look-alike + typosquat + indirect reasons', () => {
  const assessment = assessSkillSourceRisk({
    host: 'redskill.xiaohongshu.net',
    viaInstallDoc: true,
    candidateSkillNames: ['video-expert-analyzer-260324'],
    bundledSkillIds: BUNDLED,
  })
  assert.equal(assessment.tier, 'untrusted')
  const reasons = new Set(assessment.reasons.map((r) => r.reason))
  assert.ok(reasons.has('look-alike-domain'))
  assert.ok(reasons.has('typosquat-of-bundled-skill'))
  assert.ok(reasons.has('indirect-install-doc'))

  // Reasons carry the concrete specifics so the confirm card can warn precisely.
  const lookAlike = assessment.reasons.find((r) => r.reason === 'look-alike-domain')
  assert.ok(lookAlike && lookAlike.detail.includes('xiaohongshu'))
  const squat = assessment.reasons.find((r) => r.reason === 'typosquat-of-bundled-skill')
  assert.ok(squat && squat.detail.includes('video-expert-analyzer'))
})

test('a direct tarball from an unknown host flags unknown-host (untrusted)', () => {
  const source: SkillSource = { kind: 'tarball', url: 'https://files.example.org/skill.tar.gz' }
  const assessment = assessSkillSourceRisk({ source, hasCommitPin: true, bundledSkillIds: BUNDLED })
  assert.equal(assessment.tier, 'untrusted')
  assert.ok(reasonSet({ source, hasCommitPin: true, bundledSkillIds: BUNDLED }).has('unknown-host'))
})

test('a github source that could not be pinned is community via no-commit-pin', () => {
  const source: SkillSource = { kind: 'github', owner: 'acme', repo: 'widgets' }
  const assessment = assessSkillSourceRisk({ source, hasCommitPin: false, bundledSkillIds: BUNDLED })
  assert.equal(assessment.tier, 'community')
  assert.deepEqual(
    assessment.reasons.map((r) => r.reason),
    ['no-commit-pin'],
  )
})

test('an AGPL license downgrades an otherwise-trusted github source to community', () => {
  const source: SkillSource = { kind: 'github', owner: 'op7418', repo: 'guizang-ppt-skill' }
  const assessment = assessSkillSourceRisk({
    source,
    hasCommitPin: true,
    license: 'AGPL-3.0',
    bundledSkillIds: BUNDLED,
  })
  assert.equal(assessment.tier, 'community')
  assert.ok(reasonSet({ source, hasCommitPin: true, license: 'AGPL-3.0', bundledSkillIds: BUNDLED }).has('restrictive-license'))
})

test('an undetermined license (undefined) does not flag restrictive-license', () => {
  const source: SkillSource = { kind: 'github', owner: 'acme', repo: 'widgets', ref: 'main' }
  const assessment = assessSkillSourceRisk({ source, hasCommitPin: true, bundledSkillIds: BUNDLED })
  assert.equal(assessment.tier, 'trusted')
})

test('the exact bundled skill id is not treated as a typosquat', () => {
  const reasons = reasonSet({
    host: 'github.com',
    candidateSkillNames: ['video-expert-analyzer'],
    hasCommitPin: true,
    bundledSkillIds: BUNDLED,
  })
  assert.ok(!reasons.has('typosquat-of-bundled-skill'))
})

test('codeload.github.com is a trusted host (no unknown-host)', () => {
  const source: SkillSource = { kind: 'tarball', url: 'https://codeload.github.com/op7418/guizang-ppt-skill/tar.gz/abc123' }
  const reasons = reasonSet({ source, hasCommitPin: true, bundledSkillIds: BUNDLED })
  assert.ok(!reasons.has('unknown-host'))
  assert.ok(!reasons.has('look-alike-domain'))
})

test('a configured domestic mirror host is honored via extraTrustedHosts', () => {
  const source: SkillSource = { kind: 'tarball', url: 'https://ghproxy.example.cn/https://github.com/acme/widgets/archive/abc.tar.gz' }
  const reasons = reasonSet({
    source,
    hasCommitPin: true,
    extraTrustedHosts: ['ghproxy.example.cn'],
    bundledSkillIds: BUNDLED,
  })
  assert.ok(!reasons.has('unknown-host'))
})
