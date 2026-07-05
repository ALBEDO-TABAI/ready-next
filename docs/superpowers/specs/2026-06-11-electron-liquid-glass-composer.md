# Electron 液态玻璃聊天输入框规格

> 日期：2026-06-11
> 范围：Ready 右侧聊天输入框的液态玻璃效果、实时背景投影、消息底部留白、后续迁移约束。
> 状态：已落地为当前 dev 方案；未来继续增强时先读本文件。

## 1. 目标

聊天输入框需要像一块压在聊天记录上的半透明玻璃：

- 背后的聊天文字穿过输入框时应变成柔和雾化内容，不应直接清晰透显。
- 输入框边缘应有轻微折射和厚度感。
- 背后内容滚动时，玻璃里的内容也必须实时变化，不能像贴了一张静态模糊截图。
- 输入框后面不允许出现外部暗色阴影。
- 用户把聊天记录滚到底部时，最后一条内容不能被输入框压住。

## 2. 现有架构

### 2.1 组件分工

- `src/renderer/components/agent/ChatPanel.tsx`
  聊天面板总协调入口。
- `src/renderer/components/agent/chat-panel/ChatPanelBody.tsx`
  输入框浮层的布局 owner。它测量输入框浮层高度，并把高度传给消息列表作为底部留白。
- `src/renderer/components/agent/ChatMessages.tsx`
  聊天记录滚动容器。它渲染 `data-chat-bottom-overlay-spacer="true"`，保证最后一条消息可以滚到输入框上方。
- `src/renderer/components/agent/ChatInput.tsx`
  生产输入框本体。它挂载 `LiquidLens`，并创建聊天记录的实时投影层。
- `src/renderer/components/ui/liquid-glass/LiquidLens.tsx`
  可复用液态玻璃镜片。它把折射位移图接到 SVG filter 与 `backdrop-filter`。
- `src/renderer/components/ui/liquid-glass/refraction-map.ts`
  纯数学位移图生成器。不要在这里放 DOM 逻辑。
- `src/renderer/LiquidTest.tsx`
  `#/liquid-test` 调参台，只负责找方向，最终效果必须回 dev 验证。

### 2.2 渲染链路

1. `ChatMessages` 提供真实滚动内容，并标记为 `data-liquid-scroll-root="chat-messages"`。
2. `ChatInput` 内的 `ChatComposerBackdropProjection` 克隆这块滚动内容，放进输入框内部投影层。
3. 原始 `ChatMessages` 在输入框覆盖范围内被 mask 挖洞，避免清晰文字和投影文字叠在一起。
4. `LiquidLens` 生成折射位移图，把投影层和 live backdrop 都经过同一套折射。
5. CSS 只负责白纱、边缘高光、投影层雾化，不负责主折射逻辑。

## 3. 当前参数

生产输入框当前参数在 `ChatInput.tsx`：

- `radius={18}`
- `bevel={22}`
- `depth={37}`
- `ior={1.34}`
- `dome={5}`
- `profile="squircle"`（2026-07-06：超椭圆-4 边缘滚落，折弯集中最外缘；回退='circular'）
- `strength={6.4}`
- `blur={3.5}`
- `frost={0}`
- `blurBeforeRefraction`
- `saturation={1.18}`
- `brightness={1.05}`
- `contrast={0.84}`
- `aberration={0}`
- `engine="backdrop"`

这些数值是“能用的当前平衡”，不是物理真值。继续调参时要以真实 dev 截图为准。

## 4. 已知限制

- 在透明 macOS vibrancy 窗口里，`backdrop-filter: blur(...)` 的大半径雾化很弱，不能只靠它得到预览页里的朦胧感。
- SVG filter 的属性原地修改不一定触发 Chromium 重绘，所以 `LiquidLens` 会把图相关参数编进 filter id，强制换 id 重绑。
- 额外镜像侧边反射层会让输入框像冻结截图，不要作为主路线恢复。
- `#/liquid-test` 与真实 dev 不共享全部合成上下文；它只能证明参数方向，不能证明产品效果。

## 5. 不可破规则

- 不要给输入框加外部暗色阴影。
- 不要把输入框改成不透明白底来遮重影。
- 不要让原始聊天文字在输入框下方直接可见。
- 不要用静态截图、静态纹理或固定镜像层冒充实时背景。
- 不要把消息列表底部留白写死成一个随手 padding；输入框浮层高度会随附件、提示条、输入状态变化。

## 6. 后续改进方向

优先顺序：

1. ~~继续改 `refraction-map.ts` 的边缘位移曲线，让左右弧边出现更自然的压弯感。~~
   **已落地（2026-07-06）**：`profile: 'circular' | 'squircle'` 曲线族——squircle 为
   超椭圆-4 滚落 `H = depth·(1−(1−t)⁴)^¼`（斜率闭式与 glass.outpacestudios.com 的
   物理模型同型），生产输入框已切 squircle，`#/liquid-test` 有「边缘曲线」切换可 A/B。
   贴图物理性质由 liquid-glass-refraction-map.test.ts 曲线族用例钉死（rim 集中/内侧
   回平/默认曲线逐字节零漂移）。
1b. **色散（aberration）定案不启用**：参考案例的 chromatic fringe 依赖不透明背景；
   本输入框在半透明 vibrancy 之上，分通道重组无法保持预乘 alpha，>0 即亮度塌到
   ~1/3（LiquidLens 注释在案）。仅 `#/liquid-test` 可玩；若未来出现不透明背板的
   玻璃面（如实心玻璃变体上的浮层），可在那里评估。
2. 保持单一实时投影层，不新增边缘镜像 DOM 层。
3. 如果需要 Swift 原生那种“贴弧边反射”，先在位移图里做采样方向实验，而不是叠一个视觉贴片。
4. 如果后续 Electron/Chromium 修复了透明窗口 blur 限制，可以重新评估是否减少投影层 blur/filter 负担。

## 7. 验收

每次修改后至少验证：

- `npm run typecheck`
- `npx tsx --test src/__tests__/input-slot-inset-contract.test.ts src/__tests__/liquid-glass-refraction-map.test.ts src/__tests__/rss-agent-workbench-regressions.test.ts`
- `git diff --check`
- 真实 Electron dev 截图：把聊天文字滚到输入框后方，确认内容实时变化、没有清晰透显、没有冻结感、没有暗色外阴影。

## 8. 迁移提示

移植到别的 Electron 项目时，先确认三件事：

1. 目标窗口是否也是透明 / vibrancy / mica 路径。
2. 目标输入框是否覆盖在滚动内容上。如果是，必须同步实现“原内容挖洞 + 输入框内部投影”。
3. 目标 Chromium 版本对 `backdrop-filter: url(#svgFilter)` 与 `blur(...)` 的支持是否和 Ready 当前版本一致。

如果目标不是透明窗口，可能不需要投影层；如果目标是透明窗口，直接照搬 CSS blur 很可能复现重影。
