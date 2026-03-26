# UI 调整导览

这份文件是给以后接手这个项目的 coding agent 用的。
目标只有一个：想改某个 UI 区域时，先看这里，再去对应文件，不要在整个 `src/renderer/` 里盲搜。

## 1. 总入口

- 工作台总壳层：`src/renderer/pages/WorkbenchMode.tsx`
  负责左侧图标栏、侧边面板、主内容区、聊天区的整体拼装。
- 左侧图标栏入口：`src/renderer/components/layout/IconRail.tsx`
  这里只负责把当前激活项和“面板是否展开”传给左边滑块，不要把滑块状态机写回这里。
- 左侧图标滑块真实逻辑：`src/renderer/components/motion/MorphIconRailGroup.tsx`
  这里控制滑块的浮起态、下陷记忆态、按下过程、以及“先浮起再滑动”的节奏。
- 模式切换出口：`src/renderer/components/layout/WorkbenchModeOutlet.tsx`
  负责在 `browser / document / rss / calendar` 之间切换。
- 顶部模式切换栏：`src/renderer/components/layout/TopBar.tsx`
- 四模块滑块与左栏滑块样式：`src/renderer/styles/workbench-sliders.css`
- 工作台滑块运动参数基线：`src/renderer/modules/workbench/slider-motion.ts`
  顶部四模块直接用这里；左栏滑块现在是在这套基线之上做了更慢的派生节奏。

## 2. 侧边面板怎么找

- 侧边面板壳层路由：`src/renderer/components/layout/SidePanel.tsx`
  这里现在负责三件事：
  1. 决定当前显示哪个面板
  2. 统一编排标题/内容的滚动切换
  3. 在收起时保持内部内容按原宽度被裁切，避免文字被右边界挤成一列
  但它仍然不应该重新塞回文件管理/搜索/技能中心的业务细节。
- 文件面板真实入口：`src/renderer/components/layout/FilesPanel.tsx`
  文件管理标题、工具栏、搜索框、网格前进/后退、文件树/网格入口都在这里。
  现在也负责把“标题槽 / 主体槽”提供给 `SidePanel.tsx`。
- 全局搜索面板：`src/renderer/components/layout/GlobalSearchPanel.tsx`
  同样提供“标题槽 / 主体槽”给 `SidePanel.tsx`。
- 技能中心面板：`src/renderer/components/layout/SkillsCenterPanel.tsx`
  同样提供“标题槽 / 主体槽”给 `SidePanel.tsx`。
- 日程左侧内容不走 `SidePanel`，真实入口在：`src/renderer/components/calendar/CalendarWorkbenchShell.tsx`

### 和侧边面板改动最相关的检查

- 侧边面板滚动切换契约：`src/__tests__/side-panel-waterfall-contract.test.ts`
- 左栏滑块记忆态/浮起态契约：`src/__tests__/icon-rail-resting-thumb-contract.test.ts`
- 左栏滑块外观基线：`src/__tests__/workbench-mode-and-rail-slider-contract.test.ts`
- 左栏滑块与顶部滑块的运动基线关系：`src/__tests__/workbench-slider-motion-contract.test.ts`

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
- 文件面板顶部“筛选 / 更多”菜单：
  真实逻辑也在 `src/renderer/components/layout/FilesPanel.tsx`
  但菜单本体现在走顶层弹层，不再留在左侧栏内部。
- 文件面板下拉菜单共用外观：`src/renderer/components/ui/floatingMenuStyles.ts`
- 文件面板下拉菜单悬停与磨砂样式：`src/renderer/components/layout/filesPanelFloatingMenu.css`
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

### 设置

- 页面入口：`src/renderer/pages/Settings.tsx`
  设置页的整体结构、左侧导航、各分区标题、通用设置项布局都从这里开始改。
- 设置页共用外观 token：`src/renderer/components/settings/settings-theme.ts`
  输入槽、按钮、只读短槽、轻量信息块、左侧导航选中态都统一走这里，不要在设置页里再各写一套。
- 远程 IM 分区：`src/renderer/components/settings/RemoteIMSettingsPanel.tsx`
- 记忆系统分区：`src/renderer/components/memory/MemoryStatsCard.tsx`、`src/renderer/components/memory/MemoryCreator.tsx`、`src/renderer/components/memory/MemoryListPanel.tsx`、`src/renderer/components/memory/TriggerManager.tsx`
- Agent 人格分区：`src/renderer/components/personality/PersonalityEditor.tsx`
- 用户档案分区：`src/renderer/components/profile/UserProfileEditor.tsx`
- 设置页浏览器预览假数据：`src/renderer/preview/installSettingsPreviewMocks.ts`
  如果设置页预览打不开，先看这里是不是缺了 Electron API mock。

### 和设置页改动最相关的检查

- 设置页玻璃壳层与短槽约定：`src/__tests__/settings-liquid-glass-contract.test.ts`

## 5. 共用样式去哪里找

- 全局 UI 变量和共用壳层：`src/renderer/styles/index.css`
- 工作台滑块、左栏滑块、四模块切换栏：`src/renderer/styles/workbench-sliders.css`
- 左栏滑块的“浮起 / 按下 / 记忆态”样式也都在 `workbench-sliders.css`
- 日程样式：`src/renderer/styles/schedule-x.css`
- 面板尺寸 token：`src/renderer/components/layout/panelTokens.ts`

## 6. 想改什么，就先看哪里

- 改工作台布局关系：
  先看 `WorkbenchMode.tsx`
- 改侧边面板切换逻辑：
  先看 `SidePanel.tsx`
- 改侧边面板“收起时文字不要被挤坏”：
  先看 `SidePanel.tsx`
- 改文件面板里的任何内容：
  先看 `FilesPanel.tsx`
- 改文件面板顶部下拉菜单位置、显隐、完整显示问题：
  先看 `FilesPanel.tsx`，再看 `floatingMenuStyles.ts` 和 `filesPanelFloatingMenu.css`
- 改文件树、缩略图网格、拖拽、右键菜单：
  先看 `FileTree.tsx`
- 改文件夹卡片里那块小缩略图区域：
  先看 `FolderPreview.tsx`
- 改文件夹缩略图里“显示哪些子项、按什么顺序排、空状态怎么写”：
  先看 `folderPreviewModel.ts`
- 改四模块切换栏或左侧滑块：
  先看 `workbench-sliders.css`
- 改左侧滑块的交互节奏、下陷记忆态、先浮起再滑动：
  先看 `MorphIconRailGroup.tsx`，再看 `IconRail.tsx` 和 `WorkbenchMode.tsx`
- 改左侧滑块整体速度是否要更慢：
  先看 `MorphIconRailGroup.tsx`
  因为左栏现在不是直接复用顶部四模块的现成节奏，而是基于那套参数额外放慢了一层。
- 改输入框颜色、边框、聚焦态：
  先看 `index.css`
- 改日程左栏：
  先看 `CalendarWorkbenchShell.tsx`
- 改设置页整体布局、左侧导航、各分区排版：
  先看 `Settings.tsx`
- 改设置页输入槽、按钮、只读槽、轻量信息块：
  先看 `settings-theme.ts`
- 改设置页某个业务分区的内容：
  先看对应分区组件，不要回到 `Settings.tsx` 里硬塞业务细节
- 改设置页预览：
  先看 `installSettingsPreviewMocks.ts`

## 7. 当前约定

- `SidePanel.tsx` 现在不只是“壳层路由”，还负责标题/内容切换编排与收起裁切，但不要再塞回文件面板、搜索面板、技能面板的业务细节。
- 文件面板的真实入口固定在 `FilesPanel.tsx`。
- `FilesPanel.tsx`、`GlobalSearchPanel.tsx`、`SkillsCenterPanel.tsx` 现在都要继续保持“标题槽 / 主体槽”输出能力，别再改回每个面板自己整块硬切。
- 文件面板顶部的瞬时菜单不要再直接留在左侧栏布局层里；左侧栏壳层带 `overflow-hidden`，菜单一旦超出边界就会被裁掉。现在这类菜单应继续保持为顶层弹层，由 `FilesPanel.tsx` 负责位置计算。
- 文件夹缩略图的画法固定拆在 `FolderPreview.tsx`，不要再把这块样式塞回 `FileTree.tsx`。
- 文件夹缩略图“看什么内容、怎么退化”的规则固定拆在 `folderPreviewModel.ts`。
- 日程左栏的真实入口固定在 `CalendarWorkbenchShell.tsx`。
- 滑块样式优先从 `workbench-sliders.css` 改。
- 左栏滑块的状态机固定放在 `MorphIconRailGroup.tsx`，不要把“下陷 / 浮起 / 记忆态 / 先浮起再滑动”拆散回 `IconRail.tsx`。
- 左栏滑块是否处于展开态，由 `WorkbenchMode.tsx -> IconRail.tsx -> MorphIconRailGroup.tsx` 这条链路传递；不要在别的地方各自猜测。
- 如果要继续调左栏滑块速度，优先改 `MorphIconRailGroup.tsx` 里的时间常量和派生 transition，不要直接改顶部四模块那套基线。
- 如果改了滑块却表现不对，再检查 `src/renderer/styles/index.css` 里有没有旧的同名样式残留。
- 设置页左侧导航不要再加整块底板或卡片底色；选中态优先靠文字颜色、轻量高亮和图标状态表达。
- 设置页右侧内容区尽量保持干净，除了输入槽、按钮、真正承载状态的信息块外，不要额外堆大面积色块或装饰性卡片。
- 快捷键、存储、关于这类右侧展示值较短的分区，优先用短槽承载，不要让右侧控件默认拉很宽把文本挤坏。
- 设置页如果要继续补新分区，优先沿用 `settings-theme.ts` 的共用 token；不要在新分区里重新发明一套输入框、按钮和只读槽样式。
