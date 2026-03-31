# RSS Browser-First Ingestion Design

**Date:** 2026-03-31

## Goal

把微博、抖音、小红书的 RSS 更新链路从“带有 RSSHub 残留心智的混合抓取”收敛成“应用内浏览器主链”。修正后的目标效果是：

- 这三类来源统一优先复用 Ready 内置浏览器的页面与登录态
- RSSHub 不再参与这三类来源的刷新结果
- 当抓取失败时，界面给出更真实的原因，而不是继续暗示 RSSHub 问题
- 当失败原因是未登录或需要人工过验证时，RSS 面板能直接把对应账号主页拉到浏览器前台
- 诊断面板、添加源提示和刷新反馈都与新链路保持一致

## Current Structure

- RSS 主链路在 `src/main/modules/rss-engine/ipc-handler.ts`
- 浏览器抓取能力在 `src/main/modules/rss-engine/browser-acquisition.ts`
- 平台能力矩阵在 `src/main/modules/rss-engine/source-diagnostics.ts`
- 浏览器复用与后台抓取能力在 `src/main/modules/browser-engine/ipc-handler.ts`
- 预加载桥在 `src/preload/index.ts`
- RSS 页面与提示文案主要在：
  - `src/renderer/pages/modes/RSSMode.tsx`
  - `src/renderer/components/rss/AddSourceModal.tsx`
  - `src/renderer/components/rss/RSSSourceCapabilityMatrix.tsx`
  - `src/renderer/components/rss/RSSRuntimeDiagnostics.tsx`

当前微博、抖音、小红书已经能走浏览器抓取，但还存在三个不顺的地方：

1. 用户提示仍然写着“需要 RSSHub”
2. 失败后的引导不统一，无法直接带用户去浏览器处理登录或验证
3. 诊断矩阵里仍保留平台回退心智，导致产品感知和真实链路不完全一致

## Chosen Approach

采用“RSS 浏览器主链正式化 + 浏览器引导补齐 + 提示文案收口”的方式：

1. 微博、抖音、小红书的刷新与批量拉取，统一只走应用内浏览器抓取
2. 浏览器层新增“为 RSS 打开或复用目标账号主页”的能力
3. RSS 层在检测到登录、验证、空页面等失败状态时，返回结构化提示与建议动作
4. Renderer 在失败态下提供直接操作入口，把用户带到对应账号主页继续处理
5. 文档和诊断面板同步改成浏览器主链表述，不再显示“需要 RSSHub”

## Why This Approach

- 最符合当前真实能力边界：这三类平台已经有浏览器抓取基础，不需要重新造一套采集器
- 能直接复用应用内浏览器现有登录态与页面复用逻辑
- 不把 browser-agent 整体引入 RSS 定时刷新，避免引入过重流程
- 同时解决“抓不到”“看不懂为什么抓不到”“不知道下一步怎么办”这三层问题

## Interaction Details

### Source add and refresh semantics

- 添加微博、抖音、小红书来源时，不再提示“需要 RSSHub”
- 改为提示“需要应用内浏览器登录态”
- 单源刷新与批量刷新若返回：
  - 未登录：显示“去浏览器登录”
  - 遇到验证：显示“去浏览器继续验证”
  - 页面已打开但没有提取到内容：显示“去浏览器查看页面”

### Browser handoff

- 如果浏览器里已有同账号主页页签，优先复用该页签并切到前台
- 如果没有，则新建或导航到对应主页
- RSS 不直接替用户完成登录，只负责把问题页带到浏览器里，减少跳转成本

### Diagnostics semantics

- 微博、抖音、小红书的能力矩阵明确写成 browser-first
- 回退顺序移除 RSSHub
- 失败说明统一围绕登录态、验证、页面结构和浏览器抓取状态

## Browser-Agent Relationship

这次不让 browser-agent 接管 RSS 刷新执行。

browser-agent 继续负责复杂网页任务；RSS 只复用其中已经验证有效的思路：

- 目标页规范化
- 页面状态识别
- 页面进入正确运行阶段后的证据判断

也就是说，这次是“复用经验”，不是“复用整条执行器”。

## Component Boundaries

- `src/main/modules/rss-engine/source-diagnostics.ts`
  - 调整微博、抖音、小红书的能力矩阵与回退顺序
- `src/main/modules/rss-engine/scrapers/index.ts`
  - 收紧 `needsRSSHub()` 语义，移除这三类平台的 RSSHub 依赖
- `src/main/modules/rss-engine/ipc-handler.ts`
  - 去掉这三类平台的 RSSHub 预热与回退
  - 在刷新结果中返回更适合界面消费的浏览器引导信息
- `src/main/modules/browser-engine/ipc-handler.ts`
  - 新增“打开或复用某个抓取目标页”的能力
- `src/preload/index.ts`
  - 暴露新的浏览器桥接 API
- `src/renderer/types/electron.d.ts`
  - 增加 RSS 和 Browser 新返回字段
- `src/renderer/components/rss/AddSourceModal.tsx`
  - 更新平台提示文案
- `src/renderer/pages/modes/RSSMode.tsx`
  - 在刷新失败时提供浏览器引导动作
- `src/renderer/components/rss/RSSSourceCapabilityMatrix.tsx`
  - 更新能力矩阵展示
- `DOCUMENTATION.md`
- `PROGRESS.md`
- `CHANGELOG.md`

## Risks And Mitigations

- 风险：去掉 RSSHub 后，三类平台更依赖浏览器登录态
  - 处理：把失败引导做完整，减少“失败但不知道怎么办”的体验落差
- 风险：后台抓取和前台复用页面切换时互相干扰
  - 处理：继续沿用现有复用判定，只在用户主动点引导时切前台
- 风险：批量刷新时错误提示过于技术化
  - 处理：主进程先归一化失败原因，再由前端按简单文案展示

## Validation Plan

- 先补回归测试，锁定：
  - 这三类平台不再被视为 RSSHub 必需来源
  - 刷新失败时会返回浏览器引导信息
  - 浏览器能够为 RSS 复用或打开对应主页
- 运行 RSS 定向测试与类型检查
- 手动验证：
  - 添加微博/抖音/小红书来源时提示已变更
  - 刷新成功时不再带出 RSSHub 语义
  - 登录失效时能直接跳到浏览器对应页面
