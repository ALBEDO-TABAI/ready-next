# Ready 项目说明

> 更新时间: 2026-04-28

## 1. 产品目标
Ready 当前主线是一个桌面创作工作台，稳定承载以下能力：
- 浏览与检索（Browser）
- 文稿编辑（Document）
- RSS 信息流处理（RSS）
- 日程管理（Calendar）
- AI Agent、技能与远程协作（Agent / Skills / Remote IM）

## 2. 当前工作台状态
- 浏览器：多标签 BrowserView、书签/历史/下载/打印、右键菜单、Browser Agent V7 执行链路已接入；头部 chrome 已收口为单层 `BrowserHeader`
- 文稿：多标签、多格式读写，支持 `document_*` 工具链做真实编辑
- RSS：订阅、更新、分析、统计与子代理链路可用
- 日程：日/周/月视图与事件 CRUD 可用
- Agent：统一会话 scope、工具调用、技能运行时、远程 IM 基础链路已接入；聊天面板新增 `当前任务 / 后台任务` 任务区，长任务会持续投影为步骤、等待态、可继续动作与最近产物；跨会话回看第一版已落地，支持历史会话搜索、旧会话胶囊引用和本地向量召回
- 技能中心：支持系统级 embedded skills 与用户导入 custom skills 并行管理；长技能通过 SkillTaskTracker、`skill_task_runs`、task projections 与 detached/run_state 句柄呈现进度、后台运行、预算暂停和继续控制，不再依赖旧 workflow execution 状态机
- 设置页：支持多供应商、多协议、多工具模式配置

## 3. AI / Agent 当前能力
### 3.1 支持的供应商类型
- `moonshot`
- `anthropic`
- `openai`
- `fox`
- `gemini`
- `volcengine`
- `openai-compatible`

### 3.2 共享能力层
AI 配置统一解析为：
- `agentProtocol`
- `wireApi`
- `supportsToolCalls`
- `supportsNativeToolCalls`
- `toolCallTransport`
- `supportsVision`
- `supportsNativeVideo`

### 3.3 工具兼容策略
- 原生支持 function tools 的通道优先走原生工具调用
- 不稳定或不暴露原生 tools 的 OpenAI 兼容通道，回退到文本工具桥接
- Browser、Document、System、Skill、Memory 与会话回看工具从同一套工具注册中心暴露
- 会话回看现已作为独立工具族接入，`session_search` 会同时使用关键词命中和本地向量相似度补召回
- Claude skill 执行改为 `advisory / workflow / legacy direct` 三态兼容，workflow 由宿主状态机自动推进
- scope run 会额外记录任务摘要、最近产物与记忆反馈，用于聊天内任务恢复、技能 blocker 继续和自动记忆反馈

## 4. 技术栈
- Electron 34
- React 19 + TypeScript 5
- Vite 6 + electron-vite
- Zustand
- Tailwind CSS v4 + CSS Variables
- SQLite（better-sqlite3）
- Tiptap / Univer / Mammoth / XLSX / react-pdf

## 5. 目录入口
- 主进程入口：`src/main/index.ts`
- 预加载入口：`src/preload/index.ts`
- 渲染入口：`src/renderer/main.tsx`
- 应用路由：`src/renderer/App.tsx`
- AI 能力配置：`src/shared/ai-providers.ts`

## 6. 当前关键日志
- Agent / 浏览器决策：`<系统临时目录>/ready-directchat.log`
- 工具执行 / Browser Agent 阶段：`<系统临时目录>/ready-tools.log`
- BrowserView / popup / 导航：`<系统临时目录>/ready-browser.log`

> macOS: `/tmp/`, Windows: `%TEMP%`

## 7. 当前重点方向
1. 继续提升 Browser Agent 在上传、输入、提交阶段的泛化能力与证据判定
2. 稳定聊天面板里的当前任务 / 后台任务体验，包括刷新恢复、blocker 继续和记忆回流
3. 稳定远程 IM 会话、附件消费与断线恢复体验
4. 继续完善 Design / Video 的编辑细节与导出链路
5. 继续收紧 AI 供应商切换时的协议、工具、视觉能力兼容
