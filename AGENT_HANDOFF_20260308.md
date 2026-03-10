# Ready Agent Handoff - 2026-03-08

## 当前仓库状态
- 分支：`main`
- 相对远端：`ahead 29`
- 本次交接文档更新前，工作区为干净状态；如果当前看到未提交改动，应仅来自本批文档更新
- 最近关键提交：
  - `d8e5909` `fix(rss): refresh selected source from live session state`
  - `ac64281` `fix(ui): make shell resize rails non-layout-affecting`
  - `34c958a` `feat(rss): expose refresh invocation and pin header rails`
  - `21dee4a` `fix(rss): unify selected-source refresh state`
  - `1d17f79` `fix(ui): tighten workbench rails and rss refresh feedback`
  - `b464fd2` `fix(rss): restore xiaohongshu capture and align workbench chrome`

## 当前已验证事实
- 最近一次有效校验：
  - `npm run typecheck:node` 通过
  - `npm run typecheck:web` 通过
  - `npm test` 通过，最近一次全量通过为 `173` 个测试
  - `npm run build` 通过
- 体积基线：
  - 仓库总大小：`2.7G`
  - `logs`：`1.0M`
  - `out`：`24M`
  - `dist`：`924M`
- RSS 数据库位置：`/Users/user/Library/Application Support/ready/ready.db`

## 当前主线结构
1. Agent/runtime
- run routing 以 `runId + scopeId` 为前提。
- `useAgent` 已拆成多模块结构，不再是单文件执行中心。

2. Browser services
- browser main-process 已拆成多类 services。
- renderer 侧 shell/layout/diagnostics entry 已分离。

3. Repositories
- browser/chat/rss/calendar/settings/agent 已具备 repository 基线。
- 旧 `database.ts` 直接耦合与告警已不是当前主路径。

4. Module handlers
- design/video/rss/calendar 的 agent handler 已从页面组件中抽离。

5. RSS diagnostics / browser acquisition
- `rss:last_fetch_invocation` 已暴露给 renderer。
- `rss:last_route_diagnostics` 已可持久化并用于区分触发问题与抓取问题。
- `Weibo / Xiaohongshu / Douyin` 的主方向是 app browser acquisition，不再优先靠平行浏览器或外部 cookie。

## 当前剩余问题
1. 小红书应用内真实刷新签收。
- 底层真实 Electron 抓取已经通过过，但应用内真实刷新链仍需最终签收。

2. 抖音账号内容一致性最终签收。
- 重点不是“能不能抓到”，而是结果必须确实来自账号作品区，而非推荐区。

3. 微博 session / Chromium 默认恢复路径。
- 目前是条件可用，不是开箱即稳。

4. 顶部三行和右侧动作边界对齐。
- 用户已经明确指出，要对齐的是 `Connected` 左边界和右侧动作按钮边界。
- 这是所有模块下都存在的 header rail 对齐问题，不是单个模式页问题。

5. Design inspector 高频缺口。
- 圆角、字号、字重、行高、对齐、常用版式仍需补齐。

## 下一位 agent 的执行顺序
1. 先做 RSS 实机签收。
2. 再做顶部三行视觉对齐。
3. 再做 design inspector 高频能力。
4. 再回到底座主线：browser orchestration、diagnostics lab、layered memory、Feishu replacement。

## 直接验收标准
### RSS
- 点击单源刷新后：
  - `rss:last_fetch_invocation`
  - `rss:last_route_diagnostics`
  - 最终列表结果
  三者必须一致。
- 小红书必须在应用内真实刷新链下出结果，而不是只在独立隐藏窗口复现里成功。
- 抖音最终列表必须确实来自账号作品区。
- 微博必须在 Chromium/session 正常时稳定恢复。

### UI
- 用户标记的左右边界在 browser/document/design/calendar 下都必须共线。
- 第一行保持紧凑，不再人为放宽。
- 第二行 tab rail 与第三行 toolbar rail 不能再靠模块局部 padding 各自漂移。

### Design
- inspector 中可操作：
  - 圆角
  - 字号
  - 字重
  - 行高
  - 对齐
  - 常用版式/基础布局控制

## 调试入口
- `rss:last_fetch_invocation`
- `rss:last_route_diagnostics`
- `runId + scopeId` routing 前提
- 应用内 browser acquisition 路线

这些是下一位 agent 的第一层调试入口，不应再从“猜哪里坏了”开始。

## 明确禁区
- 不要重新引入外部 cookie 方案作为小红书主路径。
- 不要把 Scrapling 升格为默认 RSS 主链。
- 不要重复做已经完成的 runtime/repository/browser-service 重构。
