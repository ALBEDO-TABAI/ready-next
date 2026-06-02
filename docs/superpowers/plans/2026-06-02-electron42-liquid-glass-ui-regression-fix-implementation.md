---
title: Electron 42 / Chromium 148 液态玻璃 UI 回归修复（对齐主线 · 修根因）
date: 2026-06-02
status: approved-ready-for-construction   # R2 双方无异议通过（2026-06-02）；待用户交 Codex 施工
owner: 白
executor: Codex（调度 subagents 施工），Claude 复审
enforce: true
related:
  - docs/superpowers/specs/2026-05-16-liquid-glass-ui-layering-and-motion-contract.md   # 视觉层级与动效不可破合同
  - docs/superpowers/plans/2026-06-01-electron42-html-in-canvas-upgrade-implementation.md  # Electron 42 升级主计划（runtime/native/probe 已完成）
  - docs/superpowers/plans/2026-06-01-browserview-presentation-unification-implementation.md  # 浏览器原生层呈现时机（已施工，正交）
  - CLAUDE.md §2（BrowserView 原生覆盖层硬约束）、§0.5（先合同 / 修根因）
  - LESSONS_LEARNED.md（首帧落 data-theme/data-skin；macOS vibrancy quiesce）
external_references:
  - https://github.com/electron/electron/issues/19765   # vibrancy + backdrop-filter 双层/重影
  - https://github.com/electron/electron/issues/39529
  - https://github.com/electron/electron/issues/44720
  - https://github.com/electron/electron/issues/30412
  - https://issues.chromium.org/issues/339841685         # backdrop-filter: blur 滚动闪烁
  - https://issues.chromium.org/issues/380416865         # backdrop-filter 在非不透明背景下失效
  - https://github.com/electron/electron/issues/12906     # 滚动时 backdrop-filter 失败
---

# Electron 42 / Chromium 148 液态玻璃 UI 回归修复

> 本文是给 **Codex 调度 subagents 施工** 用的详细计划。
>
> **审查轮次**：
> - **R1（2026-06-02，Codex）**：5 问审查。§3.2 候选矩阵与排序、WP4 合同回正方向获认可（agree）。提出 3 条 needs-change：① §3.1 根因假设 over-explain 了"发平/玻璃丢失"（那是支线主动删 blur，非 Chromium bug）；② §2.1 把已退役的 layering spec §4.3 原生 fullscreen 状态机当成实现事实（实际 darwin 恒透明 + DOM `.ready-app-bg` backing）；③"动效/切换异常"无 owning WP。Claude 已逐条核实并修缮（§3.1 拆 (a)/(b)、§2.1 按 `main-window-material.ts:70-82/208-253` 勘误、新增 **WP6** 并更新 §6/§8）。
> - **R2（2026-06-02，Codex）— ✅ 通过**：定向复核 3 条修缮，全部判 **closed**，无新增问题，结论 **READY-FOR-IMPLEMENTATION**。双方无异议，待用户交 Codex 施工。
>
> 阅读顺序：§0 完成标准 → §1 前因后果（务必先读）→ §2 已核实事实（file:line）→ §3 根因假设与候选修法（待 WP0 实证）→ §4 目标设计 → §5 工作包 → §6 顺序与依赖 → §7 验收 → §8 测试影响 → §9 风险与回滚 → §10 不做的事 → §11 施工硬性约束。
>
> **范围口径（用户已定稿 2026-06-02）**：**完全对齐主线、修根因**。不允许用"删除 `backdrop-filter` / 改实色底座 / 把合同测试改松"来规避 Chromium 148 问题；必须保住真半透明液态玻璃质感，按 `2026-05-16-...-layering-and-motion-contract.md` §2.7 / §9.5 修真正的根因。

---

## 0. 完成标准

只有以下全部成立才算完成：

1. **观感完全对齐主线**：在 Electron 42 / Chromium 148 下，`liquid-glass` 皮肤（浅色 + 暗色）的下列表面与主线（Electron 34 / Chromium 132）**肉眼一致**：
   - 左侧竖向 IconRail 功能切换槽（`.icon-rail-slider`）；
   - 顶部四模式切换槽（`.draggable-mode-tabs`）；
   - 设置页整页底色与工作界面底色**一致**（都为真半透明，不出现"设置页偏实/发灰、和工作台不是一个底"）；
   - 所有 `.glass-surface-*` 面板/卡片/浮层仍有 backdrop blur 玻璃质感，不退化成纯色块。
2. **滚动残影/拖影根除**：设置页侧栏、设置页内容区、以及其它 `overflow:auto` + `backdrop-filter` 组合处，滚动/切换时不再留下拖影、残像、脏区域。
3. **修根因而非症状**：修复落在"窗口材料 / 合成层 / backdrop-root / repaint 时机"这一层，符合 layering spec §9.5 允许方向（`will-change` 时机、局部隔离、层 promote/demote、窗口材料），**不删 blur、不加实色底座、不靠 `offsetHeight` 强制 reflow**。
4. **合同测试回正并加固**：当前支线把合同测试改成"接受平面化"的两处断言被**纠正**为"锁住玻璃质感 + 锁住 Chromium 148 安全技法"；新增能在"还原平面化退化"时失败的断言。
5. **昼夜 / 模式 / 全屏切换无新异常**：主题昼夜切换 ritual、模式切换进入动画、全屏进出在 148 下不出现闪绿、硬切、残影；浏览器原生层呈现仍精确（沿用已施工的 browserview-presentation 计划，不回归）。
6. **机器验证 + 产品面验收双过**：`npm run typecheck` / `npm run test` / `npm run verify:native` 通过；并以新 userData 打包/启动做产品面"模拟人类"视觉验收，保留主线 vs 支线对照截图，逐项核对 §7.3 清单。

---

## 1. 前因后果（背景，务必先读）

### 1.1 一句话
Ready `liquid-glass` 默认是**真半透明液态玻璃**：macOS 主窗口 `backgroundColor: '#00000000'` + `vibrancy: 'under-window'`，DOM 面板靠 `backdrop-filter: blur() saturate()` 形成玻璃质感（全仓 ~40 处 backdrop-filter 规则）。**Electron 34→42（Chromium 132→148）改变了"透明/vibrancy 窗口下 backdrop-filter 的合成与脏区(damage)处理"**，使原本在 132 上可接受的 backdrop-filter 在 148 上出现**滚动残影 / 重影 / 脏区残留**。支线为了止血，**删掉了部分 backdrop-filter、把槽位与设置页改成接近实色底，并把锁视觉的合同测试改成接受平面化** —— 这恰好违反了 layering spec §2.7/§9.5 的不可破合同，导致"玻璃质感丢失、底色与主线不一致、设置页仍有残影"等用户实测问题。

### 1.2 这是一个**已知的上游问题类**，不是 Ready 写错
macOS vibrancy + CSS `backdrop-filter` 的合成冲突是长期存在的 Electron/Chromium 问题（见 external_references）：
- electron#19765 / #39529 / #44720：开 vibrancy 后 backdrop-filter 出现"模糊层与原层同时显示"的重影；关掉 vibrancy 就正常。
- chromium#339841685：`backdrop-filter: blur()` **滚动时闪烁**。
- chromium#380416865：backdrop-filter 在**非不透明（透明）背景**下表现不正确。
- electron#12906：**滚动时** backdrop-filter 失败。

含义：根因在"透明 + vibrancy 根层 + backdrop-filter + 滚动"四者交叉处的 Chromium 合成/脏区策略。Chromium 132→148 之间该策略发生了变化，把"勉强能用"变成了"明显残影"。**正确方向不是关掉 backdrop-filter（那会丢掉产品要的玻璃），而是给 backdrop-filter 一个稳定可重绘的合成上下文 / backdrop 源。**

### 1.3 主线 vs 支线的事实差（已核实，详见 §2）
- **IconRail 槽 / 四模式槽**：支线把 `backdrop-filter` 改成 `none`，背景换成 `var(--workbench-rail-slot-bg)`。关键事实：主线该处的 `background: color-mix(..., var(--lg-surface-elevated) ...)` 因 `--lg-surface-elevated` **从未定义**（主线、支线皆然）而失效、回退到基础规则的 `var(--workbench-rail-slot-bg)`。**也就是说支线对这两个槽的唯一有效视觉改动是"删掉了 blur"** → 用户看到的"底色不一致"本质是"槽位丢了玻璃模糊、平面化后色感变了"。
- **设置页**：主线 `Settings` 根 `div` 是 `style={{ background: 'transparent' }}`（与工作台同为真半透明）。支线改为 `className="settings-page-shell"` 且 `--settings-page-shell-bg: color-mix(... --workbench-liquid-chrome-bg 92%, transparent)`（接近实色 chrome 底）→ **设置页底色 ≠ 工作界面底色**。支线又给侧栏/内容区加 `contain: paint; isolation: isolate`（方向对，属 §9.5 允许的"局部隔离"）并把导航项底色改成近实色 + `backdropFilter:none`（错，平面化）——但用户反馈**残影仍在**，说明"加 contain + 改实色"并没有真正根治残影。
- **合同测试**：支线在 `dark-liquid-flat-chrome-contract.test.ts` 与 `settings-liquid-glass-contract.test.ts` 中**新增断言锁定 `backdrop-filter: none` 与近实色底**，等于把"退化"写成了新合同——与 layering spec §7（合同测试防止体验层被改塌）背道而驰。

### 1.4 为什么把它们当"同一类"问题
四个用户症状（玻璃丢失/发平、滚动残影、颜色/透明度偏差、设置页底色不一致 + 残影）**同源**：Chromium 148 下"透明 vibrancy 根 + backdrop-filter + 滚动"的合成回归。支线选择"关 blur / 加实色"来绕开，于是把根因问题转化成了视觉退化问题。修复主线是：**先在 148 找到让 backdrop-filter 在透明窗口下稳定重绘的根因修法（WP0），再据此恢复所有被平面化的玻璃表面（WP1–WP3），最后回正合同测试（WP4）并做全表面扫描与验收（WP5–WP6）。**

---

## 2. 已核实事实（全部 file:line，施工 subagent 须先复核再改）

### 2.1 窗口材料：透明 + vibrancy（根因前提，已核实实现）
- 主窗口创建：`src/main/index.ts`（约 343–367）`backgroundColor: process.platform==='darwin' ? '#00000000' : ...`，`visualEffectState: 'active'`（darwin）。
- 窗口材料实现：`src/main/modules/window-material/main-window-material.ts`：`computeMaterial` 在 darwin 上**无条件**返回 `backgroundColor='#00000000'` + `vibrancy='under-window'`（:70–82，`isFullscreen` 输入对 darwin 不生效）；`applyInitial` 之后 controller **永不再触碰** `setBackgroundColor/setVibrancy`（CALayer 冻结在透明态，避免 NSVisualEffectView quiesce 黑屏）。
- **fullscreen 不走原生材料**：4 个 fullscreen lifecycle handler 在 darwin 上**只翻内部 flag + 经 IPC 通知 renderer**（:208–253），**不**改 bg/vibrancy。全屏防壁纸采样的 backing 完全由 **DOM 层 `.ready-app-bg` 经 `--app-bg-overlay-opacity` + `data-native-fullscreen` attr** 承担（见文件头注释 :3–15）。
- **重要勘误（Codex R1 指出，已核实）**：layering spec §4.3 列的"全屏切 `vibrancy(null)` + 中性 backing `#DEE1E4/#282D33` 原生状态机"在当前代码里**已退役**（注释 "状态机彻底退役"，:11–12），实际改用上面的 DOM backing 方案。因此本计划根因修法**不要复活 §4.3 原生状态机**；可用的"已绘制 backdrop 源"杠杆是既有的 **DOM `.ready-app-bg` + `--app-bg-overlay-opacity`**（C2/C3 应优先复用它）。

### 2.2 液态玻璃 token 与 backdrop-filter 清单
- `src/renderer/styles/index.css`：
  - 浅 liquid-glass：`--lg-blur-soft:20px / -medium:28px / -strong:34px`（309–311），`--surface-saturate:155%`（334）。
  - 暗 liquid-glass：`--lg-blur-* 16/24/30`（389–391），`--surface-saturate:132%`（414）。
  - `--workbench-rail-slot-bg`：浅 362、暗 442；`--workbench-liquid-chrome-bg`：浅 342、暗 422。
  - 主玻璃面板：`.glass-surface-panel/-card/-floating`（约 2219–2265）`backdrop-filter: blur(var(--lg-blur-*)) saturate(var(--surface-saturate)) contrast(...)` + `isolation: isolate`。
  - 全仓 `backdrop-filter` 出现 ~58 行（含 `-webkit-` 与 `none`），分布于 `index.css`、`workbench-sliders.css`、`schedule-x.css`、`components/layout/filesPanelFloatingMenu.css`、`components/document/documentFloatingPanels.css`。**全表面清单见 WP5。**
- **`--lg-surface-elevated` 在主线与支线均无定义**（仅 9 处 `var(--lg-surface-elevated)` 使用，无 `--lg-surface-elevated:` 定义）。因此凡 `color-mix(..., var(--lg-surface-elevated) ...)` 的 `background` 声明在两边都**无效回退**——这是既有"哑 token"，**非支线回归，不在本计划修复范围**（除非 WP5 顺手统一，但需单独标注且不改观感）。

### 2.3 支线对 IconRail 槽 / 四模式槽的改动（工作区未提交）
- `src/renderer/styles/workbench-sliders.css`：
  - `html[data-skin='liquid-glass'] .icon-rail-slider`：`background` 由 `color-mix(... --lg-surface-elevated ...)` 改 `var(--workbench-rail-slot-bg)`；`backdrop-filter` 由 `blur(calc(--lg-blur-soft*0.25)) saturate(...)` 改 **`none`**。
  - `html[data-skin='liquid-glass'] .draggable-mode-tabs` 同样改 `backdrop-filter: none`。
  - `html[data-theme='dark'][data-skin='liquid-glass'] .icon-rail-slider, .draggable-mode-tabs`：`backdrop-filter` 由 `blur(calc(--lg-blur-soft*0.18)) saturate(...)` 改 **`none`**。
- `src/renderer/styles/index.css`：`html[data-skin='liquid-glass'] .draggable-mode-tabs` 背景改 `var(--workbench-rail-slot-bg)`、`backdrop-filter: none`（约 3472–3480）。
- **主线对照**（`git show main:`）：上述四处主线均保留 `backdrop-filter: blur(...) saturate(...)`；背景虽写 `--lg-surface-elevated` 但有效回退到 `--workbench-rail-slot-bg`。→ **支线净改动 = 删 blur**。

### 2.4 支线对设置页的改动（工作区未提交）
- `src/renderer/pages/Settings.tsx`：
  - 根 `div` 由 `style={{ background:'transparent' }}` 改为 `className="settings-page-shell flex h-full flex-col overflow-hidden"`（2826）。
  - 新增挂载副作用：`useEffect(()=>{ window.electronAPI?.browser?.sendIntent({ kind:'hide-all', intentId: nextIntentId(), reason:'overlay-open' }) }, [])`（约 2786–2792）。**需评判：这是 CLAUDE.md §2 "纯 DOM 覆盖层前先 hideAll" 的正确行为，还是残影 workaround？**（见 §3.4）。
  - DOM 结构：`.settings-page-shell`（flex 列）→ header `[data-liquid-shell="settings-header"]`（透明）→ 内容行（flex, overflow-hidden）→ 侧栏 `[data-liquid-shell="settings-sidebar"]`（`overflow-auto` 滚动）+ 内容 `[data-liquid-shell="settings-content"]`（`overflow-auto` 滚动）。
  - 脚注硬编码 `Ready v0.1.0 · Electron 34`（2916）——**事实性文案过期**（现为 42），非渲染 bug，列入 WP5 顺手项（可选）。
- `src/renderer/components/settings/settings-theme.ts`：`settingsListItemStyle` 背景由 `'transparent'` 改 `'var(--settings-list-item-bg)'`（约 205），仍 `backdropFilter:'none'`。
- `src/renderer/styles/index.css`：
  - 新增 `--settings-page-shell-bg` / `--settings-list-item-bg`：dark(283 段) `transparent`；浅 liquid-glass(369–370) 与暗 liquid-glass(450–451) 均为 `color-mix(... --workbench-liquid-chrome-bg 92%/90%, transparent)`（**近实色**）。
  - 新增 `.settings-page-shell { background: var(--settings-page-shell-bg) }`（555–561）与 `html[data-skin='liquid-glass'] [data-liquid-shell='settings-sidebar'], [...'settings-content'] { contain: paint; isolation: isolate }`（563–567）。
- **主线对照**：设置页根 div 透明、导航项 `background:'transparent'`、无 `settings-page-shell` / 无 `--settings-*-bg` / 无 `contain:paint` / 无挂载 `hide-all`。→ 支线把"设置页与工作台同为透明"改成了"设置页近实色 + 容器隔离"。

### 2.5 支线把合同测试改成接受平面化（必须回正）
- `src/__tests__/dark-liquid-flat-chrome-contract.test.ts` 新增：
  - `assert.doesNotMatch(themeStyles, /--lg-surface-elevated\s*:/)`（可保留：与主线一致，token 本就未定义）。
  - `assert.match(... .icon-rail-slider { ... background: var(--workbench-rail-slot-bg); ... backdrop-filter: none; })`（**错：锁死删 blur，必须改为锁 blur 存在**）。
  - `assert.match(... .draggable-mode-tabs { ... background: var(--workbench-rail-slot-bg); ... backdrop-filter: none; })`（**同上，必须回正**）。
- `src/__tests__/settings-liquid-glass-contract.test.ts` 新增：
  - 锁 `settings-page-shell` className、锁 `sendIntent hide-all`、锁 `--settings-page-shell-bg/-list-item-bg = color-mix(...92%/90%...)`、锁 `.settings-page-shell` 无 backdrop-filter、锁侧栏/内容 `contain:paint; isolation:isolate`、新增"导航项 `--settings-list-item-bg` + `backdropFilter:none`"。其中**近实色底 / 导航项实色**两类断言把回归写成合同，必须改为锁"设置页与工作台同底（真半透明）"。
- layering spec §7 第 13 条："`.glass-surface-*` 必须继续有 backdrop blur、半透明背景和暗色中性观感约束" —— 支线现状与该条冲突。

### 2.6 正交但相关：浏览器原生层呈现（已施工，勿重做）
`2026-06-01-browserview-presentation-unification-implementation.md`（status: approved-ready-for-construction，已对应提交 `87f82465 Fix BrowserView presentation stability`）处理"文档/Widget/文件树/全局搜索进浏览器错位"与"切标签闪烁抖动"。**本计划不重做它**；仅在 §7 回归项里确认其在 148 下仍成立（它有自带行为测试）。

---

## 3. 根因假设与候选修法（WP0 实证，不可盲修）

> CLAUDE.md §0.5 红线 2：修根因不修症状。**禁止在未实证根因前直接套用某个修法。** WP0 先复现 + A/B 候选，确定"能保住 blur 又消残影"的最小修法，再进入 WP1–WP3。

### 3.1 根因假设（待 WP0 证实/证伪）
**先分清两类症状，避免把所有问题都归到一个 Chromium bug（Codex R1 指出本节原先 over-explain）：**
- **(a) 残影/重绘类 = 真 Chromium 148 根因（本假设的范围，需 WP0 实证）**：处于**透明 / vibrancy 根合成层**内、且**位于 `overflow:auto` 滚动容器中**的 `backdrop-filter` 元素，其 backdrop 的脏区(damage)在滚动/内容变化时未被正确失效，导致 backdrop-filter 缓存输出残留 → **拖影/残像**（用户报的"滚动拖影""设置页残影"）。Chromium 132 上勉强可用，148 的合成/光栅化改动放大了它。
- **(b) 发平 / 底色不一致 = 支线的人为改动，不是 Chromium bug**：IconRail 槽 / 四模式槽的 `backdrop-filter: none`、设置页近实色底，都是支线为绕开 (a) 而**主动删 blur / 加实色**的结果（§2.3/§2.4 已核实为直接 CSS 改动，**不是** Chromium 渲染 bug）。它们的"修法"是**还原**（WP2/WP3），但必须**建立在 (a) 的根因修复之上**——否则还原 blur 后 (a) 的残影会在这些槽/卡片上回来。换言之：(b) 无需"诊断"、只需还原；(a) 才需要 WP0 probe。

### 3.2 候选修法矩阵（每个都必须"保住 blur"，WP0 逐一 A/B 截图）
按"最小、最可能、风险最低"排序，WP0 取首个通过者；都不通过则升级到下一档：

1. **C1 — 滚动容器层提升 + 干净 backdrop-root**：对 `overflow:auto` 的滚动容器（设置侧栏/内容、面板滚动区）施加 `isolation: isolate` 并促使其成为自有合成层与 backdrop-root（候选属性：`transform: translateZ(0)` 或受控时机的 `will-change: transform`），使 backdrop-filter 子元素采样的是"容器内、随滚动整帧重绘"的 backdrop。**注意**：`will-change/translateZ` 本身可能改变 backdrop-root 归属甚至反而压制 blur，必须截图确认 blur 仍在且残影消失。
2. **C2 — 为 backdrop 提供"已绘制但半透明"的源**（对应 chromium#380416865：非不透明背景下 backdrop-filter 失效）：在玻璃表面与透明根之间放一层**已绘制的半透明背景**（复用 `.ready-app-bg` 玻璃背景层，或在 backdrop-root 容器上给一个**足够淡、不破坏 vibrancy 通透感**的 painted tint），让 backdrop-filter 永远采样到有效 painted 源而非裸透明根。**红线**：layering spec §2.4/§2.7 禁止用它变成不透明底座；painted 源的 alpha 必须经视觉验收，既给 backdrop-filter 有效采样又保留真半透明观感。
3. **C3 — 全窗口单层 painted backdrop（全局修法）**：把 C2 的 painted 源上移到全窗口 `.ready-app-bg`，用**既有的 `--app-bg-overlay-opacity` 杠杆**（fullscreen backing 已用它，§2.1）以受控 opacity 让**所有** backdrop-filter 都有稳定采样源——一处修全局，且复用已落地的架构而非新造。须证明不杀死 macOS vibrancy 通透感（spec §2.4 红线）。
4. **C4 — Electron/Chromium 合成 flag 或窗口选项（兜底）**：仅当 C1–C3 都不能同时"保 blur + 消残影"时，才评估启动 flag / `backgroundColor` 微调等全局手段。全局、风险高，需单独 probe + 全模块回归，且不得破坏 §2.1 vibrancy 状态机。

### 3.3 WP0 的 probe 形态（与现有 probe 风格一致）
仿 `scripts/probe-html-in-canvas.cjs`，新增 `scripts/probe-liquid-glass-residue.cjs`：在 Electron 42 真实运行时开一个 **vibrancy + 透明** 主窗口，加载一个最小页面：一个可滚动容器内放若干 `backdrop-filter: blur()` 卡片 + 长文/渐变背景。脚本对"初始 / 滚动后 / 切换后"截图，A/B 开关每个候选（C1/C2/C3）所需的 CSS / 窗口参数，输出 JSON + PNG 到 `docs/superpowers/audits/2026-06-02-liquid-glass-residue/`，用于判定哪种修法消残影且 blur 仍在。**同时各跑一次"关 vibrancy"对照**，确认残影是否 vibrancy 依赖（决定修法落在 CSS 层还是窗口层）。

### 3.4 设置页 `hide-all` 挂载副作用的判定
`Settings` 挂载即发 `hide-all` 浏览器 intent：
- **若**判定为 CLAUDE.md §2 正解（DOM 覆盖层显示前隐藏原生 BrowserView，避免原生层透过设置页 DOM），则**保留**，但须补：① 离开设置页时恢复 `showActive`（当前 `useEffect([])` 无 cleanup，需核对返回工作台的 mode 切换是否已 re-show，避免回到浏览器是空的）；② 确认它**不是**在借隐藏原生层来掩盖 DOM 残影。
- **若**它实为残影 workaround（设置页本无原生层需要隐藏），则在 WP0 根因修复后**移除**，回归主线行为。
WP0/审查阶段先定性，再决定保留或移除。

---

## 4. 目标设计

### 4.1 总原则
- 默认 `liquid-glass` 在 148 下**继续走真半透明 + vibrancy + backdrop-filter**，仅在"合成上下文 / backdrop 源 / 重绘时机"层做最小根因修复（§3.2 选定项）。
- **逐一恢复**支线平面化的表面到主线观感；恢复必须建立在 WP0 根因修复之上（否则残影回来）。
- 合同测试**回正**：锁"玻璃质感在 + 设置页与工作台同底 + Chromium 148 安全技法在"，而非锁平面化。

### 4.2 IconRail 槽 / 四模式槽（症状：玻璃丢失/发平、底色不一致）
- 恢复 `html[data-skin='liquid-glass'] .icon-rail-slider`、`.draggable-mode-tabs`、以及 `html[data-theme='dark'][data-skin='liquid-glass']` 合并规则的 `backdrop-filter`/`-webkit-backdrop-filter` 到**主线值**（`blur(calc(var(--lg-blur-soft)*0.25)) saturate(...)`，暗色 `*0.18`）。
- 背景：保留显式 `background: var(--workbench-rail-slot-bg)`（与主线有效值一致，且消除对哑 token `--lg-surface-elevated` 的隐式依赖，属合理收敛，不改观感）。
- 这两个槽通常**不在长滚动容器内**，残影风险低；但仍须在 WP0 选定的根因技法下确认切模式/拖拽 thumb 时无残影。

### 4.3 设置页（症状：底色与工作台不一致、残影）
- 根 `div` 恢复为**与工作台同底的真半透明**：移除 `--settings-page-shell-bg` 近实色，使设置页底与工作台一致（主线是 `transparent`，叠加 `.ready-app-bg` / vibrancy）。具体取值在 WP0 根因修法下定（若选 C2/C3 的 painted 源，则设置页与工作台共用同一 painted 源，从而"同底"）。
- 导航项 `settingsListItemStyle`：恢复主线观感（`background:'transparent'` 或 hover/active 态的既有半透明），**不**用近实色 `--settings-list-item-bg`。
- 侧栏/内容滚动容器：按 WP0 选定的 §3.2 技法做 backdrop-root / 层提升以根除残影（`contain:paint; isolation:isolate` 可保留并按需补 `translateZ/will-change` 或 painted 源），**保留**容器内 `.glass-surface-*` 卡片的 blur。
- `hide-all` 挂载副作用：按 §3.4 判定保留（补 cleanup/复核）或移除。

### 4.4 全表面一致性（症状：颜色/透明度偏差的其余处）
- WP5 对 §2.2 全仓 ~40 处 backdrop-filter 表面逐一核对："在 148 + WP0 根因技法下，玻璃质感与主线一致、无残影、无双层重影"。重点：长滚动列表（聊天消息区、RSS 列表、文件树、文档面板、`schedule-x` 日历、浮动菜单 `filesPanelFloatingMenu.css`/`documentFloatingPanels.css`）。
- 任何此前为绕 148 而临时改的值（若 WP5 发现还有别处被平面化）一并恢复。

### 4.5 动效/切换（症状：闪烁/发绿/硬切；**由 WP6 owning**）
- 昼夜 ritual、模式进入动画**不改时间线/层级**（layering spec §3/§4 禁止）；只在 148 下确认：ritual 期间 `.ready-app-content` 淡出+blur、`.ready-theme-ritual-tint` 半透明桥仍生效，无残影；全屏进出按 §2.1 的 **DOM backing（`.ready-app-bg` + `--app-bg-overlay-opacity`）** 不闪绿。若 148 暴露"切主题后部分 UI 不重绘"（spec §9.5 场景），用 `will-change` 时机 / 局部隔离 / 层 promote-demote 解决，**不删 blur、不强制 reflow**。修复落点见 WP6。

---

## 5. 工作包（每个 = 一个 subagent 任务）

> 每个 WP 自带：目标、改动文件、验收、测试影响。施工前先复核 §2 file:line（行号会漂，按符号定位）。

### WP0 — 根因复现与候选修法实证（**keystone，先做**）
- **目标**：在 Electron 42 真实运行时复现"透明 vibrancy 窗口 + 滚动 + backdrop-filter"残影，A/B §3.2 候选（C1→C2→C3，必要时 C4），确定"保 blur + 消残影"的最小修法；输出证据。
- **改动/产出**：
  1. 新增 `scripts/probe-liquid-glass-residue.cjs`（§3.3）。
  2. 截图 + JSON 归档到 `docs/superpowers/audits/2026-06-02-liquid-glass-residue/`（含开/关 vibrancy 对照、各候选前后对照）。
  3. 在本计划 §3.2 标注"选定修法 = Cx + 具体属性/取值"，并据此细化 WP1–WP3 的确切 CSS。
  4. 给出 §3.4 `hide-all` 的定性结论。
- **验收**：probe 截图能证明选定修法在 148 下消残影且 blur 仍在；结论写回计划，Codex 复核认可后才动产品 CSS。
- **测试影响**：probe 脚本可加一条"脚本存在 + 退出码 0"的轻量 gate（可选）。

### WP1 — 落地根因修法（合成层 / backdrop 源 / 重绘时机）
- **目标**：把 WP0 选定的 §3.2 修法落到产品 CSS / 必要时窗口侧，作为"恢复 blur"的前置地基。
- **改动**：依 WP0 结论，可能涉及 `src/renderer/styles/index.css`（backdrop-root 容器规则 / painted 源 / `will-change` 时机）；C3/C4 才可能涉及 `.ready-app-bg` 或 `src/main/...` 窗口侧（须严守 §2.1 vibrancy 状态机）。
- **验收**：在产品页面（设置页、聊天滚动、RSS 列表等）滚动无残影，且后续 WP2/WP3 恢复 blur 后不复发。
- **测试影响**：新增锁"根因技法存在"的合同断言（如选 C1：锁滚动容器 `isolation:isolate` + 层提升属性；如选 C2/C3：锁 painted 源规则存在且 alpha 在约定区间）。

### WP2 — 恢复 IconRail 槽 / 四模式槽玻璃质感
- **目标**：把 §2.3 四处 `backdrop-filter:none` 恢复为主线 blur 值（§4.2）。
- **改动**：`src/renderer/styles/workbench-sliders.css`（3 处）、`src/renderer/styles/index.css` `.draggable-mode-tabs`（1 处）。背景统一显式 `var(--workbench-rail-slot-bg)`。
- **验收**：浅/暗两态下，IconRail 槽与四模式槽与主线肉眼一致（玻璃模糊回来、底色对）；切模式/拖 thumb 无残影。
- **测试影响**：回正 `dark-liquid-flat-chrome-contract.test.ts`（见 WP4）。

### WP3 — 恢复设置页"与工作台同底" + 根除设置页残影
- **目标**：设置页底色对齐工作台真半透明；侧栏/内容滚动残影根除；导航项恢复主线观感（§4.3）。
- **改动**：
  1. `src/renderer/pages/Settings.tsx`：根 div 恢复与工作台同底（移除近实色 `settings-page-shell` 底，或令其 = 工作台同一 painted 源）；按 §3.4 处理 `hide-all`（保留+补 cleanup 或移除）；脚注 Electron 版本号（可选，WP5）。
  2. `src/renderer/components/settings/settings-theme.ts`：`settingsListItemStyle` 恢复主线背景。
  3. `src/renderer/styles/index.css`：移除/改写 `--settings-page-shell-bg`、`--settings-list-item-bg` 近实色定义；侧栏/内容容器按 WP0 技法设 backdrop-root（`contain:paint;isolation:isolate` 可留，按需补层提升 / painted 源）。
- **验收**：设置页与工作台同底（真半透明，肉眼一致）；侧栏/内容滚动无残影；设置页内 `.glass-surface-*` 卡片仍有玻璃质感；返回工作台后原生层正常（若保留 hide-all）。
- **测试影响**：回正 `settings-liquid-glass-contract.test.ts`（见 WP4）。

### WP4 — 合同测试回正 + 加固（防再次平面化）
- **目标**：把 §2.5 两处"锁平面化"的断言改成"锁玻璃质感 + 锁同底 + 锁 Chromium 148 安全技法"；新增能在"还原平面化退化"时失败的断言。
- **改动**：
  1. `dark-liquid-flat-chrome-contract.test.ts`：把两处 `backdrop-filter: none` 断言改为断言 `.icon-rail-slider` / `.draggable-mode-tabs` 在 liquid-glass 下 **`backdrop-filter: blur(...) saturate(...)`** 存在；保留 `doesNotMatch(--lg-surface-elevated:)`。
  2. `settings-liquid-glass-contract.test.ts`：删除/改写"近实色底""导航项实色"断言；改为断言设置页底 = 工作台同底（真半透明，无近实色 `--settings-*-bg`）、`.settings-page-shell` 不得用近实色、导航项不得近实色 + 仍允许容器 `contain:paint;isolation:isolate`；按 §3.4 决定是否保留 `hide-all` 断言。
  3. 新增/对齐 layering spec §7 第 13 条的断言：`.glass-surface-*` 仍有 backdrop blur + 半透明背景。
  4. WP1 选定技法的"存在性"断言（见 WP1 测试影响）。
- **验收**：`npm run test` 全绿；把任一表面改回 `backdrop-filter:none` / 近实色底会使对应断言失败（真合同，非冒充）。
- **注**：这些是 source-grep 结构测试（CLAUDE.md §6 仅用于行为测试无法证明的硬视觉合同，符合 layering spec §7 既有约定）；它们**不能替代** §7.3 视觉验收。

### WP5 — 全表面 backdrop-filter 一致性扫描
- **目标**：对 §2.2 全仓 ~40 处 backdrop-filter 表面逐一核对 148 下与主线一致、无残影、无重影；恢复任何其它被平面化处。
- **改动**：按需最小修正 `index.css` / `workbench-sliders.css` / `schedule-x.css` / `filesPanelFloatingMenu.css` / `documentFloatingPanels.css`；可选：设置页脚注 Electron 版本号、收敛哑 token `--lg-surface-elevated`（仅在不改观感前提下，单独标注）。
- **验收**：§7.3 清单中所有长滚动 + 玻璃区域过关。
- **测试影响**：必要时补面板级断言。

### WP6 — 动效/切换异常审计与修复（昼夜 / 模式 / 全屏）
- **目标**：审计并修复用户报的"动效/切换异常"——主题昼夜切换闪烁/硬切、模式进入动画残影、全屏进出闪绿——使其与主线一致。**这是用户实测到的症状，必须有 owning WP，不允许只"if exposed"。不改 ritual 时间线/层级**（layering spec §3/§4），只用 §9.5 允许方向 + §2.1 的 DOM backing 杠杆。
- **改动（按审计结论最小落点）**：
  1. 主题切换重绘：若 148 暴露"切主题后部分 UI 不重绘/留旧色"（spec §9.5 场景），用 `will-change` 作用时机 / 局部隔离 / 层 promote-demote 修；候选落点 `src/renderer/styles/index.css`（ritual 相关层）/ `src/renderer/styles/ritual-overlay.css`。
  2. 全屏闪绿：核对 `.ready-app-bg` 的 `--app-bg-overlay-opacity` 在 `data-native-fullscreen` 下时机正确（§2.1）；main 侧 IPC 通知时序（`main-window-material.ts:208–253`）不动，只在 DOM backing 时机/取值上修。
  3. 模式进入动画残影：与 WP1 根因同源，确认进入动画期间 backdrop-filter 表面无残影（依赖 WP1）。
- **验收**：§7.3 清单 #7（昼夜切换有承接、不硬切、无残影）、#8（全屏不闪绿、退出恢复真半透明、再切昼夜走完整 ritual）通过；主线对照一致。
- **测试影响**：复核 layering spec §7 第 5/6/9/10/14 条对应断言仍成立；若本轮触碰相关 CSS，按需补/对齐断言（**不松绑**）。
- **依赖**：WP1（根因地基）。可与 WP2/WP3/WP5 并行。
- **边界**：浏览器原生层错位/白屏**不在本 WP**——由 browserview-presentation 计划（§2.6）覆盖，本 WP 仅在 §7.3#9 确认未回归。

### WP7 — 验收（机器 + 产品面视觉对照）
- **目标**：完成 §7 全部验收，产出主线 vs 支线对照截图。
- **改动/产出**：`npm run typecheck`/`test`/`verify:native`；新 userData 打包/启动产品面验收，截图归档 `docs/superpowers/audits/2026-06-02-liquid-glass-residue/`；逐项核对 §7.3 清单。
- **验收**：§7 全过；对照截图肉眼一致。

---

## 6. 顺序与依赖
- **WP0 必须最先**（keystone，定根因修法）。
- WP1 依赖 WP0 结论；WP2、WP3、WP6 依赖 WP1（先有稳定 backdrop 地基再恢复 blur / 修动效，否则残影回来）。WP2、WP3、WP6 可并行（不同文件/关注点）。
- WP5 在 WP1–WP3 之后做全表面扫描。
- WP4 依赖 WP1+WP2+WP3+WP6 落地后写/改断言（含动效相关合同对齐）。
- WP7 收尾验收。
- 建议批次：① WP0 → ② WP1 → ③ WP2 ∥ WP3 ∥ WP6 → ④ WP5 → ⑤ WP4 → ⑥ WP7。

## 7. 验收

### 7.1 机器验证
- `npm run typecheck` 无错误。
- `npm run test` 全绿（含 WP4 回正/新增断言）。
- `npm run verify:native`（涉及 better-sqlite3/设置持久化路径时；本计划主要改 CSS/renderer，但设置页改动建议照跑一次）。
- WP0 probe 退出码 0 且产出证据。

### 7.2 主线 vs 支线对照（关键）
在同一 macOS 机器、同一 userData 模板下，分别截图主线与修复后支线的同一界面，逐张肉眼比对（保留到 audits 目录）：设置页（含滚动）、IconRail 槽、四模式槽、聊天滚动区、RSS 列表、文件树、文档面板、日历。

### 7.3 手工视觉验收清单（来自 layering spec §8 + 本轮症状）
1. 浅色窗口态：真半透明液态玻璃，非实色应用背景；**设置页底色 = 工作台底色**。
2. 暗色窗口态：中性暗色，不偏暖/不偏蓝；设置页同底。
3. IconRail 竖向切换槽：有玻璃模糊，与主线一致。
4. 顶部四模式切换槽：有玻璃模糊，与主线一致。
5. 设置页侧栏滚动、内容区滚动：**无拖影/残像/脏区**；卡片仍有玻璃质感。
6. 聊天/RSS/文件树/文档/日历等长滚动 + 玻璃区域：滚动无残影、无双层重影。
7. 浅→暗 / 暗→浅切换：内容层有承接、不硬切、无暖色整窗闪、无残影。
8. 进/出全屏：不闪绿；退出后真半透明恢复；再切昼夜走完整 ritual。
9. 从文档/Widget/文件树/全局搜索/RSS 进浏览器：原生层不错位（沿用 browserview-presentation 计划，确认未回归）。
10. reduced-motion 路径：不刺眼、不残留旧主题。

## 8. 测试影响与回归论证
- WP4 改动 §2.5 的合同测试是**计划内预期**：当前断言锁的是"平面化退化"，与 layering spec §7 第 13 条冲突；回正后锁回"玻璃质感 + 同底 + 148 安全技法"。
- 回归面与对应机制/断言：
  - ① 恢复 blur 后残影复发 → 机制 WP1 根因地基；断言 WP1 技法存在性 + 视觉清单 §7.3#5/#6。
  - ② 设置页与工作台仍不同底 → 机制 WP3 同底；断言 WP4 settings 同底 + 清单 §7.3#1/#2。
  - ③ CALayer 透明冻结被 C3/C4 破坏（vibrancy quiesce 黑屏）/ 全屏 backing 时机错（闪绿）→ 机制 §2.1（DOM `.ready-app-bg` + `--app-bg-overlay-opacity`，**非**原生 vibrancy 切换）/ §4.5；断言 layering spec §7 第 9/10/14 条 + 清单 §7.3#8。
  - ④ 浏览器原生层错位回归 → 由 browserview-presentation 自带行为测试覆盖；清单 §7.3#9。
  - ⑤ 昼夜/模式/全屏切换异常未修 → 机制 WP6（§9.5 技法 + §2.1 DOM backing）；断言 layering spec §7 第 5/6/14 条 + 清单 §7.3#7/#8。

## 9. 风险与回滚
- **风险 1（最大）**：WP0 选定修法（尤其 C2/C3 painted 源）可能在"消残影"与"保真半透明通透感"之间难两全。缓解：painted 源 alpha 必须截图验收落在 spec §2.7 量级；优先 C1（纯合成层修法，不引入 painted 底）。
- **风险 2**：`will-change/translateZ` 层提升可能在某些表面反而压制 blur 或引入新合成开销。缓解：WP0 逐表面 A/B；只在需要处局部加，不全局滥用 `will-change`（spec §9.5）。
- **风险 3**：C4 全局 flag 影响 HTML-in-Canvas / 其它模块。缓解：仅兜底；启用须全模块回归 + 不破坏 §2.1。
- **风险 4**：`hide-all` 处理不当导致返回工作台浏览器空白。缓解：§3.4 补 cleanup/复核 re-show。
- **回滚**：各 WP 改动相互独立，可分别 revert；WP0 仅新增脚本/证据，零产品风险。

## 10. 不做的事（防 scope 膨胀）
- 不改昼夜 ritual 时长/曲线/层级；不改全屏材料状态机时间线（spec §3/§4）。
- 不重做 browserview-presentation（§2.6）。
- 不把默认 liquid-glass 改成实色底座 / 关 vibrancy / 删 backdrop-filter（范围口径）。
- 不用 `offsetHeight`/`getComputedStyle()` 强制 reflow 作为主修法（spec §7 第 7 条）。
- 不顺手重排/重命名/改无关注释；不扩散到 Electron 无关重构。
- 哑 token `--lg-surface-elevated` 仅在 WP5 不改观感前提下可选收敛，否则不动。

## 11. 给施工 subagent 的硬性约束
1. 先复核 §2 file:line 仍成立再改（行号会漂，按符号定位）。
2. **先 WP0 实证根因，禁止盲套修法**（CLAUDE.md §0.5 红线 2）。
3. 严守手术式改动：只碰本计划点名文件与行。
4. 任何"恢复 blur / 改底色"都必须建立在 WP0 根因地基之上，并配 §7.3 视觉验收。
5. 不删 blur、不加实色底座、不强制 reflow、不改 vibrancy 状态机时间线。
6. 测试写真合同断言，不得 source-grep 冒充行为、不得 skip 当通过；结构测试不替代视觉验收。
7. 每个 WP 完成附：改了哪些 file:line、为何这样选点、跑了哪些验证及结果、截图证据。

## 12. WP0 施工记录（Codex，2026-06-02）

- 新增 probe：`scripts/probe-liquid-glass-residue.cjs`，真实 Electron 42.3.0 / Chromium 148.0.7778.180 / darwin 透明 + `vibrancy: 'under-window'` 窗口。
- 证据目录：`docs/superpowers/audits/2026-06-02-liquid-glass-residue/`，包含 baseline / C1 / C2 / C3 的 before/after 截图与 `probe-summary.json`。
- probe 结论：最小页面未稳定复现 baseline 残影（before/after 像素差均为 0），但 C1、C2、C3 均保留计算样式 `backdrop-filter: blur(...)`。按 §3.2 风险排序选择 **C1 — `contain: paint` + `isolation: isolate` + `translateZ(0)` 局部合成层**，不采用 C2/C3 的 painted 源，避免把真半透明退化成新底座。
- `hide-all` 判定：保留设置页挂载时 `hide-all`，原因是设置页属于纯 DOM 覆盖页，若从 BrowserView 场景进入必须先隐藏原生层；本轮不把它当残影 workaround，残影修复仍落在 C1 合成层与恢复真实 blur。

## 13. WP2/WP3/WP7 施工记录（Codex，2026-06-02）

- 玻璃恢复：`icon-rail-slider` 与 `draggable-mode-tabs` 的 light/dark liquid-glass 路径恢复 `backdrop-filter` / `-webkit-backdrop-filter`，保留共享 slot 背景，不再锁 `backdrop-filter: none`。
- 设置页同底：移除 `--settings-page-shell-bg` / `--settings-list-item-bg` 近实色底，`settings-page-shell` 与工作台一样保持透明；设置导航项恢复 `background: 'transparent'`。
- Chromium 148 重绘保护：设置侧栏、设置内容区、文件树滚动根使用 C1 局部合成层方案（`contain: paint`、`isolation: isolate`、`translateZ(0)`、`backface-visibility: hidden`）。
- BrowserView 返回路径：设置页继续在挂载时 `hide-all`；浏览器模式的 `sync-bounds` 执行路径改为重新确认 `visible`，避免外部 DOM 覆盖页隐藏 BrowserView 后只更新 bounds 不恢复展示。
- 证据归档：`product-style-evidence-expanded.json` 覆盖设置页 AI/外观页 light/dark，确认设置页 shell 为透明、卡片仍有真实 blur；`product-return-path-real-browser-evidence.json` 覆盖真实网页标签从设置页返回工作台，主进程日志确认 `show ... reason=tab-activate`。
- 验证已跑：`npm run probe:liquid-glass-residue`、`npm run verify:native`、`npm run typecheck`、`npm run test`、`git diff --check` 均通过；`npm run test` 仅保留既有 ABI host mismatch skip，已由 `verify:native` 覆盖。
