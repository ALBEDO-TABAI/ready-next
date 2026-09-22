---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# 主题启动白屏与昼夜切换过渡偏色 — 根因与连带缺口审计

> 更新时间：2026-04-19
> 范围：Renderer 主题引导 + Ritual Overlay + Electron BrowserWindow 透明度
> 复现现象：
> - Bug 1（偶发）：启动后 UI 没有预期的透明 / 液态玻璃效果，整体偏"平白、调试态"。
> - Bug 2（每次）：日夜切换演出中途背景色既不是亮色也不是暗色，而是"更白/更蓝"。

---

## 0. 结论一览

| # | 现象 | 首要根因 | 置信度 |
|---|------|---------|--------|
| 1 | 启动偏白、无玻璃质感 | `data-skin` 没在 HTML 首帧设置；`main.tsx` 只在异步 IPC 完成后写 `data-theme`，`data-skin` 依赖后续动态 `import('./App')` 才写入。期间 CSS 走的是 `:root` 纯白 + 无 liquid-glass token 的最朴素样式 | 高 |
| 2 | 过渡中出现的白/蓝色 | Ritual overlay 用 `background: var(--bg-primary)`；在 liquid-glass 皮肤下，light 模式的 `--bg-primary = #F7F9FC`（冷白/微蓝），而用户日常感知的"浅色底"其实是 `--workbench-mode-bg = #F6F1E7`（暖米）。overlay 用了错误的 token，导致过渡中闪现冷白 | 高 |
| 3 | Windows 启动更容易白一闪 | `BrowserWindow.backgroundColor` 只在 `darwin` 设为透明，其他平台为 `undefined`，Electron 会回退到白底 | 中 |

---

## 1. 启动链路梳理

### 1.1 相关文件与顺序

1. `src/renderer/index.html`
   - `<head>` 内无任何主题先置脚本；也无 `<meta name="theme-color">`
   - 加载时 HTML 立即绘制 `<body>` 与 `<div id="root">`，此时 `<html>` 上既没有 `data-theme`，也没有 `data-skin`
2. `src/renderer/styles/index.css:7-9`
   ```css
   :root {
     --bg-primary: #FFFFFF;
     --bg-panel: #F6F5F1;
     ...
   }
   ```
   - `:root` 为亮色默认，但**没有任何液态玻璃 token**（`--lg-material-*`、`--surface-blur`、`--surface-saturate`、`--glass-highlight`、`--lg-specular-*` 等全部缺失）
   - liquid-glass token 集中在 `html[data-skin='liquid-glass']`（行 250–320）和 `html[data-theme='dark'][data-skin='liquid-glass']`（行 322+）
3. `src/renderer/main.tsx:15-22`
   ```ts
   async function hydrateStartupTheme() {
     if (!window.electronAPI) return
     const themeResult = await window.electronAPI?.theme.get()  // 等待 IPC
     if (!themeResult?.success || !themeResult.data) return
     writeStorage('ready-theme', themeResult.data.option)
     document.documentElement.setAttribute('data-theme', themeResult.data.resolved)  // 只写 data-theme
   }
   ```
   - 只设置 `data-theme`，**没有写 `data-skin`**
   - IPC `theme.get()` 后端走 `src/main/index.ts:50` 读 SQLite `ui_theme_option`，是跨进程异步调用
4. `src/renderer/stores/useTheme.ts:84-90`
   ```ts
   export const useTheme = create<ThemeState>((set, get) => {
       const initial = getStoredTheme()          // localStorage 同步读
       const initialSkin = getStoredSkin()
       const resolved = resolveTheme(initial)
       applyColorTheme(resolved, initial, resolved, { animate: false })
       applySkin(initialSkin)                    // 这里才写 data-skin
       ...
   })
   ```
   - 真正写 `data-skin='liquid-glass'` 的代码在 `useTheme` 模块初始化
   - `useTheme` 是被 `App.tsx` 引用的 → `main.tsx:33` 的 `await import('./App')` 完成后才执行

### 1.2 时间线（最慢路径）

```
t0  HTML 解析完成，<html> 无任何 data-* 属性
t1  CSS 解析；:root 生效 → --bg-primary=#FFFFFF，无 liquid-glass tokens
t2  main.tsx 执行 → await hydrateStartupTheme (IPC 往返)
t3  IPC 返回 → 写入 data-theme（仍无 data-skin）
t4  await import('./App') 解析完 → useTheme 模块初始化 → 写入 data-skin
t5  React 开始渲染
```

在 `ready-to-show`（`src/main/index.ts:201`）事件驱动下窗口显示的那一刻，只要主窗口先于 `t4` 被显示，用户就会看到：
- 纯 `#FFFFFF` 背景（`:root` 亮色默认）
- 无 backdrop-filter，无 blur、无镜面高光、无半透明 surface
- → 视觉上即"调试态的平白 UI"

"偶发"的原因：
- IPC 响应时间抖动（主进程繁忙、SQLite IO）
- `ready-to-show` 与 `await import('./App')` 完成顺序竞争
- React StrictMode 下双重渲染偶尔放大一帧窗口

---

## 2. 昼夜切换中途偏色根因

### 2.1 相关文件

- `src/renderer/styles/ritual-overlay.css:17-19`
  ```css
  [data-ritual-overlay][data-stage='theme-transition'] {
    background: var(--bg-primary, #ffffff);
  }
  ```
- `src/renderer/stores/useTheme.ts:57-78`（`applyColorTheme` + `withRitual` 演出）
- `src/renderer/modules/overlay/useRitualOverlay.ts:208-249`（entering → holding → leaving 时序）
- `src/renderer/styles/index.css:9 / 146 / 251 / 323`（四套 `--bg-primary`）

### 2.2 tokens 对齐核对

| 皮肤 / 主题 | `--bg-primary` | `--workbench-mode-bg` | `--bg-panel` |
|------------|----------------|------------------------|---------------|
| 基准 light（无 skin） | `#FFFFFF` | `#FAF8F2` | `#F6F5F1` |
| 基准 dark（无 skin） | `#1A1B1E` | `#23262B` | `#202124` |
| liquid-glass light | **`#F7F9FC`**（冷白/微蓝） | **`#F6F1E7`**（暖米） | `#EFF3F9` |
| liquid-glass dark | `#171D29` | `#192131` | `#1B2230` |

用户日常感知的"浅色底"=`--workbench-mode-bg`（`#F6F1E7` 暖米色画布）。但 overlay 用的是 `--bg-primary`，在 liquid-glass + light 下是 `#F7F9FC`（**冷白偏蓝**）。这两种白色视觉上分属不同色温，用户眼里的"更白/更蓝"其实就是这个 `#F7F9FC`。

### 2.3 演出时序下的色跳

`withRitual('theme-transition', ...)` 的时序（`useRitualOverlay.ts`）：
- `entering` 阶段：overlay 透明度 0→1（160ms）；**此时 `applyThemeImmediate` 还没执行**，`data-theme` 仍是旧值，`var(--bg-primary)` 仍是旧主题的冷白/深蓝
- `holding` 阶段开始时才执行 `applyThemeImmediate`（行 215 后 workFn 被触发）；`data-theme` 在此切换 → `var(--bg-primary)` 瞬变为新值；overlay 此时 opacity=1，用户看到的是**硬切**而非渐变
- `leaving` 阶段：overlay 透明度 1→0（200ms），新主题色透出

因此用户在 light→dark 切换里看到的序列是：

```
[原浅色 UI] → 淡入冷白(#F7F9FC)  (160ms)
冷白 → 深蓝黑(#171D29) 硬切     (0ms)
深蓝黑 → 透出新暗色 UI         (200ms)
```

那个"更白更蓝"的色就是 liquid-glass 的 `--bg-primary: #F7F9FC`。它本身并没有"错"，但它跟用户日常看到的 workbench 画布（暖米 `#F6F1E7`）、暗色画布（`#192131`）都不对齐，所以观感上"既不是亮模式的底色也不是暗模式的底色"。

### 2.4 多余但无害的 fallback

`background: var(--bg-primary, #ffffff)` 里的 `#ffffff` fallback 实际不会触发——`:root` 永远定义了 `--bg-primary`，CSS 变量不会降级。不过它误导性强，应换成语义正确的 fallback 或用新 token。

---

## 3. 连带发现的 UI / 交互缺口

### 3.1 主题写入路径缺一致性

- `main.tsx:hydrateStartupTheme` 只写 `data-theme`，不写 `data-skin`
- `useTheme` 模块初始化写两者
- `App.tsx`（effect）再写一次
- 三处重复、时序错位；还在 StrictMode 下会双跑一次 effect
- **建议**：启动阶段统一由 `<head>` 内 inline script 同步写入 `data-theme` + `data-skin`，从 `localStorage` 取值；再把异步 IPC 结果当作"校正"（和 SQLite 对齐）

### 3.2 跨进程主题源不一致

- Main 进程把主题存 `ui_theme_option` 到 SQLite
- Renderer 用 localStorage `ready-theme` / `ready-theme-skin`
- `useTheme.setTheme()` 向 main 触发 `theme.set`（`useTheme.ts:44-47`），但 `main.tsx:hydrateStartupTheme` 又反向覆盖 localStorage
- 用户通过菜单 / 系统级主题切换时，两边有可能短暂不一致
- 建议把"权威源"收口为 main 进程，preload 同步暴露（见 §4.2）

### 3.3 BrowserWindow 启动背景色分叉

- `src/main/index.ts:166`
  ```ts
  backgroundColor: process.platform === 'darwin' ? '#00000000' : undefined,
  ```
- macOS：完全透明 + `vibrancy: 'under-window'`，可透出桌面
- Windows：`undefined` → Electron 默认白，mica 只能在 `setBackgroundMaterial('mica')` 成功后生效（且 mica 需窗口已显示时调用）
- Linux / 其他：同 Windows，且无 mica 兜底
- 在 Windows 上这进一步放大了 Bug 1：启动白一闪不需要等 renderer，窗口本身就白

### 3.4 macOS vibrancy 放大 Bug 2

- `window.setVibrancy('under-window')` 让窗口底层走 macOS 原生毛玻璃
- 任何 DOM 元素 alpha<1 的瞬间（即 overlay 淡入 / 淡出阶段），用户都能看到 macOS vibrancy 采样桌面背后颜色与 overlay 混合
- 桌面壁纸偏冷 / 蓝时，会让 liquid-glass light 的 `#F7F9FC` 显得"更蓝"

### 3.5 `ritual-overlay.css` 的 fallback 与 keyframe 不同步

- `ritual-overlay.css:38-40` 的 `ritual-reduce-flash` keyframe 也只用 `--bg-primary` / `--bg-panel`
- reduce-motion 用户得到的"减配闪烁"同样会命中冷白 `#F7F9FC` 问题
- 建议在 keyframe 里一并替换

### 3.6 Fatal bootstrap error 永远亮色

- `main.tsx:47-60` 把错误态 UI 的样式硬编码为 `background:#f6f6f6;color:#333`
- 如果用户运行在暗模式下遇到 bootstrap 失败，错误提示会是刺眼白块，与"应用风格一致的降级体验"原则相悖
- 建议用 CSS 变量或 `matchMedia('(prefers-color-scheme: dark)')` 分支

### 3.7 `setSkin` / `toggleSkin` 实际是 no-op

- `useTheme.ts:126-135`：两者不管传什么参数都强制写 `liquid-glass`
- 当前产品策略只保留一种皮肤，但 API 形态仍保留"可切换"入参，对后续扩展形成欺骗性接口
- 若长期只保留单皮肤，建议移除 Setter 或把 `skin` 内聚成常量；否则需要真正支持二值

### 3.8 `data-theme-transitioning` 属性入口被清但未被使用

- `useTheme.ts:9` 定义 `THEME_TRANSITION_ATTRIBUTE = 'data-theme-transitioning'`
- `applyThemeImmediate` 在行 52 只做 `removeAttribute`
- 没有任何地方 `setAttribute`，也没有任何 CSS 选择器匹配这个属性
- 死代码，容易让后续维护者误以为存在一个"主题过渡态样式钩子"。建议清理或真正接入

### 3.9 `prefers-color-scheme` 系统切换不走演出

- `useTheme.ts:94-101` 的 `handleSystemChange` 调用 `applyColorTheme(..., { animate: false })`
- 用户在 `system` 模式下由 macOS "黄昏自动切换" 触发时，是**硬切**，没有 ritual 动画
- 预期一致性差：手动点和系统触发表现不同
- 建议打开 `animate: true`（与 `setTheme` 路径一致），或至少做一次 reduce-flash

### 3.10 `panelResizing` 守卫会完全跳过演出

- `useRitualOverlay.ts:127-135`：`panelResizingActive` 为真时直接执行 `workFn` 不走 overlay
- 极端场景下用户在拖动面板时触发主题切换（快捷键 / 远程），就会直接硬切 + 无视觉过渡
- 非高优先级，但建议加埋点或降级成 reduce-flash

### 3.11 BrowserView 在演出期间的遮罩靠 `beginBrowserMask` 手动 hook

- `RitualOverlay.tsx:22-31` 依赖 `beginBrowserMask / endBrowserMask` 来临时隐藏原生 BrowserView
- 如果 overlay 被异常中断（`AbortError` 分支），mask 的 end 会依赖 `session` 被置为 null 的 effect
- `useRitualOverlay.ts:232-240` 在 workPromise 报错时 phase 会走到 leaving + cleanup；但如果 workFn 抛错前 overlay 已进入 holding，BrowserView 可能被遮挡时间过长
- 建议在 `cleanup()` 里显式地广播一次 "mask should end"，而不是依赖 session 清空 → effect 退回链

### 3.12 `<html>` 在 HTML 解析阶段无 `color-scheme` 提示

- 没有 `<meta name="color-scheme" content="light dark">` 或 CSS `color-scheme: light dark;`
- 这会导致原生滚动条、表单控件在 dark 模式下仍按 light 渲染，首帧尤为刺眼
- 建议 `:root { color-scheme: light dark }` 并在 `html[data-theme='dark']` 覆盖为 `dark`

### 3.13 `index.html` 无 `<meta name="theme-color">`

- 在窗口打开 / 原生控件处容易看到白条
- macOS titleBarStyle 为 `hiddenInset`，影响较小；但对 Windows mica 窗口装饰仍有价值

---

## 4. 修复方向（尚未实施）

### 4.1 Bug 1 最小修复：HTML 内联主题先置

在 `index.html` 的 `<head>` 尾部加入内联脚本，先于 CSS 读取 localStorage 并写入 `data-theme` + `data-skin`：

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem('ready-theme') || 'light';
      var resolved = t === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : t;
      document.documentElement.setAttribute('data-theme', resolved);
      document.documentElement.setAttribute('data-skin', localStorage.getItem('ready-theme-skin') || 'liquid-glass');
    } catch (_) {}
  })();
</script>
```

辅以：
- 给 `:root` 加 `color-scheme: light dark;` 并在 `html[data-theme='dark']` 覆盖为 `dark`
- `main.tsx:hydrateStartupTheme` 降级为**校正**而不是唯一写入路径
- Windows 下为 `BrowserWindow` 补 `backgroundColor`（dark 时给 `#1A1B1E`，light 时给 `#F7F9FC`），或改为延迟 `show()` 到 React 首帧挂载后（`webContents.on('did-finish-load')`）

### 4.2 Bug 2 最小修复：换用对齐的 token

方案 A（推荐）：引入 `--ritual-overlay-bg` 专属变量，分别在 light / dark / liquid-glass 下指定为视觉上"干净画布"色（light 用 `--workbench-mode-bg` = `#F6F1E7`；dark 用 `#171D29` / `#1A1B1E`），避免与 `--bg-primary` 语义冲突。

方案 B：overlay 改用 `var(--workbench-mode-bg)`，与用户实际感知的画布色一致。

并在 `applyThemeImmediate` 执行前，对 overlay 元素 inline 写 `style.backgroundColor`，使 `entering` 阶段已经是目标主题色——彻底避免"用旧主题色淡入，再瞬切到新主题色"。

### 4.3 代码面收口

- 合并 `useTheme` 初始化 / `App.tsx` effect / `main.tsx:hydrateStartupTheme` 三处主题写入
- 让 `system` 模式的 `matchMedia` 回调也走 ritual 动画（至少 reduce-flash）
- 清理 `THEME_TRANSITION_ATTRIBUTE` 死代码或真正接入
- `setSkin` / `toggleSkin` 要么承载真实状态要么移除

---

## 5. 复现与验证建议

1. Bug 1 复现
   - 启动前断开数据库 / 提高 IPC 延迟（可以在 `theme.get` handler 前加 `await sleep(500)`）
   - 观察首帧是否为纯白、无玻璃质感
   - 验证：应用 §4.1 内联脚本后首帧应已带 `data-theme` + `data-skin`
2. Bug 2 复现
   - 保持 liquid-glass skin
   - 用 TopBar 昼夜开关做 light ↔ dark
   - 录屏慢放，抓 `entering` 结束瞬间的帧
   - 当前会看到 `#F7F9FC` 冷白一闪
   - 验证：应用 §4.2 后，过渡中途色应匹配新主题画布色

## 6. 影响面声明

以上修复触及：
1. Main：`src/main/index.ts`（BrowserWindow backgroundColor）
2. Preload：如需同步暴露主题值
3. Renderer：`index.html`、`main.tsx`、`stores/useTheme.ts`、`styles/index.css`、`styles/ritual-overlay.css`、`components/overlay/RitualOverlay.tsx`
4. 文档：`CHANGELOG.md`、`LESSONS_LEARNED.md`、`PROGRESS.md`

按 `CLAUDE.md §7` 新功能最小闭环对齐。

---

## 附录：参考文件与行号速查

- `src/renderer/main.tsx:15-22`（启动主题 IPC 写入）
- `src/renderer/index.html:1-16`（首帧无主题先置）
- `src/renderer/styles/index.css:7-9 / 146 / 251 / 323`（四套主题 token）
- `src/renderer/styles/ritual-overlay.css:17-19 / 37-41`（overlay 背景 + reduce-flash）
- `src/renderer/stores/useTheme.ts:9 / 49-78 / 84-102 / 126-135`（主题应用、skin 单值、系统切换）
- `src/renderer/modules/overlay/useRitualOverlay.ts:47-57 / 116-255`（演出时序）
- `src/renderer/components/overlay/RitualOverlay.tsx`（DOM 结构 + BrowserView mask）
- `src/main/index.ts:50-58 / 75-89 / 156-204`（theme 读取、vibrancy、window 启动）
