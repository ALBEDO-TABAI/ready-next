---
title: RSS 引擎去嵌入式 RSSHub 化（自研主路收口：bilibili native-first / XHS 隔离分区采集 / 内嵌 RSSHub 退役）
date: 2026-07-10
kind: implementation
enforce: true
status: draft-pending-review
verify_entry: 拟新增 npm run verify:rss-native（Phase 1-4 焦点测试 + 两个新 gate + 既有 verify:browser-reliability 不回归）
principle: 先契约后代码；修根因不修症状；拒绝 legacy 兼容分支；手术式改动。
---

# RSS 引擎去嵌入式 RSSHub 化实施契约

> 结论先行：**完全自研可行，且距离比直觉近得多**。RSS 模块的解析、OPML、分类、报告、诊断、9/10 平台抓取已是自研；嵌入式 RSSHub（596 个传递依赖 ≈ 494MB + 运行时另下 ~200MB Chromium + 一个常驻子进程）当前只剩**两个真实职责**：bilibili 主路（已有三级自研兜底）与小红书唯一路径（提取脚本已建好、只缺隔离运行容器）。其余引用要么是死代码（twitter/zsxq 嵌入实例无凭据必失败），要么已被浏览器采集主路取代（weibo/douyin，回退开关恒 false）。
>
> 本文档供 codex 按阶段执行。每阶段有独立验收，可分 PR 落地；Phase 1/2 先行验证自研质量，Phase 3 才删除 RSSHub，全程可回滚。

## 0. 证据基线（2026-07-10 实测，file:line 均已核对）

### 0.1 RSSHub 的真实成本

| 维度 | 实测 |
|---|---|
| 包体 | `node_modules/rsshub` 46MB，版本钉死 `1.0.0-master.5cb9913`（master 快照，非稳定发布） |
| 传递闭包 | **596 个包 ≈ 494MB**（项目 node_modules 共 ~1188 包，RSSHub 占一半；含 playwright、googleapis、telegram、instagram-private-api、ioredis 等与 Ready 无关的重依赖） |
| 运行时 Chromium | `rsshub-process.ts:79` 经 `@puppeteer/browsers` 下载 Chrome `136.0.7103.49`（~200MB）到 `userData/puppeteer-cache`，仅供 RSSHub 浏览器型路由使用 |
| 进程管理面 | `rsshub-process.ts`（789 行：端口扫描/watchdog/重启/复用/陈旧 worker 清理）+ `rsshub-process-cleanup.ts`（182 行）+ `rsshub-worker.mjs`（179 行）+ `browser-engine/browser-cleanup.ts`（专为收割 RSSHub 内 rebrowser-puppeteer 的 chromium 孤儿进程而存在）+ boot-reaper 集成 |
| 打包面 | `electron-builder.yml:71-72`（extraResources 拷 worker）、`:107-108`（asarUnpack `node_modules/rsshub/**`）、`electron.vite.config.ts:14,17`（external + worker entry）、`Packer/pack-clean-release.mjs:75`（rsshub-runtime）。已知打包痛点（symlink node_modules 需 materialize、DMG 过大）的主要贡献者即此闭包 |
| 启动面 | `src/main/index.ts:1198` 应用启动即 `rsshubManager.start()` |

### 0.2 平台 × 后端现状（route capability matrix 为单一信源，`source-diagnostics.ts:139-230`）

| 平台 | 现役主路 | RSSHub 角色 | 证据 |
|---|---|---|---|
| rss 通用 / youtube / vimeo / behance | 自研 native（fast-xml-parser，`scrapers/native-rss.ts`） | 无 | 矩阵 `backend: 'native'` |
| twitter | 自研 syndication API（`scrapers/twitter.ts:44`） | 代码内回退 `/twitter/user/`，**嵌入实例必失败**（RSSHub 该路由需 TWITTER_AUTH_TOKEN 类配置；`rsshub-worker.mjs:63-68` init 仅传 IS_PACKAGE/CACHE_TYPE/ALLOW_ORIGIN/NODE_ENV，无任何平台凭据） | 死回退 |
| zsxq | 自研 pub API（`scrapers/zsxq.ts:61`） | 回退 `/zsxq/group/`，同上**嵌入实例必失败**（需 ZSXQ_ACCESS_TOKEN） | 死回退 |
| weibo / douyin | **Ready 应用内浏览器会话采集**（`browser-acquisition.ts:1021-1022` `supportsBrowserSessionAcquisition`；主流程 `ipc-handler.ts:640-703`） | 回退被 `allowsRSSHubFallbackAfterBrowser` **恒 false** 闸死（`source-diagnostics.ts:135-137`），死路径 | 矩阵 `backend: 'browser'` |
| bilibili | RSSHub `/bilibili/user/video`→`/dynamic` 主路，**其后已有三级自研兜底**：WBI 签名 API（`scrapers/rsshub.ts:483-580`，mixinKeyEncTab 完整实现 :278-283）→ polymer API（:374-481）→ 浏览器页面陈旧兜底（`ipc-handler.ts:744-753` + `resolveBilibiliStaleRouteResult`） | 主路，但可被自研链完全覆盖 | 矩阵 `fallbackOrder: ['rsshub','browser','native','scrapling']` |
| xiaohongshu | **RSSHub 唯一路径**（strict gate：`ipc/fetch-group.ts:396,606,803`；无 hub 直接报错跳过）。设计动因是风控隔离：不复用用户登录态，走 RSSHub 托管的独立 Chromium（矩阵注释 `source-diagnostics.ts:201`） | 唯一硬依赖 | `needsRSSHub()` = bilibili ∥ xiaohongshu（`scrapers/index.ts:89-91`） |

### 0.3 关键已建资产（Phase 2 的"只差接线"证据）

- XHS 浏览器提取脚本已存在：`browser-acquisition.ts:379` `buildExtractionScript` 的 xiaohongshu 分支（含 profile 兜底链接判定 :57、候选 key 构造 :72）。
- XHS 增量/全量模式已存在：`ipc-handler.ts:574-580` `resolveBrowserAcquisitionMode`（draft_seeded → incremental）；XHS 专属超时策略已存在：`browser-acquisition.ts:1036`（incremental 6s / full 65s）。
- 风控暂停机制已存在：`ipc-handler.ts:777+` `shouldPauseSilentBrowserFetch`（验证码/风控后暂停静默刷新）。
- Bilibili 登录态凭据槽已存在：`src/shared/external-services.ts:105-111`（`bilibili-default`，sessdata/biliJct，默认 disabled）。
- 外部 RSSHub 逃生门已存在：设置键 `rsshub_base_url` + 公共 `https://rsshub.app` 兜底（`ipc-handler.ts:415-437` `resolveRSSHubBase`）；skills 侧 `rsshub-default` 外部服务默认 disabled（`external-services.ts:96-103`）。

### 0.4 为什么"完全自研"可行——范围界定

自研目标**不是**复刻 RSSHub 的 1000+ 路由（那不可行也无必要），而是：Ready 的 `detectPlatform`（`scrapers/index.ts:27-41`）只暴露 10 个平台，其中 8 个已自研；剩余 2 个平台各补一段主路代码即可让嵌入式 RSSHub 整体退役。新平台未来本来就需要改 `detectPlatform` + 接 scraper，"RSSHub 路由免费"在 Ready 的封闭平台枚举下并不成立；外部自建 hub 用户经 `rsshub_base_url` 仍可用通用 `RSSHubScraper`（纯 HTTP+XML，零依赖成本）。

---

## Phase 1 · Bilibili native-first（低风险先行，验证自研链质量）

### 合同
1. bilibili 抓取顺序变更为：**buvid-bootstrapped WBI API → polymer API → 应用内浏览器页面 → 外部 RSSHub（仅当用户配置了 `rsshub_base_url` 或公共实例可达）**。嵌入实例不再是任何平台的必要条件。
2. 新增 buvid cookie bootstrap：首次请求前 GET `https://api.bilibili.com/x/frontend/finger/spi` 取 `buvid3/buvid4`，与 WBI keys 一起按 TTL 缓存（进程内存即可，键含日期；WBI keys 每日轮换）。命中 `-352/-799` 风控码时立即降级 polymer，不重试同一路径。
3. `bilibili-default` 外部服务若 enabled 且 sessdata 非空，注入 Cookie 头（可选增强，不是依赖）。
4. 矩阵更新：`bilibili.fallbackOrder = ['native','browser','rsshub']`、`backend: 'native'`；`needsRSSHub('bilibili')` 移除。
5. 失败要响亮：每级降级写 route attempt 诊断（复用 `recordRouteAttempt`），错误信息保留各级原因拼接（现有 `errorParts.join(' | ')` 风格，`scrapers/rsshub.ts:621`）。

### 触点
- `scrapers/rsshub.ts` BilibiliScraper：重排 `fetchItems`（:582-628），新增 `bootstrapBilibiliCookies()`；WBI/polymer 实现原样保留。
- `scrapers/index.ts` `needsRSSHub`、`source-diagnostics.ts` 矩阵。
- `ipc/fetch-group.ts:396,606,803` strict gate 中 `platform !== 'bilibili'` 特判随 `needsRSSHub` 收敛自然消失。

### 测试
- WBI 签名 golden vector（固定 imgKey/subKey/params → 断言 w_rid；防未来重构破坏签名）。
- 降级顺序行为测试：WBI 返回 -352 → 断言走 polymer；两者皆空 → 断言浏览器兜底被调用（注入假 browserController）。
- buvid bootstrap 缓存 TTL 与失效重取。
- 真机验收：真实 UP 主 space 链接全链路（residential IP 下 WBI 直连成功率应显著高于经嵌入 hub 的现状）。

## Phase 2 · XHS 隔离分区浏览器采集（替换最后一个硬依赖）

### 合同
1. 新增**隔离会话采集容器**：隐藏 BrowserWindow/WebContentsView + 专用 session partition（如 `persist:rss-isolated-xhs` 或非持久分区，二选一在实施时定，倾向持久以保留访客 cookie 降低验证码频率），运行既有 `buildExtractionScript('xiaohongshu', …)`。**风控隔离性质与 RSSHub 现状等价**：匿名独立 Chromium 上下文，绝不 attach 用户浏览器 partition。
2. **红线合同（可机器验证）**：后台静默 XHS 采集使用的 partition 名必须 ≠ 用户浏览器 partition；行为测试注入记录 partition 的假 session 工厂断言之。用户显式在 Ready 浏览器打开页面的前台 harvest/preview 流不受影响。
3. 语义拆分：`supportsBrowserSessionAcquisition`（weibo/douyin，用户会话）与新谓词 `supportsIsolatedBrowserAcquisition`（xiaohongshu），两种风控姿态不得混用同一谓词。
4. XHS 抓取顺序：**隔离分区采集 → 外部 RSSHub（仅配置时）**；strict RSSHub gate（`fetch-group.ts:396,606,803`）删除；`needsRSSHub('xiaohongshu')` 移除。增量/全量与 draft_seeded 语义原样迁移（`resolveBrowserAcquisitionMode` 已支持）。
5. 验证码/风控出现时复用 `shouldPauseSilentBrowserFetch` 暂停语义 + 引导用户前台打开（现有文案链路）。可选设置：用户显式粘贴 XHS cookie 注入隔离分区（对齐 RSSHub 的 cookie 配置能力，默认关）。
6. 采集终态判决继续唯一走 `resolveCollectionVerdict()`（CLAUDE.md 硬约束，0 条永不 completed）。

### 触点
- 新文件 `rss-engine/isolated-browser-session.ts`（隐藏窗生命周期：懒创建、空闲销毁、超时硬杀；bounds 0×0 不显示，与 BrowserView 覆盖层规则无交互）。
- `browser-acquisition.ts`：`fetchFeedViaBrowserSession` 抽出脚本执行段，使其可被用户会话 controller 与隔离容器共用；XHS 分支接隔离容器。
- `ipc-handler.ts` `fetchSourceWithCurrentStack`：XHS 进入隔离采集分支。
- 矩阵：`xiaohongshu.fallbackOrder = ['browser','rsshub']`、`chromiumRequired: false`（不再需要独立下载的 Chromium——Electron 自带）。

### 测试
- partition 隔离红线测试（见合同 2）。
- 提取脚本仍走 `buildExtractionScriptForTest` 既有测试面（`rss-browser-acquisition.test.ts`、`rss-bilibili-browser-acquisition.test.ts` 不回归）。
- 隐藏窗生命周期：并发抓取复用单窗、空闲销毁、超时后进程无残留 WebContents。
- 真机验收：匿名分区拉公开笔记列表成功；触发验证码路径给出暂停+引导（与现状文案一致）。

## Phase 3 · 内嵌 RSSHub 退役（依赖 Phase 1/2 真机验收通过）

### 合同
1. 删除嵌入运行时全链：`rsshub-worker.mjs`、`rsshub-process.ts`、`rsshub-process-cleanup.ts`、`@puppeteer/browsers` 依赖及 Chromium 下载/缓存逻辑、`index.ts:45,341,1198,1285` 启动与清理接线、boot-reaper 与 `browser-cleanup.ts` 中 rsshub 专属分支、`rsshub-process-cleanup.test.ts`。
2. `package.json` 移除 `rsshub`；`electron-builder.yml:71-72,108`、`electron.vite.config.ts:14,17`、`Packer/pack-clean-release.mjs:75` 同步清理。
3. `resolveRSSHubBase` 重写为**外部-only**：`rsshub_base_url` 设置 → 公共 `rsshub.app`（保留可达性探测）；两者皆不可达时**不再抛硬错误**，返回 undefined，各平台按矩阵顺序自然跳过 RSSHub 兜底（bilibili/xhs 主路已不依赖它）。
4. 通用 `RSSHubScraper` 基类与 twitter/zsxq/weibo/douyin 的 RSSHub 回退**保留但仅当外部 hub 已解析时进入**（它们是纯 HTTP+XML 通路，服务自建 hub 用户；嵌入专属的死分支随嵌入实例一起消失，符合"拒绝 legacy 兼容分支"——留下的不是兼容层而是可选后端）。
5. `external-services.ts` `rsshub-default.baseUrl` 从 `http://localhost:1200` 改为空字符串并注明"外部实例地址"；skills 侧 `external-env-resolver.ts:96-99` 行为不变（enabled=false 默认下本就不注入）。
6. 设置页 RSS 诊断面（`RSSRuntimeDiagnostics` 等）同步：移除"内嵌 RSSHub 运行态/Chromium 下载"卡片，保留"外部 RSSHub 可达性"诊断。
7. `rsshub_base_url` 设置键语义不变，无需迁移；`puppeteer-cache` 目录做一次性清扫（启动时存在即删，带日志）。

### 测试 / Gate
- 新 gate `check-no-embedded-rsshub.cjs`（存在性合同）：`src/` 内禁止 `from 'rsshub'`、`rsshub-worker`、`@puppeteer/browsers` 任一出现；`package.json` 禁止 rsshub 依赖。防复活。
- 新 gate `check-rss-external-hub-optional.cjs`：断言 `resolveRSSHubBase` 不可达时各平台 fetch 不抛基础设施错误（行为测试配套）。
- 既有 `check-rss-platform-rule-single-source.cjs` 对齐新矩阵后必须绿。
- `rsshub-process-cleanup.test.ts` 删除；`verify:browser-reliability` 全链绿。
- 打包验收：`npm run build` + 打包产物体积对比（预期 unpacked -~500MB）+ 真机安装启动（结合已知 symlink materialize 流程）。

## Phase 4 · 收尾

1. 新增 `npm run verify:rss-native`：Phase 1-4 焦点测试 + 两个新 gate + `verify:browser-reliability`。
2. 文档同步：CLAUDE.md（§2 硬约束若涉及、§8 索引加本文档）、AGENTS.md 同步、CHANGELOG、FEATURE_MODULE_MAP、DEPENDENCY_MAP（依赖数变化显著，值得记）。
3. `LESSONS_LEARNED.md` 补一条：嵌入巨型上游做本地服务的真实成本核算方法（本文档 §0.1 的度量口径可复用）。

---

## 风险与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | XHS 匿名访问限流/验证码导致成功率下降 | 中 | 与现状同级风险——RSSHub 的 xhs 路由同样匿名+同样常挂（错误归一化已有 `__initial_state__` 分类，`scrapers/rsshub.ts:96-104`）。缓解：持久访客分区 + 可选 cookie 注入 + 外部 hub 兜底 + 前台 harvest 通路保留。Phase 2 真机验收不过则不进 Phase 3，嵌入实例继续服役，零损失 |
| R2 | Bilibili WBI 直连风控（-352/-799） | 低 | RSSHub 路由内部就是同一 WBI API，用户侧 residential IP 直连成功率≥经 hub；buvid bootstrap + polymer + 浏览器三级已覆盖；sessdata 可选增强 |
| R3 | Electron Chromium 指纹 vs 独立 Chrome | 低 | 同为真 Chromium 内核；Ready 浏览器已在可见面稳定抓 XHS/微博/抖音；UA 与自动化痕迹处理复用现有浏览器引擎姿态 |
| R4 | 公共 rsshub.app 在大陆网络不可达 | 低 | 仅作可选兜底，不是任何主路的依赖；不可达时静默跳过 |
| R5 | 未来想加新平台失去"现成路由" | 低 | 外部 hub 仍可配（通用 scraper 保留）；Ready 的平台枚举本就需要逐个接线 |

## 明确不做（防走样）

- **不**自研"任意站点通用路由引擎"（等价于复刻 RSSHub 全量，不可行也无需求）。
- **不**动 weibo/douyin 现行浏览器主路与其风控暂停机制。
- **不**动分析/报告/digest/draft-store 层（`item-analysis-manager.ts` 等与 RSSHub 无耦合）。
- **不**在本轮引入 Scrapling（矩阵中仍是远期备选，维持原状）。
- **不**给 XHS 后台采集接用户登录态（红线合同，见 Phase 2.2）。

## 收益核算（验收时回填实测）

- 依赖：-596 包（项目总包数 ~-50%），移除 master 快照版本钉死与 instagram-private-api/telegram/googleapis 等无关供应链面。
- 磁盘：安装包 unpacked 预期 -~500MB；用户机免除 ~200MB Chromium 运行时下载。
- 运行时：-1 常驻子进程及其 chromium 孤儿进程族；启动路径移除 `rsshubManager.start()`；bilibili 抓取少一跳本地 HTTP。
- 维护：789+182+179 行进程管理代码删除；bilibili/xhs 故障从"hub 黑盒内"变为可直接断点的自研代码路径；Windows 移植少一个 Chromium 下载 + 进程树清理面（`rsshub-worker.mjs:17` 的 win32 watchdog TODO 直接消失）。
