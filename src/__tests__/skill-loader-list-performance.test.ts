import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SkillLoader } from '../main/modules/skills-runtime/skill-loader'

test('custom skill listing scans the directory once and observes changes on the next call', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ready-skill-list-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (let index = 0; index < 25; index++) {
    const folder = join(root, `skill-${index}`)
    fs.mkdirSync(folder)
    fs.writeFileSync(join(folder, 'ready-skill.json'), JSON.stringify({
      id: `skill-${index}`, name: `Skill ${index}`, description: `Distinct capability ${index}`,
      version: '1.0.0', source: 'custom', runtime: 'reference', defaultAction: 'read_skill', actions: [],
    }))
    fs.writeFileSync(join(folder, 'SKILL.md'), `# Skill ${index}\nInstructions`)
  }
  const original = fs.readdirSync
  let scans = 0
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === root) scans++
    return Reflect.apply(original, fs, args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const loader = new SkillLoader(join(root, 'no-embedded'), root)
  assert.equal(loader.listCustomSkills().length, 25)
  assert.equal(scans, 1)
  fs.rmSync(join(root, 'skill-0'), { recursive: true })
  assert.equal(loader.listCustomSkills().length, 24)
  assert.equal(scans, 2, 'a new call must see a new catalog, not stale cached authorization')
})
