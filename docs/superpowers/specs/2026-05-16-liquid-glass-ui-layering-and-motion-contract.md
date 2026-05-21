# Ready 真半透明液态玻璃 UI 层级与动效规格

> 更新时间：2026-05-16
> 范围：主工作台壳层、液态玻璃皮肤、昼夜切换 ritual、全屏切换期间的窗口材料处理。
> 目的：后续修全屏闪绿、昼夜切换异常时，必须保住现有好的视觉体验，不能再用“实色底座”把真半透明效果替换掉。

---

## 0. 本轮完成标准

在继续任何视觉实现改动前，必须先满足这些标准：

1. 已能说清楚 UI 从上到下每一层负责什么，尤其是 DOM 层、BrowserView 原生层、BrowserWindow 原生材料层的边界。
2. 已把“默认真半透明液态玻璃”和“Ready 自持实色 / 渐变底座”定义成两种不同风格，不能混用选择器或共享状态导致默认体验被偷换。
3. 昼夜切换必须继续有完整承接：内容层淡出 / 模糊、半透明 tint 承接、背景层和图标协同，而不是只剩图标动画加 UI 硬切。
4. 暗色稳定态必须保持当前中性暗色观感，不能被暖米色、深蓝底座或任意新底色替换。
5. 全屏修复只能处理全屏边界的材料污染和采样问题，不能顺手重写主题 ritual、玻璃材质 token、暗色基调。
6. 每一个视觉改动都要有合同测试或截图验收点；如果测试只能覆盖文本合同，仍需保留手工视觉验收清单。

### 0.1 已核实的勘误

当前主工作区里同时存在两组暗色：

- 基础暗色 token：`--bg-primary: #1A1B1E`、`--bg-panel: #202124`、`--bg-content: #1E1F22`。这组是“中性灰黑”的主要参照。
- `liquid-glass` 暗色 token：`--bg-primary: #171D29`、`--bg-panel: #1B2230`、`--bg-content: #141C29`，以及 `--lg-material-panel: rgba(25, 36, 56, 0.30)` 等。这组带蓝调，不能在 spec 里直接称为“中性暗色目标”。

因此后续恢复暗色观感时，不能只看 `liquid-glass` 分支当前值是否存在；必须以用户看到的中性暗色观感为准，优先对齐基础暗色 token 的灰黑基调。`#171D29 / #1B2230 / #141C29` 只能作为当前实现线索，不是免审的目标值。

当前主工作区的 `#DEE1E4 / #282D33` 是 fullscreen backing 候选值。它们可以作为“全屏期间中性兜底色”的合同，但不能被解释成默认窗口态底色，也不能扩散成暗色稳定态底色。

---

## 1. 产品层面的不可变要求

### 1.1 默认风格是真半透明液态玻璃

默认 `liquid-glass` 不是“半透明颜色块叠在实色背景上”，而是：

- 主窗口在稳定窗口态允许 macOS 原生半透明 / vibrancy 参与；
- DOM 面板用半透明材质、blur、边框高光和阴影维持可读性；
- 桌面或底层内容可以影响玻璃质感，但不能在全屏动画中失控染色；
- Ready 自己的渐变 / 实色底只能作为 ritual、全屏兜底或可选独立风格，不能替代默认真半透明。

### 1.2 “实色渐变底座”只能是独立风格

如果保留上一轮那种 Ready 自己持有稳定渐变底的方案，它只能作为单独设置项，例如“稳定玻璃 / Ready 背景玻璃”。它必须满足：

- 默认不开启；
- 独立存储、独立 UI 文案、独立 data attribute；
- 不改变 `liquid-glass` 默认窗口态的透明材料路径；
- 不复用会误伤默认风格的通用选择器；
- 用户切回默认风格后，macOS 真半透明窗口态完整恢复。

---

## 2. 当前 UI 的层级合同

下面按从上到下的顺序描述。后续改动必须先说明自己改的是哪一层。

### 2.1 BrowserView 原生层

BrowserView 不在 DOM 树里，不能靠 `z-index` 盖住。

职责：

- 承载 Ready 内部浏览器页面、真实网页、blank tab；
- 在 ritual 或需要 DOM 遮罩的场景里，必须通过已有 BrowserView mask / overlay lock 隐藏，而不是指望 DOM 层覆盖它；
- 全屏或主题切换修复如果只影响 DOM，必须额外验证 BrowserView 区域没有独立发绿、残留旧主题或提前露出。

不得：

- 用 CSS 层级假装能覆盖 BrowserView；
- 为了修普通 DOM 问题改 BrowserView 核心显示策略；
- 在没有明确复现 BrowserView 独立问题前，引入新的全屏过渡期 BrowserView 状态机。

### 2.2 `.ready-app-content` 工作台内容层

这是用户看到的实际应用 UI：侧栏、顶部栏、浏览器外壳、chat panel、输入区等。

职责：

- 稳定态完整显示当前主题；
- 主题 ritual 期间允许淡出和轻微模糊，让底层承接色和图标演出成为主视觉；
- ritual 期间其后代组件的普通颜色 transition 应被暂停，避免遮罩结束后局部控件还在慢慢变色。

不得：

- 在昼夜切换中保持完全可见并直接切色，这会造成“硬切”；
- 删除内容层淡出 / 模糊后不提供等价遮挡方案；
- 把内容层整体变成实色底座。

### 2.3 `.ready-theme-ritual-tint` 主题承接层

这是昼夜切换期间的色彩桥，不是永久背景。

职责：

- 在 entering 阶段给旧主题一个柔和罩层；
- 在 holding 阶段给目标主题一个可感知但不过度的承接；
- 在 leaving 阶段和内容层一起退场；
- 使用半透明 `color-mix(... transparent)` 类型的设计，而不是全屏不透明盖板。

不得：

- 变成 100% 不透明的整窗实色；
- 把浅色暖米色在不该出现的时候铺满整窗，造成短暂暖色闪；
- 只留下图标动画而失去背景承接。

### 2.4 `.ready-app-bg` 玻璃背景 / 仪式背景层

这是 Ready 自己的背景素材层，包含 light / dark 两套渐变和径向高光。

职责：

- 为 ritual、开发实验页、可选稳定底座风格或某些兜底场景提供 Ready 自己的背景素材；
- light / dark 两套背景可以跟随 `data-theme` 交叉；
- 不能被误用成默认真半透明窗口态的永久替代品。

不得：

- 在默认 `liquid-glass` 窗口态强行把原生半透明完全盖住；
- 随意调大 opacity 来掩盖 macOS vibrancy 问题；
- 在超宽全屏下顺手调整径向高光尺寸，除非本轮目标就是视觉优化。

### 2.5 `html/body/#root/.ready-app-shell` 壳层

壳层负责建立布局与隔离，不负责制造最终视觉底色。

职责：

- 在默认 `liquid-glass` 下保持透明壳层；
- 让上面的内容层、承接层和背景层按正确 z-index 工作；
- 只在明确的 fullscreen backing 或降级路径里出现兜底色。

不得：

- 用 `.ready-app-shell { background: ... !important }` 长期覆盖默认窗口态；
- 把 fullscreen backing 的规则泄漏到普通窗口态；
- 让 `data-native-fullscreen`、`data-glass-backdrop` 一类状态互相重叠到不可判断。

### 2.6 BrowserWindow 原生材料层

这是 Electron / macOS / Windows 层。

职责：

- macOS 默认窗口态保留真半透明材料；
- Windows 可继续保留 mica，因为它和 macOS `under-window` 不是同一种采样路径；
- 全屏切换前后可以短暂改变原生材料或背景兜底，目的是防止采样桌面壁纸产生绿色污染；
- 全屏结束后必须回到默认窗口态材料。

不得：

- 把主窗口永久改成不透明底色来解决默认液态玻璃问题；
- 把 macOS fullscreen 修复扩大成三平台统一实色风格；
- 删除 macOS traffic light 位置、Windows mica 这类无关平台适配。

### 2.7 `.glass-surface-*` 玻璃面板层

`.glass-surface-panel`、`.glass-surface-card`、`.glass-surface-floating` 是用户最直接感知“玻璃质感”的层。它们不是普通背景色，而是半透明材质、backdrop blur、saturate、边框高光共同形成的表面。

职责：

- 面板、卡片、浮层必须继续使用 backdrop-filter，不得退化成纯色块；
- 主玻璃 surface 的 blur 应保持在当前量级：常规面板 / 卡片不得低于 `12px`，主要 panel 目标仍是 `20px` 以上；
- `.glass-surface-*` 的 saturate 应保持在有玻璃质感但不过度染色的范围，默认目标为 `120% - 165%`；个别浏览器 header / tabs 为了中性 chrome 使用 `saturate(0%)` 时，必须只作用于这些专门 surface，不能外溢到所有玻璃面板；
- `.glass-surface-*` 的 selector 级 `color-mix(... transparent)` 比例应保持在现有量级，主面板 / 卡片通常为 `55% - 65%`，内容面板可更轻但应有明确用途；
- 暗色模式下玻璃面板必须保持中性暗色观感。若使用 `--lg-material-*` 这类带蓝调的 rgba token，必须通过截图和合同测试确认没有把整体暗色染蓝。

不得：

- 为了遮住桌面采样，把 `.glass-surface-*` 改成不透明色；
- 只调大蓝色 material token 来制造“高级感”；
- 在 dark mode 下用明显蓝调的 `--lg-material-panel/card` 直接覆盖所有 panel，却没有视觉验收；
- 用降低 blur / 降低 alpha 的方式绕开全屏闪绿问题。

---

## 3. 昼夜切换动效合同

当前昼夜切换不是普通 CSS 颜色过渡，而是 ritual。

### 3.1 正确体验

一次手动昼夜切换应当像这样发生：

1. 用户点击图标。
2. 内容层快速淡出并变模糊，避免用户直接看到 UI 硬切。
3. 半透明 tint 和背景层接住旧主题到新主题的色彩变化。
4. `data-theme` 在 holding 阶段切换，此时真实 UI 改色被遮住。
5. 图标完成日 / 月切换。
6. tint 和内容层一起缓慢退场，新主题 UI 稳定出现。

### 3.2 必须保持的细节

- `data-theme` 仍应在 holding 阶段翻转，不能在点击瞬间裸切。
- 内容层应有淡出 / 模糊或等价遮挡，不能只让图标动。
- tint 是半透明桥，不是不透明盖板。
- leaving 阶段不能中途突然露出目标主题，内容恢复要跟遮罩退场同步。
- 后代组件在 ritual 期间不应继续各自慢慢 transition。
- reduced motion 可以降级，但也不能出现刺眼硬闪。
- 正常动效下，内容层在 entering / holding 阶段必须有足够遮挡强度：effective opacity 应不高于 `0.10`，blur 应不低于 `12px`；当前目标量级是 opacity `0.04 - 0.06`、blur `18px`。
- 正常动效下，tint 在 entering / holding 阶段应保持半透明桥接：有效 alpha 目标区间为 `15% - 35%`。低于 `15%` 容易撑不住色温桥，高于 `35%` 会接近不透明盖板。

### 3.3 颜色边界

- `--workbench-mode-bg-light: #F6F1E7` 是浅色 ritual / workbench 承接色，不等于所有窗口背景都应该永久变成暖米。
- `--workbench-mode-bg-dark: #192131` 是暗色 ritual / workbench 承接色，不等于可以把暗色稳定态整体换成更蓝的底座。
- 暗色稳定态以当前中性灰黑观感为准，基础参照是 `--bg-primary: #1A1B1E`、`--bg-panel: #202124`、`--bg-content: #1E1F22`。`liquid-glass` 分支里的 `#171D29 / #1B2230 / #141C29` 带蓝调，不能单独作为“中性暗色已满足”的证据。
- 暗色 `.ready-app-bg` 渐变、`--lg-material-*`、`--workbench-liquid-chrome-bg` 这几组会共同影响暗色观感；任何一组变蓝，用户看到的暗色都会变蓝。
- 全屏兜底色如果沿用当前合同，应保持浅色 `#DEE1E4`、暗色 `#282D33` 这类中性 fullscreen backing，而不是暖米 / 深蓝主窗口底色。

### 3.4 明确禁止的修法

- 用 `offsetHeight` / 强制 reflow 作为主修复手段，而不解释层级根因。
- 直接删除 `.ready-app-content` 的 ritual 淡出 / blur。
- 把 `.ready-theme-ritual-tint` 改成不透明 source / target 色。
- 为了解决全屏问题改掉昼夜切换的时间线。
- 在 `theme:set` 时提前改变原生窗口底色，导致 renderer ritual 还没遮住就先闪色。

---

## 4. 全屏切换合同

### 4.1 要解决的问题

全屏问题属于窗口材料边界问题，不是主题设计问题。

目标：

- 窗口进入全屏时不采到桌面湖水 / 壁纸导致玻璃面板发绿；
- 全屏退出后默认窗口态的真半透明质感恢复；
- 退出全屏后再切昼夜模式，仍然完整走 ritual；
- BrowserView 区域和 DOM chrome 同步，不出现单独发绿或旧主题残留。

### 4.2 正确修复边界

优先在 main 进程处理：

- fullscreen preflight / enter / leave 期间管理 macOS 原生材料；
- 必要时短暂关闭 `under-window` 或使用中性 fullscreen backing；
- 退出后重建窗口态材料；
- 只把“窗口正在全屏过渡”作为很窄的状态暴露给 renderer，且仅在需要遮挡 BrowserView 时使用。

不得：

- 把默认窗口态永久切到实色背景；
- 修改昼夜 ritual 的视觉层级；
- 把全屏 backing 变成新的全局背景 token；
- 为未来可能的问题预先加复杂状态机。

### 4.3 macOS 材料状态机

全屏修复必须按状态机处理，而不是在任意时机随手 `setVibrancy` / `setBackgroundColor`。

| 状态 | macOS 材料 | `backgroundColor` | 进入条件 | 退出条件 |
|---|---|---|---|---|
| Windowed 稳定态 | `setVibrancy('under-window')` | `#00000000` | 默认窗口态 | `will-enter-full-screen` |
| EnteringFullscreen | `setVibrancy(null)` | 中性 fullscreen backing：浅色 `#DEE1E4` / 暗色 `#282D33` | `will-enter-full-screen` | `enter-full-screen` |
| Fullscreen 稳定态 | `setVibrancy(null)` | 中性 fullscreen backing | `enter-full-screen` | `will-leave-full-screen` |
| LeavingFullscreen | `setVibrancy(null)` | 中性 fullscreen backing | `will-leave-full-screen` | `leave-full-screen` |
| WindowedRebuilding | 先保持 `null`，下一 tick 或短延时后重建 `under-window` | 先恢复 `#00000000` | `leave-full-screen` | 材料重建完成 |
| Windowed 稳定态 | `setVibrancy('under-window')` | `#00000000` | 材料重建完成 | 下一次全屏 |

要求：

- Windowed 稳定态必须回到透明 + `under-window`，否则默认真半透明体验已经被破坏；
- Fullscreen 稳定态不得把背景切回透明，否则全屏 Space 或 OS 动画期间仍可能采样异常；
- `theme:set` 可以刷新窗口材料，但不能打破上表状态；
- 如果 renderer 需要 `data-native-fullscreen`，它只能表达 fullscreen / transition backing 状态，不能长期影响普通窗口态。

---

## 5. 设置项合同

如果要提供“实色 / Ready 背景玻璃”风格，设置项必须这样定义：

| 风格 | 默认 | 视觉来源 | 适用目标 |
|---|---:|---|---|
| 真半透明液态玻璃 | 是 | macOS 原生半透明 + DOM 半透明材质 | 当前主体验 |
| 稳定背景玻璃 | 否 | Ready 自己的渐变 / 中性底色 + DOM 半透明材质 | 给不想透出桌面的用户 |

要求：

- 设置文案要让用户明白两者差异；
- 切换风格不能改变当前主题；
- 切换风格不能触发昼夜 ritual；
- 默认风格不能被新风格的 CSS 变量污染；
- 合同测试要断言默认值仍是真半透明液态玻璃。

---

## 6. 推荐的代码归属

为了避免继续“拆东墙补西墙”，后续可以按职责收拢，但每一步都必须小改、可验证。

### 6.1 Main 进程

建议把主窗口材料逻辑从 `src/main/index.ts` 拆到独立模块，例如：

- `src/main/modules/window-material/main-window-material.ts`

它只负责：

- 读取当前主题 / 皮肤快照；
- 设置 BrowserWindow 背景色；
- 设置 macOS vibrancy；
- 设置 Windows mica；
- 处理 fullscreen preflight / enter / leave；
- 广播必要的窗口材料状态。

它不负责：

- renderer theme ritual；
- DOM 背景层；
- BrowserView 显示策略。

### 6.2 Renderer 主题控制

`src/renderer/stores/useTheme.ts` 只负责主题状态和 ritual 时机：

- 用户手动切换主题；
- system 主题解析；
- holding 阶段翻 `data-theme`；
- 和 main 同步主题选择。

它不应该负责：

- 主窗口 fullscreen 材料细节；
- 皮肤风格之外的窗口原生效果细节；
- 通过强制 reflow 治疗 compositor 问题。

### 6.3 CSS 层

建议长期拆分成更清晰的职责文件：

- `index.css`：全局 token 和基础布局；
- `liquid-glass.css`：液态玻璃材质 token、面板材质、背景素材；
- `ritual-overlay.css`：mode/theme ritual；
- `window-state.css`：仅 fullscreen / native-window-state 兜底。

拆分不是本轮必须，但以后如果继续修这类问题，最好先拆合同再拆文件。

---

## 7. 合同测试要求

后续修复必须覆盖这些文本合同：

1. 默认 liquid-glass 不得永久使用 Ready 自己的不透明主窗口背景。
2. macOS traffic light 位置保留。
3. Windows mica 保留。
4. 真半透明默认风格和稳定背景玻璃风格必须是两个明确值。
5. `.ready-app-content` 在 theme ritual 期间仍有遮挡行为。
6. `.ready-theme-ritual-tint` entering / holding 仍是半透明桥，不是不透明盖板。
7. 产品代码 main path 不得依赖 `offsetHeight` / `getComputedStyle()` 强制 layout flush 作为主修复手段；测试 helper 不在此限。
8. `data-theme` 翻转仍在 ritual holding 阶段。
9. fullscreen backing 只作用于 fullscreen / preflight 状态。
10. `data-native-fullscreen` / `data-glass-backdrop` 等窗口状态不能互相污染默认窗口态。
11. 内容层 entering / holding 阶段 opacity 不得高于 `0.10`，blur 不得低于 `12px`，除非同一 PR 提供等价遮挡设计和视觉验收。
12. tint entering / holding 阶段必须保持 `15% - 35%` 的半透明桥接范围，不得变成不透明盖板。
13. `.glass-surface-*` 必须继续有 backdrop blur、半透明背景和暗色中性观感约束。
14. macOS fullscreen 材料必须按 §4.3 状态机验证，不得只断言某个事件里调用过 `setVibrancy`。

合同测试不能替代视觉验收，但必须防止明显错误方案再次进入代码。

---

## 8. 手工视觉验收清单

每次动这块都必须手工验收：

1. 浅色窗口态：仍是真半透明液态玻璃，不是实色应用背景。
2. 暗色窗口态：仍是当前中性暗色，不偏暖、不变成新深蓝底。
3. 浅色切暗色：内容层不硬切，有完整承接，不出现短暂暖色整窗闪。
4. 暗色切浅色：内容层不硬切，退场节奏自然。
5. 窗口进全屏：不出现绿色 / 湖水色闪烁。
6. 全屏退窗口：真半透明质感恢复。
7. 退窗口后再切昼夜：侧栏、chat panel、浏览器外壳、输入区一起完整变化。
8. Ready blank tab 和真实网页都要测。
9. reduced motion 路径不刺眼、不残留旧主题。
10. Settings 里如果新增风格切换，切回默认后必须恢复真半透明。

---

## 9. 下一步修复顺序

建议按这个顺序重新开始，不要一次改三层：

1. 先把当前 worktree 里上一轮残留的“稳定背景玻璃”状态梳理出来，决定是删掉还是隔离成设置项。
2. 恢复并锁住默认 `liquid-glass` 的视觉合同：真半透明、原 ritual、暗色中性。
3. 只修 main 进程 fullscreen 材料边界：进入全屏前防采样污染，退出后恢复窗口态材料。
4. 只在确认 BrowserView 仍有独立问题时，给 fullscreen 过渡增加 BrowserView mask。
5. 如果窗口态直接点击主题切换仍出现“部分 UI 变色”，这是 theme ritual / compositor 层缓存问题，不要归到 fullscreen。允许的方向是调整 `will-change` 作用时机、局部隔离或促使层在 ritual 前后正确 promote / demote；不允许删除 filter blur、删除内容层淡出或用 `offsetHeight` 作为主修复。
6. 如果只有全屏退出后切主题异常，才归到 §4 的 vibrancy / fullscreen 材料生命周期处理，不与第 5 步混用修法。

---

## 10. 这次教训固化

上一轮“全局实色 / Ready 渐变底座”能消掉绿色闪烁，是因为它切断了桌面采样，但它也同时切断了产品真正想要的半透明液态玻璃。这个方案可以成为一个独立视觉风格，但不能作为默认修复。

正确方向不是“把透明关掉”，而是：

- 默认窗口态继续透明；
- 全屏动画期间临时管住原生材料；
- 退出后重建材料；
- 昼夜切换 ritual 保持原有层级和节奏；
- 用合同测试防止以后再把体验层改塌。
