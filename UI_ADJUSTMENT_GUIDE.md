# UI 调整导览

这份文件是给以后接手这个项目的 coding agent 用的。
目标只有一个：想改某个 UI 区域时，先看这里，再去对应文件，不要在整个 `src/renderer/` 里盲搜。

## 1. 总入口

- 工作台总壳层：`src/renderer/pages/WorkbenchMode.tsx`
  负责左侧图标栏、侧边面板、主内容区、聊天区的整体拼装。
- 模式切换出口：`src/renderer/components/layout/WorkbenchModeOutlet.tsx`
  负责在 `browser / document / rss / calendar` 之间切换。
- 顶部模式切换栏：`src/renderer/components/layout/TopBar.tsx`
- 四模块滑块与左栏滑块样式：`src/renderer/styles/workbench-sliders.css`

## 2. 侧边面板怎么找

- 侧边面板壳层路由：`src/renderer/components/layout/SidePanel.tsx`
  这里只负责决定当前显示哪个面板，不要再把具体内容写回这个文件里。
- 文件面板真实入口：`src/renderer/components/layout/FilesPanel.tsx`
  文件管理标题、工具栏、搜索框、网格前进/后退、文件树/网格入口都在这里。
- 全局搜索面板：`src/renderer/components/layout/GlobalSearchPanel.tsx`
- 技能中心面板：`src/renderer/components/layout/SkillsCenterPanel.tsx`
- 日程左侧内容不走 `SidePanel`，真实入口在：`src/renderer/components/calendar/CalendarWorkbenchShell.tsx`

## 3. 文件面板相关改动去哪改

### 文件列表 / 网格

- 文件树与网格主体：`src/renderer/components/layout/FileTree.tsx`
  文件夹卡片、网格缩略图卡片、文件夹内容预览的挂载入口都从这里进去找。
- 文件夹缩略图预览表现：`src/renderer/components/layout/FolderPreview.tsx`
  这里控制文件夹卡片里那块小预览区域怎么画。
- 文件夹缩略图筛选与排序规则：`src/renderer/components/layout/folderPreviewModel.ts`
  想改“优先显示什么内容”“空文件夹文案”“无图片时怎么退化显示”，先看这里。
- 网格历史逻辑：`src/renderer/components/layout/gridNavigation.ts`
- 工作区文件状态：`src/renderer/stores/useWorkspace.ts`

### 文件面板搜索区

- 文件面板顶部搜索与网格前进后退：`src/renderer/components/layout/FilesPanel.tsx`
- 输入槽共用外观：`src/renderer/styles/index.css`
  关键词：
  - `--input-slot-bg`
  - `--input-slot-border`
  - `.ready-input-shell`
  - `.ready-input-slot-inner`

## 4. 四个主模式分别去哪改

### 浏览器

- 页面入口：`src/renderer/pages/modes/BrowserMode.tsx`
- 顶部浏览器栏：`src/renderer/components/browser/BrowserHeader.tsx`
- 浏览器内容壳：`src/renderer/components/browser/BrowserShellLayout.tsx`
- 激活标签输入区：`src/renderer/components/browser/ActiveTabSurface.tsx`

### 文档

- 页面入口：`src/renderer/pages/modes/DocumentMode.tsx`
- 文档标签栏：`src/renderer/components/document/DocumentTabRail.tsx`
- 编辑器主体：`src/renderer/components/document/MarkdownEditor.tsx`
- 编辑 / 预览切换滑块：`src/renderer/components/document/DraggableModeSwitch.tsx`

### RSS

- 页面入口：`src/renderer/pages/modes/RSSMode.tsx`
- RSS 主界面：`src/renderer/components/rss/RSSFeed.tsx`
- 预览浏览器：`src/renderer/components/rss/PreviewBrowser.tsx`

### 日程

- 页面入口：`src/renderer/pages/modes/CalendarMode.tsx`
- 日程整体壳层：`src/renderer/components/calendar/CalendarWorkbenchShell.tsx`
- 左侧小日历与来源列表也都从这里往下找

## 5. 共用样式去哪里找

- 全局 UI 变量和共用壳层：`src/renderer/styles/index.css`
- 工作台滑块、左栏滑块、四模块切换栏：`src/renderer/styles/workbench-sliders.css`
- 日程样式：`src/renderer/styles/schedule-x.css`
- 面板尺寸 token：`src/renderer/components/layout/panelTokens.ts`

## 6. 想改什么，就先看哪里

- 改工作台布局关系：
  先看 `WorkbenchMode.tsx`
- 改侧边面板切换逻辑：
  先看 `SidePanel.tsx`
- 改文件面板里的任何内容：
  先看 `FilesPanel.tsx`
- 改文件树、缩略图网格、拖拽、右键菜单：
  先看 `FileTree.tsx`
- 改文件夹卡片里那块小缩略图区域：
  先看 `FolderPreview.tsx`
- 改文件夹缩略图里“显示哪些子项、按什么顺序排、空状态怎么写”：
  先看 `folderPreviewModel.ts`
- 改四模块切换栏或左侧滑块：
  先看 `workbench-sliders.css`
- 改输入框颜色、边框、聚焦态：
  先看 `index.css`
- 改日程左栏：
  先看 `CalendarWorkbenchShell.tsx`

## 7. 当前约定

- `SidePanel.tsx` 只做“壳层路由”，不要再塞回文件面板细节。
- 文件面板的真实入口固定在 `FilesPanel.tsx`。
- 文件夹缩略图的画法固定拆在 `FolderPreview.tsx`，不要再把这块样式塞回 `FileTree.tsx`。
- 文件夹缩略图“看什么内容、怎么退化”的规则固定拆在 `folderPreviewModel.ts`。
- 日程左栏的真实入口固定在 `CalendarWorkbenchShell.tsx`。
- 滑块样式优先从 `workbench-sliders.css` 改。
- 如果改了滑块却表现不对，再检查 `src/renderer/styles/index.css` 里有没有旧的同名样式残留。
