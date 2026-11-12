'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { generate } = require('../generate-third-party-notices.cjs')
const { checkPackagedLicenses } = require('../check-packaged-licenses.cjs')
const { FileMatcher, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher')
const yaml = require('js-yaml')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-license-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}

test('offline generation tolerates npm ELSPROBLEMS, deduplicates identities, collects all texts and merges manual gaps', t => {
  const root = fixture(t)
  const a = { name: 'example', version: '1', license: 'MIT', repository: { url: 'https://example.invalid/repo' } }
  for (const dir of ['node_modules/example', 'node_modules/parent/node_modules/example']) {
    write(root, `${dir}/package.json`, JSON.stringify(a))
    write(root, `${dir}/LICENSE.md`, 'MIT text')
  }
  write(root, 'node_modules/other/node_modules/example/package.json', JSON.stringify({ name: 'example', version: '2' }))
  write(root, 'node_modules/other/node_modules/example/LICENSE', 'v2 license')
  const files = { 'LICENCE.txt': 'second text', COPYING: 'copying', NOTICE: 'notice', 'license-MIT': 'alternative', 'LICENSE-MORE.md': 'more', 'notice.html': '<p>notice</p>' }
  for (const [name, text] of Object.entries(files)) write(root, `node_modules/example/${name}`, text)
  write(root, 'node_modules/example/LICENSES/ignored.txt', 'directory is not a license file')
  write(root, 'node_modules/example/README.md', 'not license text')
  write(root, 'node_modules/missing/package.json', JSON.stringify({ name: 'missing', version: '2', licenses: [{ type: 'PSF', url: 'https://example.invalid/license' }] }))
  const manual = [
    { name: 'font', version: null, license: 'OFL-1.1', repository: null, textFiles: ['licenses/font.txt'], notes: [] },
    { name: 'unresolved', version: null, license: 'MIT', repository: null, textFiles: ['licenses/absent.txt'], notes: ['来源待补'] },
    { name: 'partial', version: null, license: 'MIT', repository: null, textFiles: ['licenses/declaration.txt'], notes: ['上游未附全文'], textMissing: true },
  ]
  write(root, 'licenses/ready-next/manifest.json', JSON.stringify(manual))
  write(root, 'licenses/font.txt', 'full OFL text')
  write(root, 'licenses/declaration.txt', 'MIT')
  const tree = { dependencies: {
    example: { path: path.join(root, 'node_modules/example'), dependencies: {
      duplicate: { path: path.join(root, 'node_modules/parent/node_modules/example') },
    } },
    otherVersion: { path: path.join(root, 'node_modules/other/node_modules/example') },
    missing: { path: path.join(root, 'node_modules/missing') },
    optional: {},
  }, error: { code: 'ELSPROBLEMS', summary: 'invalid fixture' } }
  const runNpm = (_cmd, args, options) => {
    assert.deepEqual(args, ['ls', '--omit=dev', '--all', '--json', '--long'])
    assert.equal(options.env.npm_config_offline, 'true')
    return { status: 1, stdout: JSON.stringify(tree), stderr: 'invalid fixture' }
  }
  const entries = generate({ root, runNpm })
  assert.equal(entries.length, 6)
  assert.equal(entries.filter(e => e.name === 'example').length, 2)
  assert.equal(entries.find(e => e.name === 'example' && e.version === '2').license, null)
  assert.equal(entries.find(e => e.name === 'example' && e.version === '2').textMissing, false)
  const example = entries.find(e => e.name === 'example')
  assert.equal(example.repository, a.repository.url)
  assert.equal(example.license, 'MIT')
  assert.equal(example.textMissing, false)
  assert.deepEqual(example.texts.map(e => e.content).sort(), ['MIT text', ...Object.values(files)].sort())
  assert.equal(entries.find(e => e.name === 'missing').textMissing, true)
  assert.equal(entries.find(e => e.name === 'missing').license, 'PSF')
  assert.equal(entries.find(e => e.name === 'font').textMissing, false)
  assert.equal(entries.find(e => e.name === 'unresolved').textMissing, true)
  assert.deepEqual(entries.find(e => e.name === 'unresolved').notes, ['来源待补', 'Missing file: licenses/absent.txt'])
  assert.equal(entries.find(e => e.name === 'partial').textMissing, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'licenses/generated/third-party-notices.json'))), entries)
  assert.match(fs.readFileSync(path.join(root, 'licenses/generated/THIRD_PARTY_NOTICES.txt'), 'utf8'), /full OFL text/)
  assert.throws(() => generate({ root, runNpm: () => ({ status: 1, stdout: '{}', stderr: 'failed' }) }), /npm ls failed/)
  assert.throws(() => generate({ root, runNpm: () => ({ status: 0, stdout: 'broken' }) }), SyntaxError)
})

// The real package (electron-builder --dir, checked by scripts/check-packaged-licenses.cjs) keeps extension-less
// LICENSE files and drops dependencies' Markdown, LICENSE.md included; every dependency's text ships in the
// generated notices instead. A FileSet re-include looked right to this matcher but did not reach the package.
test('packaging keeps plain LICENSE files, drops dependency Markdown, and ships the licenses resources', t => {
  const root = fixture(t)
  const config = yaml.load(fs.readFileSync(path.join(__dirname, '../../electron-builder.yml'), 'utf8'))
  const matcher = getNodeModuleFileMatcher(root, path.join(root, 'dest'), s => s, {}, { config, debugLogger: { isEnabled: false } })
  const filter = matcher.createFilter()
  const stat = { isDirectory: () => false }
  for (const file of ['LICENSE', 'LICENSE-MIT', 'LICENCE.txt', 'NOTICE.txt']) assert.equal(filter(path.join(root, `node_modules/pkg/${file}`), stat), true, file)
  for (const file of ['README.md', 'LICENSE.md']) assert.equal(filter(path.join(root, `node_modules/pkg/${file}`), stat), false, file)
  for (const resource of config.extraResources.filter(item => item.to.startsWith('licenses'))) {
    const file = resource.from === 'licenses' ? 'generated/third-party-notices.json' : ''
    const resourceFilter = new FileMatcher(path.join(root, resource.from), path.join(root, resource.to), s => s, resource.filter).createFilter()
    assert.equal(resourceFilter(path.join(root, resource.from, file), stat), true)
  }
})

test('packaged checker accepts app and unpacked roots, rejects missing required license', t => {
  const root = fixture(t)
  const app = path.join(root, 'Ready Next.app')
  const resources = path.join(app, 'Contents/Resources')
  for (const file of [
    'licenses/generated/THIRD_PARTY_NOTICES.txt', 'licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html',
    ...['Inter', 'InstrumentSerif', 'GeistMono'].map(n => `licenses/ready-next/OFL-${n}.txt`),
    'licenses/ready-next/paper-flipbook-LICENSE.txt', 'licenses/ready-next/lets-go-rss-NOTICE.txt',
    'app.asar.unpacked/node_modules/rsshub/LICENSE',
  ]) write(resources, file, 'fixture text')
  const md = name => ({ name, kind: 'npm', texts: [{ path: `node_modules/${name}/LICENSE.md`, content: 'license' }] })
  const notices = [{ name: 'rsshub', kind: 'npm', texts: [{ path: 'node_modules/rsshub/LICENSE', content: 'license' }] }, md('@mozilla/readability'), md('date-fns')]
  write(resources, 'licenses/generated/third-party-notices.json', JSON.stringify(notices))
  for (const input of [root, app, resources]) assert.equal(checkPackagedLicenses(input), resources)
  // Packaging drops dependencies' LICENSE.md, so the notices must carry those texts.
  write(resources, 'licenses/generated/third-party-notices.json', JSON.stringify(notices.slice(0, 2)))
  assert.throws(() => checkPackagedLicenses(app), /date-fns LICENSE\.md/)
  write(resources, 'licenses/generated/third-party-notices.json', JSON.stringify(notices))
  fs.rmSync(path.join(resources, 'app.asar.unpacked/node_modules/rsshub/LICENSE'))
  assert.throws(() => checkPackagedLicenses(app), /rsshub\/LICENSE/)
})
