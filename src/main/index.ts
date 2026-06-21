import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env from project root (before anything else)
config({ path: resolve(__dirname, '../../.env') })

import { app, shell, BrowserWindow, ipcMain, protocol, nativeImage, nativeTheme, Menu, dialog, clipboard, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { join, extname, isAbsolute } from 'path'
import { createReadStream, statSync, existsSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Import modules
import { setupAgentIPC, cleanupAgentRuntime } from './modules/claude-bridge/ipc-handler'
import { AgentManager } from './modules/claude-bridge/agent-manager'
import { setupBrowserIPC, type BrowserController } from './modules/browser-engine/ipc-handler'
import { setupDocumentIPC } from './modules/document-engine/ipc-handler'
import { setupSearchIPC, shutdownFileWatchers } from './modules/search-engine/ipc-handler'
import { requestRendererReadingSessionFlush, setupFileEmergenceIPC } from './modules/file-emergence/ipc-handler'
import { setupRSSIPC, setRSSBrowserController } from './modules/rss-engine/ipc-handler'
import { setupCalendarIPC } from './modules/calendar-engine/ipc-handler'
import {
  startReminderScheduler,
  defaultScheduleAt,
  type ReminderScheduler,
} from './modules/calendar-engine/reminder-scheduler'
import { createReminderNotifier } from './modules/calendar-engine/reminder-notifier'
import { recoverMissedReminders } from './modules/calendar-engine/reminder-cold-start'
import {
  createSyncScheduler,
  type SyncScheduler,
} from './modules/calendar-engine/sync-scheduler'
import { setupSettingsIPC } from './modules/settings-engine/ipc-handler'
import { setupPetIPC } from './modules/pet/ipc-handler'
import type { PetWindowManager } from './modules/pet/pet-window-manager'
import { applyBundledAISettingsSeed } from './modules/settings-engine/seed-loader'
import { setupAppCacheIPC } from './modules/app-control/cache-stats-ipc'
import { setupNativeContextMenuIPC } from './modules/app-control/native-context-menu-ipc'
import { isPathAllowed } from './modules/app-control/local-path-safety'
import { reconcileStartupRunsOnStartup } from './modules/app-control/startup-run-reconciler'
import { setupBoardIPC } from './modules/board-engine/ipc-handler'
import { setupSkillsIPC } from './modules/skills-runtime/ipc-handler'
import { setupMemoryManagementIPC } from './modules/memory-management/ipc-handler'
import { rsshubManager } from './modules/rss-engine/rsshub-process'
import { reapOrphans } from './modules/process-cleanup/boot-reaper'
import { runBeforeQuitCleanup } from './modules/process-cleanup/before-quit'
import { closeAllBrowsers } from './modules/browser-engine/browser-cleanup'
import { assertPrimaryDatabaseReady, getDatabase } from './modules/database'
import { shutdownWorkerDbBridge } from './modules/database/worker-bridge'
import { toOAuthCompatibleUserAgent } from './modules/browser-engine/popup-policy'
import { registerMainProcessHandlers } from './process-handlers'
import {
  createWindowMaterialController,
  DARWIN_LIQUID_GLASS_TRANSPARENT,
  type ThemeSkin,
  type ResolvedTheme as MaterialResolvedTheme,
  type SupportedPlatform,
  type WindowMaterialController,
} from './modules/window-material/main-window-material'
import { createStartupSplashDataUrl } from './startup-splash-html'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

// Environment configuration
// Document operations (local fs) are always real — no external dependencies.
// All environments: opt-in only via ENABLE_MOCK_SERVICES=true
const ENABLE_MOCK_SERVICES = process.env.ENABLE_MOCK_SERVICES === 'true'
const READY_NATIVE_FILE_DRAG_ENABLED = process.env.READY_NATIVE_FILE_DRAG_ENABLED !== '0'
const READY_APP_NAME = 'Ready'
app.setName(READY_APP_NAME)

const READY_USER_DATA_DIR = process.env.READY_USER_DATA_DIR?.trim()
if (READY_USER_DATA_DIR) {
  mkdirSync(READY_USER_DATA_DIR, { recursive: true })
  app.setPath('userData', READY_USER_DATA_DIR)
}

function ensureRegularDockApp(): void {
  if (process.platform !== 'darwin') return
  app.setActivationPolicy('regular')
}

ensureRegularDockApp()

// Document engine always uses real fs, regardless of mock setting
const DOCUMENT_USE_MOCK = false
// RSS and Calendar use the same mock flag
const RSS_USE_MOCK = ENABLE_MOCK_SERVICES
const CALENDAR_USE_MOCK = ENABLE_MOCK_SERVICES

// Initialize agent manager
const agentManager = new AgentManager(ENABLE_MOCK_SERVICES)

// Track the current main window for window-state IPC handlers
let mainWindow: BrowserWindow | null = null
let startupSplashWindow: BrowserWindow | null = null
let startupSplashFinishing = false
let startupSplashShownAtMs: number | null = null
let browserController: BrowserController | null = null
let petWindowManager: PetWindowManager | null = null
let reminderScheduler: ReminderScheduler | null = null
let reminderNotifierFire: ((payload: import('./modules/calendar-engine/reminder-scheduler').ReminderFirePayload) => void) | null = null
let calendarSyncScheduler: SyncScheduler | null = null
// Guard to prevent re-registering window-dependent IPC handlers on macOS dock re-open
let windowIPCRegistered = false
const THEME_SETTING_KEY = 'ui_theme_option'
const THEME_SKIN_SETTING_KEY = 'ui_theme_skin'

// 窗口材料状态机控制器（单一职责：管理窗口 bg + vibrancy + fullscreen 内部追踪）
// 在 createWindow() 内实例化；createWindow 之外的所有材料读写都通过它进行。
let windowMaterialController: WindowMaterialController | null = null

type ThemeSnapshot = {
  option: 'light' | 'dark' | 'system'
  resolved: MaterialResolvedTheme
  skin: ThemeSkin
  /** 由 windowMaterialController.isFullscreen() 派生，主要给 renderer 启动 reconciliation 用 */
  isNativeFullscreen: boolean
}

function resolveStoredThemeSource(): 'light' | 'dark' | 'system' {
  try {
    const raw = String(getDatabase().getSetting(THEME_SETTING_KEY) || '').trim().toLowerCase()
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // ignore persisted theme read failures
  }
  return 'light'
}

function resolveStoredThemeSkin(): ThemeSkin {
  try {
    const raw = String(getDatabase().getSetting(THEME_SKIN_SETTING_KEY) || '').trim().toLowerCase()
    if (raw === 'liquid-glass' || raw === 'ready-glass' || raw === 'solid-green-glass' || raw === 'solid-blue-glass') return raw
  } catch {
    // ignore persisted skin read failures
  }
  return 'liquid-glass'
}

function resolveSupportedPlatform(): SupportedPlatform {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return 'linux'
}

function resolveResolvedTheme(): MaterialResolvedTheme {
  // 用户显式选了 light/dark 就直接尊重；只有 'system' 才下放给 nativeTheme.shouldUseDarkColors
  const option = resolveStoredThemeSource()
  if (option === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return option
}

function getThemeSnapshot(): ThemeSnapshot {
  return {
    option: resolveStoredThemeSource(),
    resolved: resolveResolvedTheme(),
    skin: resolveStoredThemeSkin(),
    isNativeFullscreen: windowMaterialController?.isFullscreen() ?? false,
  }
}

/**
 * 广播主题变更给所有 renderer。
 *
 * **重要**：此函数仅负责 IPC 通知，**不再** 直接修改窗口材料。材料更新由
 * `windowMaterialController.sync()` 负责。如果你在调 broadcastThemeChanged 的同一路径上
 * 也要刷新材料，请显式两个都调（参见 nativeTheme.on('updated') 处理）。
 */
function broadcastThemeChanged(): void {
  const snapshot = getThemeSnapshot()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('theme:changed', snapshot)
    }
  }
}

/**
 * 通知 renderer 窗口 fullscreen 状态变化。Stage 1 留这个 helper 但没人触发；
 * Stage 2 的 will-enter / leave-full-screen lifecycle 监听器会用。
 */
function broadcastFullscreenChanged(isFullscreen: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:fullscreen-changed', isFullscreen)
  }
}

function resolveAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.icns')
    : resolve(__dirname, '../../build/icon.png')
}

let nativeFileDragIcon: NativeImage | null = null
function resolveNativeFileDragIcon(): NativeImage {
  if (nativeFileDragIcon) return nativeFileDragIcon
  const icon = nativeImage.createFromPath(resolveAppIconPath())
  nativeFileDragIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 32, height: 32 })
  return nativeFileDragIcon
}

function ensureDockIconVisible(): void {
  if (process.platform !== 'darwin') return
  ensureRegularDockApp()
  if (!app.dock) return
  void app.dock.show().catch((error) => {
    console.warn('[app] Failed to show dock icon:', error instanceof Error ? error.message : String(error))
  })
}

function applyAppIcon(): void {
  ensureDockIconVisible()
  const icon = nativeImage.createFromPath(resolveAppIconPath())
  if (icon.isEmpty()) return

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }
}

// 注：applyNativeWindowMaterial 已被 windowMaterialController 替代。
// 旧函数手动写死 setVibrancy('under-window') / setBackgroundMaterial('mica')，没法响应
// skin / fullscreen 切换；新模块按 4 行状态表自动算目标值并 diff 应用。

async function runBookmarkMenuAction(action: 'import' | 'export'): Promise<void> {
  if (!browserController) return
  if (action === 'import') {
    await browserController.importBookmarksFromDialog()
  } else {
    await browserController.exportBookmarksToDialog()
  }
}

function buildAppMenuTemplate(): MenuItemConstructorOptions[] {
  const bookmarkSubmenu: MenuItemConstructorOptions[] = [
    {
      label: '导入收藏夹…',
      click: () => { void runBookmarkMenuAction('import') },
    },
    {
      label: '导出收藏夹…',
      click: () => { void runBookmarkMenuAction('export') },
    },
  ]

  if (process.platform === 'darwin') {
    return [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: '收藏夹', submenu: bookmarkSubmenu },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]
  }

  return [
    {
      label: '文件',
      submenu: [
        { label: '收藏夹', submenu: bookmarkSubmenu },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}

function setupApplicationMenu(): void {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate())
  Menu.setApplicationMenu(menu)
}

function runFatalProcessCleanup(): Promise<void> {
  return runBeforeQuitCleanup({
    cleanupAgentRuntime,
    cleanupAgentManager: () => agentManager.cleanup(),
    cleanupRsshubManager: () => rsshubManager.cleanup(),
    cleanupManagedBrowsers: async () => {
      const result = await closeAllBrowsers()
      if (result.errors.length > 0) {
        console.warn('[process-handlers] closeAllBrowsers errors', result.errors)
      }
    },
    cleanupRendererReadingSessions: () => requestRendererReadingSessionFlush(),
    cleanupDbWorker: () => shutdownWorkerDbBridge(),
    cleanupFileWatchers: () => shutdownFileWatchers().then(() => undefined),
    closeDatabase: () => getDatabase().close(),
  }, { timeoutMs: 5_000 })
}

registerMainProcessHandlers({
  app,
  cleanup: runFatalProcessCleanup,
})

function describeStartupDatabaseFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const remediation = app.isPackaged
    ? '请重新安装或更新 Ready 后再启动。'
    : '请在项目目录执行 npm run rebuild:native；如果仍失败，执行 npm exec electron-rebuild -- -f -w better-sqlite3。'
  return [
    'Ready 无法打开本地数据库，已停止启动以避免显示空配置。',
    '',
    detail,
    '',
    remediation,
  ].join('\n')
}

function stopBootForDatabaseFailure(error: unknown): void {
  const message = describeStartupDatabaseFailure(error)
  console.error('[boot] primary database readiness failed:', error)
  try {
    dialog.showErrorBox('Ready 启动失败', message)
  } catch {
    // showErrorBox can fail in headless checks; the console log above remains.
  }
  app.exit(1)
}

async function showMainWindow(): Promise<void> {
  ensureDockIconVisible()
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow()
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  if (!mainWindow.isVisible()) {
    if (startupSplashWindow && !startupSplashWindow.isDestroyed()) {
      startupSplashWindow.focus()
      return
    }
    mainWindow.show()
  }
  mainWindow.focus()
}

const MAIN_WINDOW_RENDERER_RETRY_DELAY_MS = 500
const TRANSPARENT_SURFACE_REFRESH_DELAY_MS = 50
const STARTUP_SPLASH_MIN_VISIBLE_MS = 900
const STARTUP_SPLASH_CLOSE_FALLBACK_MS = 5000
let transparentSurfaceRefreshInFlight = false

async function refreshMainWindowTransparentSurface(): Promise<void> {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.isMinimized()) return
  if (transparentSurfaceRefreshInFlight) return

  transparentSurfaceRefreshInFlight = true
  try {
    if (process.platform === 'darwin') window.invalidateShadow()
    window.webContents.invalidate()
  } finally {
    transparentSurfaceRefreshInFlight = false
  }
}

async function loadRendererRoute(window: BrowserWindow, hashPath?: string): Promise<void> {
  const devRendererUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devRendererUrl) {
    const baseUrl = devRendererUrl.endsWith('/') ? devRendererUrl : `${devRendererUrl}/`
    await window.loadURL(hashPath ? `${baseUrl}#${hashPath}` : baseUrl)
    return
  }

  if (hashPath) {
    await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: hashPath })
    return
  }

  await window.loadFile(join(__dirname, '../renderer/index.html'))
}

async function loadMainWindowRenderer(window: BrowserWindow): Promise<void> {
  try {
    await loadRendererRoute(window)
    return
  } catch (error) {
    console.warn('[main-window] renderer load failed; retrying once:', error instanceof Error ? error.message : String(error))
    await new Promise((resolve) => setTimeout(resolve, MAIN_WINDOW_RENDERER_RETRY_DELAY_MS))
    if (window.isDestroyed()) return
    await loadRendererRoute(window)
  }
}

function showMainWindowAfterStartup(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.webContents.setZoomFactor(1)
  if (window.isMinimized()) {
    window.restore()
  }
  if (!window.isVisible()) {
    window.show()
  }
  window.focus()
  setTimeout(() => {
    void refreshMainWindowTransparentSurface()
  }, TRANSPARENT_SURFACE_REFRESH_DELAY_MS)
}

function finishStartupSplashAndShowMainWindow(): void {
  const splashWindow = startupSplashWindow
  if (!splashWindow || splashWindow.isDestroyed()) {
    showMainWindowAfterStartup()
    return
  }
  if (startupSplashFinishing) return

  startupSplashFinishing = true
  splashWindow.once('closed', () => {
    startupSplashWindow = null
    showMainWindowAfterStartup()
  })

  const shownAtMs = startupSplashShownAtMs ?? Date.now()
  const finishDelayMs = Math.max(0, STARTUP_SPLASH_MIN_VISIBLE_MS - (Date.now() - shownAtMs))

  setTimeout(() => {
    if (splashWindow.isDestroyed()) return
    void splashWindow.webContents.executeJavaScript("window.dispatchEvent(new Event('ready-startup-finish'))").catch((error) => {
      console.warn('[startup-splash] finish signal failed:', error instanceof Error ? error.message : String(error))
      if (!splashWindow.isDestroyed()) splashWindow.close()
    })
  }, finishDelayMs)

  setTimeout(() => {
    if (!splashWindow.isDestroyed()) splashWindow.close()
  }, finishDelayMs + STARTUP_SPLASH_CLOSE_FALLBACK_MS)
}

function showStartupSplashWindow(splashWindow: BrowserWindow): void {
  if (splashWindow.isDestroyed()) return
  if (!splashWindow.isVisible()) {
    splashWindow.show()
  }
  startupSplashShownAtMs ??= Date.now()
}

async function createStartupSplashWindow(variant: 'orange' | 'pink' = 'orange'): Promise<void> {
  if (startupSplashWindow && !startupSplashWindow.isDestroyed()) return

  startupSplashFinishing = false
  startupSplashShownAtMs = null
  const splashWindow = new BrowserWindow({
    width: 650,
    height: 190,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  startupSplashWindow = splashWindow
  splashWindow.on('closed', () => {
    if (startupSplashWindow === splashWindow) {
      startupSplashWindow = null
    }
  })
  splashWindow.once('ready-to-show', () => {
    showStartupSplashWindow(splashWindow)
  })

  try {
    await splashWindow.loadURL(createStartupSplashDataUrl(variant))
    showStartupSplashWindow(splashWindow)
    await new Promise<void>((resolve) => {
      if (splashWindow.isDestroyed() || splashWindow.isVisible()) {
        resolve()
        return
      }
      const settle = () => resolve()
      splashWindow.once('ready-to-show', settle)
      splashWindow.once('closed', settle)
      setTimeout(settle, 1500)
    })
  } catch (error) {
    console.warn('[startup-splash] renderer load failed:', error instanceof Error ? error.message : String(error))
    if (!splashWindow.isDestroyed()) splashWindow.close()
  }
}

async function createWindow(): Promise<void> {
  nativeTheme.themeSource = resolveStoredThemeSource()
  ensureDockIconVisible()
  // 首帧材料：macOS 从构造期就是透明 under-window，非 macOS 用主题匹配色避免白闪。
  // controller.applyInitial() 仍接管后续材料状态，但不会重复设置构造期已经应用的 macOS 值。
  const platform = resolveSupportedPlatform()
  const nonMacFirstFrameBg = nativeTheme.shouldUseDarkColors ? '#1A1B1E' : '#F7F9FC'
  const constructorMaterial = platform === 'darwin'
    ? { backgroundColor: DARWIN_LIQUID_GLASS_TRANSPARENT, vibrancy: 'under-window' as const }
    : null
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    icon: resolveAppIconPath(),
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: constructorMaterial?.backgroundColor ?? nonMacFirstFrameBg,
    vibrancy: constructorMaterial?.vibrancy,
    visualEffectState: platform === 'darwin' ? 'active' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 用 controller 接管材料；applyInitial 内部按状态表 sync 一次（macOS 上会立刻把 bg 切到透明 + vibrancy）
  windowMaterialController = createWindowMaterialController({
    window: mainWindow,
    platform,
    initialMaterial: constructorMaterial,
    getTheme: () => ({
      skin: resolveStoredThemeSkin(),
      resolvedTheme: resolveResolvedTheme(),
    }),
    notifyFullscreenChanged: (isFullscreen) => broadcastFullscreenChanged(isFullscreen),
  })
  windowMaterialController.applyInitial()
  windowMaterialController.attachLifecycle() // Stage 1 是 stub；Stage 2 填监听器

  const closedWindow = mainWindow
  mainWindow.on('closed', () => {
    if (mainWindow === closedWindow) {
      mainWindow = null
      windowMaterialController = null
      if (startupSplashWindow && !startupSplashWindow.isDestroyed()) {
        startupSplashWindow.close()
      }
    }
  })

  // Keep renderer UI at 100% scale so panel sizing remains pixel-consistent with design specs.
  mainWindow.webContents.setZoomFactor(1)
  // fire-and-forget: setVisualZoomLevelLimits rejects on some Electron builds before first navigation; UX impact is cosmetic-only zoom limit.
  void mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {
    // Ignore; some Electron builds may reject this before first navigation.
  })
  mainWindow.webContents.on('zoom-changed', () => {
    mainWindow?.webContents.setZoomFactor(1)
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase()
    const isZoomShortcut = (input.control || input.meta) && (key === '+' || key === '=' || key === '-' || key === '0')
    if (isZoomShortcut) {
      event.preventDefault()
      mainWindow?.webContents.setZoomFactor(1)
    }
  })

  mainWindow.on('ready-to-show', () => {
    finishStartupSplashAndShowMainWindow()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Setup window-dependent IPC only once (agent/browser handlers register ipcMain.handle
  // which cannot be registered twice without error)
  if (!windowIPCRegistered) {
    browserController = setupBrowserIPC(mainWindow, ENABLE_MOCK_SERVICES, {
      preloadPath: join(__dirname, '../preload/index.mjs'),
      rendererFile: join(__dirname, '../renderer/index.html'),
    })
    setRSSBrowserController(browserController)
    setupAgentIPC(agentManager, mainWindow, browserController)
    windowIPCRegistered = true
  } else {
    browserController?.attachWindow(mainWindow)
  }
  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  void loadMainWindowRenderer(mainWindow).catch((error) => {
    console.error('[main-window] renderer load failed:', error instanceof Error ? error.message : String(error))
  })

  // Auto-updater — only in production builds
  if (app.isPackaged) {
    setupAutoUpdater(mainWindow)
  }
}

// --- Register all ipcMain.handle() handlers once (not per-window) ---

function setupGlobalIPC(): void {
  // Module IPC handlers (no window dependency)
  setupDocumentIPC(DOCUMENT_USE_MOCK)  // Always real fs
  setupBoardIPC({ getMainWindow: () => mainWindow })
  setupSearchIPC()
  setupFileEmergenceIPC()
  setupRSSIPC(RSS_USE_MOCK)
  // Reminder runtime: notifier closes over the mainWindow accessor (window
  // may be created after this point on cold start; closure defers reads).
  // Scheduler reads from the DB and calls notifier.fire() when timers
  // expire. The IPC handler notifies scheduler.onEventChanged() after
  // each successful event mutation.
  const reminderNotifier = createReminderNotifier({
    getMainWindow: () => mainWindow,
  })
  reminderNotifierFire = (payload) => reminderNotifier.fire(payload)
  reminderScheduler = startReminderScheduler({
    getDb: () => getDatabase(),
    now: () => Math.floor(Date.now() / 1000),
    scheduleAt: defaultScheduleAt,
    fire: (payload) => reminderNotifier.fire(payload),
  })
  // L4-B-External-Sync — periodic ICS subscription poller. Lives next
  // to the reminder scheduler because both share the "in-memory
  // setTimeout map + DI clock + scheduleAt" shape; one stop call kills
  // both kinds of timers cleanly. Skip the construction entirely under
  // mock mode so we don't reach into a non-existent DB on dev start.
  if (!CALENDAR_USE_MOCK) {
    calendarSyncScheduler = createSyncScheduler({
      getSources: () => {
        try {
          // The repository.getSources() filter strips disabled rows,
          // which is what we want — disabled subscriptions should not
          // be re-polled. We narrow the row shape so the scheduler's
          // TS contract is preserved (it only needs id / sync_url /
          // sync_interval).
          return getDatabase().getCalendarSources().map((s) => ({
            id: s.id,
            sync_url: s.sync_url,
            sync_interval: s.sync_interval,
          }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn('[sync-scheduler] getSources read failed:', message)
          return []
        }
      },
      fetchIcs: async (url: string) => {
        // Node 18+ has a global `fetch`; Electron 34 inherits it. We
        // set a UA so upstream servers can tell us apart from generic
        // crawlers and apply less aggressive rate-limits where they
        // distinguish (Google's iCal endpoints do this).
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Ready-Calendar/1.0' },
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }
        return res.text()
      },
      importedEventsFor: (sourceId: string) => {
        try {
          return getDatabase().listImportedEventsForSource(sourceId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[sync-scheduler] listImportedEventsForSource(${sourceId}) failed:`, message)
          return []
        }
      },
      upsertImportedEvent: (sourceId, ev) =>
        getDatabase().upsertImportedEvent(sourceId, ev),
      deleteImportedEvent: (sourceId, uid) =>
        getDatabase().deleteImportedEvent(sourceId, uid),
      onSourceSynced: (result) => {
        // Telemetry hook — log line; tests rely on this not throwing.
        if (result.ok) {
          console.log(
            `[sync-scheduler] ${result.sourceId} ok created=${result.eventsCreated} updated=${result.eventsUpdated} removed=${result.eventsRemoved}`,
          )
        } else {
          console.warn(
            `[sync-scheduler] ${result.sourceId} fail ${result.error}`,
          )
        }
      },
      now: () => Math.floor(Date.now() / 1000),
      scheduleAt: defaultScheduleAt,
    })
  }
  setupCalendarIPC(CALENDAR_USE_MOCK, {
    onEventChanged: (eventId) => {
      reminderScheduler?.onEventChanged(eventId)
    },
    syncScheduler: calendarSyncScheduler ?? undefined,
  })
  setupSettingsIPC()
  petWindowManager = setupPetIPC({
    preloadPath: join(__dirname, '../preload/index.mjs'),
      rendererFile: join(__dirname, '../renderer/index.html'),
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      ensureDockApp: ensureDockIconVisible,
    })
  setupAppCacheIPC()
  setupNativeContextMenuIPC(() => mainWindow)
  setupSkillsIPC()
  setupMemoryManagementIPC()

  // Window state IPC — uses the module-level mainWindow variable
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })
  ipcMain.handle('window:refreshTransparentSurface', () => refreshMainWindowTransparentSurface())

  ipcMain.on('app:startNativeFileDrag', (event, paths: unknown) => {
    try {
      if (!READY_NATIVE_FILE_DRAG_ENABLED) return
      if (!Array.isArray(paths)) return
      const files = paths
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .filter((filePath) => {
          try {
            return isAbsolute(filePath) && existsSync(filePath) && statSync(filePath).isFile()
          } catch {
            return false
          }
        })
      if (files.length === 0) return
      const icon = resolveNativeFileDragIcon()
      if (icon.isEmpty()) return
      event.sender.startDrag({
        file: files[0],
        files,
        icon,
      })
    } catch (error) {
      console.warn('[drag] start native file drag failed:', error instanceof Error ? error.message : String(error))
    }
  })

  // Theme sync — sets Electron's nativeTheme so BrowserView respects prefers-color-scheme,
  // then refreshes window material via the state machine and broadcasts the snapshot.
  ipcMain.handle('theme:set', (_event, theme: string) => {
    const nextTheme = theme === 'dark' || theme === 'light' || theme === 'system' ? theme : 'light'
    nativeTheme.themeSource = nextTheme
    try {
      getDatabase().setSetting(THEME_SETTING_KEY, nextTheme)
    } catch {
      // ignore persistence failures
    }
    // 通过状态机刷新窗口材料（macOS 下 light/dark 切换可能影响 fullscreen backing 色）
    windowMaterialController?.sync()
    broadcastThemeChanged()
  })

  // Skin sync — switches between liquid-glass (真半透明) and ready-glass (Ready 自持稳定底);
  // Persists to DB and refreshes window material (vibrancy / opaque bg 切换走状态表).
  // 切换 skin **不** 触发 ritual（ritual 只为昼夜主题切换），renderer 端通过 onChanged 收新 snapshot.
  ipcMain.handle('theme:setSkin', (_event, skin: string) => {
    const nextSkin: ThemeSkin = skin === 'ready-glass' || skin === 'solid-green-glass' || skin === 'solid-blue-glass' ? skin : 'liquid-glass'
    try {
      getDatabase().setSetting(THEME_SKIN_SETTING_KEY, nextSkin)
    } catch {
      // ignore persistence failures
    }
    windowMaterialController?.sync()
    broadcastThemeChanged()
  })

  ipcMain.handle('theme:get', () => {
    try {
      return {
        success: true,
        data: getThemeSnapshot(),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

// --- Auto-updater setup (production only) ---

let autoUpdaterConfigured = false
let autoUpdaterStatusWindow: BrowserWindow | null = null

function setupAutoUpdater(mainWindow: BrowserWindow): void {
  autoUpdaterStatusWindow = mainWindow
  if (autoUpdaterConfigured) return
  autoUpdaterConfigured = true
  const updaterConfigPath = join(process.resourcesPath, 'app-update.yml')
  const updaterConfigAvailable = existsSync(updaterConfigPath)

  const sendStatus = (status: string, data?: Record<string, unknown>): void => {
    const targetWindow = autoUpdaterStatusWindow
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send('update-status', { status, ...data })
    }
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendStatus('checking')
  })

  autoUpdater.on('update-available', (info) => {
    sendStatus('available', { version: info.version, releaseDate: info.releaseDate })
  })

  autoUpdater.on('update-not-available', (info) => {
    sendStatus('not-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('downloading', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus('downloaded', { version: info.version, releaseDate: info.releaseDate })
  })

  autoUpdater.on('error', (err) => {
    sendStatus('error', { error: err.message })
  })

  // IPC: manual check for update
  ipcMain.handle('app:check-update', async () => {
    if (!updaterConfigAvailable) {
      return { success: false, error: 'Update configuration is not available in this build.' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      return { success: true, version: result?.updateInfo?.version ?? null }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  // IPC: quit and install downloaded update
  ipcMain.handle('app:install-update', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('app:writeImageToClipboard', async (_, payload: { path?: unknown; text?: unknown }) => {
    try {
      const imagePath = typeof payload?.path === 'string' ? payload.path.trim() : ''
      if (!imagePath || !isAbsolute(imagePath)) return { success: false, error: 'Invalid image path' }
      if (!existsSync(imagePath) || !statSync(imagePath).isFile()) return { success: false, error: 'Image not found' }
      const image = nativeImage.createFromPath(imagePath)
      if (image.isEmpty()) return { success: false, error: 'Unsupported image' }
      const text = typeof payload?.text === 'string' ? payload.text : imagePath
      clipboard.write({ image, text })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Check for updates after a short delay to avoid slowing down startup
  if (updaterConfigAvailable) {
    setTimeout(() => {
      // fire-and-forget: background update check; failure is exposed via the manual app:check-update IPC the user can invoke from the menu.
      autoUpdater.checkForUpdates().catch(() => {
        // Silently ignore — user can manually check via app:check-update
      })
    }, 5_000)
  }
}

// Register local-file as a privileged scheme BEFORE app.whenReady()
// This is required for video streaming (range requests), fetch API support, etc.
// Keep auth popups (OAuth / SSO) available inside BrowserView-based tabs.
app.commandLine.appendSwitch('disable-popup-blocking')
// FedCM can become a no-op inside BrowserView on some Electron builds.
// Force legacy OAuth popup flow for stable third-party login behavior.
app.commandLine.appendSwitch('disable-features', 'FedCm')
const remoteDebuggingPort = process.env.READY_REMOTE_DEBUGGING_PORT?.trim()
if (remoteDebuggingPort) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
}
app.userAgentFallback = toOAuthCompatibleUserAgent(app.userAgentFallback)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    }
  }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.ready.app')
  applyAppIcon()
  setupApplicationMenu()
  await createStartupSplashWindow()

  // Reap any orphaned child processes from a previous Ready instance that was
  // force-quit / crashed. Must run BEFORE rsshub / skill runtime spawns so we
  // don't accidentally kill our own fresh children.
  try {
    const result = reapOrphans()
    if (result.skipped) {
      console.log(`[boot-reaper] skipped (${result.skipped})`)
    } else {
      console.log(`[boot-reaper] reaped=${result.reaped.length} errors=${result.errors.length}`)
      for (const err of result.errors) {
        console.warn(`[boot-reaper] ${err}`)
      }
    }
  } catch (err) {
    console.warn('[boot-reaper] failed:', err instanceof Error ? err.message : String(err))
  }

  try {
    assertPrimaryDatabaseReady()
  } catch (error) {
    stopBootForDatabaseFailure(error)
    return
  }
  try {
    reconcileStartupRunsOnStartup()
  } catch (error) {
    console.warn('[startup-run-reconciler] failed:', error instanceof Error ? error.message : String(error))
  }

  // nativeTheme.updated 可能在 OS 切换深浅模式时、或我们在 theme:set handler 里设置
  // themeSource 时触发。**必须显式做两件事**：刷新窗口材料 + 广播 renderer。
  // 不能简化成只 sync 不 broadcast —— 否则 system 模式下 OS 切换深浅时 renderer
  // 收不到 theme:changed 推送，useTheme 状态静默不同步。
  nativeTheme.on('updated', () => {
    windowMaterialController?.sync()
    broadcastThemeChanged()
  })

  console.log('[Main] App ready, registering protocol handler...')

  // Register local-file:// protocol handler for serving local files to the renderer
  // Uses fs directly to properly support Range requests for video seeking.
  protocol.handle('local-file', async (request) => {
    // Because local-file is registered as a "standard" scheme, Chromium parses
    // local-file:///Users/user/file.png as:
    //   host = "users" (lowercased!), pathname = "/user/file.png"
    // We must reconstruct the original absolute path from host + pathname.
    const parsed = new URL(request.url)
    const decodedPathname = decodeURIComponent(parsed.pathname)
    let filePath = parsed.host
      ? `/${parsed.host}${decodedPathname}`
      : decodedPathname

    // Windows: remove leading slash and fix drive letter case
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1)
      // Fix lowercase drive letter: c:/path -> C:/path
      if (filePath.length >= 2 && filePath[1] === ':') {
        filePath = filePath[0].toUpperCase() + filePath.slice(1)
      }
    }

    // Security: validate the path before serving
    if (!isPathAllowed(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }

    if (!existsSync(filePath)) {
      return new Response('Not Found', { status: 404 })
    }

    // MIME type map
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
      '.tiff': 'image/tiff', '.tif': 'image/tiff',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.ogg': 'video/ogg',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
      '.aac': 'audio/aac', '.m4a': 'audio/mp4',
      '.pdf': 'application/pdf', '.json': 'application/json',
      '.epub': 'application/epub+zip',
      '.mobi': 'application/x-mobipocket-ebook',
      '.azw': 'application/vnd.amazon.ebook',
      '.azw3': 'application/vnd.amazon.ebook',
      '.fb2': 'application/x-fictionbook+xml',
      '.cbz': 'application/vnd.comicbook+zip',
      '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    }
    const ext = extname(filePath).toLowerCase()
    const contentType = mimeMap[ext] || 'application/octet-stream'
    const fileSize = statSync(filePath).size
    const fullResponseHeaders = {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    }

    // Parse Range header for partial content (required for video seeking)
    const rangeHeader = request.headers.get('Range')
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const chunkSize = end - start + 1

        // Use a readable stream for efficient partial reads
        const stream = createReadStream(filePath, { start, end })
        const readable = new ReadableStream({
          start(controller) {
            stream.on('data', (chunk) => controller.enqueue(chunk))
            stream.on('end', () => controller.close())
            stream.on('error', (err) => controller.error(err))
          },
          cancel() { stream.destroy() }
        })

        return new Response(readable, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': String(chunkSize),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range',
          },
        })
      }
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: fullResponseHeaders,
      })
    }

    if (contentType.startsWith('image/')) {
      return new Response(await readFile(filePath), {
        status: 200,
        headers: fullResponseHeaders,
      })
    }

    // Full file response — also use stream for large files
    const stream = createReadStream(filePath)
    const readable = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(chunk))
        stream.on('end', () => controller.close())
        stream.on('error', (err) => controller.error(err))
      },
      cancel() { stream.destroy() }
    })

    return new Response(readable, {
      status: 200,
      headers: fullResponseHeaders,
    })
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Start embedded RSSHub instance (non-blocking) unless explicitly mocked.
  if (!RSS_USE_MOCK) {
    rsshubManager.start().catch((err) => {
      console.error('[rsshub] Failed to start embedded RSSHub:', err)
    })
  }

  // Register global IPC handlers once, before any window is created
  setupGlobalIPC()
  applyBundledAISettingsSeed()

  // Reminder bootstrap: replay any missed reminders inside the grace window,
  // then arm the live scheduler. Window creation is async, but the notifier
  // closes over a deferred `getMainWindow` accessor so it's safe to fire
  // here — IPC pushes will silently no-op until the window mounts, and
  // missed-reminder OS notifications still surface via the system tray.
  if (reminderScheduler && reminderNotifierFire) {
    const scheduler = reminderScheduler
    const fire = reminderNotifierFire
    void recoverMissedReminders({
      getDb: () => getDatabase(),
      now: () => Math.floor(Date.now() / 1000),
      fire,
    }).then((summary) => {
      console.log('[reminder-cold-start]', summary)
    }).catch((err) => {
      console.warn('[reminder-cold-start] recovery failed:', err)
    })
    void scheduler.rescheduleAll().catch((err) => {
      console.warn('[reminder-scheduler] initial sweep failed:', err)
    })
  }

  // L4-B — kick off the periodic ICS sync timers. The constructor is
  // a no-op when no source has a sync_url; calling here is safe even
  // for fresh installs. We wrap in try/catch so a startup misconfig
  // (e.g. a bad URL recorded in a previous session) can't crash the
  // app cold-start path.
  if (calendarSyncScheduler) {
    try {
      calendarSyncScheduler.startPeriodic()
    } catch (err) {
      console.warn('[sync-scheduler] startPeriodic failed:', err)
    }
  }

  void createWindow().then(() => petWindowManager?.restoreIfEnabled())

  app.on('activate', function () {
    // Pet windows are separate BrowserWindows; Dock activation should restore the main app window.
    void showMainWindow()
  })
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Clean up before quit. Previous version fired the runtime cleanup with `void`
// and then synchronously closed the DB, so the process could exit mid-cleanup
// and leave sidecar / chrome / rsshub orphans. We now defer the quit, await an
// ordered shutdown (bounded by a 5s timeout so a stuck sidecar can't hang the
// app), then re-trigger quit. The `isQuitting` guard prevents the second
// `app.quit()` from re-entering this handler.
let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  isQuitting = true
  event.preventDefault()
  // Stop the reminder scheduler synchronously — it owns only in-process
  // setTimeout handles, no IO or sidecar processes, so it's safe to run
  // before the async cleanup chain. Doing it here prevents any timer that
  // races the shutdown from trying to call into a half-destroyed mainWindow.
  try {
    reminderScheduler?.stop()
  } catch (err) {
    console.warn('[before-quit] reminderScheduler.stop threw:', err)
  }
  try {
    calendarSyncScheduler?.stop()
  } catch (err) {
    console.warn('[before-quit] calendarSyncScheduler.stop threw:', err)
  }
  void runBeforeQuitCleanup({
    cleanupAgentRuntime,
    cleanupAgentManager: () => agentManager.cleanup(),
    cleanupRsshubManager: () => rsshubManager.cleanup(),
    cleanupManagedBrowsers: async () => {
      const result = await closeAllBrowsers()
      if (result.errors.length > 0) {
        console.warn('[before-quit] closeAllBrowsers errors', result.errors)
      }
    },
    cleanupRendererReadingSessions: () => requestRendererReadingSessionFlush(),
    cleanupDbWorker: () => shutdownWorkerDbBridge(),
    cleanupFileWatchers: () => shutdownFileWatchers().then(() => undefined),
    closeDatabase: () => getDatabase().close(),
  }).catch((err) => {
    console.error('[before-quit] cleanup error', err)
  }).finally(() => {
    app.quit()
  })
})
