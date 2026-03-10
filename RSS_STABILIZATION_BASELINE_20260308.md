# RSS Stabilization Baseline - 2026-03-08

## 当前架构基线
RSS 主链仍然保持为：
1. `native feed / simple scraper`
2. `lets-go-rss style scraper`
3. `RSSHub`
4. `browser-backed acquisition` 仅在确实需要时启用

`Scrapling` 仍然只是 benchmark-gated 候选 fallback，不在默认生产链路中。

## 已落地的 runtime 与打包收口
1. RSS 默认走真实 runtime，只有显式 `ENABLE_MOCK_RSS=true` 才进入 mock。
2. 内嵌 `rsshub-worker` 已进入主构建产物。
3. worker 查找与生命周期支持 bundled artifact、健康复用、端口扫描、显式 shutdown、runtime repair。
4. RSSHub 日志与运行目录已收紧，之前导致仓库异常膨胀的日志风暴不再是当前主路径。

## 已落地的诊断与交互收口
1. RSS diagnostics 已拆成：
- runtime state
- source capability state
- benchmark state
2. route diagnostics 可跨重启持久化。
3. benchmark 结果会落到 `rss-artifacts` 并自动恢复展示。
4. source capability UI 会显示：
- backend
- backendState
- failureKind
- chromiumRequired
- scraplingEligible
5. 手动刷新语义已固定：
- 选中 source => 刷新该 source
- 未选中 source => 刷新全部
6. RSS preview 关闭后不再留下 browser layer 覆盖 RSS pane。
7. `lastFetchInvocation` 已暴露到 diagnostics，用来区分“没触发刷新”和“触发了但抓取失败”。
8. browser-backed acquisition 已明确优先复用应用内浏览器路线。

## 当前稳定性分档
### 已可用
- Bilibili
- YouTube
- Vimeo
- Behance
- Twitter/X
- Zsxq

### 条件可用
- Weibo
  - 当前主方向是 browser-backed / Chromium-dependent。
  - 路线可行，但仍依赖 Chromium/session 供应稳定。
- Xiaohongshu
  - 主线已切到 app browser acquisition。
  - 提取脚本语法回归已修，真实 Electron `persist:browser` 会话下已验证可抓到结果。
  - 仍需在应用内真实刷新链完成最终签收。
- Douyin
  - 主线已切到 app browser acquisition。
  - 账号作品区 extractor 已在真实 Electron `persist:browser` 会话下验证过。
  - 仍需在应用内真实刷新链完成最终签收。

### 未稳定完成
- Weibo
  - 还没有把 Chromium/session 默认恢复路径做成“开箱即稳”的程度。
- Xiaohongshu
  - 仍需完成应用内真实刷新链签收，而不是只看底层隐藏窗口抓取成功。
  - 已明确禁止回退到外部 cookie 方案作为主路径。
- Douyin
  - browser-backed 已打通，但账号作品区 extractor 还需要最终硬化与实际 UI 刷新签收。
  - 已明确禁止再把 page-wide 推荐内容当成账号作品结果。

## 已落地的架构变化
1. RSS diagnostics 逻辑已集中到 `source-diagnostics.ts`。
2. Browser-backed acquisition 以应用内 browser/session 为准，不再引入平行浏览器 runtime 作为默认路径。
3. Xiaohongshu / Douyin 已不再静默接受 RSSHub fallback 结果作为主结果。
4. RSS runtime 与 benchmark 状态已在 renderer 中通过专门 diagnostics 组件承载。
5. Scrapling 只保留 sidecar contract 和 benchmark 候选身份。

## 仍然故意未做的内容
1. Scrapling 未接入生产默认链路。
2. Weibo / Xiaohongshu / Douyin 仍需平台专用收尾。
3. RSS diagnostics 仍属于应用内 diagnostics panel，而不是完整独立 lab。

## 重新并回主线前的判断
RSS 已经不是“需要重新摸底的脆弱模块”，而是一个可独立维护的子系统：
1. runtime 可观察
2. repair 已存在
3. source failure 已可分类
4. benchmark 已可持久化
5. browser-backed acquisition 已接入应用内 browser stack

下一步不该重做架构，而是把 Weibo / Xiaohongshu / Douyin 的最终质量收尾做完。
