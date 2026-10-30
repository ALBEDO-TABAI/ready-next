import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { inspectBookSourceBuild, verifyExcluded } from '../../scripts/verify-ready-next-book-sources.mjs'
const require = createRequire(import.meta.url)
test('C11 compiled OFF refuses loading extras; ON loads them; output checker detects contamination', async t => {
  const dir = await mkdtemp(resolve('node_modules/.cache/ready-l3-feature-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const enabled of [false, true]) {
    const out = join(dir, String(enabled)); await mkdir(join(out, 'renderer'), { recursive: true })
    await build({ entryPoints: ['src/main/modules/library-engine/source-service.ts'], outfile: join(out, 'main', 'sources.cjs'), bundle: true, minifySyntax: true, platform: 'node', format: 'cjs', packages: 'external', define: { __READY_FEATURE_CTFILE__: String(enabled) } })
    await build({ entryPoints: ['src/renderer/modules/library/find/build-feature.ts'], outfile: join(out, 'renderer', 'features.cjs'), bundle: true, minifySyntax: true, platform: 'node', format: 'cjs', packages: 'external', define: { __READY_FEATURE_CTFILE__: String(enabled) } })
    await writeFile(join(out, 'renderer', 'index.html'), '<div></div>')
    const service = require(join(out, 'main', 'sources.cjs'))
    const ui = require(join(out, 'renderer', 'features.cjs'))
    if (enabled) {
      const extra = await service.loadExtraSources(dir)
      assert.equal(typeof extra.download, 'function'); assert.ok(ui.ExtraSourceSettings)
      assert.equal(inspectBookSourceBuild(out).ctfile, true)
      assert.throws(() => verifyExcluded(out), /关闭 ctfile/)
    } else {
      await assert.rejects(service.loadExtraSources(dir), /未包含/)
      assert.equal(ui.ExtraSourceSettings, null); assert.equal(ui.ExtraSourceSearch, null)
      assert.equal(verifyExcluded(out).ctfile, false)
      await writeFile(join(out, 'main', 'leaked.js'), "console.log('READY_OPTIONAL_CTFILE_IMPLEMENTATION_V1')")
      assert.throws(() => verifyExcluded(out), /仍包含/)
    }
  }
})
