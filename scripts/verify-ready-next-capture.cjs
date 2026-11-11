#!/usr/bin/env node
// Build first: npx --no-install electron-vite build. Hidden real window, disposable HOME/profile/vault.
// Calls production capture/drop functions; no model and no external fetch. Source selections are synthetic hook inputs.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')
const harness = require('./design-matrix/harness.cjs')
const repo = path.resolve(__dirname, '..')

async function main() {
  const temp = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'w6c-'))
  process.once('exit', () => fs.rmSync(temp, { recursive: true, force: true }))
  const previousHome = process.env.HOME
  const profile = path.join(temp, 'profile'), vault = path.join(temp, 'vault')
  fs.mkdirSync(profile); fs.mkdirSync(vault)
  process.env.HOME = temp; process.env.READY_START_HIDDEN = '1'
  let current
  const seed = results => {
    const result = spawnSync(require('electron'), ['--import', 'tsx', path.join(__dirname, 'fixtures/ready-next-capture-seed.cjs'), profile, ...results ? [results] : []], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000,
    })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error || 'fixture process failed'))
  }
  try {
    current = await harness.launch(profile)
    const configured = await current.page.evaluate(root => window.electronAPI.vault.set(root), vault)
    if (configured.status !== 'ready') throw new Error(JSON.stringify(configured))
    await harness.close(current.app); current = null
    seed()
    const bookPath = path.join(temp, '验收书.txt'), pdfPath = path.join(vault, '验收PDF.pdf')
    fs.writeFileSync(bookPath, '第一章\n\n这是验收书的正文。只供本地测试。')
    // A valid local PDF, rather than a renamed text file. Selection gestures are outside this nonvisual gate.
    const stream = 'BT /F1 12 Tf 30 150 Td (Ready capture PDF selection) Tj ET'
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream']
    let pdf = '%PDF-1.4\n'; const offsets = [0]
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n' }
    const xref = Buffer.byteLength(pdf)
    pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
      + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF'
    fs.writeFileSync(pdfPath, pdf)
    current = await harness.launch(profile)
    await current.app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    })
    const bundle = await build({ entryPoints: [path.join(__dirname, 'fixtures/ready-next-capture-driver.ts')], absWorkingDir: repo,
      bundle: true, write: false, format: 'iife', globalName: 'w6Capture', platform: 'browser', loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': JSON.stringify('test'), '__READY_FEATURE_CTFILE__': 'false' },
    })
    await current.page.addScriptTag({ content: bundle.outputFiles[0].text })
    const results = await current.page.evaluate(input => window.w6Capture.run(input), { root: vault, bookPath, pdfPath })
    for (const result of results) {
      if (result.path) {
        const content = fs.readFileSync(result.path, 'utf8')
        if (result.text && !content.includes(result.text)) throw new Error('Disk content missing: ' + result.name)
        if (!content.includes(result.source.replaceAll('&', '&#x26;')) && !content.includes(result.source)) throw new Error('Disk provenance missing: ' + result.name)
      }
      console.log('PASS ' + result.name + ' → ' + result.destination)
    }
    const expectedImage = fs.readFileSync(path.join(profile, 'fastcard-media', fs.readdirSync(path.join(profile, 'fastcard-media'))[0]))
    for (const directory of ['收下目标.assets', '收下画板.assets']) {
      const images = fs.readdirSync(path.join(vault, directory)).filter(name => name.endsWith('.png'))
      if (!images.some(name => fs.readFileSync(path.join(vault, directory, name)).equals(expectedImage))) throw new Error('Image copy readback failed: ' + directory)
    }
    const report = path.join(temp, 'results.json'); fs.writeFileSync(report, JSON.stringify(results)); seed(report)
    console.log('Capture matrix: ' + results.length + ' cells passed; file and database readback verified')
  } finally {
    if (current) await harness.close(current.app)
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
