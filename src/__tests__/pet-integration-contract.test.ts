import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { PET_ANIMATION_FRAME_COUNTS } from '../shared/pet'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function readSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1)
  return source.slice(startIndex, endIndex)
}

test('desktop pet IPC is wired through main, preload, renderer types, and settings route', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const app = readWorkspaceFile('src/renderer/App.tsx')
  const settings = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.match(mainIndex, /setupPetIPC\(/)
  assert.match(preload, /pet:\s*petAPI/)
  assert.match(preload, /getSettings:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pet:getSettings'\)/)
  assert.match(preload, /updateActivity:\s*\(snapshot: PetActivitySnapshot\)\s*=>\s*ipcRenderer\.invoke\('pet:updateActivity', snapshot\)/)
  assert.match(electronTypes, /interface ElectronPetAPI/)
  assert.match(app, /path="\/pet-window"/)
  assert.match(settings, /id:\s*'pet'/)
  assert.match(settings, /<PetSettingsPanel \/>/)
})

test('desktop pet window avoids macOS chrome and sprite blank frames', () => {
  const petWindowManager = readWorkspaceFile('src/main/modules/pet/pet-window-manager.ts')
  const petWindow = readWorkspaceFile('src/renderer/pages/PetWindow.tsx')
  const rendererStyles = readRendererStyles()

  assert.match(petWindowManager, /trafficLightPosition:\s*\{\s*x:\s*-\d+,\s*y:\s*-\d+\s*\}/)
  assert.match(petWindowManager, /setWindowButtonVisibility\(false\)/)
  assert.deepEqual(PET_ANIMATION_FRAME_COUNTS, {
    idle: 6,
    'running-right': 8,
    'running-left': 8,
    waving: 4,
    jumping: 5,
    failed: 8,
    waiting: 6,
    running: 6,
    review: 6,
  })
  assert.match(petWindow, /PET_ANIMATION_FRAME_COUNTS\[petState\]/)
  assert.match(petWindow, /pet-sprite-frames-\$\{frameCount\}/)
  assert.doesNotMatch(readSection(rendererStyles, '@keyframes readyPetFrames4', '@keyframes readyPetFrames5'), /-(768|960|1152|1344|1536)px/)
  assert.doesNotMatch(readSection(rendererStyles, '@keyframes readyPetFrames5', '@keyframes readyPetFrames6'), /-(960|1152|1344|1536)px/)
  assert.doesNotMatch(readSection(rendererStyles, '@keyframes readyPetFrames6', '@keyframes readyPetFrames8'), /-(1152|1344|1536)px/)
  assert.doesNotMatch(readSection(rendererStyles, '@keyframes readyPetFrames8', '.pet-sprite-missing'), /-1536px/)
  assert.match(rendererStyles, /background-position-x:\s*-1344px/)
})

test('desktop pet window keeps Ready visible in the macOS Dock', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const petWindowManager = readWorkspaceFile('src/main/modules/pet/pet-window-manager.ts')

  assert.match(mainIndex, /setActivationPolicy\('regular'\)/)
  assert.match(mainIndex, /app\.dock\.show\(\)/)
  assert.match(mainIndex, /ensureDockApp:\s*ensureDockIconVisible/)
  assert.match(petWindowManager, /skipTaskbar:\s*process\.platform\s*!==\s*'darwin'/)
  assert.match(petWindowManager, /ensureDockApp\?:\s*\(\)\s*=>\s*void/)
  assert.match(petWindowManager, /this\.options\.ensureDockApp\?\.\(\)/)
})

test('desktop pet window does not block macOS activation from restoring the main window', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  assert.match(mainIndex, /async function showMainWindow\(\): Promise<void>/)
  assert.match(mainIndex, /mainWindow\.isMinimized\(\)[\s\S]*mainWindow\.restore\(\)/)
  assert.match(mainIndex, /!mainWindow\.isVisible\(\)[\s\S]*mainWindow\.show\(\)/)
  assert.match(mainIndex, /app\.on\('activate'[\s\S]*showMainWindow\(\)/)
  assert.doesNotMatch(mainIndex, /BrowserWindow\.getAllWindows\(\)\.length\s*===\s*0/)
})

test('desktop pet controls stay minimal: bubble toggle and close pet only', () => {
  const petWindow = readWorkspaceFile('src/renderer/pages/PetWindow.tsx')

  assert.match(petWindow, /title=\{settings\.bubbleEnabled \? '关闭气泡' : '开启气泡'\}/)
  assert.match(petWindow, /title="关闭宠物"/)
  assert.doesNotMatch(petWindow, /cyclePet/)
  assert.doesNotMatch(petWindow, /title="切换宠物"/)
  assert.doesNotMatch(petWindow, /title="显示 Ready 主窗口"/)
  assert.doesNotMatch(petWindow, /title="隐藏"/)
  assert.doesNotMatch(petWindow, /electronAPI\.window\.show\(\)/)
  assert.doesNotMatch(petWindow, /electronAPI\.pet\.hide\(\)/)
})

test('desktop pet bubble follows Ready theme updates from the main process', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const petWindow = readWorkspaceFile('src/renderer/pages/PetWindow.tsx')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')

  assert.doesNotMatch(petWindow, /useTheme/)
  assert.match(petWindow, /theme\.onChanged/)
  assert.match(petWindow, /data-skin', 'liquid-glass'/)
  assert.match(preload, /onChanged:\s*\(listener/)
  assert.match(electronTypes, /onChanged:\s*\(listener/)
  assert.match(mainIndex, /theme:changed/)
  assert.match(mainIndex, /nativeTheme\.on\('updated'/)
})

test('desktop pet bubble has compact layout guards for long activity text', () => {
  const styles = readRendererStyles()

  assert.match(styles, /\.pet-bubble\s*\{[^}]*max-height:/s)
  assert.match(styles, /\.pet-bubble-copy span\s*\{[^}]*-webkit-line-clamp:/s)
  assert.match(styles, /\.pet-bubble-events\s*\{[^}]*max-height:/s)
  assert.match(styles, /\.pet-bubble-event\s*\{[^}]*overflow-wrap:/s)
})

test('desktop pet supports independent sticky notes above the agent bubble', () => {
  const sharedPet = readWorkspaceFile('src/shared/pet.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/pet/ipc-handler.ts')
  const petWindowManager = readWorkspaceFile('src/main/modules/pet/pet-window-manager.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const petWindow = readWorkspaceFile('src/renderer/pages/PetWindow.tsx')
  const styles = readRendererStyles()

  assert.match(sharedPet, /interface PetStickyNote/)
  assert.match(sharedPet, /stickyNotes:\s*PetStickyNote\[\]/)
  assert.match(petWindowManager, /pushStickyNote/)
  assert.match(petWindowManager, /dismissStickyNote/)
  assert.match(petWindowManager, /clearStickyNotes/)
  assert.match(ipcHandler, /pet:pushStickyNote/)
  assert.match(ipcHandler, /pet:dismissStickyNote/)
  assert.match(ipcHandler, /pet:clearStickyNotes/)
  assert.match(preload, /pushStickyNote:\s*\(note: PetStickyNoteInput\)\s*=>\s*ipcRenderer\.invoke\('pet:pushStickyNote', note\)/)
  assert.match(electronTypes, /pushStickyNote:\s*\(note: PetStickyNoteInput\)/)
  assert.match(petWindow, /stickyNotes/)
  assert.match(petWindow, /pet-sticky-stack/)
  assert.match(petWindow, /pet-sticky-close/)
  assert.match(petWindow, /dismissStickyNote\(note\.id\)/)
  assert.match(styles, /\.pet-bubble-stack\s*\{/)
  assert.match(styles, /\.pet-sticky-stack\s*\{[^}]*flex-direction:\s*column/s)
  assert.match(styles, /\.pet-sticky-close\s*\{[^}]*opacity:\s*0/s)
  assert.match(styles, /\.pet-sticky:hover\s+\.pet-sticky-close/s)
})
