---
title: Ready Next 订阅的会话内采集实施计划
date: 2026-11-17
status: implemented
enforce: true
---

# Ready Next 订阅的会话内采集：用自己的登录、按人的节奏拿更新

## 1. 为什么改

需要登录才看得全的平台（B 站、小红书、微博、抖音），匿名抓取已经走不稳：

- 2026-11-17 在安装版里导入 5 个订阅后的第一次刷新：B 站 3 个源里 2 个拿回的是两周以前的旧内容，小红书 45 秒超时。登录 B 站后，转到 Ready 浏览器会话的那一个源拿到了 20 条。
- RSSHub 上游把 B 站匿名请求的问题关闭为“不计划修”（DIYgod/RSSHub#18506）；同一讨论指出带上用户自己的登录不会出错。
- 我们自己的代码在加重它：B 站失败后依次再试几条程序自签的匿名接口；从页面拿到条目后并发最多 20 个请求补发布时间；同一平台的几个源同时抓；平台主页和普通 RSS 一样 15 分钟一次。

用户决定（2026-11-17）：允许后台低频自动刷新使用 Ready 浏览器里的登录，小红书也一样；目标是让这些访问尽量就是“用户自己打开这一页”时网站看到的样子。

## 2. 合同

下面每条都有对应的行为测试（§4）。

- **S1 会话平台。** B 站、小红书、微博、抖音的订阅由 Ready 浏览器的登录会话获取：在隐藏页里打开订阅对应的主页，隐藏页与用户标签页共用 `persist:browser`，不占用、不跳转、不重载用户已打开的任何标签页。
- **S2 请求只来自页面。** 会话平台的刷新路径里，程序自己不向平台发任何请求：不重算签名、不调平台接口补数据、不在程序侧解析短链。数据只有两个来源：页面自己请求的返回（只读观察，不改写、不拦截），和页面里已有的内容（内嵌状态、DOM）。B 站与小红书的页面脚本不滚动页面、不向页面派发事件。
- **S3 读法的先后。** B 站先读页面自己请求到的投稿列表（有发布时间、简介、封面），拿不到再读 DOM。小红书先读页面内嵌状态，再读页面自己请求的笔记列表，最后读 DOM。同一条内容不论用哪种读法，得到的条目身份相同。
- **S4 登录、验证的判定。** 只要读到了条目就算成功；只有没读到条目时才判断登录页或验证页。验证页的判定只认网址、专用的验证容器和明确的提示语，不因正文里出现“验证”二字误判。
- **S5 节奏。** 整个应用同一时刻最多有一个会话采集页；同一平台相邻两次打开之间留随机间隔。自动刷新时，一个会话源的最短刷新间隔是“平台基础间隔”和“源数量 × 平台最小间隔”的较大者，再带固定比例的抖动；一个平台在一段时间窗内打开的页数有上限，超出的留到后面的轮次。数值集中在 `rss-engine/session-acquisition-pacer.ts`。
- **S6 人在才刷。** 自动刷新只在用户最近操作过这台电脑时进行会话采集；电脑闲置或锁屏时跳过，等人回来后的下一轮再做。手动刷新不受这一条限制。
- **S7 遇到登录页或验证页就停。** 任一会话源遇到登录页或验证页后，该平台的自动刷新暂停（登录 12 小时、验证 6 小时），同一轮里排在后面的同平台源不再打开页面；本次不重试、不换别的通道再试。用户手动刷新单个源、或正开着该主页时不受暂停限制；任一次成功即解除暂停。
- **S8 没到时间不算失败。** 自动刷新里因为 S5、S6、S7 被跳过的会话源不记失败、不改上次结果、不计入错误。
- **S9 未登录的 B 站。** 页面显示需要登录时，B 站退到 RSSHub 的匿名路由（按需启动，不预热）；结果偏旧时按需要登录处理。小红书、微博、抖音没有匿名通道，直接提示去 Ready 浏览器登录。
- **S10 不新增后台的笔记详情访问。** 小红书条目带真实笔记链接后，资讯筛子判断前的后台正文预取不访问小红书笔记页；用户在阅读页打开某条时照常加载。
- **S11 读完不立刻关。** 读到条目的页面再停留 2–4 秒才关闭，让它把自己的封面图和后续请求加载完，不在列表一到手就掐断；没读到内容的页面（登录页、验证页）不停留。

明确不做：伪装指纹、自动处理验证码、代理或换 IP、把登录信息导出给别的程序或内核。

## 3. 实现

| 位置 | 改动 |
| --- | --- |
| `browser-engine/background-capture-page.ts`（新） | 隐藏采集页句柄：导航、在页面里取值、只读观察页面请求的 JSON 返回（CDP `Network` 域）、关闭 |
| `browser-engine/browser-controller-capture-runtime.ts` | `openBackgroundPage()` 取代 `captureBackgroundPage` 与 `captureLiveTabPage`（后者会重载用户的标签页） |
| `rss-engine/session-response-parsers.ts`（新） | 从页面请求的返回里按结构认出 B 站投稿列表、小红书笔记列表和平台的风控返回 |
| `rss-engine/session-acquisition-pacer.ts`（新） | S5–S8 的规则与全局串行队列，纯逻辑，时钟、随机数、闲置时长注入 |
| `rss-engine/browser-acquisition.ts` | 按 S1–S4 重写流程；去掉程序侧请求与合成点击 |
| `rss-engine/scrapers/rsshub.ts` | B 站只保留 RSSHub 路由（去掉程序自签接口）；删除小红书的 RSSHub 抓取 |
| `rss-engine/ipc-handler.ts`、`ipc/fetch-group.ts` | 路由改为会话优先；RSSHub 按需解析；`fetchAll` 区分自动与手动；跳过的源按 S8 处理 |
| `rss-engine/content-service.ts` | S10 |
| `rss-engine/source-diagnostics.ts` | 能力表：四个平台的后端都是 `browser` |
| `docs/architecture/current-runtime-contracts.md` | 替换“小红书只走内嵌 RSSHub”一条 |

采集诊断写入 `ready-browser.log`：平台、用了哪种读法、条数、状态、耗时、跳过原因；不写页面内容和网址参数。

## 4. 验证

行为测试（合同条目 → 测试）：

- S3、S4 的返回解析：`src/__tests__/rss-session-response-parsers.test.ts`。
- S5–S8 的节奏、暂停与队列：`src/__tests__/rss-session-acquisition-pacer.test.ts`。
- S1–S4、S11 的采集流程与页面脚本；采集全程 `fetch` 被调用即失败（S2）：`src/__tests__/rss-browser-acquisition.test.ts`。
- S7、S8、S9 的单源刷新：`src/__tests__/rss-session-source-fetch.test.ts`。
- S8 与自动、手动的区分，普通订阅排在会话源前面：`src/__tests__/rss-fetch-group-register.test.ts`。
- 路由与能力表：`src/__tests__/rss-scrapers.test.ts`、`rss-diagnostics.test.ts`。
- S10：`src/__tests__/rss-sieve-review.test.ts`（需 Electron 运行时，`node scripts/run-rss-workspace-native-tests.cjs`）。

2026-11-17 实际跑过：

- `node scripts/run-rss-workspace-native-tests.cjs`：473 项全部通过，无跳过。
- `npm run typecheck`、`npm run test:parallel`（8527 项，唯一失败是已记录的 `rrule-engine` 200ms 性能阈值）、`check-rss-platform-rule-single-source`、`check-silent-catch`、`check-provider-checkpoint-module-boundaries`、`check-plan-pairing`、`verify:ready-next-smoke`（44/44）。
- 隐藏真实窗口：隔离资料，启动参数把所有域名解析到本机的 HTTPS 夹具站点，没有流量离开本机。4 个源（3 个 B 站、1 个小红书）“全部刷新”后入库 10 条：两个 B 站源读的是页面自己请求的返回（带发布时间、简介、封面），一个只有渲染列表的 B 站源走 DOM，小红书读的是内嵌状态且链接带上了页面给的访问令牌；一次只开一页，同平台两页之间隔了 14 秒和 22 秒；平台接口的请求全部由页面发出（`sec-fetch-site: same-site`、`Origin` 为主页域名）；紧接着的自动轮因为电脑已闲置 13 分钟一页没开，结果写的是“4 个等下一轮”、没有错误；再次“全部刷新”不重复打开刚开过的页；手动刷新单个源重新打开了一次、条目身份不变。
- **真实网站没有验证。** B 站、小红书当前的页面结构与风控反应要在装有用户登录的安装版里看 `ready-browser.log` 的 `[rss-session]` 行和刷新记录，再按证据修正。

## 5. 后续（本次不做）

- 微博、抖音的页面脚本还会滚动页面并点击切换标签，这次只让它们走同一个隐藏页和同一套节奏，脚本本身没有改（没有真实页面可验证）。
- 小红书条目在阅读页里加载正文仍走原来的正文通路（带登录的一次页面请求，不是页面导航），没有改成隐藏页打开。
- 关注流：打开一次平台的“动态/关注”页覆盖全部已关注作者，把 N 次打开降到 1 次。
- 顺路更新：用户自己在 Ready 里浏览这些站点时，用页面已加载的内容更新订阅，不产生额外请求。
- 内嵌 RSSHub 整体退役（现在只剩未登录 B 站的匿名通道在用）。
