# Ready 项目说明

> 更新时间: 2026-03-07

## 1. 产品目标
Ready 是一个桌面创作工作台，目标是把以下工作流统一到一个应用内：
- 浏览与检索（Browser）
- 文稿编辑（Document）
- 设计编辑（Design）
- 视频剪辑（Video）
- RSS 信息流处理（RSS）
- 日程管理（Calendar）
- AI Agent、技能与远程协作（Agent / Skills / Remote IM）

## 2. 当前模块状态
- 浏览器：多标签 BrowserView、书签/历史/下载/打印、右键菜单、Browser Agent V7 任务图执行框架
- 文稿：多标签、多格式读写，支持 `document_*` 工具链做真实编辑
- 设计：`DesignMode` 已替代旧 `ImageMode`，TLDraw 画布与设计侧组件链路已接入
- 剪辑：Remotion 预览、时间轴与 Inspector 结构已形成
- RSS：订阅、更新、分析、统计与子代理链路可用
- 日程：日/周/月视图与事件 CRUD 可用
- Agent：统一会话 scope、工具调用、技能运行时、远程 IM 基础链路已接入
- 技能中心：支持系统级 embedded skills 与用户导入 custom skills 并行管理
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
AI 配置不再只按 provider 名称分支，而是统一解析为：
- `agentProtocol`
- `wireApi`
- `supportsToolCalls`
- `supportsNativeToolCalls`
- `toolCallTransport`
- `supportsVision`
- `supportsNativeVideo`

### 3.3 工具兼容策略
- 原生支持 function tools 的通道优先走原生工具调用
- 对不稳定或不暴露原生 tools 的 OpenAI 兼容通道，回退到文本工具桥接
- Browser、Document、System、Skill 工具都从同一套工具注册中心暴露

## 4. 技术栈
- Electron 34
- React 19 + TypeScript 5
- Vite 6 + electron-vite
- Zustand
- Tailwind CSS v4 + CSS Variables
- SQLite（better-sqlite3）
- TLDraw
- Remotion
- Tiptap / Univer / Mammoth / XLSX / react-pdf

## 5. 目录入口
- 主进程入口：`src/main/index.ts`
- 预加载入口：`src/preload/index.ts`
- 渲染入口：`src/renderer/main.tsx`
- 应用路由：`src/renderer/App.tsx`
- AI 能力配置：`src/shared/ai-providers.ts`

## 6. 当前关键日志
- Agent / 浏览器决策：`/tmp/ready-directchat.log`
- 工具执行 / Browser Agent 阶段：`/tmp/ready-tools.log`
- BrowserView / popup / 导航：`/tmp/ready-browser.log`

## 7. 当前重点方向
1. 继续提升 Browser Agent 在上传、输入、提交阶段的泛化能力与证据判定
2. 稳定远程 IM 会话、附件消费与断线恢复体验
3. 继续完善 Design / Video 的编辑细节与导出链路
4. 继续收紧 AI 供应商切换时的协议、工具、视觉能力兼容
