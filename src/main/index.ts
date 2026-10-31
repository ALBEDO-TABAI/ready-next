import { registerDocumentImportIPC } from './modules/document-import/ipc'
import { ObjectRelationsService, registerObjectRelationsIPC } from './modules/object-relations/service'
import { registerDocumentAnnotationsIPC } from './modules/document-annotations/ipc'
import { setupDateMentions } from './modules/calendar-engine/date-mentions/runtime'
import { registerCalendarLayersIPC } from './modules/calendar-layers/ipc'
import { createCalendarLayersResolver } from './modules/calendar-layers/runtime'
import { createDocumentDatabaseResolver } from './modules/document-database/runtime'
import { registerDocumentDatabaseIPC } from './modules/document-database/ipc'
import { VaultService } from './modules/settings-engine/vault-service'
import { AppSettingsRepository } from './modules/repositories/app-settings-repository'
import { getDocumentWriteDependencies } from './modules/document-engine/document-write-service'
import { setupDocumentPagesIPC } from './modules/document-pages/runtime'
import { captureCalendarOpen } from './calendar-open-intents'
import { startCalendarDesktop } from './modules/calendar-engine/calendar-desktop'
import { onCalendarChanged } from './modules/calendar-engine/calendar-change'
import { isChatGptOAuthConfig } from '../shared/chatgpt-oauth'
import { startRSSDigests, stopRSSDigests, resumeRSSDigests } from './modules/rss-engine/digest-runtime'
import { stopRSSContentService } from './modules/rss-engine/content-runtime'
import { startRSSProcessing, stopRSSProcessing, wakeRSSProcessing } from './modules/rss-engine/processing-runtime'
// 本文件是重模块：由 boot-entry.ts（构建入口）在 splash 可见后动态加载。
// dotenv、userData 路径、协议注册、命令行开关等 pre-ready 配置都在 boot-entry 完成。
import { app, shell, BrowserWindow, ipcMain, protocol, nativeImage, nativeTheme, Menu, dialog, clipboard, powerMonitor, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { join, isAbsolute, basename, resolve } from 'path'
import { statSync, existsSync, appendFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Import modules
import {
  setupAgentIPC,
  cleanupAgentRuntime,
  migrateAgentChannelCredentialsAfterWindowReady,
  readAgentCodexRuntimeDiagnostics,
} from './modules/claude-bridge/ipc-handler'
import { AgentManager } from './modules/claude-bridge/agent-manager'
import { startRendererBeforeRuntimeReady } from './modules/claude-bridge/runtime-startup-slot'
import { registerAgentRuntimeReadinessIPC } from './modules/claude-bridge/agent-runtime-readiness'
import { setupBrowserIPC, type BrowserController } from './modules/browser-engine/ipc-handler'
import { setupBrowserLiveProofHandshake } from './modules/browser-engine/live-proof-handshake'
import { setupDocumentIPC } from './modules/document-engine/ipc-handler'
import { setupSearchIPC, shutdownFileWatchers, getSearchEngine } from './modules/search-engine/ipc-handler'
import { setupFileEmergenceIPC } from './modules/file-emergence/ipc-handler'
import { setupTagForgeIPC } from './modules/tag-forge/ipc-handler'
import {
  fetchAllRSSFeeds,
  readLastRSSFetchAllCompletedAt,
  readRSSAutoRefreshInterval,
  setupRSSIPC,
  setRSSBrowserController,
  setRSSFetchAllCompletedListener,
} from './modules/rss-engine/ipc-handler'
import {
  RSSAutoRefreshScheduler,
  setupRSSAutoRefreshIPC,
} from './modules/rss-engine/auto-refresh-scheduler'
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
import { setupLibraryIPC, shutdownLibrarySources } from './modules/library-engine/runtime'
import { initializeCredentialVault } from './modules/settings-engine/credential-vault'
import { pruneUnreferencedCredentialsAtStartup } from './modules/settings-engine/credential-vault-reconciliation'
import { migrateExternalServiceCredentialsAfterWindowReady } from './modules/settings-engine/external-service-store'
import type { ChatGptOAuthService } from './modules/settings-engine/chatgpt-oauth-service'
import {
  RSS_AUTO_REFRESH_INTERVAL_KEY,
} from '../shared/rss-auto-refresh'
import { setupPetIPC } from './modules/pet/ipc-handler'
import type { PetWindowManager } from './modules/pet/pet-window-manager'
import { applyBundledAISettingsSeed } from './modules/settings-engine/seed-loader'
import { setupAppCacheIPC } from './modules/app-control/cache-stats-ipc'
import { setupNativeContextMenuIPC } from './modules/app-control/native-context-menu-ipc'
import { captureReadyWindow, type ReadyWindowCaptureResult } from './modules/app-control/window-capture-service'
import { isPathAllowed } from './modules/app-control/local-path-safety'
import { createLocalFileResponse } from './modules/app-control/local-file-response'
import { reconcileStartupRunsOnStartup } from './modules/app-control/startup-run-reconciler'
import { setupCanvasRuntime } from './modules/board-engine/runtime'
import { setupSkillsIPC } from './modules/skills-runtime/ipc-handler'
import { setupImageGenerationIPC } from './modules/image-generation/ipc-handler'
import { rsshubManager } from './modules/rss-engine/rsshub-process'
import { reapOrphans } from './modules/process-cleanup/boot-reaper'
import { runBeforeQuitCleanup } from './modules/process-cleanup/before-quit'
import {
  GracefulWindowCloseCoordinator,
  type GracefulExitAction,
} from './modules/process-cleanup/graceful-window-close-coordinator'
import { requestRendererStateFlush, setupRendererStateFlushIPC } from './modules/process-cleanup/renderer-state-flush'
import { closeAllBrowsers } from './modules/browser-engine/browser-cleanup'
import { assertPrimaryDatabaseReady, getDatabase } from './modules/database'
import { shutdownWorkerDbBridge } from './modules/database/worker-bridge'
import { shutdownDocumentWorker } from './modules/document-engine/document-worker-bridge'
import {
  setDirectoryChangeBroadcastTargetProvider,
  shutdownDirectoryChangeBroadcasts,
} from './modules/document-engine/ipc/directory-change-broadcast'
import { registerMainProcessHandlers } from './process-handlers'
import {
  createWindowMaterialController,
  DARWIN_LIQUID_GLASS_TRANSPARENT,
  type ThemeSkin,
  type ResolvedTheme as MaterialResolvedTheme,
  type SupportedPlatform,
  type WindowMaterialController,
} from './modules/window-material/main-window-material'
import { createStartupSplashWindow, finishStartupSplashThen, getStartupSplashWindow, yieldToPresentation } from './startup-splash-window'
import { logBootStage } from './boot-timing'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

// Environment configuration
// Document operations (local fs) are always real — no external dependencies.
// All environments: opt-in only via ENABLE_MOCK_SERVICES=true
const ENABLE_MOCK_SERVICES = process.env.ENABLE_MOCK_SERVICES === 'true'
const READY_NATIVE_FILE_DRAG_ENABLED = process.env.READY_NATIVE_FILE_DRAG_ENABLED !== '0'
const READY_START_HIDDEN = process.env.READY_START_HIDDEN === '1'
const READY_BROWSER_LOG_PATH = join(tmpdir(), 'ready-browser.log')
const NATIVE_FILE_DRAG_FALLBACK_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJElEQVR42mP4////JUoww+AywOTyzP/E4FEDRg2grQFDMzMBAGl5WG7b5B5RAAAAAElFTkSuQmCC'

function ensureRegularDockApp(): void {
  if (process.platform !== 'darwin' || READY_START_HIDDEN) return
  app.setActivationPolicy('regular')
}

// Document engine always uses real fs, regardless of mock setting
const DOCUMENT_USE_MOCK = false
// RSS and Calendar use the same mock flag
const RSS_USE_MOCK = ENABLE_MOCK_SERVICES
const CALENDAR_USE_MOCK = ENABLE_MOCK_SERVICES

// Initialize agent manager
const agentManager = new AgentManager(ENABLE_MOCK_SERVICES)

// Track the current main window for window-state IPC handlers
let mainWindow: BrowserWindow | null = null
let browserController: BrowserController | null = null
let petWindowManager: PetWindowManager | null = null
let dateMentions: ReturnType<typeof setupDateMentions> | undefined
let reminderScheduler: ReminderScheduler | null = null
let reminderNotifierFire: ((payload: import('./modules/calendar-engine/reminder-scheduler').ReminderFirePayload) => void) | null = null
let calendarSyncScheduler: SyncScheduler | null = null
let stopCalendarDesktop: (() => void) | null = null
let rssAutoRefreshScheduler: RSSAutoRefreshScheduler | null = null
let chatGptOAuthService: ChatGptOAuthService | null = null
let canvasRuntime: ReturnType<typeof setupCanvasRuntime> | undefined

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
    const raw = String(getDatabase().settings.getSetting(THEME_SETTING_KEY) || '').trim().toLowerCase()
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // ignore persisted theme read failures
  }
  return 'light'
}

function resolveStoredThemeSkin(): ThemeSkin {
  try {
    const raw = String(getDatabase().settings.getSetting(THEME_SKIN_SETTING_KEY) || '').trim().toLowerCase()
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

function logNativeFileDragDiag(message: string): void {
  try {
    appendFileSync(READY_BROWSER_LOG_PATH, `${new Date().toISOString()} [native-file-drag] ${message}\n`, 'utf8')
  } catch {
    // Diagnostics must never block a drag gesture.
  }
}

let nativeFileDragIcon: NativeImage | null = null
let nativeFileDragIconSource = ''
function resolveNativeFileDragIcon(): NativeImage {
  if (nativeFileDragIcon) return nativeFileDragIcon
  const icon = nativeImage.createFromPath(resolveAppIconPath())
  if (!icon.isEmpty()) {
    nativeFileDragIconSource = resolveAppIconPath()
    nativeFileDragIcon = icon.resize({ width: 32, height: 32 })
    return nativeFileDragIcon
  }
  const fallbackIcon = nativeImage.createFromDataURL(NATIVE_FILE_DRAG_FALLBACK_ICON_DATA_URL)
  nativeFileDragIconSource = fallbackIcon.isEmpty() ? 'empty-fallback' : 'embedded-fallback'
  nativeFileDragIcon = fallbackIcon.isEmpty() ? nativeImage.createEmpty() : fallbackIcon.resize({ width: 32, height: 32 })
  return nativeFileDragIcon
}

function ensureDockIconVisible(): void {
  if (process.platform !== 'darwin' || READY_START_HIDDEN) return
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

const handleRSSResume = (): void => { void resumeRSSDigests().catch((error) => console.error('[rss-digests] resume failed', error)) }
const handleCalendarResume = (): void => {
  if (!reminderScheduler || !reminderNotifierFire) return
  void reminderScheduler.rescheduleAll().then(() => recoverMissedReminders({mentions: dateMentions, getDb: () => getDatabase().calendar, now: () => Math.floor(Date.now()/1000), fire: reminderNotifierFire!})).catch(error => console.error('[calendar-resume]', error))
}

function stopRSSAutoRefresh(): Promise<void> {
  setRSSFetchAllCompletedListener(null)
  try {
    return rssAutoRefreshScheduler?.stop() ?? Promise.resolve()
  } catch (error) {
    console.warn('[rss:auto-refresh] stop failed:', error instanceof Error ? error.message : String(error))
    return Promise.resolve()
  }
}

function runFatalProcessCleanup(): Promise<void> {
  stopRSSDigests()
  powerMonitor.removeListener('resume', handleRSSResume)
  powerMonitor.removeListener('resume', handleCalendarResume)
  const rssAutoRefreshStopped = Promise.all([stopRSSAutoRefresh(), stopRSSContentService(), stopRSSProcessing()])
  return runBeforeQuitCleanup({
    cleanupAgentRuntime,
    cleanupAgentManager: () => agentManager.cleanup(),
    cleanupRsshubManager: async () => {
      await rssAutoRefreshStopped
      await rsshubManager.cleanup()
    },
    cleanupManagedBrowsers: async () => {
      await rssAutoRefreshStopped
      const result = await closeAllBrowsers()
      if (result.errors.length > 0) {
        console.warn('[process-handlers] closeAllBrowsers errors', result.errors)
      }
    },
    cleanupRendererState: () => requestRendererStateFlush(mainWindow).then(() => undefined),
    cleanupDbWorker: () => shutdownWorkerDbBridge(),
    cleanupDocumentWorker: () => shutdownDocumentWorker(),
    cleanupDocumentDirectoryBroadcasts: () => shutdownDirectoryChangeBroadcasts(),
    cleanupFileWatchers: () => shutdownFileWatchers().then(() => undefined),
    cleanupLibrarySources: () => shutdownLibrarySources(),
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
    const splashWindow = getStartupSplashWindow()
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.focus()
      return
    }
    mainWindow.show()
  }
  mainWindow.focus()
  runCredentialMigrationsAfterWindowReady()
}

const MAIN_WINDOW_RENDERER_RETRY_DELAY_MS = 500
const TRANSPARENT_SURFACE_REFRESH_DELAY_MS = 50
let transparentSurfaceRefreshInFlight = false
let credentialMigrationsStarted = false

function runCredentialMigrationsAfterWindowReady(): void {
  if (credentialMigrationsStarted) return
  credentialMigrationsStarted = true
  void Promise.all([
    migrateExternalServiceCredentialsAfterWindowReady(),
    migrateAgentChannelCredentialsAfterWindowReady(),
  ]).catch((error) => {
    console.warn('[credential-migration] failed:', error instanceof Error ? error.message : String(error))
  })
}

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
  if (READY_START_HIDDEN) return
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
  runCredentialMigrationsAfterWindowReady()
  setTimeout(() => {
    void refreshMainWindowTransparentSurface()
  }, TRANSPARENT_SURFACE_REFRESH_DELAY_MS)
}

async function createWindow(): Promise<void> {
  logBootStage('create-window:start')
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
  mainWindow.on('close', (event) => {
    getGracefulWindowCloseCoordinator().handleWindowClose(event)
  })
  mainWindow.on('closed', () => {
    getGracefulWindowCloseCoordinator().handleWindowClosed()
    if (mainWindow === closedWindow) {
      mainWindow = null
      windowMaterialController = null
      const splashWindow = getStartupSplashWindow()
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close()
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
    logBootStage('main-window-ready-to-show')
    finishStartupSplashThen(showMainWindowAfterStartup)
  })

  // D18-d 观测线（真机第十六轮：窗口在 agent 运行中出现缩放开关，两次
  // 与 CDP Cmd+A 派发毫秒级对齐）。窗级几何事件全部落主日志，下次任何
  // 窗口尺寸异动都有一手时间戳可对账。
  for (const geometryEvent of ['resized', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    mainWindow.on(geometryEvent as never, () => {
      try {
        const bounds = mainWindow?.getBounds()
        console.log(`[main-window][geometry] ${geometryEvent} bounds=${JSON.stringify(bounds)} maximized=${mainWindow?.isMaximized()} fullscreen=${mainWindow?.isFullScreen()}`)
      } catch { /* observability only */ }
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Setup window-dependent IPC only once (agent/browser handlers register ipcMain.handle
  // which cannot be registered twice without error)
  let rendererLoadStarted = false
  if (!windowIPCRegistered) {
    const window = mainWindow
    logBootStage('browser-ipc:start')
    const currentBrowserController = setupBrowserIPC(window, ENABLE_MOCK_SERVICES, {
      preloadPath: join(__dirname, '../preload/index.mjs'),
      rendererFile: join(__dirname, '../renderer/index.html'),
    })
    browserController = currentBrowserController
    setRSSBrowserController(currentBrowserController)
    logBootStage('agent-ipc:start')
    await startRendererBeforeRuntimeReady({
      startRuntime: () => setupAgentIPC(
        agentManager,
        window,
        currentBrowserController,
        chatGptOAuthService || undefined,
      ),
      startRenderer() {
        rendererLoadStarted = true
        logBootStage('renderer-load:kickoff')
        void loadMainWindowRenderer(window).catch((error) => {
          console.error('[main-window] renderer load failed:', error instanceof Error ? error.message : String(error))
        })
      },
    })
    logBootStage('agent-ipc:done')
    windowIPCRegistered = true
  } else {
    browserController?.attachWindow(mainWindow)
  }
  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (!rendererLoadStarted) {
    logBootStage('renderer-load:kickoff')
    void loadMainWindowRenderer(mainWindow).catch((error) => {
      console.error('[main-window] renderer load failed:', error instanceof Error ? error.message : String(error))
    })
  }

  // Auto-updater — only in production builds
  if (app.isPackaged) {
    setupAutoUpdater(mainWindow)
  }
}

// --- Register all ipcMain.handle() handlers once (not per-window) ---

function setupGlobalIPC(): void {
  registerAgentRuntimeReadinessIPC(ipcMain)
  setupBrowserLiveProofHandshake()
  // Module IPC handlers (no window dependency)
  setDirectoryChangeBroadcastTargetProvider(() => (
    mainWindow && !mainWindow.isDestroyed() ? [mainWindow.webContents] : []
  ))
  setupDocumentIPC(DOCUMENT_USE_MOCK)  // Always real fs
  setupSearchIPC()
  registerObjectRelationsIPC(ipcMain, () => {
    const db = getDatabase().getRawDb()
    if (!db) throw new Error('关系索引尚未就绪')
    return new ObjectRelationsService(db)
  })
  setupLibraryIPC()
  const documentPages = setupDocumentPagesIPC()
  canvasRuntime = setupCanvasRuntime(documentPages.ready, { preloadPath: join(__dirname, '../preload/index.mjs'), rendererFile: join(__dirname, '../renderer/index.html'), rendererUrl: process.env.ELECTRON_RENDERER_URL })
  setupFileEmergenceIPC()
  setupRendererStateFlushIPC()
  setupTagForgeIPC()
  setupImageGenerationIPC()
  setupRSSIPC(RSS_USE_MOCK)
  if (!RSS_USE_MOCK) { void startRSSDigests().catch((error) => console.error('[rss-digests] startup failed', error)); powerMonitor.on('resume', handleRSSResume) }
  rssAutoRefreshScheduler = new RSSAutoRefreshScheduler({
    now: () => Date.now(),
    readIntervalMs: readRSSAutoRefreshInterval,
    readLastCompletedAt: readLastRSSFetchAllCompletedAt,
    runFetchAll: () => fetchAllRSSFeeds(),
    schedule: (delayMs, callback) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    publish: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('rss:autoRefreshCompleted', snapshot)
        }
      }
    },
  })
  setRSSFetchAllCompletedListener((completedAt, result) => {
    rssAutoRefreshScheduler?.onFetchAllCompleted(completedAt, result)
  })
  setupRSSAutoRefreshIPC(ipcMain, () => rssAutoRefreshScheduler!.getSnapshot())
  // Reminder runtime: notifier closes over the mainWindow accessor (window
  // may be created after this point on cold start; closure defers reads).
  // Scheduler reads from the DB and calls notifier.fire() when timers
  // expire. The IPC handler notifies scheduler.onEventChanged() after
  // each successful event mutation.
  const reminderNotifier = createReminderNotifier({
    getMainWindow: () => mainWindow,
  })
  dateMentions = setupDateMentions({ registry: documentPages.service.registry, ready: documentPages.ready, getWindow: () => mainWindow,
    reschedule: async () => { await reminderScheduler?.rescheduleAll() } })
  reminderNotifierFire = (payload) => {
    if (payload.mention) { dateMentions?.fire(payload); return }
    const store = getDatabase().calendar
    const prefs = store.snapshot().prefs || {}
    if (prefs.notifications === false || !store.claimReminder(payload.eventId, payload.eventStartTime, payload.offsetMinutes, payload.method, payload.firedAt)) return
    reminderNotifier.fire({ ...payload, method: prefs.notifySound === false ? 'notification' : 'sound' })
  }
  reminderScheduler = startReminderScheduler({
    getDb: () => getDatabase().calendar,
    mentions: dateMentions,
    now: () => Math.floor(Date.now() / 1000),
    scheduleAt: defaultScheduleAt,
    fire: (payload) => reminderNotifierFire?.(payload),
  })
  const refreshCalendarSearch = () => { void getSearchEngine()?.reindexCalendar().catch(error=>console.error('[calendar search]',error)) }
  onCalendarChanged(ids => { void reminderScheduler?.rescheduleAll(); if(ids.length)refreshCalendarSearch() })
  refreshCalendarSearch()
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
          return getDatabase().calendar.getCalendarSources().filter(s => s.enabled).map((s) => ({
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
      fetchIcs: async (url: string, signal: AbortSignal) => {
        // Node 18+ has a global `fetch`; Electron 34 inherits it. We
        // set a UA so upstream servers can tell us apart from generic
        // crawlers and apply less aggressive rate-limits where they
        // distinguish (Google's iCal endpoints do this).
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Ready-Calendar/1.0' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }
        return res.text()
      },
      replaceEvents: (sourceId, events) => getDatabase().calendar.replaceImportedCalendar(sourceId, events),
      onSourceSynced: (result) => {
        getDatabase().calendar.recordSyncResult(result.sourceId, result.error);
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
  powerMonitor.on('resume', handleCalendarResume)
  setupCalendarIPC(CALENDAR_USE_MOCK, {
    syncScheduler: calendarSyncScheduler ?? undefined,
  })
  const documentDatabase = createDocumentDatabaseResolver({
    vault: new VaultService(new AppSettingsRepository(), { home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged }),
    pages: documentPages.service, ready: documentPages.ready, writer: getDocumentWriteDependencies,
  })
  registerDocumentDatabaseIPC(ipcMain, documentDatabase)
  registerDocumentImportIPC(ipcMain, { pages: documentPages.service, database: documentDatabase })
  registerDocumentAnnotationsIPC(ipcMain, { pages: documentPages.service, ready: documentPages.ready,
    vault: new VaultService(new AppSettingsRepository(), { home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged }),
  })
  registerCalendarLayersIPC(ipcMain, createCalendarLayersResolver({ pages: documentPages.service, writer: getDocumentWriteDependencies, database: documentDatabase }))
  chatGptOAuthService = setupSettingsIPC({
    onModelChanged: wakeRSSProcessing,
    onSettingChanged: (key) => {
      if (key === RSS_AUTO_REFRESH_INTERVAL_KEY) {
        rssAutoRefreshScheduler?.onSettingChanged()
      }
    },
  })
  if (!RSS_USE_MOCK) void startRSSProcessing({ isProviderReady: (config) => !chatGptOAuthService?.isLifecycleBusy() && (!isChatGptOAuthConfig(config) || chatGptOAuthService?.getStatus().state === 'ready') })
  petWindowManager = setupPetIPC({
    preloadPath: join(__dirname, '../preload/index.mjs'),
      rendererFile: join(__dirname, '../renderer/index.html'),
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      ensureDockApp: ensureDockIconVisible,
      openActivity: (activity) => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error('main_window_unavailable')
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('pet:openActivity', activity)
      },
    })
  setupAppCacheIPC({
    readCodexRuntimeDiagnostics: () => readAgentCodexRuntimeDiagnostics(),
  })
  setupNativeContextMenuIPC(() => mainWindow)
  setupSkillsIPC()

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

  let windowCaptureInFlight: Promise<ReadyWindowCaptureResult> | null = null
  ipcMain.handle('app:captureWindow', () => {
    if (windowCaptureInFlight) return windowCaptureInFlight

    const captureTask = captureReadyWindow({
      window: mainWindow,
      desktopPath: app.getPath('desktop'),
      now: () => new Date(),
      platform: process.platform,
      createPngFromBitmap: (bitmap, size) => nativeImage.createFromBitmap(bitmap, size).toPNG(),
      writeFile,
    })
    windowCaptureInFlight = captureTask
    void captureTask.finally(() => {
      if (windowCaptureInFlight === captureTask) windowCaptureInFlight = null
    })
    return captureTask
  })

  ipcMain.on('app:startNativeFileDrag', (event, paths: unknown) => {
    try {
      if (!READY_NATIVE_FILE_DRAG_ENABLED) {
        logNativeFileDragDiag('ignored disabled')
        return
      }
      if (!Array.isArray(paths)) {
        logNativeFileDragDiag(`ignored invalid-payload type=${typeof paths}`)
        return
      }
      const files = paths
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .filter((filePath) => {
          try {
            return isAbsolute(filePath) && existsSync(filePath) && statSync(filePath).isFile()
          } catch {
            return false
          }
        })
      if (files.length === 0) {
        logNativeFileDragDiag(`ignored no-valid-files requested=${paths.length}`)
        return
      }
      const icon = resolveNativeFileDragIcon()
      if (icon.isEmpty()) {
        logNativeFileDragDiag(`ignored icon-empty source=${nativeFileDragIconSource || 'none'} files=${files.length}`)
        return
      }
      logNativeFileDragDiag(`start files=${files.length} primary=${basename(files[0])} icon=${nativeFileDragIconSource || 'unknown'}`)
      event.sender.startDrag({
        file: files[0],
        files,
        icon,
      })
      logNativeFileDragDiag(`started files=${files.length} primary=${basename(files[0])}`)
    } catch (error) {
      logNativeFileDragDiag(`failed ${error instanceof Error ? error.message : String(error)}`)
      console.warn('[drag] start native file drag failed:', error instanceof Error ? error.message : String(error))
    }
  })

  // Theme sync — sets Electron's nativeTheme so BrowserView respects prefers-color-scheme,
  // then refreshes window material via the state machine and broadcasts the snapshot.
  ipcMain.handle('theme:set', (_event, theme: string) => {
    const nextTheme = theme === 'dark' || theme === 'light' || theme === 'system' ? theme : 'light'
    nativeTheme.themeSource = nextTheme
    try {
      getDatabase().settings.setSetting(THEME_SETTING_KEY, nextTheme)
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
      getDatabase().settings.setSetting(THEME_SKIN_SETTING_KEY, nextSkin)
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

// pre-ready 配置（协议注册、命令行开关、userAgent、userData）见 boot-entry.ts。
// 本模块在 splash 可见后才被动态加载，此处 whenReady 已 resolve，回调立即执行。
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.ready.app')
  applyAppIcon()
  setupApplicationMenu()
  // boot-entry 已建 splash；此 await 幂等，保底"splash 先于 boot 清理与数据库门"。
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
  // whenReady 主体的各大同步阶段之间让出主线程：呈现管线追帧靠这些间隙，
  // 否则 splash 动画在整个初始化期间冻结（见 startup-splash-window.ts 注释）。
  await yieldToPresentation()

  try {
    assertPrimaryDatabaseReady()
  } catch (error) {
    stopBootForDatabaseFailure(error)
    return
  }
  try {
    await initializeCredentialVault()
    try {
      await pruneUnreferencedCredentialsAtStartup()
    } catch (error) {
      console.warn('[credential-vault] orphan cleanup skipped:', error instanceof Error ? error.message : String(error))
    }
  } catch (error) {
    console.warn('[credential-vault] unavailable:', error instanceof Error ? error.message : String(error))
  }
  try {
    await reconcileStartupRunsOnStartup()
  } catch (error) {
    console.warn('[startup-run-reconciler] failed:', error instanceof Error ? error.message : String(error))
  }
  await yieldToPresentation()

  // nativeTheme.updated 可能在 OS 切换深浅模式时、或我们在 theme:set handler 里设置
  // themeSource 时触发。**必须显式做两件事**：刷新窗口材料 + 广播 renderer。
  // 不能简化成只 sync 不 broadcast —— 否则 system 模式下 OS 切换深浅时 renderer
  // 收不到 theme:changed 推送，useTheme 状态静默不同步。
  nativeTheme.on('updated', () => {
    windowMaterialController?.sync()
    broadcastThemeChanged()
  })

  console.log('[Main] App ready, registering protocol handler...')

  protocol.handle('local-file', (request) => createLocalFileResponse(request, { isPathAllowed }))

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await yieldToPresentation()
  // Register global IPC handlers once, before any window is created
  logBootStage('global-ipc:start')
  setupGlobalIPC()
  logBootStage('global-ipc:done')
  await yieldToPresentation()
  applyBundledAISettingsSeed()
  logBootStage('settings-seed:done')

  // Reminder bootstrap: replay any missed reminders inside the grace window,
  // then arm the live scheduler. Window creation is async, but the notifier
  // closes over a deferred `getMainWindow` accessor so it's safe to fire
  // here — IPC pushes will silently no-op until the window mounts, and
  // missed-reminder OS notifications still surface via the system tray.
  if (reminderScheduler && reminderNotifierFire) {
    const scheduler = reminderScheduler
    const fire = reminderNotifierFire
    void recoverMissedReminders({
      getDb: () => getDatabase().calendar,
      mentions: dateMentions,
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

  await yieldToPresentation()
  stopCalendarDesktop = startCalendarDesktop(async () => { await showMainWindow(); return mainWindow })
  void createWindow().then(() => {
    rssAutoRefreshScheduler?.start()
    return petWindowManager?.restoreIfEnabled()
  })

  app.on('activate', function () {
    // Pet windows are separate BrowserWindows; Dock activation should restore the main app window.
    void showMainWindow()
  })
})

// Quit when all windows are closed, except on macOS.
// A second launch on the same userData is denied the single-instance lock in
// boot-entry and exits; this focuses the already-running window instead of
// silently doing nothing. Guards the invariant that only one process ever runs
// the startup reconciler against a given SQLite (see boot-entry lock rationale).
app.on('second-instance', (_event, argv) => {
  for(const value of argv)captureCalendarOpen({kind:value.startsWith('ready-next:')?'url':'file',value})
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

async function cleanupBeforeAppQuit(startedAt: number): Promise<void> {
  stopCalendarDesktop?.(); stopCalendarDesktop=null
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
  stopRSSDigests()
  powerMonitor.removeListener('resume', handleRSSResume)
  powerMonitor.removeListener('resume', handleCalendarResume)
  const rssAutoRefreshStopped = Promise.all([stopRSSAutoRefresh(), stopRSSContentService(), stopRSSProcessing()])
  const remainingTimeoutMs = Math.max(0, 5_000 - (Date.now() - startedAt))
  await runBeforeQuitCleanup({
    cleanupAgentRuntime,
    cleanupAgentManager: () => agentManager.cleanup(),
    cleanupRsshubManager: async () => {
      await rssAutoRefreshStopped
      await rsshubManager.cleanup()
    },
    cleanupManagedBrowsers: async () => {
      await rssAutoRefreshStopped
      const result = await closeAllBrowsers()
      if (result.errors.length > 0) {
        console.warn('[before-quit] closeAllBrowsers errors', result.errors)
      }
    },
    cleanupDbWorker: () => shutdownWorkerDbBridge(),
    cleanupDocumentWorker: () => shutdownDocumentWorker(),
    cleanupDocumentDirectoryBroadcasts: () => shutdownDirectoryChangeBroadcasts(),
    cleanupFileWatchers: () => shutdownFileWatchers().then(() => undefined),
    cleanupLibrarySources: () => shutdownLibrarySources(),
    closeDatabase: () => getDatabase().close(),
  }, { timeoutMs: remainingTimeoutMs })
}

function showGracefulExitFailure(error: unknown, action: GracefulExitAction): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`[before-quit] state flush failed; ${action} cancelled`, error)
  const options = {
    type: 'error' as const,
    title: '仍有内容没有保存',
    message: action === 'quit_app'
      ? 'Ready 已取消退出，避免丢失未保存内容。'
      : 'Ready 已取消关窗，避免丢失未保存内容。',
    detail: `${detail}\n\n请返回文档重试保存后再关闭。`,
    buttons: ['返回并重试'],
    defaultId: 0,
    noLink: true,
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    void dialog.showMessageBox(mainWindow, options)
  } else {
    void dialog.showMessageBox(options)
  }
}

let gracefulWindowCloseCoordinator: GracefulWindowCloseCoordinator | null = null

function getGracefulWindowCloseCoordinator(): GracefulWindowCloseCoordinator {
  gracefulWindowCloseCoordinator ??= new GracefulWindowCloseCoordinator({
    flushRendererState: () => requestRendererStateFlush(mainWindow, 5_000),
    cleanupBeforeQuit: cleanupBeforeAppQuit,
    requestWindowClose: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    },
    requestAppQuit: () => app.quit(),
    onFailure: showGracefulExitFailure,
  })
  return gracefulWindowCloseCoordinator
}

app.on('will-quit', () => canvasRuntime?.stop())

app.on('before-quit', (event) => {
  getGracefulWindowCloseCoordinator().handleBeforeQuit(event)
})
