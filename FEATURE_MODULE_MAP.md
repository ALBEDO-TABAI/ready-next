# Feature Module Map

> Updated: 2026-04-17

## 模块清单
| 模块 | 前端入口 | 主进程模块 | 状态 |
|---|---|---|---|
| 浏览器 Browser | `src/renderer/pages/modes/BrowserMode.tsx` | `src/main/modules/browser-engine` | 可用，持续优化 Agent 泛化 |
| 文稿 Document | `src/renderer/pages/modes/DocumentMode.tsx` | `src/main/modules/document-engine` | 可用 |
| 设计 Design | `src/renderer/pages/modes/DesignMode.tsx` | `src/main/modules/design-engine` | 可用，持续迭代 |
| 剪辑 Video | `src/renderer/pages/modes/VideoMode.tsx` | `src/main/modules/video-engine` | 可用，持续迭代 |
| RSS | `src/renderer/pages/modes/RSSMode.tsx` | `src/main/modules/rss-engine` | 可用 |
| 日程 Calendar | `src/renderer/pages/modes/CalendarMode.tsx` | `src/main/modules/calendar-engine` | 可用 |
| Agent / AI 中控 | `src/renderer/components/agent/ChatPanel.tsx` | `src/main/modules/claude-bridge` | 可用，持续迭代 |
| 会话控制 / 远程 IM | `src/renderer/components/agent/*` | `src/main/modules/agent-control` | 可用，持续迭代 |
| 技能中心 / 运行时 | `src/renderer/components/layout/SkillsCenterPanel.tsx` | `src/main/modules/skills-runtime` | 可用 |
| 应用工具层 | 无独立页面 | `src/main/modules/tools` | 可用 |
| AI 设置 / 供应商配置 | `src/renderer/pages/Settings.tsx` | `src/main/modules/settings-engine` + `src/shared/ai-providers.ts` | 可用 |

## 共享壳层与通用层
- 布局壳层：`src/renderer/components/layout/*`
- 通用 UI：`src/renderer/components/ui/*`
- 状态管理：`src/renderer/stores/*`
- 共享配置 / 类型：`src/shared/*`
- 预加载桥接：`src/preload/index.ts`

## 技能分层
- 系统级技能：embedded skills，随应用资产一起分发
- 用户级技能：custom skills，支持导入、移除、说明更新与运行调度
- Skill tools：由 `skills-runtime` 动态转换为 `skill_*` 工具，供 Agent 直接调用

## 重要现状
- 旧 `image` 模式已下线，统一为 `design`
- Browser Agent 主线是 V7 任务图执行与证据复核
- Agent Control 现在额外承载 session recall 主链：历史会话索引、旧会话胶囊引用、本地向量召回
- Agent Control 现在还承载 task projection 真值、父子任务关联和 run-scoped cleanup registry
- Agent Control 现已新增 `ToolRuntime`：工具批执行、恢复结果包装、cleanup 回收与结构化工具结果真相都收口在这一层
- AI 配置已从“按 provider 写死”过渡到“工作区预设 + 当前生效配置 + 能力层解析”
- 设置页模型入口已收敛为 `OpenAI / Anthropic / Gemini / 自定义`
- 聊天区模型切换只展示 `showInChatSwitcher = true` 的预设
- `fox` 这类 OpenAI 兼容通道在工具调用上默认走文本桥接降级
- `src/main/modules/tools` 继续只负责各 domain tool dispatch；旧字符串结果会在 executor 层统一包装成结构化结果后再回到主链
