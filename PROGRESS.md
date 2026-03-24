# Ready 开发进展

> 更新时间: 2026-03-25

## 当前真值摘要
1. 当前基线是本地 `main`。
- 本地相对 `origin/main` 为 `ahead 29`。
- 这条基线已经吸收了 agent/runtime 拆分、browser service 化、repository 基线拆分、module handler 独立化、RSS runtime 与 browser-backed acquisition 的主要改动。

2. Agent/runtime 底座已经落地到可继续迭代的状态。
- `useAgent` 不再独自承担整条执行链。
- 运行态按 `runId + scopeId` 路由。
- runtime routing、message composition、module execution、scope-run patching 已拆入独立模块。

3. Browser 主干已经完成第一轮架构收口。
- main-process browser 逻辑已拆成 shell、lifecycle、preview、automation、data、diagnostics、download、session policy、layout 等 services。
- renderer 侧 browser shell、layout、diagnostics entry 已从页面容器中拆出。
- preview/context-menu/browser overlay 相关层级问题已处理过一轮。

4. Repository 基线已经建立。
- browser/chat/rss/calendar/settings/agent 的主要访问路径已不再依赖旧式跨域 `getDatabase()` 直连。
- 之前的 `database.ts` 静态/动态混合导入告警已清掉。

5. Workbench 基线已收敛到 4 个稳定子模式。
- `useMode` 当前只维护 `browser / document / rss / calendar`。
- `WorkbenchModeOutlet`、tabs/chrome、split view 与 `/ready` 协作壳层都已对齐到这 4 条主链。
- 独立 `design / video` 工作台模式已退出当前活跃基线，相关能力分别下沉到文档生成式 UI、多模态附件与 skill workflow。

6. RSS 已经具备独立维护条件。
- packaged/runtime RSSHub 可观察、可修复、可诊断。
- route diagnostics 和 benchmark 结果会持久化。
- browser-backed acquisition 已切到优先复用应用内浏览器路线。
- 单源刷新语义、`lastFetchInvocation` 诊断、preview 关闭覆盖 RSS 面板 bug 都已收口。

7. Skill runtime 已完成 Claude workflow 执行底座升级（2026-03-15）。
- 新增 `skill-execution-types.ts`、compiler / loader、execution state store、execution coordinator、prompt builder。
- embedded skills 已拆分为 `workflow / advisory / direct` 兼容模式：
  - `video-copy-analyzer`：workflow
  - `video-expert-analyzer`：workflow
  - `lets-go-rss`：advisory + direct runtime utility
- 新增 `skill_get_state / skill_submit_input / skill_submit_confirmation / skill_submit_agent_result / skill_restart_from_step / skill_cancel_execution`
- 新增 `system_run_embedded_python`
- skills center 已新增 Recent Executions 和 blocker 继续入口
- direct-chat 已加入视频输入下的 skill/python tools 保留策略，以及 OpenAI tool history repair

8. C 类安全清扫已进入收口阶段（2026-03-18）。
- 已开始清理根文档、模块图、结构快照和低风险工具注册中的过期 `design / video` 真值。
- 当前策略是优先处理“不改行为、但会误导后续开发和排障”的残留，再评估更深层的兼容代码瘦身。
- 2026-03-19 已补上本轮关键 fail-fast 收尾：
  - 工作区重选目录会真正切换到新目录，不再只把目录加入固定列表。
  - 文档模式对外部删除 / stat 失败会显式显示“无法打开文档”。
  - browser data IPC 的下载/历史/打印错误路径已统一到 shared error helper。
  - 文件树 / Ready 文件面板 / 拖拽分类 / 旧样式里的 `design` 残留已继续清掉一轮。
  - Browser 模式创建标签页失败时会继续保留底层错误细节，不再统一塌成泛化空态提示。
  - `scopeRunState` 新增统一 error-state builder，`runtimeDriver` / `useAgent` 的重复错误构造已收口一层，并修正 `checkpointExpiresAt: null` 以前无法显式清空的问题。
  - `direct-chat` 主链里的 design tool policy 死分支已继续清理：移除失效的 `forceDesignTool / preferredDesignTool / allowMultipleDesignArtifacts` 字段、helper 和日志分支，当前主链只保留 document / browser / skill 相关策略。
  - `tool-policy-heuristics.ts` 中未再被主链消费的 design heuristic 与 design context marker 也已移除，文档 / widget / format 判断不再绕经退场的 design 判定链。
  - `MemoryRepository / UserProfileRepository / AgentPersonalityRepository` 已不再绕经 `database-accessor` 纯透传层，`database-accessor.ts` 已删除。

## 当前最高优先级
1. 文档编辑、结构化预览与 `show-widget` 更新链路继续收口。
- 2026-03-25 已完成文档模式两层收口：Markdown / TXT / DOCX 现在只保留 `源码 / 排版`，`排版` 默认打开并承担最终成品界面，`show-widget` 管理动作统一回到 `源码`。
2. Browser orchestration 与 diagnostics lab 继续补齐。
3. Skill workflow execution UX 与 embedded skill 迁移继续推进。
4. `PromptAssemblyService + L0/L1/L2 memory` 与 `Feishu capability replacement` 仍是底座主线。
5. C 类安全清扫继续完成：清除已下线模式的误导性文档和低风险注册残留。

## 当前未完成项
- Weibo/Xiaohongshu/Douyin 仍未全部完成最终实机签收。
- Workbench 顶部三行在各模块下仍需最后一轮视觉对齐。
- Browser diagnostics 仍是 panel，不是完整 lab。
- Browser orchestration 仍有最后一层收口空间。
- skill workflow 仍缺少更细的 execution UX 打磨与更多样例 skill 迁移。
- 文档 widget / preview / precise edit 仍需更多回归用例。
- 文档模式虽然已收口为 `源码 / 排版`，但排版界面和未来导出链路仍值得继续做视觉和一致性打磨。
- C 类安全清扫仍有更深层兼容代码可评估，但本轮先以低风险真值对齐为主。
- C06 方向仍可继续评估，但当前 repository 已去掉 `database-accessor` 这类纯透传层，剩余主要是 `app-settings / memory / user-profile / agent-personality` 等仍带有数据映射或领域职责的层。
- **`PromptAssemblyService + L0/L1/L2 memory` 还未启动**（下一阶段主线）。
- **Feishu capability replacement 还未启动**（下一阶段主线）。

## 建议的继续顺序
1. 先完成 C 类安全清扫，统一当前真值。
2. 再继续文档 widget / preview / precise edit 的收口与回归。
3. 然后处理 Browser orchestration 和 diagnostics labs 完整化。
4. 最后回到底座主线：
   - `PromptAssemblyService + L0/L1/L2 memory`
   - `Feishu capability replacement`

## 最近一次有效校验
- `npx tsx@^4.19.2 --test src/__tests__/document-view-modes.test.ts` 通过
- `npm run typecheck` 通过
- `npm test` 通过，当前全量为 `308` 个测试
- `npm run build` 通过
- `npm run typecheck:node` 通过
- `npm run typecheck:web` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-engine-services.test.ts src/__tests__/c-class-cleanup-contract.test.ts src/__tests__/ipc-handlers.test.ts src/__tests__/stores.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/scope-run-state.test.ts src/__tests__/stores.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/direct-chat-design-cleanup.test.ts src/__tests__/document-widget-target-context.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/direct-chat-design-cleanup.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/repository-flattening.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/skill-compiler-smoke.test.ts src/__tests__/skill-resolver-smoke.test.ts` 通过
- `python3 -m py_compile` 已校验新 wrapper 脚本语法

## 体积基线
- 仓库总大小：`2.7G`
- `logs`：`1.0M`
- `out`：`24M`
- `dist`：`924M`
