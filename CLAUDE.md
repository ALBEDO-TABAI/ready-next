# Ready 项目协作指引（CLAUDE）

> 更新时间: 2026-03-07

## 0. 前置思考
请使用第一性原理思考。不要默认用户已经把目标、限制和最佳路径都描述完整；当目标不清晰时先澄清，当路径不优时先提出更好的方案。

## 1. 项目定位
Ready 是一个集成式创作工作台，统一承载：浏览、文稿、设计、剪辑、RSS、日程、AI Agent、技能中心与远程协作。

## 2. 技术基线
- Electron 34
- React 19
- TypeScript 5
- Vite 6 + electron-vite
- Zustand
- Tailwind CSS v4 + CSS Variables
- SQLite（better-sqlite3）

## 3. 代码分层
- Main：`src/main/`
- Preload：`src/preload/`
- Renderer：`src/renderer/`
- Shared：`src/shared/`

## 4. 关键入口
- 主进程：`src/main/index.ts`
- 预加载：`src/preload/index.ts`
- 渲染入口：`src/renderer/main.tsx`
- 应用壳层：`src/renderer/App.tsx`
- AI 配置能力层：`src/shared/ai-providers.ts`

## 5. 工作台子模式
`useMode` 当前包含：
- `browser`
- `document`
- `design`
- `video`
- `rss`
- `calendar`

> 旧 `image` 模式已迁移为 `design`。

## 6. 当前稳定性约定
### 6.1 白屏防护
- `src/renderer/main.tsx` 必须保留 bootstrap 级错误兜底 UI
- `src/renderer/App.tsx` 必须保留 `/workbench` 路由与 `* -> /workbench` fallback

### 6.2 BrowserView 使用原则
- BrowserView 是原生层覆盖，不受 DOM `z-index` 控制
- 需要显示纯 DOM 覆盖层时，先 `browser.hideAll()`
- 恢复浏览内容时，`browser.showActive()` 后同步更新 bounds

### 6.3 统一会话 Scope
- 会话按“来源频道 + 线程/本地 conversation + agent”隔离
- 左上切换的是频道来源，不是具体历史会话
- 工具日志只能留在前台运行态 / 胶囊层，不允许混入正文消息

### 6.4 附件安全边界
- 飞书/远程图片与文件单发：只进入会话资源层，不自动触发 agent
- 后续文字任务若要消费附件，必须由 planner / workflow 显式选取附件资源
- 远程消息不能把图片/文件伪造成普通文本

### 6.5 Browser Agent V7 原则
- 浏览器任务必须走：任务理解 -> 计划生成 -> 分步执行 -> 结果复核
- 链接是资源，不是立即执行指令
- 执行器只按计划推进，不临场重写大方向
- 上传型任务的最小完成条件：
  - 页面已挂载附件
  - Prompt 已进入正确输入区
  - 页面已提交并出现运行态证据

### 6.6 AI 供应商兼容原则
- 不要假设“OpenAI 兼容”就一定支持原生 function tools
- 优先通过共享能力层判断协议、wire API、tools/vision/video 能力
- 若通道不支持原生 tools，应优先复用文本工具桥接，而不是继续写 provider 特判

### 6.7 技能中心原则
- 系统级 embedded skills 与用户 custom skills 要分层管理
- Agent 调用 skill 时优先走统一 `skill_*` 工具，而不是绕到手工网页流程
- 更新 skill 管理逻辑时，要同时考虑运行时、UI、默认命令与说明文案

## 7. 新功能开发最小闭环
新增跨进程功能时，至少同步修改：
1. Main IPC handler
2. Preload API
3. Renderer 类型声明
4. Renderer 页面或组件
5. 至少一份相关文档

## 8. 协作文档索引
- 项目说明：`PROJECT_OVERVIEW.md`
- 开发文档：`DOCUMENTATION.md`
- 经验文档：`LESSONS_LEARNED.md`
- 开发进展：`PROGRESS.md`
- 模块地图：`FEATURE_MODULE_MAP.md`
- 依赖地图：`DEPENDENCY_MAP.md`
- 结构快照：`PROJECT_STRUCTURE_SNAPSHOT.md`
- 更新日志：`CHANGELOG.md`

## 9. 常用命令
```bash
npm run dev
npm run typecheck
npm run test
npm run verify
npm run build
```

## 10. 提交前检查
- `npm run typecheck` 无错误
- 关键页面可正常渲染与切换
- Browser / Agent / Settings 关键链路至少做一次基础回归
- 若改动跨多层，必须同步更新根目录协作文档

## 11. 当前关键日志
- Agent / 浏览器决策：`/tmp/ready-directchat.log`
- 工具执行：`/tmp/ready-tools.log`
- BrowserView / popup：`/tmp/ready-browser.log`

> 调整 Browser Agent、远程 IM、会话 scope、BrowserView、AI provider 能力层、技能运行时等跨模块行为时，必须同步更新根目录协作文档。
