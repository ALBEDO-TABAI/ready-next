# Ready 模块架构复审（2026-03-07）

## 基线状态
- 仓库基线：`/Users/user/Documents/ready`
- 当前分支：`codex/baseline-rebuild-20260307`
- 校验结果：
  - `npm run typecheck` 通过
  - `npm test` 通过
  - `npm run build` 通过

## 本轮已落地的低风险优化
- 将 `WorkbenchMode` 和 `LiveFollowPanel` 的子模式出口统一为懒加载组件：
  - 避免 `CalendarMode` 在一个地方写 `lazy`，另一个地方又静态 `import`
  - 为后续把 `BrowserMode` / `DocumentMode` / `DesignMode` / `VideoMode` / `RSSMode` 继续拆块留出统一出口
  - 最新构建结果中，renderer 主包已从约 `6.9 MB` 降到约 `840 KB`

## Findings

### P1. 模式级拆块已恢复，但各模式内部仍有明显的重包问题
- 证据：
  - 新增统一出口 [WorkbenchModeOutlet.tsx](/Users/user/Documents/ready/src/renderer/components/layout/WorkbenchModeOutlet.tsx)
  - 最新构建结果已拆出 `BrowserMode 70.84 kB`、`DocumentMode 357.74 kB`、`CalendarMode 485.00 kB`、`VideoMode 1188.13 kB`、`DesignMode 3091.10 kB`
  - `UniverSheet` 仍独立达到 `13376.21 kB`
- 风险：
  - 首屏主包虽然明显下降，但切入设计、视频、文档模式仍会触发大块加载
  - 模式页面内部继续堆共享依赖，会把后续优化空间再次吃掉
- 建议：
  - 保持统一的模式注册和懒加载出口，不再在多个容器组件里直接静态导入模式页面
  - 下一步把模式级别的共享重型依赖继续拆出独立 chunk，优先处理 `DesignMode`、`VideoMode`、`UniverSheet`

### P1. `useAgent.ts` 把状态、发送编排、附件拼装、持久化、事件监听揉进一个 store，存在流失配风险
- 证据：
  - [useAgent.ts](/Users/user/Documents/ready/src/renderer/stores/useAgent.ts#L1720) `sendMessage` 单函数承担 scope 创建、附件读取、消息落库、命令分流、流式启动
  - [useAgent.ts](/Users/user/Documents/ready/src/renderer/stores/useAgent.ts#L2273) `initAgentListeners` 仍和 store 放在同一文件
  - [useAgent.ts](/Users/user/Documents/ready/src/renderer/stores/useAgent.ts#L2280) 到 [useAgent.ts](/Users/user/Documents/ready/src/renderer/stores/useAgent.ts#L2286) 的 `onStream` 过滤依赖 `currentAgent/currentScopeId`
- 风险：
  - 如果用户在流式回复期间切换 scope 或 agent，事件会被当前 UI 选择态过滤掉，造成消息不追加、状态不同步或 assistant 回复不落盘
  - 发送链路很难做单元测试，只能靠端到端碰运气
- 建议：
  - 拆成三层：
    - `agent-store`：只管纯状态
    - `agent-runtime-driver`：绑定 Electron 事件与 run lifecycle
    - `message-composer`：专门处理附件、`@[file]` 引用、browser tab context 拼装
  - stream/status/error 监听应按 `requestId + scopeId` 路由，不应依赖当前选中的会话

### P1. `BrowserMode` 仍直接承担 BrowserView 几何同步、可见性切换、书签/历史/下载/adblock 面板与 tab 事件订阅
- 证据：
  - [BrowserMode.tsx](/Users/user/Documents/ready/src/renderer/pages/modes/BrowserMode.tsx#L442) 到 [BrowserMode.tsx](/Users/user/Documents/ready/src/renderer/pages/modes/BrowserMode.tsx#L555) 负责 BrowserView bounds 计算和节流
  - [BrowserMode.tsx](/Users/user/Documents/ready/src/renderer/pages/modes/BrowserMode.tsx#L557) 到 [BrowserMode.tsx](/Users/user/Documents/ready/src/renderer/pages/modes/BrowserMode.tsx#L579) 直接调用 `showActive/hideAll`
  - [BrowserMode.tsx](/Users/user/Documents/ready/src/renderer/pages/modes/BrowserMode.tsx#L582) 到 [BrowserMode.tsx](/Users/user/Documents/ready/src/renderer/pages/modes/BrowserMode.tsx#L683) 继续承接 tab/adblock/bookmark 订阅
- 风险：
  - BrowserView 与 DOM 布局继续强耦合，后续改 shell、split view、side sheet 时仍容易闪烁或错位
  - 书签/历史/下载/adblock 这些数据面板和原生浏览器宿主没有隔离，功能一多就继续膨胀
- 建议：
  - 拆成四层：
    - `BrowserShellLayout`：只负责原生宿主 bounds/visibility
    - `BrowserChrome`：地址栏、tab bar、toolbar
    - `BrowserDataPanels`：书签/历史/下载/adblock
    - `BrowserSessionStore`：tab、panel、adblock 状态
  - `hideAll/showActive` 只允许布局层使用，页面级 UI 不直接调

### P2. `BrowserController` 已经成为 main 进程的 god object
- 证据：
  - [ipc-handler.ts](/Users/user/Documents/ready/src/main/modules/browser-engine/ipc-handler.ts#L1) 顶部 imports 已覆盖 Electron host、DB、菜单、文件、session、clipboard
  - [ipc-handler.ts](/Users/user/Documents/ready/src/main/modules/browser-engine/ipc-handler.ts#L270) `BrowserController` 本体同时管理 tab、preview、download、CDP 输入、截图、文件上传、adblock、bookmarks/history
  - [ipc-handler.ts](/Users/user/Documents/ready/src/main/modules/browser-engine/ipc-handler.ts#L2295) `setupBrowserIPC` 又在同文件注册所有 browser IPC
- 风险：
  - 任一浏览器功能回归都会波及其它路径
  - 工具层和 direct-chat 都直接依赖这个总控对象，替换和测试成本高
- 建议：
  - 至少拆成：
    - `browser-tab-service`
    - `browser-preview-service`
    - `browser-cdp-service`
    - `browser-data-service`
    - `browser-adblock-service`
    - `browser-ipc.ts`
  - `BrowserController` 最多保留为 facade，不再承载全部实现

### P2. `database.ts` 跨 RSS、Calendar、Browser、Chat、Agent Channel、Settings 的单体仓储已经成为边界污染源
- 证据：
  - [database.ts](/Users/user/Documents/ready/src/main/modules/database.ts#L21) 开始连续定义多个业务域的 record 类型
  - 查询分布跨越 RSS（约 [database.ts](/Users/user/Documents/ready/src/main/modules/database.ts#L340) 起）、Calendar（约 [database.ts](/Users/user/Documents/ready/src/main/modules/database.ts#L745) 起）、Browser（约 [database.ts](/Users/user/Documents/ready/src/main/modules/database.ts#L855) 起）、Chat/Agent（约 [database.ts](/Users/user/Documents/ready/src/main/modules/database.ts#L1065) 起）
  - 构建明确警告 `database.ts` 同时被静态和动态导入，动态拆块失效
- 风险：
  - 一个表结构改动会扩大到整个主进程依赖图
  - 工具层为了取一小段数据也要把完整数据库管理器耦合进来
- 建议：
  - 保留一个共享 DB 连接层
  - 上层拆成 repository：
    - `repositories/browser-repo.ts`
    - `repositories/chat-repo.ts`
    - `repositories/rss-repo.ts`
    - `repositories/calendar-repo.ts`
    - `repositories/settings-repo.ts`

### P3. preload surface 过宽且手写重复，容易出现接口漂移
- 证据：
  - [preload/index.ts](/Users/user/Documents/ready/src/preload/index.ts#L3) 到 [preload/index.ts](/Users/user/Documents/ready/src/preload/index.ts#L392) 手工维护多个 domain API
  - [preload/index.ts](/Users/user/Documents/ready/src/preload/index.ts#L395) 到 [preload/index.ts](/Users/user/Documents/ready/src/preload/index.ts#L435) 又重复声明 renderer 侧全局类型
- 风险：
  - IPC 名称、参数和返回值容易在主进程/preload/renderer 三处失配
  - 新增 channel 时 review 成本高
- 建议：
  - 把 IPC contract 抽到 `shared/ipc/`
  - preload 只做薄封装，renderer 类型从 contract 自动推导

### P3. `ChatPanel.tsx` 既是 UI 容器又内嵌 markdown 解析、附件预览、历史下拉、输入态计时器
- 证据：
  - [ChatPanel.tsx](/Users/user/Documents/ready/src/renderer/components/agent/ChatPanel.tsx#L21) 自带 markdown parser
  - [ChatPanel.tsx](/Users/user/Documents/ready/src/renderer/components/agent/ChatPanel.tsx#L319) 起主体组件继续处理历史、复制、附件预览、拖拽、输入与发送
- 风险：
  - UI 调整时容易碰到消息渲染和附件读取副作用
  - 很难拆分复用到 Ready/Workbench 之外的场景
- 建议：
  - 拆成：
    - `MessageList`
    - `Composer`
    - `HistoryDropdown`
    - `AttachmentTray`
    - `MarkdownRenderer`

## 推荐执行顺序

### 第一轮：先拆边界，不改行为
1. 固化 `WorkbenchModeOutlet`，把模式页面统一走懒加载出口
2. 从 `useAgent.ts` 抽出 `agent-runtime-driver`
3. 从 `BrowserMode.tsx` 抽出 `BrowserShellLayout`
4. 从 `browser-engine/ipc-handler.ts` 抽出 `browser-ipc.ts`

### 第二轮：收敛主进程职责
1. 拆 BrowserController 子服务
2. 拆数据库 repositories
3. 把 `DirectChatEngine` 的 browser/document/tool bridge 分流成独立协作者

### 第三轮：压缩前端复杂度
1. 拆 ChatPanel
2. 统一 preload contract
3. 再做 UI 细节和动效层优化

## 不建议当前就做的事
- 不建议现在直接全仓大重命名或全量目录搬迁
- 不建议在没有拆 listener/driver 之前重写 agent 交互流程
- 不建议在 BrowserController 仍是单体时继续往里塞更多浏览器产品能力
