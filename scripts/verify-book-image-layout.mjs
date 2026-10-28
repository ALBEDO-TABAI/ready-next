import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

// Isolated local fixtures: no Ready profile, account, document writes or external requests.
const root = process.cwd()
const work = await mkdtemp(join(tmpdir(), 'ready-book-images-'))
const evidence = resolve('outputs/book-images')
await mkdir(evidence, { recursive: true })
const server = createServer((request, response) => {
  const name = request.url.split('?')[0]
  const sizes = { '/portrait': [720, 1080], '/tall': [180, 2200], '/small': [100, 60], '/wide': [900, 120] }
  setTimeout(() => {
    if (!sizes[name]) { response.writeHead(404); response.end(); return }
    const [width, height] = sizes[name]
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#286373"/><rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#ffdb72" stroke-width="8"/><text x="50%" y="50%" fill="white" font-size="32" text-anchor="middle">${name}</text></svg>`)
  }, 250)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const fixture = [
  '# 阅读图文验收',
  ...Array.from({ length: 8 }, (_, i) => `前文${i}。${'阳光照在安静的书页上，读完这一段，再看下一页的图片。'.repeat(3)}`),
  '## 第九卷 预审',
  `![卷首图](${origin}/portrait)`,
  '### 正文继续',
  ...Array.from({ length: 9 }, (_, i) => `后文${i}。${'图与文字保持顺序，任何一行都不应压在图片上。'.repeat(3)}`),
  `![重复卷首图](${origin}/portrait)`,
  '重复图片之后的正文。',
  `![连续大图](${origin}/portrait?second)`,
  `![超长图](${origin}/tall)`,
  '连续大图之后的正文。',
  '![本地卷首图](portrait.svg)',
  '本地图片之后的正文。',
  '![重复本地图](portrait.svg)',
  '重复本地图片之后的正文。',
  `![小图](${origin}/small)`,
  '小图之后的正文。',
  `![宽图](${origin}/wide)`,
  '宽图之后的正文。',
  `![缺失图](${origin}/missing)`,
  '缺失图片之后的正文仍然可以阅读。',
  `段中小图 ![行内图](${origin}/small) 随文字继续。`,
].join('\n\n')

try {
  await writeFile(join(work, 'portrait.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#7b653d"/><rect x="6" y="6" width="588" height="888" fill="none" stroke="white" stroke-width="6"/></svg>')
  await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import Book from ${JSON.stringify(join(root, 'src/renderer/components/document/book/DocumentBookReadingView'))};
      import ${JSON.stringify(join(root, 'src/renderer/styles/document-book.css'))};
      const root = createRoot(document.getElementById('root'));
      window.startBook = (fontSize, margin) => {
        localStorage.clear();
        localStorage.setItem('ready-document-book-reading-preferences-v1', JSON.stringify({fontSize, margin, lineHeight:1.75}));
        flushSync(() => root.render(<Book key={fontSize+margin} tab={{id:'image-test-'+fontSize+margin,title:'图文分页验收',path:${JSON.stringify(join(work, 'book.md'))},content:${JSON.stringify(fixture)},type:'text'}} isSceneVisible onExit={()=>{}}/>));
      };
    `, resolveDir: root, loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: join(work, 'probe.js'), logLevel: 'warning',
  })
  await writeFile(join(work, 'index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>*{box-sizing:border-box}body{margin:0}#root{position:absolute;inset:0}button,input{font:inherit}button{border:0;background:transparent}</style><div id="root"></div><script src="probe.js"></script></html>')
  await build({ entryPoints: [join(root, 'src/main/modules/app-control/local-file-response.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(work, 'local-file.cjs'), logLevel: 'warning' })
  await writeFile(join(work, 'main.cjs'), `
    const {app,BrowserWindow,protocol}=require('electron');
    const fs=require('node:fs');
    const {createLocalFileResponse}=require('./local-file.cjs');
    protocol.registerSchemesAsPrivileged([{scheme:'local-file',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
    app.setPath('userData',${JSON.stringify(join(work, 'profile'))});
    app.whenReady().then(async()=>{
      protocol.handle('local-file',request=>createLocalFileResponse(request,{isPathAllowed:path=>path===${JSON.stringify(join(work, 'portrait.svg'))}}));
      const win=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{backgroundThrottling:false}});
      await win.loadFile(${JSON.stringify(join(work, 'index.html'))});
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      const results=[];
      for (const [width,height,font,margin] of [[1100,900,15,'normal'],[760,680,22,'wide'],[1500,1040,12,'narrow']]) {
        win.setSize(width,height);
        await win.webContents.executeJavaScript('window.startBook('+font+','+JSON.stringify(margin)+')');
        const result=await win.webContents.executeJavaScript('('+${JSON.stringify(inspectBook.toString())}+')()');
        results.push({width,height,font,margin,...result});
        if (results.length===1) {
          await win.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Home'}));");
          await win.webContents.executeJavaScript("document.querySelector('[aria-label=\\"下一页\\"]').click(); new Promise(r=>setTimeout(r,400));");
          fs.writeFileSync(${JSON.stringify(join(evidence, 'verified.png'))},(await win.webContents.capturePage()).toPNG());
        }
      }
      win.setSize(920,760);
      await win.webContents.executeJavaScript(
        "new Promise(r=>setTimeout(r,100)).then(()=>{const input=document.querySelector('[aria-label=\\"字号\\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'20');input.dispatchEvent(new Event('input',{bubbles:true}));})"
      );
      const reflow=await win.webContents.executeJavaScript('('+${JSON.stringify(inspectBook.toString())}+')()');
      if(reflow.fontSize!=='20px') reflow.failures.push('font control did not reflow');
      results.push({reflow:true,...reflow});
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      const flip=await win.webContents.executeJavaScript('('+${JSON.stringify(inspectImageFlip.toString())}+')('+JSON.stringify(reflow.imagePages['卷首图']?.[0])+')');
      results.push(flip);
      fs.writeFileSync(${JSON.stringify(join(evidence, 'verified-layout-results.json'))},JSON.stringify(results,null,2));
      console.log(JSON.stringify(results));
      if(results.some(r=>r.failures.length)) throw Error('Book image layout failed');
      app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((done, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/electron'), [join(work, 'main.cjs')], { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', done)
  })
  if (code !== 0) throw new Error(`Electron image verification exited ${code}`)
} finally {
  server.closeAllConnections()
  server.close()
  await rm(work, { recursive: true, force: true })
}

async function inspectBook() {
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const waitFor = async fn => {
    for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(50) }
    throw new Error('Timed out waiting for book layout')
  }
  await waitFor(() => document.querySelector('[aria-label="下一页"]'))
  document.querySelector('[aria-label="下一页"]').click()
  await sleep(750)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
  await sleep(30)
  const seen = new Set(), imagePages = {}, failures = [], text = []
  for (let turn = 0; turn < 100; turn++) {
    await sleep(20)
    await waitFor(() => [...document.querySelectorAll('.document-book-stage__page-top img')].every(img => img.complete))
    for (const page of document.querySelectorAll('.document-book-stage__page-top .document-book-page')) {
      const folio = page.querySelector('.document-book-page__folio')?.textContent
      if (!folio || seen.has(folio)) continue
      seen.add(folio)
      const content = page.querySelector('.document-book-page__content'), box = content.getBoundingClientRect()
      const rects = []
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.textContent.trim()) continue
        const range = document.createRange(); range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
          if (rect.right > box.left + 1 && rect.left < box.right - 1 && rect.bottom > box.top + 1 && rect.top < box.bottom - 1) {
            rects.push(rect); text.push(node.textContent)
          }
        }
      }
      for (const img of content.querySelectorAll('img')) {
        const r = img.getBoundingClientRect()
        if (r.right <= box.left + 1 || r.left >= box.right - 1 || r.bottom <= box.top + 1 || r.top >= box.bottom - 1) continue
        if (!img.naturalWidth) continue
        const name = img.alt
        ;(imagePages[name] ??= []).push(folio)
        if (r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.right > box.right + 1) failures.push('clipped '+name+' page '+folio)
        if (Math.abs(r.width/r.height - img.naturalWidth/img.naturalHeight) > .02) failures.push('distorted '+name)
        if (rects.some(t => Math.min(t.right,r.right)-Math.max(t.left,r.left)>1 && Math.min(t.bottom,r.bottom)-Math.max(t.top,r.top)>1)) failures.push('overlap '+name+' page '+folio)
        if (['卷首图','重复卷首图','连续大图','超长图','本地卷首图','重复本地图'].includes(name) && rects.length) failures.push('large image shares text '+name+' page '+folio)
      }
    }
    const next = document.querySelector('[aria-label="下一页"]')
    if (next.disabled) break
    next.click()
  }
  for (const name of ['卷首图','重复卷首图','连续大图','超长图','本地卷首图','重复本地图','小图','宽图','行内图']) {
    if (imagePages[name]?.length !== 1) failures.push('image occurrence '+name+': '+JSON.stringify(imagePages[name]))
  }
  if (!text.join('').includes('缺失图片之后的正文仍然可以阅读')) failures.push('missing text after failed image')
  for (const [prefix, count] of [['前文', 8], ['后文', 9]]) {
    for (let index = 0; index < count; index++) {
      if (!text.join('').includes(prefix + index + '。')) failures.push('missing paragraph ' + prefix + index)
    }
  }
  if (document.querySelector('.document-book-measurer')) failures.push('measurer retained')
  return {pages:seen.size,fontSize:getComputedStyle(document.querySelector('.document-book-reading')).getPropertyValue('--book-font-size').trim(),imagePages,failures}
}

async function inspectImageFlip(folio) {
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const failures = []
  if (!folio) return {flip:true, failures:['missing image page for flip']}
  const input = document.querySelector('[aria-label="页码"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(Math.floor(Number(folio) / 2)))
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(1000)
  const source = document.querySelector('.document-book-stage__page-top img[alt="卷首图"]')
  if (!source) return {flip:true, failures:['cannot navigate to image page']}
  const width = source.style.width, height = source.style.height
  const direction = Number(folio) % 2 ? '下一页' : '上一页'
  document.querySelector('[aria-label="' + direction + '"]').click()
  await sleep(60)
  const clones = [...document.querySelectorAll('.document-book-leaf img[alt="卷首图"]')]
  if (!clones.length || clones.some(img => !width || img.style.width !== width || img.style.height !== height)) failures.push('flipping image dimensions changed')
  await sleep(1000)
  document.querySelector('[aria-label="' + (direction === '下一页' ? '上一页' : '下一页') + '"]').click()
  await sleep(1000)
  const restored = document.querySelector('.document-book-stage__page-top img[alt="卷首图"]')
  if (!restored || restored.style.width !== width || restored.style.height !== height) failures.push('image dimensions changed after flip back')
  return {flip:true, clones:clones.length, failures}
}
