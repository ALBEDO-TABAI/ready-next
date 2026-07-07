/**
 * P3-3 — agentskills.io-spec lint rule matrix (shared engine scripts/lint-skill-core.cjs).
 * One fixture per ERROR/WARN rule; plus the load-bearing invariant that all shipped embedded
 * skills lint with ERROR=0 (json-backed identity, so intentional short SKILL.md names are fine).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const require = createRequire(import.meta.url)
const { lintSkillInputs } = require('../../scripts/lint-skill-core.cjs') as {
  lintSkillInputs: (i: { dirName: string; json: unknown; skillMd: string | null; hasScripts: boolean }) => { errors: string[]; warnings: string[] }
}

const md = (fm: string, body = '# body') => `---\n${fm}\n---\n${body}`

test('lint ERROR: neither SKILL.md nor ready-skill.json', () => {
  const r = lintSkillInputs({ dirName: 'x', json: null, skillMd: null, hasScripts: false })
  assert.equal(r.errors.length, 1)
})

test('lint ERROR: bare SKILL.md missing name / description / name!=dir / bad slug / --', () => {
  assert.ok(lintSkillInputs({ dirName: 'a', json: null, skillMd: md('description: d'), hasScripts: false }).errors.some((e) => /缺少 name/.test(e)))
  assert.ok(lintSkillInputs({ dirName: 'a', json: null, skillMd: md('name: a'), hasScripts: false }).errors.some((e) => /缺少 description/.test(e)))
  assert.ok(lintSkillInputs({ dirName: 'a', json: null, skillMd: md('name: b\ndescription: d'), hasScripts: false }).errors.some((e) => /必须等于目录名/.test(e)))
  assert.ok(lintSkillInputs({ dirName: 'A_b', json: null, skillMd: md('name: A_b\ndescription: d'), hasScripts: false }).errors.some((e) => /不符合/.test(e)))
  assert.ok(lintSkillInputs({ dirName: 'a--b', json: null, skillMd: md('name: a--b\ndescription: d'), hasScripts: false }).errors.some((e) => /"--"/.test(e)))
})

test('lint ERROR: description over 1024 chars', () => {
  const r = lintSkillInputs({ dirName: 'a', json: null, skillMd: md(`name: a\ndescription: ${'x'.repeat(1025)}`), hasScripts: false })
  assert.ok(r.errors.some((e) => /超过 1024/.test(e)))
})

test('lint: json-backed skill validates json.id==dir (SKILL.md name is NOT checked)', () => {
  // vea-style: json.id matches dir, but SKILL.md name is a short label → must NOT error
  const ok = lintSkillInputs({ dirName: 'vea-skill', json: { id: 'vea-skill', description: 'd' }, skillMd: md('name: vea\ndescription: d'), hasScripts: false })
  assert.deepEqual(ok.errors, [])
  const bad = lintSkillInputs({ dirName: 'vea-skill', json: { id: 'other', description: 'd' }, skillMd: null, hasScripts: false })
  assert.ok(bad.errors.some((e) => /必须等于目录名/.test(e)))
})

test('lint WARN: oversized body, >500 lines, allowed-tools, scripts without $CLAUDE_SKILL_DIR', () => {
  const big = lintSkillInputs({ dirName: 'a', json: null, skillMd: md('name: a\ndescription: d', 'x'.repeat(12001)), hasScripts: false })
  assert.ok(big.warnings.some((w) => /12000/.test(w)))
  const many = lintSkillInputs({ dirName: 'a', json: null, skillMd: md('name: a\ndescription: d', 'l\n'.repeat(501)), hasScripts: false })
  assert.ok(many.warnings.some((w) => /500 行/.test(w)))
  const at = lintSkillInputs({ dirName: 'a', json: null, skillMd: md('name: a\ndescription: d\nallowed-tools: Read'), hasScripts: false })
  assert.ok(at.warnings.some((w) => /allowed-tools/.test(w)))
  const scr = lintSkillInputs({ dirName: 'a', json: null, skillMd: md('name: a\ndescription: d', '# no dir var'), hasScripts: true })
  assert.ok(scr.warnings.some((w) => /CLAUDE_SKILL_DIR/.test(w)))
})

test('lint invariant: every shipped embedded skill lints with ERROR=0', () => {
  const root = join(process.cwd(), 'assets', 'embedded-skills')
  const failures: string[] = []
  for (const dirName of readdirSync(root)) {
    const dir = join(root, dirName)
    if (!statSync(dir).isDirectory()) continue
    const jsonPath = join(dir, 'ready-skill.json')
    const mdPath = join(dir, 'SKILL.md')
    const json = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null
    const skillMd = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : null
    const hasScripts = existsSync(join(dir, 'scripts'))
    const { errors } = lintSkillInputs({ dirName: basename(dir), json, skillMd, hasScripts })
    if (errors.length) failures.push(`${dirName}: ${errors.join(' | ')}`)
  }
  assert.deepEqual(failures, [], `embedded skills must lint ERROR=0:\n${failures.join('\n')}`)
})
