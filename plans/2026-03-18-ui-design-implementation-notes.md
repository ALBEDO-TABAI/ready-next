# 2026-03-18 UI 设计改动与实现路径说明

## 1. 文档目的

本文档用于沉淀当前这一轮 UI 设计调整的：

- 视觉方向
- 关键设计数值
- 组件与模式层的实现特点
- 具体实现路径（文件落点）
- 当前已知问题与后续收口方向

适用范围：

- `Settings` 设置页
- `Workbench` 四个主模式：`browser` / `document` / `rss` / `calendar`
- 原生浏览器宿主视图（`BrowserView` / `WebContentsView`）相关 UI 壳层

---

## 2. 当前设计方向

### 2.1 总体风格

当前 UI 方向不是高对比的“卡片拼装”，而是偏轻壳层、弱分隔、米色连续面的工作台风格。

核心原则：

- 只有输入框、按钮、状态 badge、激活项、统计卡片等“有交互或需要强调”的元素保留边框和底色
- 普通 section 容器、描述块、辅助说明尽量去边框、去底色
- 面板底色统一到浅米色系，减少模块之间割裂感
- 圆角只应落在真正的“模式主画布边界”上，不应该在内部内容层重复出现

### 2.2 表层语义

表层大致分为四级：

- App / Workbench 背景：很浅的暖白或米白
- Panel 面：统一浅米色
- Content 面：比 panel 更亮一点的浅米白
- Interactive 面：输入框、按钮、激活项，用更明确的边框与浅蓝/白色承载

---

## 3. 全局设计 Token

来源文件：

- [index.css](/Users/user/Documents/ready-cowork/src/renderer/styles/index.css)

### 3.1 颜色（Light）

- `--bg-primary: #FFFFFF`
- `--bg-panel: #F6F5F1`
- `--bg-content: #FDFCFA`
- `--workbench-mode-bg: #FAF8F2`
- `--bg-editor: #F8F7F4`
- `--bg-toolbar: #FAFAF9`
- `--bg-canvas: #F0EFED`
- `--border-default: #E8E5DE`
- `--border-input: #D5D5D5`
- `--text-title: #1A1A1A`
- `--text-body: #333333`
- `--text-muted: #666666`
- `--text-light: #999999`
- `--panel-unified-bg: #F6F5F1`

### 3.2 语义色

- `--color-blue: #5B8DEF`
- `--color-blue-light: rgba(91, 141, 239, 0.1)`
- `--color-green: #34D399`
- `--color-orange: #E97A2B`
- `--color-purple: #8B5CF6`
- `--color-red: #EB5757`

### 3.3 阴影

- `--shadow-sm: 0 1px 3px rgba(0,0,0,0.06)`
- `--shadow-md: 0 2px 6px rgba(0,0,0,0.04)`
- `--shadow-lg: 0 4px 12px rgba(0,0,0,0.08)`

### 3.4 字号 Token

- `--text-xs: 10px`
- `--text-sm: 11px`
- `--text-base: 13px`
- `--text-lg: 15px`
- `--text-xl: 18px`
- `--text-2xl: 24px`

### 3.5 圆角 Token

- `--radius-sm: 4px`
- `--radius-md: 8px`
- `--radius-lg: 12px`
- `--radius-xl: 16px`
- `--radius-full: 9999px`
- `--workbench-canvas-radius: 18px`

### 3.6 Workbench 主画布边界

新增共享壳层：

- `.workbench-canvas-shell`

当前设计值：

- 圆角：`18px`
- 边框：`1px solid color-mix(in srgb, var(--border-default) 86%, transparent)`
- 阴影：`0 4px 14px rgba(15, 23, 42, 0.03)`

作用：

- 作为 `browser / document / rss / calendar` 模式的主画布外壳
- 避免内部子层重复加圆角造成“圆角套圆角”的层级错误

---

## 4. Settings 体系

来源文件：

- [Settings.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/Settings.tsx)
- [settings-theme.ts](/Users/user/Documents/ready-cowork/src/renderer/components/settings/settings-theme.ts)
- [PersonalityEditor.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/personality/PersonalityEditor.tsx)
- [UserProfileEditor.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/profile/UserProfileEditor.tsx)
- [RemoteIMSettingsPanel.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/settings/RemoteIMSettingsPanel.tsx)

### 4.1 当前设置页方向

本轮设置页强调“轻容器 + 强控件”：

- 大块 section 头部去掉厚边框外壳
- 普通设置项不再放在重卡片容器中
- 只保留输入槽、按钮、激活项、状态 notice 有明确底色或边框

### 4.2 关键数值

来自 `settings-theme.ts`：

- `SETTINGS_CARD_STYLE`
  - `borderRadius: 24`
  - `boxShadow: 0 10px 24px rgba(15, 23, 42, 0.03)`
- `SETTINGS_SUBTLE_CARD_STYLE`
  - `borderRadius: 20`
- `SETTINGS_INPUT_STYLE`
  - `borderRadius: 16`
  - `padding: 12px 14px`
  - `fontSize: 13`
  - `lineHeight: 1.45`
- `SETTINGS_TEXTAREA_STYLE`
  - `minHeight: 220`
- 按钮基础：
  - `minWidth: 108`
  - `padding: 12px 18px`
  - `borderRadius: 16`
  - `fontSize: 13`
  - `fontWeight: 600`
- badge：
  - `padding: 5px 10px`
  - `borderRadius: 999`
  - `fontSize: 11`

### 4.3 布局特点

`Settings.tsx` 当前主布局：

- 左侧设置导航宽度：`252px`
- 主内容最大宽度：`980px`
- 主内容 padding：`36px 44px 72px`
- 标题区：
  - 小标题字距：`0.18em`
  - 主标题字号：`22px`
  - 描述字号：`13px`

### 4.4 子模块实现特点

`PersonalityEditor.tsx`

- 双栏布局：左侧列表，右侧编辑
- 列表项使用激活态浅蓝底 + 边框
- 编辑区主要保留输入和按钮的视觉重量

`UserProfileEditor.tsx`

- 同样是“左侧实体列表 + 右侧详情面板”
- 表单通过输入框和选择器强调，不靠外围大卡片强调

`RemoteIMSettingsPanel.tsx`

- 已开始去除“只是包一层”的容器
- 保留真正需要强调的控制项与状态卡

---

## 5. Workbench 模式 UI 改动

### 5.1 Browser 模式

来源文件：

- [BrowserMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/BrowserMode.tsx)
- [BrowserTabBar.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/browser/BrowserTabBar.tsx)
- [BrowserAddressBar.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/browser/BrowserAddressBar.tsx)
- [BrowserShellLayout.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/browser/BrowserShellLayout.tsx)
- [BrowserSidePanel.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/browser/BrowserSidePanel.tsx)
- [useBrowserViewBounds.ts](/Users/user/Documents/ready-cowork/src/renderer/modules/browser/useBrowserViewBounds.ts)
- [host-layout-service.ts](/Users/user/Documents/ready-cowork/src/main/modules/browser-engine/host-layout-service.ts)
- [tab-lifecycle-service.ts](/Users/user/Documents/ready-cowork/src/main/modules/browser-engine/tab-lifecycle-service.ts)
- [preview-service.ts](/Users/user/Documents/ready-cowork/src/main/modules/browser-engine/preview-service.ts)

当前目标：

- Browser 模式使用一个统一外壳容纳：
  - tab bar
  - address bar
  - native web viewport
- 避免 DOM 圆角和原生视图圆角互相打架
- 避免新 tab 在加载前先露出原生白底 view

关键实现：

- `BrowserMode.tsx`
  - 外层使用 `.workbench-canvas-shell`
  - 新建 tab 前先同步 bounds，再触发 createTab
- `BrowserTabBar.tsx`
  - 左侧 tab rail 贴边
  - 当前版本中把最左侧 padding 压到了更小
- `BrowserShellLayout.tsx`
  - 负责浏览器内容区和右侧面板的 DOM 壳层组织
- `host-layout-service.ts`
  - 创建 host 时调用：
    - `setBackgroundColor('#00000000')`
    - `setBorderRadius(18)`（在 `WebContentsView` 能力可用时）
- `tab-lifecycle-service.ts`
  - 新 tab 创建后不再直接无条件先把新 host 露出来
  - 通过加载完成/失败事件决定换屏时机
- `preview-service.ts`
  - RSS 预览浏览器复用相同思路

当前状态说明：

- Browser 是本轮最复杂也最不稳定的一块
- 已经从“网页 CSS 假裁切”回退到“原生 host 层裁切”
- 仍建议以真实运行截图继续校验，而不是只看代码

### 5.2 Document 模式

来源文件：

- [DocumentMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/DocumentMode.tsx)
- [MarkdownEditor.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/document/MarkdownEditor.tsx)

当前方向：

- 文档模式是目前四个模式中相对最稳定的一块
- 主壳层已经上移到：
  - 标签条
  - 路径信息带
  - 编辑/预览内容区

关键数值：

- 模式外层 padding：`px-3 pb-3 pt-2`
- 文档内容宽度：`maxWidth: 800`
- 内容内边距：`12px 40px 24px`

### 5.3 RSS 模式

来源文件：

- [RSSMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/RSSMode.tsx)
- [RSSFeed.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/rss/RSSFeed.tsx)
- [PreviewBrowser.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/rss/PreviewBrowser.tsx)

当前方向：

- RSS 需要把“外层蓝框范围”与“内部列表区”统一成同一份浅米色
- 不应出现外层浅灰 / 内层浅米的双层底色

关键实现：

- `RSSMode.tsx`
  - 外层模式根加 `rss-mode-shell`
  - 外壳使用 `.workbench-canvas-shell`
- `RSSFeed.tsx`
  - 内容面背景已改向 `var(--bg-content)` 靠拢
- `index.css`
  - 额外补了 `.rss-mode-shell` 下的高优先级背景覆盖

当前状态说明：

- RSS 的颜色统一问题主要是“全局 `.content-surface-panel` 背景覆盖”导致
- 这块目前依靠模式级选择器继续压色

### 5.4 Calendar 模式

来源文件：

- [CalendarMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/CalendarMode.tsx)
- [schedule-x.css](/Users/user/Documents/ready-cowork/src/renderer/styles/schedule-x.css)

当前方向：

- 左侧 mini calendar / source 列是独立 column
- 右侧主日程区才是带右侧圆角的主画布
- 左侧与右侧连接处应为直线、直角，不应出现内弧

关键实现：

- 外层布局：
  - 左侧栏宽度：`220px`
  - 右侧主区单独作为 `.workbench-canvas-shell`
- 主日程区壳层：
  - 左侧无圆角
  - 右上/右下保留 `18px` 圆角
- `schedule-x.css`
  - `.sx__calendar-wrapper { border-radius: inherit !important; }`
  - 让内部 SX wrapper 继承外层右侧圆角

当前状态说明：

- Calendar 当前主要难点是：
  - 左栏与右栏交界处的直线连续性
  - 主区左侧是否仍残留弧角
- 这些都属于布局层问题，不是 token 问题

---

## 6. 设计特点总结

### 6.1 视觉特点

- 浅米色大面连续，模块像同一张桌面上的不同工作面
- 高强调元素集中在输入、按钮、激活项、badge，而不是大容器
- 字号体系偏克制，主内容多在 `11px / 13px / 16px / 22px`
- 圆角只应在最终模式边界或明确的交互元素上出现

### 6.2 工程特点

- 很多 UI 统一不靠单组件手写，而是靠全局 token + 模式壳层
- Browser 是“DOM + 原生 host view”混合渲染，不能只靠前端 CSS 验证
- Settings 已抽出独立设计底座，适合作为后续其他偏后台界面的模板

---

## 7. 当前已知问题

截至本文档生成时，仍需持续校验的点：

- Browser 模式：
  - 新页面切换时是否还有白底闪现
  - 原生 view 的圆角是否与 DOM 壳层严格重合
- RSS 模式：
  - 蓝框范围内底色是否已完全统一
- Calendar 模式：
  - 左右连接处是否严格为“直线 + 直角”

这些问题已经不再是“设计方向未定义”，而是“最后一层实现收口”问题。

---

## 8. 实现路径总览

### 8.1 样式与 Token

- [index.css](/Users/user/Documents/ready-cowork/src/renderer/styles/index.css)
- [schedule-x.css](/Users/user/Documents/ready-cowork/src/renderer/styles/schedule-x.css)
- [settings-theme.ts](/Users/user/Documents/ready-cowork/src/renderer/components/settings/settings-theme.ts)

### 8.2 设置页

- [Settings.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/Settings.tsx)
- [RemoteIMSettingsPanel.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/settings/RemoteIMSettingsPanel.tsx)
- [PersonalityEditor.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/personality/PersonalityEditor.tsx)
- [UserProfileEditor.tsx](/Users/user/Documents/ready-cowork/src/renderer/components/profile/UserProfileEditor.tsx)

### 8.3 Workbench 模式

- [BrowserMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/BrowserMode.tsx)
- [DocumentMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/DocumentMode.tsx)
- [RSSMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/RSSMode.tsx)
- [CalendarMode.tsx](/Users/user/Documents/ready-cowork/src/renderer/pages/modes/CalendarMode.tsx)

### 8.4 浏览器原生宿主层

- [host-layout-service.ts](/Users/user/Documents/ready-cowork/src/main/modules/browser-engine/host-layout-service.ts)
- [tab-lifecycle-service.ts](/Users/user/Documents/ready-cowork/src/main/modules/browser-engine/tab-lifecycle-service.ts)
- [preview-service.ts](/Users/user/Documents/ready-cowork/src/main/modules/browser-engine/preview-service.ts)

---

## 9. 推荐后续工作方式

后续继续改 UI 时建议遵循：

1. 先判断问题属于：
   - token 问题
   - 壳层层级问题
   - 原生 view 问题
2. Browser 一律优先实机截图验证，不要只看代码
3. 对于 RSS / Calendar / Browser 这种模式页，优先改“最外层模式画布”，不要在内部继续叠壳
4. Settings 继续沿用 `settings-theme.ts`，不要回到零散 inline style 体系
