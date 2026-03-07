import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env from project root (before anything else)
config({ path: resolve(__dirname, '../../.env') })

import { app, shell, BrowserWindow, ipcMain, protocol, net, nativeTheme, Menu, type MenuItemConstructorOptions } from 'electron'
import { join, extname, normalize } from 'path'
import { homedir } from 'os'
import { createReadStream, statSync, existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Import modules
import { setupAgentIPC, cleanupAgentRuntime } from './modules/claude-bridge/ipc-handler'
import { AgentManager } from './modules/claude-bridge/agent-manager'
import { setupBrowserIPC, type BrowserController } from './modules/browser-engine/ipc-handler'
import { setupDocumentIPC } from './modules/document-engine/ipc-handler'
import { setupRSSIPC } from './modules/rss-engine/ipc-handler'
import { setupCalendarIPC } from './modules/calendar-engine/ipc-handler'
import { setupVideoIPC } from './modules/video-engine/ipc-handler'
import { setupSettingsIPC } from './modules/settings-engine/ipc-handler'
import { setupDesignIPC } from './modules/design-engine/ipc-handler'
import { setupSkillsIPC } from './modules/skills-runtime/ipc-handler'
import { rsshubManager } from './modules/rss-engine/rsshub-process'
import { getDatabase } from './modules/database'
import { toOAuthCompatibleUserAgent } from './modules/browser-engine/popup-policy'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

// Environment configuration
// Document operations (local fs) are always real — no external dependencies.
// External services (RSS, Calendar, Agent) default to mock in production
// since their backends are not fully ready yet.
const ENABLE_MOCK_SERVICES = is.dev
  ? process.env.ENABLE_MOCK_SERVICES === 'true'
  : process.env.ENABLE_MOCK_SERVICES !== 'false' // default true in production

// Document engine always uses real fs, regardless of mock setting
const DOCUMENT_USE_MOCK = false

// Initialize agent manager
const agentManager = new AgentManager(ENABLE_MOCK_SERVICES)

// Track the current main window for window-state IPC handlers
let mainWindow: BrowserWindow | null = null
let browserController: BrowserController | null = null
// Guard to prevent re-registering window-dependent IPC handlers on macOS dock re-open
let windowIPCRegistered = false

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

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
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

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Setup window-dependent IPC only once (agent/browser handlers register ipcMain.handle
  // which cannot be registered twice without error)
  if (!windowIPCRegistered) {
    browserController = setupBrowserIPC(mainWindow, ENABLE_MOCK_SERVICES)
    setupAgentIPC(agentManager, mainWindow, browserController)
    windowIPCRegistered = true
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
  setupRSSIPC(ENABLE_MOCK_SERVICES)
  setupCalendarIPC(ENABLE_MOCK_SERVICES)
  setupVideoIPC()
  setupSettingsIPC()
  setupDesignIPC()
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

  // Theme sync — sets Electron's nativeTheme so BrowserView respects prefers-color-scheme
  ipcMain.handle('theme:set', (_event, theme: string) => {
    nativeTheme.themeSource = theme as 'light' | 'dark' | 'system'
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

/** Sensitive directories that should never be served via local-file:// */
const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.gnome-keyring', '.pki']
const SENSITIVE_FILES = ['.env', '.npmrc', '.pypirc', 'credentials.json']

function isPathAllowed(filePath: string): boolean {
  // Canonicalize the path to resolve any .. or symlink tricks
  const resolved = resolve(filePath)
  const normalized = normalize(resolved)

  // Must be within user's home directory
  // macOS/Windows filesystems are case-insensitive, so compare accordingly.
  // (Chromium lowercases the host component of standard scheme URLs,
  //  e.g. local-file:///Users/... → host="users", breaking case-sensitive checks)
  const home = homedir()
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
  const normalizedCmp = caseInsensitive ? normalized.toLowerCase() : normalized
  const homeCmp = caseInsensitive ? home.toLowerCase() : home

  if (!normalizedCmp.startsWith(homeCmp)) {
    return false
  }

  // Block path traversal
  const relativePart = normalized.slice(home.length)
  if (relativePart.includes('..')) {
    return false
  }

  // Block sensitive directories
  const pathSegments = relativePart.split('/').filter(Boolean)
  for (const segment of pathSegments) {
    if (SENSITIVE_DIRS.includes(segment.toLowerCase())) {
      return false
    }
  }

  // Block sensitive files (check the basename)
  const fileName = pathSegments[pathSegments.length - 1]
  if (fileName && SENSITIVE_FILES.includes(fileName.toLowerCase())) {
    return false
  }

  return true
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.ready.app')
  setupApplicationMenu()

  // Register local-file:// protocol handler for serving local files to the renderer
  // Uses fs directly to properly support Range requests for video seeking.
  protocol.handle('local-file', (request) => {
    // Because local-file is registered as a "standard" scheme, Chromium parses
    // local-file:///Users/user/file.png as:
    //   host = "users" (lowercased!), pathname = "/user/file.png"
    // We must reconstruct the original absolute path from host + pathname.
    const parsed = new URL(request.url)
    const decodedPathname = decodeURIComponent(parsed.pathname)
    let filePath = parsed.host
      ? `/${parsed.host}${decodedPathname}`
      : decodedPathname

    // On Windows, remove leading slash from /C:/path
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1)
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
      },
    })
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Start embedded RSSHub instance (non-blocking)
  rsshubManager.start().catch((err) => {
    console.error('[rsshub] Failed to start embedded RSSHub:', err)
  })

  // Register global IPC handlers once, before any window is created
  setupGlobalIPC()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Clean up before quit
app.on('before-quit', () => {
  void cleanupAgentRuntime()
  getDatabase().close()
  agentManager.cleanup()
  rsshubManager.cleanup()
})
