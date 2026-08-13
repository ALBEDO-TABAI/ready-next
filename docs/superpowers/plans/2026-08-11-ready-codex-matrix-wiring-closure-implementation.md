---
title: Ready 与 Codex Matrix Runtime 接线收口计划
date: 2026-08-11
status: in-progress
enforce: true
---

# Ready 与 Codex Matrix Runtime 接线收口

## 目标

一次性核对 Ready 与 Codex 内核之间的全部跨层接线，并以本机 ChatGPT Matrix Runtime 的成熟身份与生命周期做法作为对照，成组修复 Ready 应用层的遗漏。Codex 内核已经提供的能力必须直接使用；只有 Ready 独有的会话、任务、Browser、文档、权限和界面需要在应用层适配，不为内核再造第二套状态机。

本轮禁止按单个报错或截图逐个打补丁。每发现一个缺口，必须先沿同一身份、状态与恢复边界查完所有相邻入口，并在下表归类后成组修复；只有当随包 Codex 内核与 Matrix 对照都证明没有可复用能力时，才允许在 Ready 增加新的产品层机制。

本计划不是功能追赶清单。Matrix 当前随包内核为 0.147 alpha，Ready 固定内核为 0.146.1；只借鉴两边共同需求下的稳定原则，不能把版本差集、远程主机、终端或工作树等 Matrix 专属功能当成 Ready 缺陷。

## 完成标准

1. 下表每个接线域都有 Ready 权威入口、Matrix/内核对照、当前结论和行为门禁；不存在“以后再查”的空白项。
2. 任何跨 Renderer、Main、数据库、app-server 和 Browser 子任务的动作，都以同一个 `readyRunId + codexThreadId + codexTurnId` 归属；旧轮事件、停止结果或工具结果不能碰新轮。
3. 启动、发送、流式回复、工具调用、用户确认、停止、终态、恢复、压缩和设置变化都只消费一个持久真值；不靠 Renderer 猜测，也不靠重启解锁。
4. 每个已证实缺口先有真实入口反例，再做最小修复；普通 Node 跳过的 SQLite 用例必须用 Electron ABI 跑通。
5. 全部自动门禁通过，独立对抗审查的 P0/P1/P2 全部清零，然后重算 runtime manifest 并产出经校验的当前源码安装包。`/Applications/Ready.app` 的真实资料、天气、BrowserView、停止和冷重启复测由用户在出包后手工完成，本计划不得冒充这部分已验收。

## 参考原则

- **身份只解析一次**：Matrix 从当前 turn 投影得到精确 thread/turn，再把这组身份贯穿 interrupt；Ready 从持久 admission 得到精确 alias generation/run/thread/turn，再贯穿发送、工具、停止和 closeout。
- **迟到结果按原轮处理**：旧 turn 的完成、错误、工具回执和停止 Promise 只能结束原轮，不能重新解析“当前轮”。
- **内核协议由随包 schema 决定**：合法通知要接收或明确 passive；未知通知仍失败关闭。不能按 Matrix 0.147 的方法名盲目扩白名单。
- **产品终态由 Ready 原子收口**：Codex terminal 不是 Ready parent、Browser child、消息和 fence 已完成的同义词；这些产品状态要在同一持久事务中结束。
- **恢复先重建所有者再开放操作**：Main/Renderer 冷启动都必须从持久 run 恢复同一运行身份，不能只恢复监控而丢失停止句柄或界面投影。
- **应用层只做适配**：推理、模型循环、工具选择和 turn interrupt 交给 Codex；Ready 只负责模型设置映射、权限、资源、Browser、持久账本和界面投影。

## 全量接线矩阵

| 域 | Ready 权威入口 | Matrix / 内核对照 | 当前结论 | 必须通过的行为门禁 |
| --- | --- | --- | --- | --- |
| 1. 随包二进制与握手 | runtime manifest、sidecar supervisor、app-server client | 单一 app-server connection 与 protocol schema | 已修源码版本权威与受控协议错误记录；最终 manifest 留到收口时统一重算 | 包内二进制/manifest/initialize 版本一致；协议错误保留 code+method |
| 2. 认证、模型与推理设置 | AI settings、gateway profile、turn collaboration settings | 当前 host/account/model projection | 已修：每轮冻结非密路由，密钥可轮换；活动任务阻止路由改写/删除；OAuth 的配置、凭证和本地服务共用一条生命周期队列，并在写凭证前先封住新准入 | API/OAuth 各一条真实请求；OAuth 授权、断开、切换并发时不换号、不复活旧配置 |
| 3. conversation alias 与 generation | conversation scope、start identity、ingress admission | conversation 投影只定位当前 thread | 已修：原生 thread generation 与可见上下文 epoch 分轴持久化；停止、Browser verifier nonaccept 或发布分歧只换 generation 并保留历史，重置才在同一事务内同时推进 generation 与 context epoch；admission 事件和最终返回回传真实双轴身份 | 无 active generation 冷启动发送后立即可停止；停止后的下一条输入保留历史并进入合法 successor；重置前旧写入不能进入新上下文 |
| 4. 用户输入与原子 admission | sendScoped、prepared run、atomic ingress | 输入被接受后才创建 active turn projection | 已修：用户正文、附件、当前文档、技能、模型快照、run/generation/context epoch 在同一准入边界冻结；Main 在持久化前后都重验 | 被拒输入不落消息；已接收输入同时冻结 run/generation/context epoch/资源/设置；切会话或重置期间完成的旧附件读取与发送不得回流 |
| 5. thread start/read/resume | lifecycle adapter、resume authority、input builder | 同一 client/connection 下 read→resume | 已有严格身份链 | connection/manifest/thread 任一漂移都在 turn 前失败，正常恢复可续用 |
| 6. turn start 与模型循环 | native runtime、turn collector、gateway authority | `turn/start` 后按精确 turn 处理事件 | 已接；预算最终答复槽已修 | 工具预算耗尽后仍有无工具最终答复；不得扩大动作额度 |
| 7. 通知与流式投影 | native normalizer、app-server client、Renderer runtime driver | Matrix 按 exact turn 更新 projection | 已按随包 0.146.1 schema 闭合 projected/passive/rerouted/opt-out；流、错误、工具与终态均按精确 run 拒绝迟到事件 | 合法 passive 不断链；正文/错误/终态只更新精确 run；旧事件全 no-op |
| 8. 工具面与工具回执 | frozen tool surface、tool bridge、action receipts | turn 内工具调用按 call/turn 归属 | 已修：动作回执与响应交付分账；响应写回前断线时只在新连接上回放同 run/thread/turn/call/tool/args 的已确认结果，每次交付有独立 intent/ack，绝不重执行动作 | 入站工具面与执行授权同摘要；写回失败后新连接恢复同 call，动作执行次数仍为 1，终态发布从精确交付记录重算 |
| 9. 技能与动态能力 | selected skill snapshot、native skill input、skill bridge | Matrix 原生 skill input | 已修：稳定 host 指令不再嵌技能正文；显式/选中技能由 Main 校验后走原生 skill input；Browser 在 turn 前结构化解析 | 选技后的可用能力与实际执行面一致；技能内容漂移在 turn 前拒绝 |
| 10. 用户确认与行动授权 | frozen call、confirmation store、Renderer card | Matrix 的 approval resolver 是进程内状态，连接销毁后拒绝全部 pending | 已修：冷启动在 product recovery 前取消旧 frozen call 与 ask-user 卡；只有 exact identity 可在同一事务内局部终结原 run/child/fence，无身份、错 run 或已终态只取消卡且不触碰新 run | 错 run/scope/args 不可放行；重启后旧卡明确取消、动作执行 0 次、原 run/child/fence 同步终态且其他会话可继续 |
| 11. Browser 工作流与原生覆盖层 | BrowserActionExecutor、journal、BrowserView host | Matrix 不具备 Ready 同形产品层，仅借鉴 turn 归属 | 已修：动作 journal、观察屏障、研究覆盖、tab/host 覆盖层与 fresh verifier 共用 exact run 身份；复核前候选不流向 Renderer。Codex 0.146.1 无 non-user successor，因此 nonaccept 保存 exact verifier receipt、同事务退役含隐藏候选的旧 thread，只由下一条真实用户输入创建空 native root | 新标签不抢前台；每个 mutation 有后续观察；网页不穿插 DOM；accept 只发布一次，nonaccept 正文为 0 且下一真实输入进入空 successor |
| 12. 文档、附件与当前资源 | message composer、resource envelope、current document anchor | Matrix 原生 image/audio/mention/skill input | 已修：Renderer 只发无正文选择，Main 重验真实路径/类型/摘要；图片、音频、文档、目录、当前文档均有结构身份，未支持入口不再宣称可用 | 各类型真实发送；内容变化必变摘要；未支持类型在发送前可见失败 |
| 13. 停止、重置、关闭与压缩 | lifecycle IPC/adapter/repository | Matrix interrupt 贯穿 exact threadId+turnId，no-active 幂等 | 已修：stop 必须携带点击时的活动 run，close/reset 只在 idle 允许 run 为 null；运行态先持久冻结身份及 `action=stop / close / reset`，再中止同一 run，冷恢复按该 action 继续。close 同事务 tombstone scope，reset 同事务推进 generation 与 context epoch；退役原生 thread 在同事务生成持久归档待办，并在精确空闲读回后执行 | A 的迟到动作绝不处理同代 B；运行中、终态待收口与三种 idle 状态均可真实操作；提交后崩溃仍能完成关闭/重置/归档且不会复活旧 scope |
| 14. 产品 closeout 与 Browser child | canonical closeout participant、checkpoint repository、durable verifier attempt | turn terminal 后按同一 turn 发布完成 | 已收紧 Browser 路径：候选在复核前不流向 Renderer；付费复核先写 exact attempt，并发观察只共享一个 job，冷恢复不重发；只有同事务重读到 settled accept 才发布成功。所有 nonaccept 保存 exact receipt、不写 checkpoint/resume，退役含隐藏候选的旧 native thread，下一真实输入自动建新 generation/root。engine-terminal 复核期间的用户停止先持久化 exact interrupt，再中止同 run/scope/alias 的活跃信号，最后以 `cancelled_user` 单次收口；找不到精确活跃所有者时失败关闭，不伪报停止成功 | accept：Browser delta=0、canonical=1、receipt/identity/seal 事务内一致；nonaccept：候选正文0、parent/run/child/fence原子终态、旧thread退役、新输入generation+1；重试/冷恢复provider调用总数仍为1；deferred verifier 停止后 signal 已中止、迟到 provider 不得 accept/发布且后续 run 不受影响 |
| 15. Main 冷启动恢复 | boot reconciler、product boot recovery、process lease | 重新加载当前 thread/turn projection | 已修：恢复精确 fence 后重建同一 Ready active-run handle，并按 run/generation 精确释放 | 跨 Main 运行仍能立即停止；终态/换代后句柄精确释放 |
| 16. Renderer 冷启动与会话切换 | lifecycle snapshot、scope events、session slices、根监听 owner | UI 从持久 current turn projection恢复 | 已修：持久 lifecycle snapshot 精确回填；runtime-ready 用 push+pull 补冷启动丢边；scope、run、卡片和异步资源结果同时核对 generation、context epoch 与本地 authority，关闭 tombstone 阻止迟到列表/事件复活。reset/close 持久成功后经单一 Main 同步收口清理远程合并入站、Browser claim、技能/授权/续跑上下文、交互卡与快照；持久身份读回不精确时失败关闭 | 冷启动可见真实 running/terminal 状态；后台轮、旧 context 与切换前的附件/预览/搜索结果不串会话；关闭后重启不再出现幽灵 scope |
| 17. 错误、重连与可观测性 | lifecycle error、gateway/sidecar metrics、UI soft error | 协议/连接错误按 host/turn 分类 | 已修：sidecar 由单一有界恢复 owner 接管，旧 lease 结算后才重启；工作台启动与 Agent 首启解耦，预算耗尽后可显式重试 | Main 调用有 start/done；用户看得到可操作错误；瞬时服务失败同进程可恢复；局部旧 run 不关闭全局 ingress |
| 18. IPC 与发布边界 | shared contracts、preload、Main handlers、Renderer types | 单一 typed bridge | 已修条件注册常量识别并重锚 Browser typed forwarder，`verify:ipc-contract` 真绿 | shared/Main/preload/Renderer 四边一致；IPC gate 真绿且无过期 allowlist |

## 修复顺序

1. 身份与生命周期：generation、exact run stop、Main/Renderer 冷启动所有者恢复。
2. 协议与投影：initialize 元数据、合法通知、迟到 stream/error/tool/terminal 的 run-CAS。
3. 工具与资源：工具面、技能、确认、附件/当前文档的真实可用性。
4. Browser 与 closeout：动作—观察—研究证据—最终消息—子任务/fence 的完整闭环。
5. IPC、原生数据库门禁、P0/P1/P2 对抗审查清零、manifest 重算与出包校验。安装后实机复测不是本计划的自动完成项。

当前状态仍为 `in-progress`：接线修复已进入最终门禁与对抗审查；只有审查 P0/P1/P2 清零、最终 manifest 与安装包校验完成后才能收口，本文不声称已出包或已手工复测。

任何一层仍需靠重启、切会话、清数据库或手工改状态才能恢复，都视为未完成。
