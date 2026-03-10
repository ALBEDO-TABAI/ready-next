# RSS Source Connectivity Report - 2026-03-08

## 范围说明
- creator-watchlist 源已写入 `~/Library/Application Support/ready/ready.db`。
- 当前报告反映的是交接时刻的代码与诊断真值，不再使用最早那轮 probe-only 结论。
- 用户曾手动清空过 RSS 数据；之后部分“点击刷新但无结果”的现象并不全是抓取失败，也包含刷新调用未真正触发到主进程的情况。下一位 agent 不应把这两类问题混为一谈。

## 平台摘要
| 平台 | 当前状态 | 当前 backend 方向 | 当前说明 |
| --- | --- | --- | --- |
| Bilibili | 已可用 | native / lets-go-rss style fallback | 当前栈足够 |
| YouTube | 已可用 | native | 当前栈足够 |
| Vimeo | 已可用 | native | 当前栈足够 |
| Behance | 已可用 | native | 当前栈足够 |
| Twitter/X | 已可用 | native / syndication | 当前栈足够 |
| Zsxq | 已可用 | native / API | 当前栈足够 |
| Weibo | 条件可用 | browser-backed / Chromium dependent | 保留当前路线，继续做 session 稳定化 |
| Xiaohongshu | 条件可用 | app-browser-backed acquisition | 真实 Electron 会话抓取已验证，仍需应用内真实刷新签收 |
| Douyin | 条件可用 | app-browser-backed acquisition | 账号作品区 extractor 已验证，仍需应用内真实刷新签收 |

## Creator-watchlist 当前真值
### 已可用
- 某幻君
- 罗永浩的十字路口
- 影视飓风
- Matthew Encina
- XK studio
- OFFF Festival
- Yokohara Hirokazu
- 歸藏(guizang.ai)
- 「美妆内行人」资料空间站

### 条件可用或未最终签收
- 歸藏的AI工具箱
  - 当前路线可用，但前提是 browser/Chromium session 健康。
- UmeDesign_wanying
  - 真实 Electron `persist:browser` 会话中已抓到结果。
  - 仍需在应用内真实刷新链签收。
- DiDi_OK
- Nio尼奥
  - 共享 extractor 路线不再被语法错误阻塞。
  - 仍需应用内真实刷新链签收。
- Kou悠悠
  - 真实 Electron `persist:browser` 会话中，账号作品区已抓到正确方向的结果。
  - 仍需应用内真实刷新链签收。

## 三个平台的交接重点
### Weibo
- 当前 backend：browser-backed / Chromium dependent
- 当前主要阻塞：Chromium/session 供应稳定性
- 当前验证状态：路径可行，但尚未固化为默认稳定恢复路径
- 下一位 agent 的直接检查方法：
  1. 查看 `rss:last_fetch_invocation`
  2. 查看 `rss:last_route_diagnostics`
  3. 确认点击单源刷新后 diagnostics、列表结果、route 结论三者一致

### Xiaohongshu
- 当前 backend：app-browser-backed acquisition
- 当前主要阻塞：应用内真实刷新链最终签收，而不是 extractor 语法或外部 cookie
- 当前验证状态：
  - 提取脚本语法错误已修
  - same-domain 复用已收紧为 same-profile 复用
  - 真实 Electron `persist:browser` 会话下已抓到结果
- 下一位 agent 的直接检查方法：
  1. 在 Ready 浏览器保持登录态
  2. 在 RSS 中选中单个小红书源并点击刷新
  3. 同时核对 `lastFetchInvocation`、route diagnostics、最终列表是否一致
  4. 如果无结果，先分辨是“没触发刷新”还是“触发了但抓取失败”

### Douyin
- 当前 backend：app-browser-backed acquisition
- 当前主要阻塞：账号作品区 extractor 的最终硬化与 UI 刷新签收
- 当前验证状态：
  - 真实 Electron `persist:browser` 会话下已验证过账号作品区提取
  - page-wide 推荐内容误入结果的旧路径已被修过多轮
- 下一位 agent 的直接检查方法：
  1. 在 RSS 中选中抖音源单独刷新
  2. 核对 `lastFetchInvocation` 是否正确落到该 source
  3. 核对 route diagnostics 与最终列表是否指向同一账号作品区，而不是推荐区

## 当前架构立场
- Xiaohongshu / Douyin / Weibo 应继续沿应用内 browser module 路线收尾。
- 不要重新引入平行浏览器 runtime 作为默认主路径。
- 不要把 Scrapling 升格成默认 RSS 主链。
- 只有在当前架构被证明确实无法收敛时，才重新评估更重的 fallback。
