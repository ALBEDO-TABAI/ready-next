import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'

test('human-touch templates and recipe icons are usable through artifact reads without external icon scripts', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'human-touch-artifacts-'))
  try {
    for (const [id, ready, human, recipes, count] of [
      ['ready-human-touch-card', 'template-ready-card.html', 'template-human-touch-card.html', 'recipes-ready.md', 4],
      ['ready-human-touch-ppt', 'template-ready.html', 'template-human-touch.html', 'layouts-ready.md', 3],
    ] as const) {
      const assetRoot = join(process.cwd(), 'assets/embedded-skills', id)
      const read = async (relativePath: string) => (await executeReadArtifact({ relativePath, maxBytes: 200000 }, {
        skillId: id, lookupSkillRoots: () => ({ skillId: id, assetRoot, artifactRoot }),
      })).text
      for (const template of [ready, human]) {
        const dom = new JSDOM(await read(`assets/${template}`))
        const doc = dom.window.document
        assert.equal(doc.querySelectorAll('script[src]').length, 0, `${id}/${template} needs no external scripts`)
        assert.ok(doc.querySelector('link[href^="https://fonts.googleapis.com/css2"]'), 'Google Fonts remains optional')
        const style = dom.window.getComputedStyle(doc.documentElement)
        assert.match(style.getPropertyValue('--sans'), /"(?:PingFang SC|Microsoft YaHei)".*sans-serif/)
        const secondary = style.getPropertyValue(template === human ? '--serif' : '--mono')
        assert.match(secondary, template === human ? /"(?:Songti SC|SimSun)".*serif/ : /(?:Menlo|Consolas).*monospace/)
        dom.window.close()
      }
      // The actual HTML examples consumed by the skill must already contain their icons.
      const examples = [...(await read(`references/${recipes}`)).matchAll(/```html\s*\n([\s\S]*?)```/g)].map(match => match[1])
      const dom = new JSDOM(examples.join('\n'))
      const icons = dom.window.document.querySelectorAll('.row-icon svg')
      assert.equal(icons.length, count)
      for (const icon of icons) {
        assert.equal(icon.namespaceURI, 'http://www.w3.org/2000/svg')
        assert.equal(icon.getAttribute('viewBox'), '0 0 24 24')
        assert.ok(icon.querySelector('path, rect'))
      }
      assert.equal(dom.window.document.querySelectorAll('[data-lucide]').length, 0)
      dom.window.close()
    }
  } finally { rmSync(artifactRoot, { recursive: true, force: true }) }
})
