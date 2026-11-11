// No model, network, visible window or remote debugging. Run with Electron.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { app, BrowserWindow, WebContentsView } from 'electron'

const profile = mkdtempSync('/private/tmp/rbg-')
app.setPath('userData', profile)
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
const violations = []
for (const name of ['show', 'showInactive', 'focus', 'moveTop']) {
  BrowserWindow.prototype[name] = () => { violations.push(name) }
}
app.focus = () => { violations.push('app.focus') }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await app.whenReady()
let window
let view
try {
  const before = app.getAppMetrics()
  window = new BrowserWindow({ show: false, width: 1280, height: 800,
    paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } })
  view = new WebContentsView({ webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
  const wc = view.webContents
  const html = `<style>body{margin:0;height:4000px}button{position:absolute;left:40px;top:40px;width:200px;height:80px}#lazy{position:absolute;top:2000px}</style>
    <button>Hit target</button><div id="lazy">Lazy target</div><script>
    window.probe={clicks:0,frames:0,intersections:0,drag:0};
    document.querySelector('button').onclick=()=>probe.clicks++;
    document.onpointermove=e=>{if(e.buttons)probe.drag++};
    function tick(){probe.frames++;requestAnimationFrame(tick)};tick();
    new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting)){probe.intersections++;document.querySelector('#lazy').dataset.loaded='true'}}).observe(document.querySelector('#lazy'));
    </script>`
  await wc.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  wc.debugger.attach('1.3')
  const mouse = (type, args = {}) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 100, y: 80, ...args })
  await mouse('mousePressed', { button: 'left', clickCount: 1 })
  await mouse('mouseReleased', { button: 'left', clickCount: 1 })
  await mouse('mousePressed', { button: 'left', buttons: 1 })
  await mouse('mouseMoved', { x: 200, buttons: 1 })
  await mouse('mouseReleased', { x: 200, button: 'left' })
  await mouse('mouseWheel', { deltaX: 0, deltaY: 1800 })
  await delay(1200)
  const state = await wc.executeJavaScript('({...probe, width:innerWidth,height:innerHeight,visibility:document.visibilityState,scrollY,loaded:document.querySelector("#lazy").dataset.loaded})')
  assert.ok(state.clicks >= 1)
  assert.ok(state.drag >= 1)
  assert.ok(state.frames > 5)
  assert.ok(state.intersections >= 1)
  assert.equal(state.loaded, 'true')
  assert.equal(state.width, 1280)
  assert.equal(state.height, 800)
  assert.equal(state.visibility, 'visible')
  assert.equal(window.isVisible(), false)
  assert.equal(window.isFocused(), false)
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await mouse('mouseWheel', { deltaX: 0, deltaY: -1800 })
  await delay(1000)
  assert.equal(await wc.executeJavaScript('scrollY'), 0)
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
  // getAppMetrics memory is KiB; percentCPUUsage is Electron's process interval sample.
  const samples = []
  for (let i = 0; i < 5; i++) {
    await delay(1000)
    samples.push(app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })))
  }
  assert.deepEqual(violations, [])
  console.log(JSON.stringify({ electron: process.versions.electron, state, before, samples, violations }, null, 2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (view && !view.webContents.isDestroyed()) view.webContents.close()
  if (window && !window.isDestroyed()) window.destroy()
  rmSync(profile, { recursive: true, force: true })
  app.exit(process.exitCode || 0)
}
