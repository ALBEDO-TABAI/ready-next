import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env from project root (before anything else)
config({ path: resolve(__dirname, '../../.env') })

import { app, shell, BrowserWindow, ipcMain, protocol, nativeImage, nativeTheme, Menu, type MenuItemConstructorOptions } from 'electron'
import { join, extname, normalize } from 'path'
import { createReadStream, statSync, existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Import modules
import { setupAgentIPC, cleanupAgentRuntime } from './modules/claude-bridge/ipc-handler'
import { AgentManager } from './modules/claude-bridge/agent-manager'
import { setupBrowserIPC, type BrowserController } from './modules/browser-engine/ipc-handler'
import { setupDocumentIPC } from './modules/document-engine/ipc-handler'
import { setupSearchIPC } from './modules/search-engine/ipc-handler'
import { setupRSSIPC, setRSSBrowserController } from './modules/rss-engine/ipc-handler'
import { setupCalendarIPC } from './modules/calendar-engine/ipc-handler'
import { setupSettingsIPC } from './modules/settings-engine/ipc-handler'
import { applyBundledAISettingsSeed } from './modules/settings-engine/seed-loader'
import { setupSkillsIPC } from './modules/skills-runtime/ipc-handler'
import { setupMemoryManagementIPC } from './modules/memory-management/ipc-handler'
import { rsshubManager } from './modules/rss-engine/rsshub-process'
import { reapOrphans } from './modules/process-cleanup/boot-reaper'
import { runBeforeQuitCleanup } from './modules/process-cleanup/before-quit'
import { closeAllBrowsers } from './modules/browser-engine/browser-cleanup'
import { getDatabase } from './modules/database'
import { shutdownWorkerDbBridge } from './modules/database/worker-bridge'
import { toOAuthCompatibleUserAgent } from './modules/browser-engine/popup-policy'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

// Environment configuration
// Document operations (local fs) are always real — no external dependencies.
// All environments: opt-in only via ENABLE_MOCK_SERVICES=true
const ENABLE_MOCK_SERVICES = process.env.ENABLE_MOCK_SERVICES === 'true'

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
// Guard to prevent re-registering window-dependent IPC handlers on macOS dock re-open
let windowIPCRegistered = false
const THEME_SETTING_KEY = 'ui_theme_option'

function resolveStoredThemeSource(): 'light' | 'dark' | 'system' {
  try {
    const raw = String(getDatabase().getSetting(THEME_SETTING_KEY) || '').trim().toLowerCase()
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // ignore persisted theme read failures
  }
  return 'light'
}

function resolveAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.icns')
    : resolve(__dirname, '../../build/icon.png')
}

function applyAppIcon(): void {
  const icon = nativeImage.createFromPath(resolveAppIconPath())
  if (icon.isEmpty()) return

  if (process.platform === 'darwin') {
    app.dock.setIcon(icon)
  }
}

function applyNativeWindowMaterial(window: BrowserWindow): void {
  if (process.platform === 'darwin') {
    window.setVibrancy('under-window')
    window.setWindowButtonPosition({ x: 14, y: 14 })
    return
  }

  if (process.platform === 'win32' && 'setBackgroundMaterial' in window) {
    try {
      window.setBackgroundMaterial('mica')
    } catch {
      /* ignore unsupported Windows builds */
    }
  }
}

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

async function createWindow(): Promise<void> {
  nativeTheme.themeSource = resolveStoredThemeSource()
  // Pick a first-frame background that matches the resolved theme so non-macOS platforms don't flash white.
  const nonMacFirstFrameBg = nativeTheme.shouldUseDarkColors ? '#1A1B1E' : '#F7F9FC'
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    icon: resolveAppIconPath(),
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : nonMacFirstFrameBg,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  applyNativeWindowMaterial(mainWindow)
  const closedWindow = mainWindow
  mainWindow.on('closed', () => {
    if (mainWindow === closedWindow) {
      mainWindow = null
    }
  })

  // Keep renderer UI at 100% scale so panel sizing remains pixel-consistent with design specs.
  mainWindow.webContents.setZoomFactor(1)
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
    mainWindow?.webContents.setZoomFactor(1)
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Setup window-dependent IPC only once (agent/browser handlers register ipcMain.handle
  // which cannot be registered twice without error)
  if (!windowIPCRegistered) {
    browserController = setupBrowserIPC(mainWindow, ENABLE_MOCK_SERVICES)
    setRSSBrowserController(browserController)
    setupAgentIPC(agentManager, mainWindow, browserController)
    windowIPCRegistered = true
  } else {
    browserController?.attachWindow(mainWindow)
  }
  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Auto-updater — only in production builds
  if (app.isPackaged) {
    setupAutoUpdater(mainWindow)
  }
}

// --- Register all ipcMain.handle() handlers once (not per-window) ---

function setupGlobalIPC(): void {
  // Module IPC handlers (no window dependency)
  setupDocumentIPC(DOCUMENT_USE_MOCK)  // Always real fs
  setupSearchIPC()
  setupRSSIPC(RSS_USE_MOCK)
  setupCalendarIPC(CALENDAR_USE_MOCK)
  setupSettingsIPC()
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

  // Theme sync — sets Electron's nativeTheme so BrowserView respects prefers-color-scheme
  ipcMain.handle('theme:set', (_event, theme: string) => {
    const nextTheme = theme === 'dark' || theme === 'light' || theme === 'system' ? theme : 'light'
    nativeTheme.themeSource = nextTheme
    try {
      getDatabase().setSetting(THEME_SETTING_KEY, nextTheme)
    } catch {
      // ignore persistence failures
    }
  })
  ipcMain.handle('theme:get', () => {
    try {
      const option = resolveStoredThemeSource()
      return {
        success: true,
        data: {
          option,
          resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        },
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

function setupAutoUpdater(mainWindow: BrowserWindow): void {
  const sendStatus = (status: string, data?: Record<string, unknown>): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { status, ...data })
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

  // Check for updates after a short delay to avoid slowing down startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silently ignore — user can manually check via app:check-update
    })
  }, 5_000)
}

// Register local-file as a privileged scheme BEFORE app.whenReady()
// This is required for video streaming (range requests), fetch API support, etc.
// Keep auth popups (OAuth / SSO) available inside BrowserView-based tabs.
app.commandLine.appendSwitch('disable-popup-blocking')
// FedCM can become a no-op inside BrowserView on some Electron builds.
// Force legacy OAuth popup flow for stable third-party login behavior.
app.commandLine.appendSwitch('disable-features', 'FedCm')
app.userAgentFallback = toOAuthCompatibleUserAgent(app.userAgentFallback)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    }
  }
])

// --- local-file:// path validation ---

function isPathAllowed(filePath: string): boolean {
  // Canonicalize the path to resolve any .. or symlink tricks
  const resolved = resolve(filePath)
  const normalized = normalize(resolved)

  // Block path traversal
  if (normalized.includes('..')) {
    return false
  }

  // Blacklist: sensitive patterns (case-insensitive on macOS/Windows)
  const sensitivePatterns = [
    /[/\\]\.ssh[/\\]/,
    /[/\\]\.aws[/\\]/,
    /[/\\]\.gnupg[/\\]/,
    /[/\\]\.env$/,
    /[/\\]credentials$/,
    /[/\\]credentials\.json$/,
    /[/\\]\.npmrc$/,
    /[/\\]\.pypirc$/,
    /[/\\]\.gitconfig$/,
    /[/\\]id_rsa/,
    /[/\\]id_ed25519/,
  ]

  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
  const pathToCheck = caseInsensitive ? normalized.toLowerCase() : normalized

  for (const pattern of sensitivePatterns) {
    if (pattern.test(pathToCheck)) {
      return false
    }
  }

  return true
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.ready.app')
  applyAppIcon()
  setupApplicationMenu()

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

  console.log('[Main] App ready, registering protocol handler...')

  // Register local-file:// protocol handler for serving local files to the renderer
  // Uses fs directly to properly support Range requests for video seeking.
  protocol.handle('local-file', (request) => {
    console.log('[Protocol] ===== Handling request =====')
    console.log('[Protocol] URL:', request.url)
    console.log('[Protocol] Method:', request.method)
    console.log('[Protocol] Headers:', request.headers)

    // Because local-file is registered as a "standard" scheme, Chromium parses
    // local-file:///Users/user/file.png as:
    //   host = "users" (lowercased!), pathname = "/user/file.png"
    // We must reconstruct the original absolute path from host + pathname.
    const parsed = new URL(request.url)
    const decodedPathname = decodeURIComponent(parsed.pathname)
    let filePath = parsed.host
      ? `/${parsed.host}${decodedPathname}`
      : decodedPathname

    console.log('[Protocol] Parsed path:', { host: parsed.host, pathname: parsed.pathname, filePath })

    // Windows: remove leading slash and fix drive letter case
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1)
      // Fix lowercase drive letter: c:/path -> C:/path
      if (filePath.length >= 2 && filePath[1] === ':') {
        filePath = filePath[0].toUpperCase() + filePath.slice(1)
      }
    }

    console.log('[Protocol] Final path:', filePath)

    // Security: validate the path before serving
    if (!isPathAllowed(filePath)) {
      console.log('[Protocol] Path not allowed:', filePath)
      return new Response('Forbidden', { status: 403 })
    }

    if (!existsSync(filePath)) {
      console.log('[Protocol] File not found:', filePath)
      return new Response('Not Found', { status: 404 })
    }

    console.log('[Protocol] File exists, serving:', filePath)

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
      '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    }
    const ext = extname(filePath).toLowerCase()
    const contentType = mimeMap[ext] || 'application/octet-stream'
    const fileSize = statSync(filePath).size

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
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      },
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

  void createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
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
    cleanupDbWorker: () => shutdownWorkerDbBridge(),
    closeDatabase: () => getDatabase().close(),
  }).catch((err) => {
    console.error('[before-quit] cleanup error', err)
  }).finally(() => {
    app.quit()
  })
})
