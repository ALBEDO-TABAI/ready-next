import { BrowserWindow, nativeTheme } from 'electron'
import {
  renderStartupSplashMarkup,
  STARTUP_SPLASH_FINISH,
  STARTUP_SPLASH_FINISH_EVENT,
  STARTUP_SPLASH_SIZE,
  type StartupSplashTheme,
} from '../shared/startup-splash-markup'

/**
 * 启动动画窗口的唯一状态源。
 * 该模块被 boot-entry（微入口，splash 先于重模块加载）与 index（重模块，
 * 主窗口 ready 后收口 splash）共享；两侧必须操作同一份窗口状态，
 * 因此创建、展示、收口逻辑全部收在这里，不允许在别处另建 splash 窗口。
 */

const STARTUP_SPLASH_MIN_VISIBLE_MS = 900
const STARTUP_SPLASH_CLOSE_FALLBACK_MS = 5000

/**
 * 启动期主线程让步：新窗口最初几秒的帧呈现（CATransaction 提交）依赖浏览器
 * 主线程有真实空闲；实心同步段之间必须让出 ≥ 两帧时长，splash 动画才会前进。
 * boot-entry 的重模块分片与 index 的 whenReady 大阶段之间统一用这一个节拍。
 */
export function yieldToPresentation(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 48))
}
// 退场节奏来自页面自己的时间表（startup-splash-markup.ts）：字标立住、点散尽，再停一拍，
// 由这里的窗口整体 setOpacity 渐隐退场。
const STARTUP_SPLASH_EXIT_FADE_DELAY_MS = STARTUP_SPLASH_FINISH.fadeDelayMs
const STARTUP_SPLASH_EXIT_FADE_MS = STARTUP_SPLASH_FINISH.fadeMs

let startupSplashWindow: BrowserWindow | null = null
let startupSplashFinishing = false
let startupSplashShownAtMs: number | null = null

export function getStartupSplashWindow(): BrowserWindow | null {
  return startupSplashWindow
}

function showStartupSplashWindow(splashWindow: BrowserWindow): void {
  if (splashWindow.isDestroyed()) return
  if (!splashWindow.isVisible()) {
    splashWindow.show()
  }
  startupSplashShownAtMs ??= Date.now()
}

export async function createStartupSplashWindow(): Promise<void> {
  // A hidden start (automation, verification scripts) shows nothing on the user's screen:
  // boot-entry already skips the splash, and the second call in index.ts must not create it.
  if (process.env.READY_START_HIDDEN === '1') return
  if (startupSplashWindow && !startupSplashWindow.isDestroyed()) return

  startupSplashFinishing = false
  startupSplashShownAtMs = null
  // 设置库此时还没打开，读不到应用自己的主题：字标的墨色跟随系统外观（玻璃本身无色）。
  const theme: StartupSplashTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const splashWindow = new BrowserWindow({
    width: STARTUP_SPLASH_SIZE.width,
    height: STARTUP_SPLASH_SIZE.height,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 透明窗口：玻璃板是无色的真透明（用户 2026-11-19 要求），页面只画玻璃板和它的阴影。
    // 已知代价（2026-07 逐帧截屏实证）：macOS 透明窗口的出帧耦合主进程主线程，启动期的实心
    // 同步块会让画面停住，停完按时间跳到当前帧。所以加载阶段只放随机闪烁（停顿看不出来），
    // 字标的构成留到就绪信号之后；首帧握手的保护（ready-to-show + 帧跑道回执）照旧。
    transparent: true,
    roundedCorners: false,
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
    await splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderStartupSplashMarkup(theme))}`)
    // 不在首帧就绪前强制 show：透明窗口在首帧 commit 前 show 出来是全透明的；
    // 若随后主线程立刻被重模块求值长时间阻塞（boot-entry 的动态 import），
    // 首帧握手会被永久卡死——真机复现过"窗口 isVisible 但屏幕全程无像素"。
    // 正常路径等 ready-to-show（创建时注册的 once 会执行 show），超时兜底强制 show。
    await new Promise<void>((resolve) => {
      if (splashWindow.isDestroyed() || splashWindow.isVisible()) {
        resolve()
        return
      }
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(fallbackTimer)
        resolve()
      }
      const fallbackTimer = setTimeout(() => {
        showStartupSplashWindow(splashWindow)
        settle()
      }, 1500)
      splashWindow.once('ready-to-show', settle)
      splashWindow.once('closed', settle)
    })
    // 帧跑道回执：透明窗口的呈现管线在首帧后的最初一小段时间内是脆弱的——
    // 此时若主线程被重模块求值实心阻塞，管线握手会被永久卡死（真机截屏序列
    // 复现过：首帧后 ~0.4s 起整段启动期动画逐字节冻结）。等连续 ~36 帧
    //（约 600ms @60fps）跑完代表管线已站稳，之后的主线程阻塞不再影响出帧。
    if (!splashWindow.isDestroyed()) {
      await Promise.race([
        splashWindow.webContents
          .executeJavaScript(
            'new Promise((resolve) => { let count = 0; const step = () => { count += 1; if (count >= 36) { resolve(true); return } requestAnimationFrame(step) }; requestAnimationFrame(step) })'
          )
          .catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ])
    }
  } catch (error) {
    console.warn('[startup-splash] renderer load failed:', error instanceof Error ? error.message : String(error))
    if (!splashWindow.isDestroyed()) splashWindow.close()
  }
}

/**
 * 收口启动动画：保证最短可见时长后向 splash 页面发 finish 信号，
 * 由页面播完退场动画自行 window.close()；超时兜底强制 close。
 * splash 真正关闭后才执行 showMainWindow，避免主窗口和动画叠帧。
 */
export function finishStartupSplashThen(showMainWindow: () => void): void {
  const splashWindow = startupSplashWindow
  if (!splashWindow || splashWindow.isDestroyed()) {
    showMainWindow()
    return
  }
  if (startupSplashFinishing) return

  startupSplashFinishing = true
  splashWindow.once('closed', () => {
    startupSplashWindow = null
    showMainWindow()
  })

  const shownAtMs = startupSplashShownAtMs ?? Date.now()
  const finishDelayMs = Math.max(0, STARTUP_SPLASH_MIN_VISIBLE_MS - (Date.now() - shownAtMs))

  setTimeout(() => {
    if (splashWindow.isDestroyed()) return
    void splashWindow.webContents.executeJavaScript(`window.dispatchEvent(new Event('${STARTUP_SPLASH_FINISH_EVENT}'))`).catch((error) => {
      console.warn('[startup-splash] finish signal failed:', error instanceof Error ? error.message : String(error))
      if (!splashWindow.isDestroyed()) splashWindow.close()
    })
  }, finishDelayMs)

  // 视觉退场：字标立住 + 停顿结束后整窗渐隐再关闭。
  // 页面内的自关闭与这里的 close 竞态无妨，先到先赢。
  setTimeout(() => {
    if (splashWindow.isDestroyed()) return
    const fadeStartedAt = Date.now()
    const fadeTimer = setInterval(() => {
      if (splashWindow.isDestroyed()) {
        clearInterval(fadeTimer)
        return
      }
      const progress = (Date.now() - fadeStartedAt) / STARTUP_SPLASH_EXIT_FADE_MS
      if (progress >= 1) {
        clearInterval(fadeTimer)
        splashWindow.close()
        return
      }
      splashWindow.setOpacity(1 - progress)
    }, 16)
  }, finishDelayMs + STARTUP_SPLASH_EXIT_FADE_DELAY_MS)

  setTimeout(() => {
    if (!splashWindow.isDestroyed()) splashWindow.close()
  }, finishDelayMs + STARTUP_SPLASH_CLOSE_FALLBACK_MS)
}
