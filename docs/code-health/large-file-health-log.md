# 代码行数健康度台账

> 更新时间：2026-10-02

这份台账记录“任务给代码文件增加行数后，文件总行数已超过 1000 行”的健康度评估。它不是按行数自动要求拆分，而是把真正影响维护、验证和协作的风险持续留下来。

## 触发与更新

1. 任务收尾前，用本次差异找出有新增行的代码文件，并检查修改后的物理总行数。
2. 总行数不超过 1000 行，不进入台账；超过 1000 行，必须评为危险、一般或健康，并新增或更新记录。
3. 生成物、锁文件、第三方 vendored 文件不参与评估；如果任务修改了生成器源码，评估生成器本身。
4. 同一文件以后再次触发时，更新总行数、判断和行动；不能只沿用旧结论。

## 分档标准

- 危险：文件已经混合多个独立职责，或体量正在明显妨碍定位、验证、并行修改和提交边界。当前任务不顺手大拆，但任务结束时必须提醒用户可能需要拆分重构，并在台账留下建议边界。
- 一般：文件仍有清楚的主职责和可验证边界，但继续增长会放大维护成本。必须写明计划复查日期和复查目标。
- 健康：文件虽超过 1000 行，但主要是单一职责的声明、映射、合同或机械聚合，且有可靠自动检查；拆分收益不足。记录结论即可，不安排处理。

## 当前记录

| 评估日期 | 任务 | 文件 | 总行数 | 本次新增 | 结论 | 判断与后续动作 | 状态 |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| 2026-10-02 | 设置页视觉重整 | `src/renderer/styles/settings-surfaces.css` | 1295 | 新文件 +1295 | 健康 | 设置页单一设计系统表：`--sx-*` token（明/暗/实色三套）+ `sx-*` 组件类，只承担设置页的材质、控件状态与强调色纪律；组件类在 `@layer components`，级联层 gate 与 `settings-liquid-glass-contract` / `settings-design-system` 测试在位，拆分收益不足。 | 无需处理 |
| 2026-09-29 | 项目目录收尾与停止修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 5590 | 净 +1 | 危险 | 仅对齐直接停止与实时 lifecycle 的隐藏回答历史规则；生产装配仍过密，后续独立拆分。 | 后续拆分；交付时提醒 |
| 2026-09-29 | 项目目录收尾与停止修复 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 10662 | 本修复有新增 | 危险 | 本轮仅纠正未声明文件输出时的收口条件；原有大仓库仍混合准入、交付与恢复职责，后续单独拆分。 | 后续拆分；交付时提醒 |
| 2026-09-29 | 项目目录收尾与停止修复 | `src/__tests__/codex-browser-verifier-closeout-native.test.ts` | 1794 | 本修复有新增 | 一般 | 补完整目录准备条件，验证普通回答可收口。2026-10-29 复查按历史与复核职责拆分。 | 已排期：2026-10-29 |
| 2026-09-29 | 额度恢复与资源输入续聊 | `src/__tests__/codex-browser-verifier-closeout-native.test.ts` | 1730 | 本修复有新增 | 一般 | 复用已有终态夹具，覆盖额度失败与资源回读后的真实持久收口。2026-10-29 复查是否按历史与复核职责拆分测试。 | 已排期：2026-10-29 |
| 2026-09-29 | 聊天项目选择器 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 5589 | 净 +15 | 危险 | 项目选择只增加准备/准入接线；已有组合根仍混合准入、历史与恢复，后续按这些边界拆分。 | 后续拆分；交付提醒 |
| 2026-09-29 | 聊天项目选择器 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 1938 | 净 +4 | 一般 | 仅委派目录保存；2026-10-29复查宿主服务边界。 | 已排期：2026-10-29 |
| 2026-09-29 | 聊天项目选择器 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1332 | 净 +1 | 一般 | 仅依赖接线；2026-10-29复查按组注册。 | 已排期：2026-10-29 |
| 2026-09-29 | 聊天项目选择器 | `src/preload/index.ts` | 1539 | 净 +2 | 一般 | 仅增加一条目录选择透传；2026-10-29复查按域声明。 | 已排期：2026-10-29 |
| 2026-09-29 | 聊天项目选择器 | `src/renderer/types/electron.d.ts` | 3543 | 净 +2 | 健康 | 单一跨进程声明，类型与IPC合同检查通过。 | 无需处理 |
| 2026-09-29 | 聊天项目选择器 | `src/__tests__/codex-binding-repository-native.test.ts` | 9116 | 净 +8 | 一般 | 复用生产准入用例验证更换项目拒绝旧请求且不落库；2026-10-29复查按场景拆套件。 | 已排期：2026-10-29 |
| 2026-09-07 | 安装版历史失败恢复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 5574 | 净 +3 | 危险 | 仅补齐既有恢复资格消费和原生额度错误呈现；组合根仍混合准入、历史、恢复与收口。沿既定边界拆分，当前不扩大故障修复范围。 | 后续拆分；交付时提醒 |
| 2026-09-06 | 登录与微信连接进度 | `src/preload/index.ts` | 1537 | 净 +2 | 一般 | 只增加登录取消/重开和当前微信状态的透传；业务状态留在 Main。2026-10-06 复查按域接线增长。 | 已排期：2026-10-06 |
| 2026-09-06 | 登录与微信连接进度 | `src/renderer/types/electron.d.ts` | 3541 | 净 -6 | 健康 | 删除重复 OAuth 状态声明，统一引用共享合同；新增方法与当前会话查询有 IPC/typecheck 检查。 | 无需处理 |
| 2026-09-06 | 登录与微信连接进度 | `src/python/ready_sidecar/channels/wechat_openclaw_adapter.py` | 1175 | 净 +10 | 一般 | 微信传输单一域，本次只调整停止与扫码终态。2026-10-06 复查将媒体编解码移至现有同域模块的必要性。 | 已排期：2026-10-06 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 5571 | 本批净增，已检查 | 危险 | 本次只委托远程初始 head 的原子创建，新增逻辑位于独立叶子；组合根仍集中 admission/history/recovery，沿用既定拆分边界。 | 后续拆分；交付时提醒 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 1934 | 本批净增，已检查 | 一般 | 只连接远程收发、当前准入快照和停止入口；业务判断下沉至远程服务与独立入口。 | 2026-10-05 复查远程生命周期接线 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1331 | 本批净增，已检查 | 一般 | 仅绑定本人配对入口到既有 IPC 分组，无内联配对逻辑。 | 2026-10-05 复查分组接线 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/main/modules/migrations.ts` | 4486 | 本批净增，已检查 | 健康 | 按既有顺序添加 123 迁移；业务持久化从 DatabaseManager 迁出到远程事件仓储。 | 顺序迁移与原生门禁持续覆盖 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/preload/index.ts` | 1535 | 本批净增，已检查 | 健康 | 只增加配对请求透传，仍为声明式 API 汇总。 | IPC 对称检查持续覆盖 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/python/ready_sidecar/channels/wechat_openclaw_adapter.py` | 1165 | 本批净增，已检查 | 一般 | 同一微信协议的扫码、收信和媒体功能边界清楚；本次加身份恢复、游标提交与凭据撤销，已有 Python 行为覆盖。 | 2026-10-05 复查扫码与媒体边界 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/renderer/components/settings/RemoteIMSettingsPanel.tsx` | 1011 | 本批净增，已检查 | 一般 | 按渠道组织设置，增加本人绑定、真实连接状态和扫码取消；未扩展其他渠道。 | 2026-10-05 复查渠道面板分拆 |
| 2026-09-05 | 微信飞书远程可靠性 | `src/renderer/types/electron.d.ts` | 3545 | 本批净增，已检查 | 健康 | 新增配对结果声明，与 Main 和 Preload 同步。 | 类型检查持续覆盖 |
| 2026-09-05 | 历史续聊复查与包体来源交接 | `scripts/run-history-continuation-installed-proof.mjs` | 1644 | 从1776行缩减并补全旧头/重放覆盖 | 一般 | fresh-root 独立场景已拆到现有脚本子目录，复用正式发送与同一请求捕获器；入口保留资料隔离、全分母和清理。2026-10-05 复查剩余独立资料准备逻辑。 | 已排期：2026-10-05 |
| 2026-09-05 | 空白旧头及上下文边界升级 | `src/main/modules/migrations.ts` | 4480 | 本轮增加122号迁移 | 健康 | 单一顺序迁移目录；复用同一边界定义和刷新guard，不回填旧记录，不引入第二套升级真值。 | 无需处理 |
| 2026-09-05 | 恢复回执与当前动作一致性 | `src/shared/ipc-contracts/agent-runtime.ts` | 1406 | 边界摘要和结果关系校验 | 健康 | 单一跨进程合同聚合；同一解析器拒绝回执与当前动作身份矛盾。 | 无需处理 |
| 2026-09-04 | 安装态恢复分母、本地技能提示重放与 fresh-root 读路径修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 5572 | 本批净 +19 | 危险 | 本批只把两处续聊分支的判别式从"物化种类"换成"重播窗口是否仍开"（`freshRootRequiresReseed`），修掉已结算 fresh-root head 的读路径抛错；组合根仍过密，沿用 history / recovery / admission 拆分方向。 | 后续拆分；交付时提醒 |
| 2026-09-04 | 安装态恢复分母、本地技能提示重放与 fresh-root 读路径修复 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 1898 | 本批净 +14 | 危险 | 本批只在 `sendScoped` 入口重放本地 scope 的持久化技能提示（此前只有远程 `ensureChannelScope` 消费该字段）；运行服务仍是多产品组合根。 | 后续拆分；交付时提醒 |
| 2026-09-04 | 安装态恢复分母、本地技能提示重放与 fresh-root 读路径修复 | `src/__tests__/codex-binding-repository-native.test.ts` | 9070 | 本批净 +26 | 一般 | 本批只补 fresh-root 判别式分裂的仓库级断言（种类不变、重播窗口关闭、窗口外调用继承合同即报错）。复查日期沿用 2026-10-04。 | 已排期：2026-10-04 |
| 2026-09-04 | 历史会话续聊、草稿编辑与恢复闭环 | `src/__tests__/codex-binding-repository-native.test.ts` | 9044 | 本批净 +282 | 一般 | 本批新增"生产 ingress 经真实仓库准入 fresh-root tail 并跨重启"整链回归，并让 recovery fixture 支持 admission 覆盖。2026-10-04 复查按 continuity / recovery / action-surface 拆成独立套件。 | 已排期：2026-10-04 |
| 2026-09-04 | 历史会话续聊、草稿编辑与恢复闭环 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 10648 | 本批净 +646 | 危险 | 本批接入 boundary 表读校验、同 thread 全合同预检与恢复事务的仓库侧收口；仓库仍混合多类事务。已超既定 10000 行上限，下一次净增前必须先按 continuity / boundary / action-surface 拆出叶子模块。 | 阻断性：下次净增前先拆分；交付时提醒 |
| 2026-09-04 | 历史会话续聊、草稿编辑与恢复闭环 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 5553 | 本批净 +522 | 危险 | 本批接入唯一 runtime 兼容结论、同 thread 预检、begin-new-context 签发与 profile route 具名拒绝；组合根仍过密。后续继续按 history / recovery / admission composition 拆分。 | 后续拆分；交付时提醒 |
| 2026-09-04 | 历史会话续聊、草稿编辑与恢复闭环 | `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts` | 3009 | 本批净 +40 | 危险 | 本批新增 context boundary 表及其不可变约束；高密度 schema 汇总仍待按事务边界拆分。 | 后续拆分；交付时提醒 |
| 2026-09-04 | 历史会话续聊、草稿编辑与恢复闭环 | `src/renderer/stores/useAgent.ts` | 2494 | 本批净 +198 | 危险 | 本批加入动作面单飞所有者与排队跟进读取、草稿 revision 归属和恢复入口；store 仍聚合会话、生命周期与动作面三类职责。2026-10-04 复查按 hydration / draft / lifecycle 拆分。 | 已排期：2026-10-04 |
| 2026-09-04 | 历史会话续聊、草稿编辑与恢复闭环 | `src/renderer/components/agent/ChatPanel.tsx` | 1365 | 本批净 +54 | 一般 | 本批只把发送资格与草稿可编辑性分离，并按 session 隔离 sending owner 与 notice。2026-10-04 复查 composer 与任务卡分组。 | 已排期：2026-10-04 |
| 2026-09-03 | 已有数据覆盖升级修复 | `src/main/modules/migrations.ts` | 4452 | 本批净 +7 | 健康 | 仅新增119，使用同一个网关约束定义补齐已经升级的数据库；顺序迁移目录仍是单一职责。 | 无需处理 |
| 2026-09-03 | 已有数据覆盖升级修复 | `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts` | 2969 | 本批净 +17 | 危险 | 保存历史未知证据并统一安装网关索引与新写入约束；未新增运行期兼容路径。高密度schema汇总仍待按事务边界拆分。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/codex-model-gateway-retry.test.ts` | 1277 | 本批净 +1 | 一般 | 补齐当前网关上下文参数的真实空值；未改变原有重试策略。2026-10-02复查请求合同与传输重试测试边界。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/codex-model-gateway-contract.test.ts` | 1268 | 本批净 +6 | 一般 | 补齐当前网关上下文参数的真实空值；未改变原有重试策略。2026-10-02复查请求合同与传输重试测试边界。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/codex-action-surface-event-bridge.test.ts` | 1070 | 本批净 +150 | 一般 | 单一动作面交接套件覆盖丢通知、旧读取、跨会话及未来版本下界。2026-10-02复查事件与恢复测试分组。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3545 | 本批净 +114 | 一般 | 增加真实untrusted wrapper、身份/内容/角色/顺序/当前输入篡改与HTTP上游回读。2026-10-02复查按请求校验与流处理分套件。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/codex-sidecar-crash-recovery.e2e.ts` | 1374 | 当前共享工作树净 +49 | 一般 | 只补真实进程恢复夹具的 E2 准入字段，未增加恢复路径。2026-10-02 复查崩溃场景与生命周期测试分界。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/codex-sidecar-process-lease.e2e.ts` | 1340 | 当前共享工作树净 +90 | 一般 | 只同步进程租约端到端夹具的当前准入合同。2026-10-02 与 crash-recovery 套件一并复查重复夹具。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `scripts/run-codex-context-continuity-installed-proof.mjs` | 1816 | 本批净 +87 | 一般 | 同包隔离验收增加真实Retry按钮、控制语义拒绝及后果展示。2026-10-02复查按fixture与场景拆分，保持同一包身份。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 10002 | 本批净 -94 | 危险 | 提取覆盖读取并从同一冻结prepared派生实际应交付的历史内容；无新增持久字段。其余事务仍集中，后续按事务域下沉。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/codex-binding-repository-native.test.ts` | 8648 | 本批净 +262 | 一般 | 新增真实压缩与普通覆盖的区别、先后顺序和分叉继承；合并重复失败夹具。2026-10-02复查按覆盖与事务域拆套件。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 5031 | 本批净 +12 | 危险 | 只修raw观测激活交接、事实阶段与原子拒绝清理；仍混合网关、资源和生命周期组合。后续按已有叶子边界拆分。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/migrations.ts` | 4445 | 当前共享工作树净 +107 | 健康 | 单一有序迁移目录；118 号迁移只承担本次旧数据退役和新事实表建置，并由真实 pre-118 数据库升级验证。 | 无需处理 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/renderer/types/electron.d.ts` | 3541 | 当前共享工作树净 +53 | 健康 | 只机械同步生命周期、动作投影与安装验收入口的跨进程类型，没有复制业务判断。 | 无需处理 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2813 | 本批净 +15 | 危险 | 校验一次当前上下文并把同一结果交记忆处理；仍混合HTTP、流转换、权限与响应收口。后续按已有协议边界下沉。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway-authority.ts` | 1029 | 本批净 +2 | 一般 | 只转交本次冻结的历史内容期望，仍为同一网关准入权威。2026-10-02复查是否继续保持薄转发。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts` | 2952 | 当前共享工作树净 +586 | 危险 | 本轮集中声明终态事实、fork materialization、coverage 与动作读模型，避免散落第二真相；文件已成为高密度 schema 汇总。后续随事务叶子模块拆分对应 schema。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/ready-codex-lifecycle-adapter.test.ts` | 2282 | 当前共享工作树净 +114 | 一般 | 只补当前 run 身份、旧终态拒绝与 value-based action ref 校验。2026-10-02 复查按 stop / close / reset 分组。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/renderer/stores/useAgent.ts` | 2296 | 本批净 +14 | 危险 | 复用元数据读回与原子hydrate恢复，不新增动作账本；仍集中会话与运行管理，后续按既有职责拆分。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 1868 | 当前共享工作树净 +30 | 危险 | 本轮只装配一次性 action-surface 失效通知和交互终态 fence；运行服务仍是多产品组合根。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/codex-tool-bridge.test.ts` | 1808 | 当前共享工作树净 +115 | 一般 | 只补工具结果、交互终态和同轮权限冻结的桥接回归。2026-10-02 复查按 tool result / interaction fence 拆套件。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/codex-product-boot-recovery.test.ts` | 1780 | 当前共享工作树净 +18 | 一般 | 只同步恢复 fixture 的当前终态身份；不新增恢复分支。2026-10-02 与 continuity boot 场景一并复查。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/codex-app-server-client.test.ts` | 1658 | 当前共享工作树净 +95 | 一般 | 本轮只补原生 fork 参数、无响应对账和 accepted-prefix 读回。2026-10-02 复查请求、通知和 fork 测试拆分。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts` | 1626 | 当前共享工作树净 +54 | 一般 | 本轮只让 stop / close / reset 消费同一 action ref 与 terminal facts，不新增另一套终态。2026-10-02 复查动作适配器与恢复分支密度。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1572 | 当前共享工作树净 +14 | 一般 | 只把交互请求纳入当前轮授权与终态 fence；未新增通用注册层。2026-10-02 复查注册密度。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts` | 1543 | 当前共享工作树净 +116 | 一般 | 本轮只实现 pinned runtime 的原生 fork、readback 与错误分类。2026-10-02 复查 fork transport 能否独立成窄客户端。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/codex-renderer-lifecycle-contract.test.ts` | 1724 | 本批净 +76 | 一般 | 补齐读取失败恢复、保留版本地板与陈旧owner拒绝。2026-10-02复查hydrate与失效事件分界。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/preload/index.ts` | 1528 | 当前共享工作树净 +51 | 健康 | 只机械暴露动作投影读口与失效事件，没有产品判断。 | 无需处理 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/tools/tool-executor.ts` | 1474 | 当前共享工作树净 +2 | 危险 | 本轮只把 terminal fence 绑定到已有交互工具出口；执行器仍混合多域分发。 | 后续拆分；交付时提醒 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/renderer/styles/markdown.css` | 1410 | 当前共享工作树净 +21 | 一般 | 只为语义有序列表设置局部十进制样式，不改全局 reset。2026-10-02 复查列表样式是否仍局限于消息正文。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1329 | 当前共享工作树净 +30 | 一般 | 只组装动作投影失效事件与生命周期读口；判断仍在 Main 权威层。2026-10-02 复查 IPC 组装是否继续保持薄转发。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/renderer/components/agent/ChatPanel.tsx` | 1314 | 当前共享工作树净 +51 | 一般 | 只消费当前工作台模式与动作投影，不生成第二终态。2026-10-02 复查面板与状态订阅边界。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/shared/ipc-contracts/agent-runtime.ts` | 1309 | 本批净 +2 | 健康 | 仅新增两个明确拒绝种类，保持错误分区互斥；共享声明由行为合同验证。 | 无需处理 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/codex-model-gateway-sidecar.e2e.ts` | 1307 | 当前共享工作树净 +42 | 一般 | 只在真实 app-server 链验证失败证据和连续性身份。2026-10-02 与 gateway transport 场景一并复查。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/chat-panel-baseline.test.ts` | 1273 | 本批净 +63 | 一般 | 补齐显示后果、展示引用、恢复入口及停止按钮的真实组件回归。2026-10-02复查按输入与动作呈现拆套件。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex重试入口与动作消费修复 | `src/__tests__/codex-renderer-admission-contract.test.ts` | 1180 | 本批净 +29 | 一般 | 补齐陈旧展示拒绝后的单次读取与零重发。2026-10-02复查与恢复套件边界。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/use-agent-scope-list-contract.test.ts` | 1145 | 当前共享工作树净 +261 | 一般 | 本轮只覆盖新会话、终态回读、失效事件和多 run 投影的 scope 隔离。2026-10-02 复查按动作表面与列表加载拆套件。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway-chat.ts` | 1132 | 当前共享工作树净 +22 | 一般 | 只把 terminal facts 与 wire failure record 送入唯一 closeout 输入。2026-10-02 复查 chat adapter 是否保持纯转换。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer.ts` | 1073 | 当前共享工作树净 +27 | 一般 | 只隔离旧 generation 的迟到终态、用量和工具回执。2026-10-02 复查通知分类仍保持单一职责。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/__tests__/codex-browser-verifier-closeout-native.test.ts` | 1671 | 当前共享工作树净 +716 | 一般 | 只补浏览器观察结果进入同一终态事实与 coverage 的原生回归。2026-10-02 复查是否归入 terminal-facts 专项套件。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/codex-runtime/codex-tool-binding-repository.ts` | 1038 | 当前共享工作树净 +12 | 一般 | 只让工具回执按 exact generation / run 被终态 fold 消费并拒绝旧回执。2026-10-02 复查工具绑定读口密度。 | 已排期：2026-10-02 |
| 2026-09-03 | Codex 原生连续性、终态单线与回复呈现 | `src/main/modules/agent-control/ready-memory/ready-memory-generation.ts` | 1007 | 当前共享工作树净 +19 | 一般 | 只从当前终态事实生成记忆事件，不把旧 generation 或 Retry 文案写成第二真相。2026-10-02 复查生成器输入是否仍为单一投影。 | 已排期：2026-10-02 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2667 | 本修复有新增 | 危险 | 本轮只把固定 ChatGPT OAuth 的静默等待合同绑定到冻结的 provider 身份；网关仍混合准入、请求转换与流消费，后续应按 gateway admission / upstream transport 边界拆分。 | 后续拆分；交付时提醒 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3917 | 本修复有新增 | 危险 | 本轮只透传候选态拥有的上下文快照；生产装配仍过密，沿用 product resource/action composition 下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 8243 | 本修复有新增 | 危险 | 本轮只校验终态候选中的上下文快照；仓库仍混合多类事务，沿用只读发布与准入裁决下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/renderer/stores/useAgent.ts` | 2026 | 本修复有新增 | 危险 | 本轮只在新轮准入、精确终态空闲刷新和恢复时保留已确认上下文快照；store 仍混合会话选择、加载与生命周期状态。 | 后续拆分；交付时提醒 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts` | 1478 | 本修复有新增 | 一般 | 本轮只接入 token usage 通知并补无敏感值诊断。2026-09-30 复查请求、通知解析能否分套件下沉。 | 已排期：2026-09-30 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer.ts` | 1061 | 本修复有新增 | 一般 | 仍聚焦 start 回包前的身份缓冲与失败关闭；本轮只补迟到用量通知不得占用下一轮身份。2026-09-30 复查通知分类是否继续保持单一职责。 | 已排期：2026-09-30 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/__tests__/codex-app-server-client.test.ts` | 1595 | 本修复有新增 | 一般 | 只增加 token usage 通知的精确解析与拒绝场景。2026-09-30 复查请求和通知测试拆分。 | 已排期：2026-09-30 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/__tests__/codex-model-gateway-sidecar.e2e.ts` | 1267 | 本修复有新增 | 一般 | 只在既有真实 app-server 流里读取上下文通知。2026-09-30 复查按 capability 与 telemetry 场景拆分。 | 已排期：2026-09-30 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/__tests__/use-agent-scope-list-contract.test.ts` | 1085 | 本修复有新增 | 一般 | 只补新轮保留和 idle lifecycle 竞态不清空精确终态快照的会话级合同。2026-09-30 复查是否与 admission 场景分离。 | 已排期：2026-09-30 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/__tests__/codex-renderer-admission-contract.test.ts` | 1123 | 本修复有新增 | 一般 | 只补新轮准入不清空已确认上下文的行为。2026-09-30 复查 admission 场景分组。 | 已排期：2026-09-30 |
| 2026-08-30 | Codex 上下文指示器与流静默修复 | `src/shared/ipc-contracts/agent-runtime.ts` | 1044 | 本修复有新增 | 健康 | 单一共享 IPC 合同聚合；本轮只把产品回执升级为携带上下文快照，并由主进程和 Renderer 双向测试覆盖。 | 无需处理 |
| 2026-08-24 | 已完成输出仍显示工作中修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3906 | 本修复净 +29 | 危险 | 本轮只分开环境文档捕获与本轮资源激活，并让停止竞态以持久终态读回为准；生产装配仍过密，沿用 product resource/action composition 下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-21 | 失败任务自然重试的原任务恢复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3877 | 本修复净 +8 | 危险 | 只从已有重试 lineage 冻结并透传原始任务输入；生产装配仍过密，沿用 product resource/action composition 下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-21 | 失败任务自然重试的原任务恢复 | `src/__tests__/codex-binding-repository-native.test.ts` | 7448 | 本修复净 +8 | 一般 | 只补齐显式重试 fixture 的原任务身份；仍是绑定仓库原生总套件。2026-09-21 复查时与 retry lineage 场景一并拆分。 | 已排期：2026-09-21 |
| 2026-08-21 | Runtime 长任务、Browser 观察与宠物旁白修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3869 | 本切片净 +7 | 危险 | 只把冻结 Browser 工具事实送入现有任务事实并取消生产轮次时间截止；生产装配仍过密，沿用 product resource/action composition 下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-21 | Runtime 长任务、Browser 观察与宠物旁白修复 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 8241 | 本切片净 +13 | 危险 | 只在现有 gateway 读口保留 Browser 观察位；仓库仍混合多类事务，沿用只读发布与准入裁决下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-21 | Runtime 长任务、Browser 观察与宠物旁白修复 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1312 | 本切片净 +2 | 一般 | 只把 ingress 与 exact scope run 事件转交宠物聚合器。2026-09-21 复查 IPC 组装是否继续保持薄转发。 | 已排期：2026-09-21 |
| 2026-08-21 | Runtime 长任务、Browser 观察与宠物旁白修复 | `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts` | 1456 | 本切片净 +13 | 一般 | 只把真实连接关闭广播给当前 turn collector，不增加任务计时。2026-09-21 与请求、通知解析拆分复查合并处理。 | 已排期：2026-09-21 |
| 2026-08-21 | Runtime 长任务、Browser 观察与宠物旁白修复 | `src/__tests__/codex-app-server-client.test.ts` | 1595 | 本切片净 +12 | 一般 | 只补连接真实关闭的广播回归。2026-09-21 与请求、通知分套件复查合并处理。 | 已排期：2026-09-21 |
| 2026-08-21 | Runtime 长任务、Browser 观察与宠物旁白修复 | `src/__tests__/codex-binding-repository-native.test.ts` | 7440 | 本切片净 +111 | 一般 | 本轮只补最终 Browser 位双层只读准入；仍是绑定仓库原生总套件。2026-09-21 复查拆出 Browser admission 套件。 | 已排期：2026-09-21 |
| 2026-08-21 | 宠物任务注意力状态修复 | `src/renderer/stores/useAgent.ts` | 2011 | 本修复净 +1 | 危险 | 只在会话成功呈现后发出宠物已读信号；store 仍混合会话选择、加载与生命周期状态。沿用既有会话选择边界下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-21 | 宠物任务注意力状态修复 | `src/main/modules/migrations.ts` | 4359 | 本修复净 +10 | 健康 | 单一有序迁移目录；117 号迁移只建立宠物活动首次接线 cutover，并由完整原生 SQLite 门覆盖。 | 无需处理 |
| 2026-08-21 | 宠物任务注意力状态修复 | `src/preload/index.ts` | 1497 | 本修复净 +5 | 健康 | 机械补齐 exact 宠物活动身份与 scope 已读信号，无产品判断。 | 无需处理 |
| 2026-08-21 | 宠物任务注意力状态修复 | `src/renderer/types/electron.d.ts` | 3528 | 本修复净 +2 | 健康 | 机械补齐共享宠物活动身份与 scope 已读声明，由类型检查、IPC 合同和真实 Electron 验收覆盖。 | 无需处理 |
| 2026-08-21 | Codex 上下文连续性与 harness 接线修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3862 | 本修复切片小幅增长 | 危险 | 只收口终态归因与 RSS 终态等待读回；生产装配仍过密，沿用 product resource/action composition 下沉方向。 | 后续拆分；交付时提醒 |
| 2026-08-21 | Codex 上下文连续性与 harness 接线修复 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1572 | 本修复切片净 +14 | 一般 | 只统一候选技能原语的准入/执行面并增加 RSS 等待时限类型。2026-09-21 复查注册密度。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex 上下文连续性与 harness 接线修复 | `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts` | 1443 | 本修复切片净 +16 | 一般 | 只保留工具桥可控失败的精确原因。2026-09-21 与既有请求/通知解析拆分复查合并处理。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex 上下文连续性与 harness 接线修复 | `src/__tests__/codex-app-server-client.test.ts` | 1583 | 本修复切片净 +20 | 一般 | 只补工具桥精确失败原因的连接收口回归。2026-09-21 与请求、通知分套件复查合并处理。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex 上下文连续性与 harness 接线修复 | `src/main/modules/rss-engine/item-analysis-manager.ts` | 1099 | 本修复切片净 +8 | 一般 | 只把终态等待改为有界且可读回运行/暂停真值。2026-09-21 复查作业调度与查询边界。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex 上下文连续性与 harness 接线修复 | `src/__tests__/codex-tool-bridge.test.ts` | 1808 | 本修复切片净 +69 | 一般 | 只补候选 `skill_ask_user` 的同轮执行与精确失败边界。2026-09-21 复查是否按准入、结果、连接恢复拆套件。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2649 | 本切片净 +18 | 危险 | 只收紧 0.149 的请求身份形状；网关仍混合协议、身份与上游调度，沿用既有 transport 拆分方向。 | 后续拆分；交付时提醒 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 1838 | 本切片 +4 | 危险 | 只透传现有诊断包的按需读取；运行服务仍是多产品组合根。 | 后续拆分；交付时提醒 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts` | 1427 | 本切片净 +55 | 一般 | 只增加官方诊断请求的精确解析与新通知分类。2026-09-21 复查请求与通知解析是否需要分离。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3364 | 本切片净 +8 | 一般 | 只补 0.149 root turn 伪造反例。2026-09-21 复查是否随网关拆分同步分套件。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/__tests__/codex-app-server-client.test.ts` | 1563 | 本切片净 +59 | 一般 | 只补诊断响应与 0.149 通知分类。2026-09-21 复查是否按请求、通知分套件。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/__tests__/codex-product-boot-recovery.test.ts` | 1764 | 本切片净 +2 | 一般 | 只修正已有恢复证据 fixture 与数据库合同的漂移。2026-09-21 复查。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/__tests__/codex-sidecar-process-lease.e2e.ts` | 1250 | 本切片 +5 | 一般 | 只把自动压缩的精确工具面纳入真进程验证。2026-09-21 复查。 | 已排期：2026-09-21 |
| 2026-08-21 | Codex runtime 0.149.0 采用 | `src/__tests__/codex-model-gateway-contract.test.ts` | 1262 | 本切片 +7 | 一般 | 只同步 0.149 的精确请求身份形状。2026-09-21 复查。 | 已排期：2026-09-21 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 8228 | 工作树净 +54 | 危险 | 本轮只在现有发布屏障补动作义务裁决；仓库仍混合多类事务。沿用既有拆分方向，优先下沉只读发布裁决。 | 后续拆分；交付时提醒 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/__tests__/codex-binding-repository-native.test.ts` | 7329 | 工作树净 +49 | 一般 | 仍是绑定仓库原生总套件，本轮只增加零产品动作不得发布的全链回归。2026-09-21 复查是否拆出 publication barrier 套件。 | 已排期：2026-09-21 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/modules/migrations.ts` | 4349 | 工作树净 +11 | 健康 | 单一有序迁移目录；116 号迁移只增加宠物活动的会话已读标记，由原生 SQLite 回归覆盖。 | 无需处理 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3853 | 工作树净 +154 | 危险 | 本轮只组装三个产品域的冻结义务、MCP 资源和读回端口；生产装配仍过密。后续按 product resource/action composition 下沉叶子组件。 | 后续拆分；交付时提醒 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/renderer/types/electron.d.ts` | 3526 | 工作树净 +38 | 健康 | 机械汇总的跨进程类型声明，本轮只补 MCP 目录、资源与状态读口。 | 无需处理 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1559 | 工作树净 +1 | 一般 | 公开工具注册边界未新增产品状态，只切换到 MCP ready 目录门。2026-09-21 复查注册密度。 | 已排期：2026-09-21 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/preload/index.ts` | 1492 | 工作树净 +15 | 健康 | 机械汇总的窄 IPC 暴露面，本轮只补 MCP 状态、资源目录与读取调用。 | 无需处理 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/modules/tools/tool-executor.ts` | 1474 | 工作树净 +2 | 危险 | 本轮只把产品动作请求传给现有域工具并保留 MCP 连接目录复核；执行器仍混合多域分发。 | 后续拆分；交付时提醒 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1310 | 工作树净 +15 | 一般 | 本轮只把 Main 宠物活动投影接到现有任务变更事件。2026-09-21 复查 IPC 组装是否继续保持薄转发。 | 已排期：2026-09-21 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/index.ts` | 1231 | 工作树净 +9 | 一般 | 本轮只接宠物精确会话导航，未写任务判断。2026-09-21 复查窗口导航组装。 | 已排期：2026-09-21 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/main/modules/rss-engine/item-analysis-manager.ts` | 1091 | 工作树净 +19 | 一般 | 文件仍聚焦 RSS 分析作业，本轮只补 exact job 查询与有中止信号的终态等待。2026-09-21 复查作业调度与查询边界。 | 已排期：2026-09-21 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/renderer/modules/agent/messageComposer.ts` | 1056 | 工作树净 +30 | 一般 | 本轮只把用户显式选中的 MCP 资源转成结构化选择，未在 Renderer 解析内容。2026-09-21 复查附件与资源组装的拆分收益。 | 已排期：2026-09-21 |
| 2026-08-21 | MCP、宠物与 RSS 完全接线 | `src/shared/ipc-contracts/agent-runtime.ts` | 1034 | 工作树净 +20 | 健康 | 单一跨进程合同汇总，本轮只增加冻结 MCP 资源身份。 | 无需处理 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 8269 | 在 8 月 19 日交付切片后净 +39 | 危险 | 只补记忆快照、读取回执和 cleanup 归档授权，仓库事务职责仍然过密；沿用既有拆分方向，优先下沉 presentation 与只读回执查询。 | 后续拆分；交付时提醒 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/__tests__/codex-binding-repository-native.test.ts` | 7280 | 在 8 月 19 日交付切片后净 +127 | 一般 | 仍是绑定仓库的原生数据库总套件，本轮增加记忆快照、读取回执和 cleanup 全链回归，并覆盖原生已卸载线程的真实归档授权。2026-09-20 复查是否按 memory / cleanup 独立拆套件。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3686 | 在 8 月 19 日交付切片后净 +113 | 危险 | 本轮只接记忆快照、成功会话封印和空闲 worker；生产装配仍过密，后续把 Ready memory composition 下沉为独立装配单元。 | 后续拆分；交付时提醒 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3356 | 在 8 月 19 日交付切片后净 +46 | 一般 | 增加记忆历史清除与真实请求回执边界，仍属于同一网关对抗套件。2026-09-20 复查是否把 memory history 独立成完整套件。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2631 | 在 8 月 19 日交付切片后净 +64 | 危险 | 只接请求前记忆清除与密封回执；网关仍混合协议、身份和上游调度，继续沿用既有 transport 拆分方向。 | 后续拆分；交付时提醒 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts` | 2366 | 净 +37 | 危险 | 只新增记忆快照和读取回执字段；DDL 仍聚合多个事务域，沿用既有按 binding / tool / compaction / process-lease 拆分计划。 | 后续拆分；交付时提醒 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/__tests__/ready-codex-lifecycle-adapter.test.ts` | 2168 | 在 8 月 18 日交付切片后净 +11 | 一般 | 只补成功 closeout 的记忆使用回执。2026-09-20 复查是否随 memory closeout 套件下沉。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/__tests__/codex-product-boot-recovery.test.ts` | 1762 | 在 8 月 18 日交付切片后净 +2 | 一般 | 只补启动恢复对冻结记忆快照的边界。2026-09-20 复查日期随原套件顺延。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/__tests__/codex-sidecar-crash-recovery.e2e.ts` | 1325 | 在 8 月 18 日交付切片后净 +2 | 一般 | 只补崩溃恢复时的记忆快照字段。2026-09-20 复查是否随恢复 fixture 一并收敛。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/__tests__/codex-sidecar-process-lease.e2e.ts` | 1245 | 在 8 月 18 日交付切片后净 +2 | 一般 | 只补进程租约 fixture 的记忆快照字段。2026-09-20 复查是否随恢复 fixture 一并收敛。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/main/modules/agent-control/codex-runtime/codex-tool-binding-repository.ts` | 1026 | 在 8 月 18 日交付切片后净 +24 | 一般 | 只补记忆读取回执的精确工具调用身份。2026-09-20 复查是否迁入独立 memory receipt helper。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/shared/ipc-contracts/agent-runtime.ts` | 1014 | 净 +122 | 健康 | 机械聚合的跨进程合同，本轮删除专项入口并新增窄记忆管理与 ProductTurn 读取合同，没有运行职责。 | 无需处理 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/renderer/components/agent/ChatPanel.tsx` | 1266 | 本切片净 +5 | 一般 | 文件仍是聊天面板组合宿主；本轮只在首条 Ready 对话建立后清除启动期误提示。2026-09-20 复查会话 hydration 提示能否随 store hydration 一并下沉。 | 已排期：2026-09-20 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/main/modules/migrations.ts` | 4338 | 工作树净 +94 | 健康 | 仍是单一有序迁移目录；112 号迁移只负责一次性清理，115 号迁移只结清退役执行链遗留的非终态账目，原生线程退役写入已下沉到现有迁移辅助模块，并有真实数据库副本与原生测试覆盖。 | 无需处理 |
| 2026-08-20 | 单一 Ready 身份、旧会话清理与记忆方案 | `src/renderer/stores/useAgent.ts` | 2010 | 工作树净 +11；本切片净删选择逻辑 | 危险 | 本轮删除可选 Agent 状态和替换身份入口，没有新增职责；但 store 仍集中会话 hydration、生命周期和 UI 状态，沿用既有结论，后续先下沉会话 hydration。 | 后续拆分；交付时提醒 |
| 2026-08-20 | 稳定凭据库与地图路由 | `src/main/index.ts` | 1218 | 工作树净 +31 | 一般 | 本轮只接凭据库初始化、严格孤儿回收和窗口可交互后的单次升级恢复；保存、迁移与路由逻辑均留在叶子服务。2026-09-20 复查凭据启动编排是否应下沉。 | 已排期：2026-09-20 |
| 2026-08-19 | Tag Forge 单文档准入与整批终态修复 | `src/__tests__/tag-forge-batch.test.ts` | 1381 | 净 +323 | 一般 | 仍是 Tag Forge 受控写回的单一原生数据库套件，本轮增加精确单文件授权、冲突恢复、审核重启权限、整批回读与文件漂移自恢复场景。2026-09-19 复查是否把资源授权与批次终态场景拆到独立套件。 | 已排期：2026-09-19 |
| 2026-08-19 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 8230 | 净 +765 | 危险 | 本轮在既有聚合根补统一收口、批量展示读取、旧失败修复、交付回执折叠、精确工具调用身份、重试链上的产物所有权与回收，并使当前文档读取屏障与最终冻结授权一致；事务与查询职责仍过密，后续应先继续下沉只读 presentation SQL 与物化回执 fold。 | 后续拆分；交付时提醒 |
| 2026-08-19 | Codex 产物交付与失败历史闭环 | `src/__tests__/codex-binding-repository-native.test.ts` | 7153 | 净 +719 | 一般 | 仍是绑定仓库的原生数据库总套件，本轮补交付、失败收口、精确调用证明、跨重试产物发布及排他技能不受无关当前文档阻塞的全链行为。2026-09-18 复查是否按 closeout / delivery / recovery 拆套件。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/migrations.ts` | 4255 | 净 +10 | 健康 | 单一有序迁移目录，本轮只新增 111 号预算 lane 迁移。 | 无需处理 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/renderer/types/electron.d.ts` | 3839 | 净 +6 | 健康 | 机械聚合的 Preload 类型声明，本轮只补 ProductTurn 单次/批量读取与显式 retry 接口。 | 无需处理 |
| 2026-08-19 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3573 | 净 +266 | 危险 | 本轮接入 output activation、materializer、统一 presentation/closeout 与 retry，并让历史 Retry 从原任务恢复资源和技能、收敛到当前失败尾部且继承沿途已暂存产物后重新核验；生产装配已明显过密，后续应把产物交付依赖装配下沉为独立 composition slice。 | 后续拆分；交付时提醒 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/tools/skills-tools.ts` | 3040 | 净 -146 | 危险 | 本轮把 Codex 文件夹产物读写接到 Materializer，支持重试直接交付前轮已暂存版本，并删除文本猜测旁路；技能工具注册与多种 primitive 执行仍混合，后续应按 artifact / shell / detached 分离。 | 后续拆分；交付时提醒 |
| 2026-08-19 | Codex 产物交付与失败历史闭环 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3310 | 净 +420 | 一般 | 单一网关对抗套件，本轮补正向事件表、真实结构风暴、长参数、断流与重试边界。2026-09-18 复查是否按身份、SSE、retry 拆套件。 | 已排期：2026-09-18 |
| 2026-08-19 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2567 | 净 +26 | 危险 | 新的流策略已迁出，主文件只保留接线与统一重试边界；网关仍混合协议、身份与上游调度，后续继续按 native/chat transport 拆分。 | 后续拆分；交付时提醒 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/__tests__/ready-codex-lifecycle-adapter.test.ts` | 2157 | 净 +9 | 一般 | 本轮只补统一失败回执投影。2026-09-18 复查 lifecycle 与 presentation 断言边界。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2041 | 净 +35 | 危险 | 只接入 ProductTurn receipt 的单次/批量宿主传播；旧 SDK 支撑职责仍过宽，后续按现行 Codex 与历史支撑边界继续缩减。 | 后续拆分；交付时提醒 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/renderer/stores/useAgent.ts` | 2049 | 净 +50 | 危险 | 本轮让会话选择、全部历史终态与当前终态走同一 receipt 归并；store 仍混合 hydration、lifecycle 与 UI 状态，后续先下沉会话 hydration。 | 后续拆分；交付时提醒 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/__tests__/use-agent-scope-list-contract.test.ts` | 1002 | 净 +118 | 一般 | 单一会话加载行为套件，本轮覆盖冷启动标签选择与多轮 ProductTurn 历史恢复。2026-09-18 复查是否按目录加载与消息 hydration 拆分。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/__tests__/codex-product-boot-recovery.test.ts` | 1760 | 净 +9 | 一般 | 本轮补旧失败历史与 ProductTurn 恢复边界。2026-09-18 复查按启动接管与 legacy repair 拆套件。 | 已排期：2026-09-18 |
| 2026-08-19 | Codex 产物交付与失败历史闭环 | `src/__tests__/codex-tool-bridge.test.ts` | 1739 | 净 +46 | 一般 | 本轮补产物激活后的精确回执、调用身份与交付证明路径。2026-09-18 复查工具 RPC 与交付回放是否需要拆套件。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1561 | 净 +4 | 一般 | 本轮只登记 dormant 宿主产物原语。2026-09-18 复查注册目录与执行元数据是否仍保持单一职责。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/preload/index.ts` | 1517 | 净 +4 | 健康 | 机械聚合的窄 IPC 暴露面，本轮只补 ProductTurn 单次/批量读取与显式重试。 | 无需处理 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/tools/tool-executor.ts` | 1473 | 净 +51 | 危险 | 本轮只把 Materializer 所需的冻结资源、版本上下文和 Tag Forge 精确交接摘要送入既有执行链；执行器仍混合多域分发，后续应继续把域上下文装配下沉。 | 后续拆分；交付时提醒 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1431 | 净 +2 | 一般 | 本轮只暴露统一 ProductTurn 单次/批量 presentation。2026-09-18 复查 IPC handler 是否继续保持薄转发。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/__tests__/codex-sidecar-crash-recovery.e2e.ts` | 1323 | 净 +9 | 一般 | 本轮只补 closeout 崩溃点恢复。2026-09-18 复查按启动 seam 拆 fixture 的收益。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/renderer/components/agent/ChatPanel.tsx` | 1298 | 净 +38 | 一般 | 本轮只接显式 retry、receipt 归并与历史活动分类字段。2026-09-18 复查这些接线是否可完全下沉到消息组件。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/__tests__/codex-sidecar-process-lease.e2e.ts` | 1243 | 净 +7 | 一般 | 本轮只补失败终态 canonical message。2026-09-18 复查进程租约与终态场景拆分。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1208 | 净 +27 | 一般 | 本轮删除错误的文件夹写权限泄漏，并保持历史 SDK 授权精确。2026-09-18 复查旧 SDK 支撑面是否还能继续收缩。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway-chat.ts` | 1110 | 净 +32 | 一般 | 本轮复用统一流策略并保持 Chat 协议折叠。2026-09-18 复查 transport policy 接线是否还能变薄。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/__tests__/codex-renderer-admission-contract.test.ts` | 1037 | 净 +23 | 一般 | 本轮补 event/send-return 顺序交换与失败回执归并。2026-09-18 复查按 admission 与 terminal receipt 拆套件。 | 已排期：2026-09-18 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/contracts/run-contracts.ts` | 1013 | 净 +2 | 健康 | 单一运行合同声明集合，本轮只补 ProductTurn 产物字段。 | 无需处理 |
| 2026-08-18 | Codex 产物交付与失败历史闭环 | `src/main/modules/agent-control/codex-runtime/codex-tool-binding-repository.ts` | 1002 | 净 +94 | 一般 | 本轮补交付 lane 与产物动作只读折叠，仍是单一工具绑定仓库。2026-09-18 复查是否应把 artifact 查询迁到 presentation helper。 | 已排期：2026-09-18 |
| 2026-08-16 | 长文写出被 native 事件上限掐死 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2551 | 净 +11 | 危险 | 只把增量 delta 排除出结构事件计数。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 长文写出被 native 事件上限掐死 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3214 | 净 +80 | 危险 | 套件仍覆盖网关对抗面；本轮补长文 delta 不触事件帽。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 文件夹导出地板与冻结核定义不一致 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1219 | 净 +64 | 一般 | 只把地板补回改成与 live 根面同一份定义。2026-09-16 复查默认面装配密度。 | 已排期：2026-09-16 |
| 2026-08-16 | 再试一次被历史资源标签 409 秒停 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3134 | 净 +244 | 危险 | 套件仍覆盖网关对抗面；本轮补历史残留 additionalContext 核验。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 再试一次被历史资源标签 409 秒停 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2543 | 净 +4 | 危险 | 只把 additionalContext 核验切到本轮标签。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 无技能文件夹导出授写 | `src/main/modules/tools/skills-tools.ts` | 3223 | 净 +43 | 危险 | 只把 folder-export 宿主 skillId 接到既有 write/export 查找，没有新执行器。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 无技能文件夹导出授写 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3322 | 净 +19 | 危险 | 只把 folderExport 授权和预算信号传入既有 compose/seed。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 无技能文件夹导出授写 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1199 | 净 +28 | 一般 | 只修正导出意图读源，并为宿主写原语补 Codex-safe 标记。2026-09-16 复查默认面装配密度。 | 已排期：2026-09-16 |
| 2026-08-16 | 无技能文件夹导出授写 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1561 | 净 +10 | 一般 | 只让 write/export 作为宿主原语进入冻结根表面。2026-09-14 复查日期不变。 | 已排期：2026-09-14 |
| 2026-08-16 | 聊天引用封装为可点芯片 | `src/renderer/styles/markdown.css` | 1389 | 净 +52 | 健康 | 只补本地路径/@ 引用芯片样式，仍是单一 Markdown 呈现表。 | 无需处理 |
| 2026-08-16 | skill+folder 导出时路径别名无法解析 | `src/main/modules/tools/skills-tools.ts` | 3189 | 净 +3 | 危险 | 只把冻结文件夹别名传入既有 export primitive。 | 后续拆分；交付时提醒 |
| 2026-08-16 | skill+folder 导出时路径别名无法解析 | `src/main/modules/tools/tool-executor.ts` | 1424 | 净 +2 | 危险 | 只把 directoryAliases 传给既有文件工具上下文。 | 后续拆分；交付时提醒 |
| 2026-08-16 | skill+folder 导出时路径别名无法解析 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3313 | 净 +6 | 危险 | 只在有文件夹导出目标时给既有预算加保留额度。 | 后续拆分；交付时提醒 |
| 2026-08-16 | skill+folder 因 additionalContext 顺序 409 秒停 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3045 | 净 +124 | 危险 | 套件仍覆盖网关对抗面；本轮补多引用顺序与现场 digest 核验。 | 后续拆分；交付时提醒 |
| 2026-08-16 | skill+folder 因 additionalContext 顺序 409 秒停 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2542 | 净 +1 | 危险 | 只把 additionalContext 核验切到共享规范化 digest。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 工作区收口与稳定门同步 | `src/main/modules/tools/skills-tools.ts` | 3186 | 净 +1 | 危险 | 只把候选技能身份传入既有 primitive 调用，没有继续扩大执行分支；技能工具注册、授权和执行仍集中。 | 待独立拆分合同；交付时提醒 |
| 2026-08-16 | 浏览器后台占用状态 | `src/renderer/pages/modes/BrowserMode.tsx` | 1450 | 净 +1 | 一般 | 只把完整 claim 列表交给现有状态投影。2026-09-16 复查浏览器监督状态是否继续下沉。 | 已排期：2026-09-16 |
| 2026-08-16 | 发送准入与 generation 恢复 | `src/__tests__/codex-renderer-admission-contract.test.ts` | 1014 | 净 +79 | 一般 | 套件仍只覆盖发送前后状态与 generation 收口；本轮补未建 generation、发布分歧和拒绝回执。2026-09-16 复查是否按准入前后拆套件。 | 已排期：2026-09-16 |
| 2026-08-16 | 找回文档书本阅读模式 | `src/renderer/pages/modes/DocumentMode.tsx` | 1094 | 净 +67 | 一般 | 这里只接入入口、只读覆盖层和会话收口；分页、翻页、排版与位置持久化都留在独立叶子模块。2026-09-16 复查会话接线是否还应继续迁出。 | 已排期：2026-09-16 |
| 2026-08-16 | 反问等待被 15s 超时误杀后无法再发 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3307 | 净 +48 | 危险 | 只补已提交 closeout 幂等读回，并叫醒 live collector。 | 后续拆分；交付时提醒 |
| 2026-08-16 | 反问等待被 15s 超时误杀后无法再发 | `src/__tests__/codex-tool-bridge.test.ts` | 1693 | 净 +26 | 一般 | 只补 user_interaction 等待不被 host deadline 杀掉。2026-09-16 复查。 | 已排期：2026-09-16 |
| 2026-08-16 | 反问等待被 15s 超时误杀后无法再发 | `src/renderer/components/agent/ChatPanel.tsx` | 1260 | 净 +6 | 一般 | 只在 UI 已空闲时释放悬挂的发送锁。2026-09-16 复查。 | 已排期：2026-09-16 |
| 2026-08-16 | 反问等待被 15s 超时误杀后无法再发 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1557 | 净 +1 | 一般 | 只把反问工具标成 user_interaction。2026-09-14 复查日期不变。 | 已排期：2026-09-14 |
| 2026-08-15 | publication_diverged 后发送被前端拦截 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 7465 | 净 +10 | 危险 | 只补 latest generation 只读查询，公开 facade 未分叉。 | 后续拆分；交付时提醒 |
| 2026-08-15 | sidecar 断连后反问卡与停止失真 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3259 | 净 +1 | 危险 | 只把 pending-interaction 收口投给既有 recovered closeout 发布。 | 后续拆分；交付时提醒 |
| 2026-08-15 | sidecar 断连后反问卡与停止失真 | `src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts` | 1572 | 净 +8 | 一般 | 只让已退役 generation 的 stop 走既有 no-active 幂等。2026-09-15 复查。 | 已排期：2026-09-15 |
| 2026-08-15 | sidecar 断连后反问卡与停止失真 | `src/__tests__/ready-codex-lifecycle-adapter.test.ts` | 2148 | 净 +21 | 一般 | 只补退役 generation 的 stop 幂等。2026-09-15 复查。 | 已排期：2026-09-15 |
| 2026-08-15 | publication_diverged 后发送被前端拦截 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3258 | 净 +12 | 危险 | 只把 latest generation 接到既有 port，并让缺省 expected generation 走 conversation 投影。 | 后续拆分；交付时提醒 |
| 2026-08-15 | publication_diverged 后发送被前端拦截 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2006 | 净 +2 | 危险 | 只把 latest generation 传给既有 scope store。 | 待独立拆分合同；交付时提醒 |
| 2026-08-15 | publication_diverged 后发送被前端拦截 | `src/renderer/types/electron.d.ts` | 3833 | 净 +1 | 健康 | 只机械补 latestAliasGeneration 声明。 | 无需处理 |
| 2026-08-15 | 新装包发送键无反馈 | `src/renderer/components/agent/ChatPanel.tsx` | 1244 | 净 +22 | 一般 | 只把发送拒绝和准入未就绪接到既有组合宿主。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-15 | 新装包发送键无反馈 | `src/renderer/components/agent/ChatInput.tsx` | 1006 | 净 +14 | 一般 | 只补发送禁用可见状态与未就绪提示。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-15 | 日历来源候选与语义选择 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1181 | 净 +15 | 一般 | 候选原语通过既有闸门，并保留加性日历与反问工具；已移除对普通网页搜索的过宽保留。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-15 | 日历来源候选与语义选择 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1556 | 净 +8 | 一般 | 技能组定义改用与冻结根表面相同的 Codex-safe 标记，避免候选原语触发换 thread。2026-09-14 复查跨域注册密度。 | 已排期：2026-09-14 |
| 2026-08-15 | 日历来源候选与语义选择 | `src/__tests__/sdk-turnengine-capability-parity.test.ts` | 1466 | 净 +约30 | 一般 | 只把飞书 CLI 从强制选技改成候选方法断言。2026-09-14 复查是否按能力面拆分。 | 已排期：2026-09-14 |
| 2026-08-15 | 语义能力选择层 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3246 | 净 +约6 | 危险 | 只把结构 availability 传入既有 compose，factory 仍是单一闭包装配根。 | 后续拆分；交付时提醒 |
| 2026-08-15 | 语义能力选择层 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1171 | 净 -12 | 一般 | 删除 Browser↔research 互斥过滤，不再消费当前页正则。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-15 | 当前页目标/排除贯穿工具面 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1183 | 净 +1 | 一般 | 只消费资源层当前页目标事实，不再用平台词特判。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-15 | 当前页目标/排除贯穿工具面 | `src/main/modules/tools/browser-observe-tools.ts` | 1241 | 净 +约23 | 一般 | 只让 tabs_list 按标签读全部 claim。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-15 | 当前页目标/排除贯穿工具面 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3240 | 净 +约11 | 危险 | 只把当前页准入事实传入既有 admission 快照。 | 后续拆分；交付时提醒 |
| 2026-08-15 | 浏览器受控换页后继可信页 | `src/main/modules/tools/tool-executor.ts` | 1422 | 净 +57 | 危险 | 只在既有 browser 分派点把 journal 后继主文档提升为当前可信页。 | 后续拆分；交付时提醒 |
| 2026-08-14 | 旧会话工具面漂移收口 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 7455 | 净 +约131 | 危险 | 只在用户 ingress 解析处增加空闲已启动 thread 的 cleanup successor，公开 facade 未分叉。 | 后续拆分；交付时提醒 |
| 2026-08-14 | 旧会话工具面漂移收口 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3229 | 净 +18 | 危险 | 只把当前 root tool surface digest 传入既有 alias 解析。 | 后续拆分；交付时提醒 |
| 2026-08-14 | 旧会话工具面漂移收口 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1170 | 净 +4 | 一般 | 只抽出 live root 工具定义列表供 ingress 复用。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-14 | 旧会话工具面漂移收口 | `src/__tests__/codex-binding-repository-native.test.ts` | 6434 | 净 +约120 | 危险 | 套件继续覆盖绑定、收口与 successor；本轮只补空闲 thread 的表面漂移行为。 | 后续拆分；交付时提醒 |
| 2026-08-14 | Codex 工作面硬化与拆分 | `src/main/modules/tools/browser-act-tools.ts` | 79 | 净 -约2513 | 健康 | 已按动作族拆到 navigation/form/target/pointer/upload/shared；本文件只留 facade 路由与 re-export。 | 无需处理 |
| 2026-08-14 | Codex 工作面硬化与拆分 | `src/main/modules/tools/browser-act-form.ts` | 840 | 新文件 | 一般 | 表单与嵌套 type/press 仍集中。2026-09-14 复查是否继续下沉 search。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex 工作面硬化与拆分 | `src/main/modules/tools/browser-act-pointer.ts` | 682 | 新文件 | 一般 | 指针动作与 click-by-text 回退。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex 工作面硬化与拆分 | `src/main/modules/tools/browser-input-actions.ts` | 1537 | 净 +约32 | 一般 | 只补 click press 阶段结算。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser Enter 部分按键结算 | `src/main/modules/tools/browser-input-actions.ts` | 1505 | 净 +约34 | 一般 | 一次完整按键按已发送次数结算。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser 文字按键发送前核对 | `src/main/modules/tools/browser-input-actions.ts` | 1471 | 净 +约34 | 一般 | 抽出共用发送前页面核对，覆盖指针/文字/键盘。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser 换页核对与部分滚动复审 | `src/main/modules/tools/browser-act-tools.ts` | 2591 | 净 +约19 | 危险 | 只把冻结文档身份绑到 click/type 投递，并回收指针拒绝。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 换页核对与部分滚动复审 | `src/main/modules/tools/browser-input-actions.ts` | 1437 | 净 +约15 | 一般 | 指针绑定仍在输入簇。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser 换页核对与部分滚动复审 | `src/main/modules/tools/tool-executor.ts` | 1365 | 净 +1 | 危险 | 只把返回前身份核对限制为 observe。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 文档代次与关闭复审 | `src/main/modules/tools/browser-act-tools.ts` | 2572 | 净 +约18 | 危险 | 只把冻结文档身份传入指针投递。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 文档代次与关闭复审 | `src/main/modules/tools/browser-input-actions.ts` | 1422 | 净 +约31 | 一般 | 投递前补文档代次核对。2026-09-14 复查。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser 文档代次与关闭复审 | `src/main/modules/tools/tool-executor.ts` | 1364 | 净 +约21 | 危险 | 读取入账前再核冻结页面身份。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 页签/指针/关闭复审 | `src/main/modules/tools/browser-input-actions.ts` | 1391 | 净 +约24 | 一般 | 只在投递前补同步再读。2026-09-14 复查键鼠簇是否继续下沉。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser 页签/指针/关闭复审 | `src/main/modules/tools/tool-executor.ts` | 1343 | 净 +约13 | 危险 | 只拒绝模型 open 页签并收紧 list 绑定。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 页签/指针/关闭复审 | `src/main/modules/tools/browser-observe-tools.ts` | 1218 | 净 +约5 | 一般 | 只让 tabs_list 在钉死后过滤到本页。2026-09-14 复查观察分派器密度。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser 执行绑定与关闭收口 | `src/main/modules/tools/browser-act-tools.ts` | 2554 | 净 +约30 | 危险 | 只把 hover/drag/scroll 改成投递前再读；分派器职责未扩大。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 执行绑定与关闭收口 | `src/main/modules/tools/browser-input-actions.ts` | 1367 | 净 +约70 | 一般 | 抽出 `dispatchTrustedPointer` 作为投递前重读入口。2026-09-14 复查键鼠簇是否继续下沉。 | 已排期：2026-09-14 |
| 2026-08-14 | Codex Browser 执行绑定与关闭收口 | `src/main/modules/tools/tool-executor.ts` | 1330 | 净 +约15 | 危险 | 只补模型调用缺 pageRef 时失败关闭，不扩大分派职责。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 执行绑定与关闭收口 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2013 | 净 +约20 | 危险 | 只在 canonical/failure 事务提交后 reconcile 页面控制副作用。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 接线切片 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3211 | 净 +29 | 危险 | 本轮只把 Browser 准入快照接到既有 send 组合；factory 仍是单一闭包装配根。 | 后续拆分；交付时提醒 |
| 2026-08-14 | Codex Browser 接线切片 | `src/main/modules/tools/browser-act-tools.ts` | 2524 | 净 +约40 | 危险 | 只给 hover/scroll/drag 补同一指针 preflight，未扩大分派器职责。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex Browser 接线切片 | `src/main/modules/tools/browser-input-actions.ts` | 1298 | 净 +约30 | 一般 | 仍是输入/键鼠动作簇；本轮只抽出共用 pointer 拒绝回执。2026-09-14 复查是否继续下沉。 | 已排期：2026-09-14 |
| 2026-08-14 | Ready host/store 拆分 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 3182 | 净 -1218 | 危险 | 已把资源 ingress、closeout 辅助、turn 授权和 lifecycle store 迁出，公开 facade 与 re-export 保持不变。factory 仍是单一闭包装配根（ingress/host/closeCandidate），不宜再机械切片。后续若再拆，只允许按显式 port 上下文对象下沉，不得复制第二条生产路径。 | 后续拆分；交付时提醒 |
| 2026-08-14 | Ready host/store 拆分 | `src/renderer/stores/useAgent.ts` | 2001 | 净 -423 | 危险 | 发送编排与工作面资源已迁出；`sendMessage` 仍是单一 facade，pending ingress Map 由编排模块独占。监听、会话选择和生命周期动作仍在同一 store，再拆需先解 listener 对 `useAgent.getState` 的环。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex 工作面重接线审查修复 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 4400 | 净 +58 | 危险 | 文件仍混合网关、生命周期、工具、资源与发布收口；本轮只补 Tag Forge 别名授权、RSS 分析端口和日程列表回执接线。后续仍按 gateway/lifecycle/tool/resource 边界拆分。 | 后续拆分；交付时提醒 |
| 2026-08-14 | Codex 工作面重接线审查修复 | `src/renderer/stores/useAgent.ts` | 2424 | 净 +2 | 危险 | 会话发送仍集中在同一 store；本轮只把循环日程选择映射为可持久 parent id。后续按发送编排与会话选择拆分。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex 工作面重接线 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 4342 | 净 +127 | 危险 | 文件仍混合网关、生命周期、工具、资源与发布收口；本轮只把产品动作桥与工具面组合接到既有 send/tool 入口。后续仍按 gateway/lifecycle/tool/resource 边界拆分。 | 后续拆分；交付时提醒 |
| 2026-08-14 | Codex 工作面重接线审查修复 | `src/renderer/stores/useAgent.ts` | 2431 | 净 +9 | 危险 | 会话发送仍集中在同一 store；本轮只把循环日程选择映射为可持久 parent id。后续按发送编排与会话选择拆分。 | 待独立拆分合同；交付时提醒 |
| 2026-08-14 | Codex 工作面重接线 | `src/renderer/stores/useAgent.ts` | 2422 | 净 +57 | 危险 | 会话发送仍集中在同一 store；本轮只调整发送顺序并附带工作面结构化资源。后续按发送编排与会话选择拆分。 | 待独立拆分合同；交付时提醒 |
| 2026-08-13 | Codex 引用入口与启动就绪收口 | `src/preload/index.ts` | 1513 | 净 +18 | 健康 | 本轮只把既有 Agent、Skill 与 ask-user IPC 机械接到统一就绪门，通道定义仍是单一声明表面。 | 无需处理 |
| 2026-08-13 | Codex 引用入口与启动就绪收口 | `src/renderer/stores/useAgent.ts` | 2365 | 净 +20 | 危险 | 会话、消息、准入与生命周期状态仍集中在同一 store；本轮只消除显式创建与启动 hydration 的竞态。后续按会话目录、准入和生命周期三个 owner 拆分。 | 待独立拆分合同；交付时提醒 |
| 2026-08-13 | Codex 引用入口与启动就绪收口 | `src/main/modules/tools/tool-executor.ts` | 1317 | 净 +65 | 危险 | 文件继续混合多个产品域工具执行；本轮只把 Browser 工具钉到引用时冻结的页面并逐次重验。后续按 Browser、Document 与通用工具域拆分。 | 待独立拆分合同；交付时提醒 |
| 2026-08-13 | Codex 引用入口与启动就绪收口 | `src/renderer/pages/modes/DocumentMode.tsx` | 1027 | 净 +12 | 一般 | 文档模式仍聚焦单一工作面；本轮只在拖拽载荷中补齐标签、路径、脏状态和选区身份。2026-09-13 复查拖拽桥是否可下沉到独立 hook。 | 已排期：2026-09-13 |
| 2026-08-13 | Codex 安全旁白实时接线 | `src/__tests__/codex-app-server-client.test.ts` | 1504 | 净 +2 | 一般 | 套件仍聚焦固定 app-server 协议、请求所有者与关闭顺序；本轮只补安全摘要与原始推理的通知分类对照。2026-09-13 复查是否按请求、通知和关闭恢复拆套件。 | 已排期：2026-09-13 |
| 2026-08-13 | Codex 安全旁白实时接线 | `src/__tests__/scope-run-state.test.ts` | 1285 | 净 +42 | 一般 | 套件仍聚焦 Renderer 运行状态归一化；本轮只补活动旁白的保留、终态清除与换轮隔离。2026-09-13 复查是否按活动、终态和持久恢复拆套件。 | 已排期：2026-09-13 |
| 2026-08-13 | Codex 安全旁白实时接线 | `src/renderer/modules/agent/scopeRunState.ts` | 1046 | 净 +23 | 一般 | 文件仍是 Renderer 运行状态归一化单一边界；本轮只接收当前 run 的安全旁白，并在终态或换轮时清除。2026-09-13 复查事件归一化与终态派生的拆分收益。 | 已排期：2026-09-13 |
| 2026-08-13 | Codex 安全旁白实时接线 | `src/renderer/types/electron.d.ts` | 3832 | 净 +8 | 健康 | 只机械补齐安全旁白的跨进程声明，由类型检查和行为门覆盖。 | 无需处理 |
| 2026-08-13 | Codex 工具活动与结构化引用接线 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 4215 | 净 +158 | 危险 | 文件仍混合网关、生命周期、工具、资源与发布收口；本轮接入安全旁白、工具活动、Main 侧资源解析与当前文档精确写回。后续仍按 gateway/lifecycle/tool/resource/verifier 边界拆分。 | 后续拆分；交付时提醒 |
| 2026-08-13 | Codex 工具过程可见性接线 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2000 | 净 +3 | 危险 | 文件仍是运行服务组合根；本轮只把既有任务投影发布入口交给 Codex 组合层，不加入产品判断。后续继续按既有合同下沉运行时装配。 | 待独立拆分合同；交付时提醒 |
| 2026-08-13 | 飞书 CLI 日历查询接线 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 1997 | 净 +2 | 危险 | 文件仍是运行服务组合根；本轮只在 Codex 工具面冻结前传入已选技能的独占面声明，业务判断留在技能叶子。后续继续按既有合同下沉运行时装配。 | 待独立拆分合同；交付时提醒 |
| 2026-08-13 | 实时查询工具面与只读超时收口 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1166 | 当前共享差异净 +3 | 一般 | 文件仍聚焦 SDK 工具面组装与执行包装；本轮只在既有意图裁决点收窄实时查询工具面。沿用 2026-09-12 对工具包装与工具面组装拆分收益的复查。 | 已排期：2026-09-12 |
| 2026-08-13 | 实时查询工具面与只读超时收口 | `src/__tests__/codex-tool-bridge.test.ts` | 1659 | 当前共享差异净 +44 | 危险 | 套件继续同时覆盖准入、回执、结果转换和连接恢复；本轮只补只读超时可交付与写操作继续失败关闭的边界。后续仍按准入与动作、结果转换、连接恢复三组拆分。 | 后续拆分；交付时提醒 |
| 2026-08-13 | Ready 结构出包身份与载荷验收 | `scripts/verify-release-structural-package.cjs` | 1150 | 新增文件 1150 行 | 危险 | 当前同时承担 DMG 挂载读回、应用清单比对、运行依赖闭包、敏感载荷扫描和结构收据签发；本轮需要它们共享同一不可变包身份，未在收尾阶段搬动。后续应先固定现有成品反例，再按“包体读取与清单 / 依赖与敏感载荷 / 收据写入与重验”三层拆分。 | 后续拆分；交付时提醒 |
| 2026-08-12 | VEA 恢复身份与精确输出收口 | `assets/embedded-skills/video-expert-analyzer/scripts/pipeline_enhanced.py` | 2137 | 当前共享差异净 +43 | 危险 | 来源准备、下载、场景检测、裁剪、抽帧、评分与报告编排仍集中在同一流水线；本轮只收口精确输出目录、身份变化后的陈旧结果清理和恢复进度。后续按来源获取、场景准备和总编排拆分。 | 后续拆分；交付时提醒 |
| 2026-08-12 | VEA 报告场景证据收口 | `assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/reporting/template_engine.py` | 2461 | 当前共享差异净 +77 | 危险 | 报告路由、提示组装、原始输出修复、验证与成稿仍集中在同一模板引擎；本轮只补场景证据与标题规范化。后续优先迁出原始输出修复和验证。 | 后续拆分；交付时提醒 |
| 2026-08-12 | 会话切换与异步回写隔离 | `src/renderer/stores/useAgent.ts` | 2369 | 当前共享差异净 +858 | 危险 | 会话、发送、运行与界面输入权威仍集中在同一 store；本轮只收口切换、重置、停止和延迟响应的身份竞态。后续应把发送编排与会话选择权威迁出，保留单一入口。 | 后续拆分；交付时提醒 |
| 2026-08-12 | 会话切换与异步回写隔离 | `src/renderer/components/agent/ChatPanel.tsx` | 1265 | 当前共享差异净 +120 | 一般 | 文件仍是聊天面板组合宿主；本轮只接入按会话版本隔离的附件、预览、任务投影和子任务读取。2026-09-12 复查是否将持久读取编排整体下沉。 | 已排期：2026-09-12 |
| 2026-08-12 | 会话切换与异步回写隔离 | `src/renderer/components/ready/TaskPanel.tsx` | 1205 | 当前共享差异净 +50 | 一般 | 文件仍是任务面板宿主；本轮只增加按当前会话版本过滤投影读取和任务动作。2026-09-12 复查读取与动作编排是否应继续下沉。 | 已排期：2026-09-12 |
| 2026-08-12 | Ready-Codex 身份与生命周期收口 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 7324 | 当前共享差异净 +5195 | 危险 | 唯一写者继续同时承载启动、turn、工具、压缩、精确生命周期、scope 关闭与 thread 归档事务，体量已明显妨碍定位。保留单一公开 facade 与写向门禁，后续按事务域下沉内部存储。 | 后续拆分；交付时提醒 |
| 2026-08-12 | Ready-Codex 身份与生命周期收口 | `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts` | 2270 | 当前共享差异净 +1569 | 危险 | DDL 已聚合启动、工具、压缩、进程租约、双轴上下文、精确动作和归档待办多个独立事务域。后续按同样事务边界拆分，保留统一导出与迁移门禁。 | 后续拆分；交付时提醒 |
| 2026-08-12 | Ready-Codex 精确停止、关闭与重置 | `src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts` | 1565 | 当前共享差异净 +667 | 危险 | 适配器已同时编排 stop/close/reset 的 running、engine-terminal、idle、unknown 恢复与归档分支，继续增长会放大生命周期回归成本。后续保留单一适配入口，按精确动作与恢复对账拆分叶子。 | 后续拆分；交付时提醒 |
| 2026-08-12 | Ready-Codex 精确动作与归档协议 | `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts` | 1314 | 当前共享差异净 +453 | 一般 | 文件仍聚焦固定版本 JSON-RPC 会话、turn、工具回写与 thread archive 协议，边界仍可验证。2026-09-12 复查请求身份激活与帧归一是否应分开。 | 已排期：2026-09-12 |
| 2026-08-12 | Browser 终态与上下文隔离 | `src/main/modules/repositories/agent-session-checkpoint-closeout.ts` | 1046 | 当前共享差异净 +360 | 一般 | 文件仍聚焦 checkpoint/Parent/child/canonical notice 的单一终态事务，本轮增加可见 epoch 与发布读回。2026-09-12 复查成功 seal 与非成功 closeout 的拆分收益。 | 已排期：2026-09-12 |
| 2026-08-12 | 会话上下文重置收口 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2649 | 当前共享差异净 +350 | 危险 | 运行服务仍是多产品组合根；本轮只组装单一 reset/close 后清理入口和持久身份读回，对应判断已在叶子模块。后续继续迁出会话与 Codex 组合边界。 | 后续拆分；交付时提醒 |
| 2026-08-12 | Ready-Codex 顺序迁移 | `src/main/modules/migrations.ts` | 4192 | 当前共享差异净 +189 | 健康 | 只追加受连续编号、机器合同和 Electron SQLite 正反例约束的顺序迁移，仍是单一机械聚合。 | 无需处理 |
| 2026-08-12 | 技能任务可见 epoch 归属 | `src/main/modules/repositories/skill-task-run-repository.ts` | 1012 | 当前共享差异净 +123 | 一般 | 仓储仍聚焦技能任务的持久、读取和终态转换，本轮只把会话可见 epoch 纳入写入与查询边界。2026-09-12 复查读模型与写事务是否需拆分。 | 已排期：2026-09-12 |
| 2026-08-12 | 会话上下文与远程入站持久接线 | `src/main/modules/database.ts` | 3220 | 当前共享差异净 +131 | 危险 | 多产品域数据操作仍集中在总管理器；本轮只补会话可见 epoch、交互清理、投影窄读写和无主远程事件收口。后续继续下沉到会话、投影与渠道仓储。 | 后续拆分；交付时提醒 |
| 2026-08-12 | 远程 IM 资源化退役 | `src/main/modules/agent-control/runtime-core/remote-channel-service.ts` | 890 | 当前共享差异净 -364 | 健康 | 已删除自动 Agent 派发、typing、投影附件回传与日历旁路；文件回落到 1000 行以下，仅保留入站资源、指令、ask-card 和明确出站。 | 已收口 |
| 2026-08-12 | 工具结果与上下文归属 | `src/main/modules/tools/tool-executor.ts` | 1426 | 当前共享差异净 +96 | 一般 | 统一入口只透传 run/scope/epoch 和活动 run 读回，具体业务仍在叶子 handler。2026-09-12 复查身份解析与路由是否可整体下沉。 | 已排期：2026-09-12 |
| 2026-08-12 | 技能上下文隔离 | `src/main/modules/tools/skills-tools.ts` | 3185 | 当前共享差异净 +84 | 危险 | 技能工具注册、执行分派、授权和投影仍集中；本轮只增加可见 epoch 和重置隔离。后续按既有独立合同拆分全局技能工具宿主。 | 待独立拆分合同；交付时提醒 |
| 2026-08-12 | 会话生命周期 IPC 汇总 | `src/preload/index.ts` | 1661 | 当前共享差异净 +68 | 一般 | 只汇总会话双轴身份、精确动作和持久快照的跨进程透传，仍无产品判断。2026-09-12 复查按 Agent 产品域拆分 API 组装。 | 已排期：2026-09-12 |
| 2026-08-12 | 会话双轴与生命周期类型 | `src/renderer/types/electron.d.ts` | 4063 | 当前共享差异净 +51 | 健康 | 机械补齐 generation/epoch、精确 lifecycle action 与持久读回形状，由类型检查、IPC 合同和原生 SQLite 门禁覆盖。 | 无需处理 |
| 2026-08-12 | 子任务上下文归属 | `src/main/modules/agent-control/skills/skill-child-runner.ts` | 3608 | 当前共享差异净 +47 | 危险 | 子任务创建、调度、续跑、终态和结果上行仍集中于单一大 runner；本轮只贯穿 scope/epoch 并拒绝旧上下文回写。后续按创建恢复、执行和终态分层。 | 待独立拆分合同；交付时提醒 |
| 2026-08-12 | SDK 工具结果迟到隔离 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1163 | 当前共享差异净 +29 | 一般 | SDK 工具包装与跟踪发布仍是单一可验证边界；本轮加入 run 与可见 epoch 双重当前性门禁。2026-09-12 复查工具包装与 canonical 发布的拆分收益。 | 已排期：2026-09-12 |
| 2026-08-12 | Agent 上下文重置组合 | `src/main/modules/agent-control/runtime-core/orchestrator.ts` | 1066 | 当前共享差异净 +26 | 一般 | 仍是 Agent 运行组合入口，本轮只统一调用 SDK 与 domain adapter 的 scope context reset。2026-09-12 复查上下文清理组装是否需继续下沉。 | 已排期：2026-09-12 |
| 2026-08-12 | 应用启动与恢复接线 | `src/main/index.ts` | 1201 | 当前共享差异净 +26 | 一般 | 文件仍是 Main 启动与退出组合根；本轮只接入 Codex 产品恢复、归档 owner 与清理时序。2026-09-12 复查 Agent 恢复组装是否应迁出启动根。 | 已排期：2026-09-12 |
| 2026-08-12 | Browser 精确动作与上下文归属 | `src/main/modules/tools/browser-act-tools.ts` | 2549 | 当前共享差异净 +13 | 危险 | 页面交互、表单、导航、上传与采集动作仍集中在巨大分派器；本轮只传递当前 scope/epoch 与精确执行身份。沿用“导航观察 / 可信输入表单 / 上传采集”拆分边界。 | 待独立拆分合同；交付时提醒 |
| 2026-08-12 | 工具合同可见性收口 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1548 | 当前共享差异净 +11 | 一般 | 仍是公开工具定义、效果与执行上限的单一注册面，本轮未加入产品特例。2026-09-12 复查跨域注册密度。 | 已排期：2026-09-12 |
| 2026-08-12 | 技能任务投影可见性 | `src/main/modules/agent-control/skills/skill-task-tracker.ts` | 1250 | 当前共享差异净 +3 | 一般 | 文件仍聚焦技能任务跟踪与投影，本轮只把会话可见 epoch 带入持久记录。2026-09-12 复查持久投影组装是否可下沉到仓储。 | 已排期：2026-09-12 |
| 2026-08-12 | Agent 运行合同双轴身份 | `src/main/modules/agent-control/contracts/run-contracts.ts` | 1013 | 当前共享差异净 +3 | 健康 | 只为既有运行合同机械补齐可见 epoch 字段，由类型检查、身份门禁和行为测试覆盖。 | 无需处理 |
| 2026-08-12 | Codex 模型网关身份收口 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2538 | 新文件，较上次记录 +30 | 危险 | 请求准入、上游转发和 native Responses 流验证仍集中；本轮只补双轴身份与发布边界。后续迁出响应流验证与 listener/upstream 组合，保留同一准入合同。 | 后续拆分；交付时提醒 |
| 2026-08-12 | Codex 产品收口组合 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 4065 | 新文件，较上次记录 +1456 | 危险 | 产品发送、网关、生命周期、工具、资源、Browser fresh verifier 与发布收口已聚合在单一装配入口，体量明显妨碍并行修改。保留单一公开 composition，后续按 gateway/lifecycle/tool/resource/verifier 下沉叶子组合。 | 后续拆分；交付时提醒 |
| 2026-08-12 | 会话切换与异步回写隔离 | `src/__tests__/chat-panel-baseline.test.ts` | 1180 | 当前共享差异净 +282 | 一般 | 套件仍覆盖聊天面板组合行为；本轮补齐会话切换、重置和延迟读取回归。2026-09-12 复查是否按输入、任务投影和生命周期拆套件。 | 已排期：2026-09-12 |
| 2026-08-12 | 会话切换与异步回写隔离 | `src/__tests__/stores.test.ts` | 2169 | 当前共享差异净 +42 | 危险 | 多个 store 产品域仍共用同一大套件；本轮只补齐新的会话身份状态与现有 fixture。后续应把 Agent store 行为独立拆出。 | 待独立测试拆分合同；交付时提醒 |
| 2026-08-11 | 天气任务收口与停止按钮实机修复 | `src/main/modules/tools/browser-observe-tools.ts` | 1217 | 净 +10 | 一般 | 文件仍聚焦只读浏览器观察；本轮只让成功的页面稳定等待产生因果观察，并明确禁止作为正文来源。2026-09-11 复查等待、页面读取与媒体观察的拆分收益。 | 已排期：2026-09-11 |
| 2026-08-11 | 天气任务收口与停止按钮实机修复 | `src/renderer/components/agent/ChatPanel.tsx` | 1237 | 本轮累计 +55 | 一般 | 文件仍是聊天面板组合宿主；本轮只接入停止等待、失败反馈、任务身份绑定与重试可见状态，具体按钮展示留在叶子组件。2026-09-11 复查生命周期提示是否应整体下沉。 | 已排期：2026-09-11 |
| 2026-08-11 | 天气任务收口与停止按钮实机修复 | `src/renderer/stores/useAgent.ts` | 1616 | 本轮累计 +25 | 危险 | 本轮只在 Main 明确证明没有活动任务时解开错误遗留的输入锁，并使迟到的停止结果只能回写原任务；store 仍混合会话、发送和投影职责。本轮不扩大重构，后续随既定发送编排下沉一并迁出。 | 后续拆分；交付时提醒 |
| 2026-08-11 | 天气任务收口与停止按钮实机修复 | `src/__tests__/chat-panel-baseline.test.ts` | 1144 | 净 +246 | 一般 | 套件仍聚焦聊天面板组合行为，本轮增加停止异常、精确终态、旧任务乱序和跨会话的行为回归。2026-09-11 复查是否按基线展示与生命周期交互拆分。 | 已排期：2026-09-11 |
| 2026-08-10 | ChatGPT 发送拒绝可见反馈 | `src/renderer/stores/useAgent.ts` | 1591 | 小幅接线 | 危险 | 本轮只把发送前被拒绝的结果接入既有提示槽，避免输入看似无响应；store 仍混合会话、发送和投影职责。本轮不扩大重构，后续随既定发送编排下沉一并迁出。 | 后续拆分；交付时提醒 |
| 2026-08-10 | Codex Runtime E6 用户场景验收驱动 | `scripts/run-codex-runtime-e6-user-scenario.mjs` | 1568 | 新文件 | 危险 | 文件同时承担构建、隐藏启动、页面驱动、确认、恢复和清理；Owner 已裁决真实 Codex 路径即可验收，不再让这套附加驱动成为阶段权威。正式收尾时优先退役，而不是继续扩建。 | E9 后退役；交付时提醒 |
| 2026-08-10 | Codex Runtime E6 用户场景证据外壳 | `scripts/codex-runtime/e6-user-scenario-evidence.cjs` | 1899 | 新文件 | 危险 | 文件复制了大量运行关系和结果校验，正是 Owner 要求停止叠加的额外证明层。当前 E6-E9 通过不依赖它；正式收尾时优先退役，禁止继续把生产语义复制进来。 | E9 后退役；交付时提醒 |
| 2026-08-10 | Codex Runtime E6 最终收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 7619 | 净 +37 | 危险 | 共享 SDK 宿主测试继续聚合大量状态场景；本轮只补飞书 CLI 浏览器工具面正反例，但文件规模已明显妨碍定位。E8 建立隔离 fixture 后按 Provider、浏览器、技能授权和生命周期拆套件。 | E8 必拆；交付时提醒 |
| 2026-08-11 | Ready 模型设置与旧任务恢复链 | `src/__tests__/codex-product-boot-recovery.test.ts` | 1097 | 本轮小幅接线 | 一般 | 套件仍聚焦同一产品恢复合同，本轮补旧 Browser 任务无法成功收口时必须先完成局部失败结算、再开放发送；2026-09-10 复查是否按启动恢复、网关证据和超时读回拆分。 | 已排期：2026-09-10 |
| 2026-08-11 | Codex 工具结果断线恢复 | `src/__tests__/codex-tool-bridge.test.ts` | 1615 | 本轮净 +288 | 危险 | 套件已同时覆盖准入、冻结身份、动作回执、结果转换和两个 app-server 连接的组合恢复，失败定位开始受体量影响。后续按准入/动作、结果转换、transport 恢复三组拆套件。 | 后续拆分；交付时提醒 |
| 2026-08-09 | Codex Runtime E6 模型受控续试真实链路修复 | `src/__tests__/codex-model-gateway-retry.test.ts` | 1267 | 净 +384 | 一般 | 套件仍聚焦同一网关受控续试合同，本次补齐无内容前缀、带元数据错误、严格 UTF-8、EOF 半字符、精确字节与单块事件预算、取消失败、认证错误、身份漂移及正文/推理/工具提议后禁止重放；2026-09-09 复查是否按 HTTP、流前缀与重放禁止三组拆分。 | 已排期：2026-09-09 |
| 2026-08-11 | Codex 工具结果断线恢复 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 5480 | 本轮小幅增长 | 危险 | 本轮只在公开 facade 增加交付尝试委托，并使 publication 从 canonical 响应重算候选摘要；文件仍混合启动、turn、压缩、进程租约与发布事务。保留单一公开 facade 和写向门禁，后续按事务域拆内部存储。 | 后续拆分；交付时提醒 |
| 2026-08-11 | Codex 工具结果断线恢复 | `src/__tests__/codex-binding-repository-native.test.ts` | 5438 | 本轮净 +802 | 危险 | 原生 SQLite 套件继续增加交付尝试、确认、篡改拒绝和发布回读，已明显阻碍定位。后续按启动、工具、授权、压缩、进程租约和发布恢复拆套件，共享一个原生 fixture。 | 后续拆分；交付时提醒 |
| 2026-08-11 | Codex 工具结果断线恢复 | `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts` | 2108 | 本轮净 +155 | 危险 | 迁移 105 只新增独立的 canonical response 交付尝试与一次性 transport 确认，但 DDL 仍混合多个独立事务域。后续按 binding/tool/compaction/process-lease 拆分，保留统一导出。 | 后续拆分；交付时提醒 |
| 2026-08-11 | Codex 工具结果断线恢复 | `src/main/modules/migrations.ts` | 4166 | 净 +14 | 健康 | 只追加顺序迁移 105 的注册入口，具体表语义留在 Codex schema 唯一拥有者，并有原生 SQLite 正反例。 | 无需处理 |
| 2026-08-09 | 普通 Agent 飞书 CLI 执行收窄 | `src/main/modules/tools/skills-tools.ts` | 3176 | 本轮净 +75 | 危险 | 本次在既有技能 primitive 调度点加入“无 scripts 不开放通用 shell”、冻结全局 CLI 身份、会话内授权句柄绑定与生产组合回归注入点；Codex 额外只允许宿主原生 primitive，明确禁用目录脚本和可变 action，但本文件仍继续混合全部技能工具宿主。 | E8 必拆；交付时提醒 |
| 2026-08-09 | 普通 Agent 对话自动识别飞书 CLI | `src/__tests__/sdk-turnengine-capability-parity.test.ts` | 1436 | 净 +113 | 一般 | 套件仍聚焦 SDK 工具面与意图裁决的同源合同，本次增加普通用户输入选中受限飞书技能，以及跨轮本地输入不重新开放技能的生产路径回归。2026-09-09 复查是否需要按浏览器、技能和文档三类能力面拆分用例。 | 已排期：2026-09-09 |
| 2026-08-08 | Codex Runtime E6 真实外部读取验收 | `scripts/run-codex-runtime-e6-live-proof.mjs` | 2207 | 新文件 | 危险 | 单一验收入口已同时承担严格预检、隔离构建、Electron/CDP 驱动、六轮外部读取、进程租约恢复、安全清理和证据封存；对抗性收口后已超出可维护上限。E8 将用例定义、进程恢复、外部身份准备和报告封存拆到叶子模块，保留薄调度入口。 | E8 必拆；交付时提醒 |
| 2026-08-09 | Codex Runtime E6 验收驱动对抗验证 | `scripts/__tests__/e6-live-proof-runner-preflight.test.cjs` | 1291 | 新文件 | 危险 | 同一套件已混合预检无副作用、共享构建锁、依赖树身份漂移、WAL 冻结、跨临时目录 SIGKILL 恢复、Main/sidecar 进程身份与安全停机，失败定位成本已过高。E8 按预检、构建身份与租约、进程恢复和停机四个套件拆分，共享一个最小 fixture。 | E8 必拆；交付时提醒 |
| 2026-08-11 | Codex engine-terminal 用户停止与旧任务局部结算 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 2609 | 本轮小幅接线 | 危险 | 本轮把 engine 已结束但产品收口未完成时的用户停止、旧 Browser 证据缺口和实时观察缺失统一接入既有持久失败结算；单个任务不再无限占用输入与产品栅栏，真实损坏仍阻止启动。总入口仍混合网关、生命周期、工具与资源组合。E8 按既定边界拆分，保留单一公开装配入口。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E6 外部只读切片 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2445 | E6 净 +146 | 危险 | E6 只解析 Feishu channel、Lark Skill、原生程序与登录读回，执行策略下沉到独立叶子；运行服务总装配职责仍过多。E8 迁出 Codex 外部资源 resolver 与组合接线。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E6 精确技能读取 | `src/main/modules/tools/skills-tools.ts` | 3114 | E6 净 +13 | 危险 | 统一技能入口仅透传已冻结的三个只读资源和单一命令方法；路径、文件身份与执行校验已下沉。后续仍按既有独立合同拆分全局技能工具宿主。 | 待独立拆分合同；交付时提醒 |
| 2026-08-08 | Codex Runtime E6 Renderer 受控验收入口 | `src/renderer/stores/useAgent.ts` | 1523 | E6 净 +5 | 危险 | 只允许测试 harness 把一个窄外部读取切片放入现有用户消息元数据，Main 继续做严格校验；store 仍混合会话、发送和投影职责。E8 前不再扩张，并迁出发送编排。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E6 工具上下文接线 | `src/main/modules/tools/tool-executor.ts` | 1354 | E6 净 +24 | 一般 | 统一入口只透传飞书读取权威、冻结命令和三个精确文件绑定，域内判断都在叶子模块。2026-09-08 复查统一工具路由密度。 | 已排期：2026-09-08 |
| 2026-08-08 | Codex Runtime E5 会话、压缩与当前文档权威 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 4613 | E1-E5 净 +2484 | 危险 | 启动绑定、turn、进程租约、手动/自动压缩与恢复仍集中在同一唯一写者；工具事务虽已下沉，但 E5 新增压缩与同进程恢复证据后已明显妨碍故障定位。E8 必须保留单一 facade 与写向 gate，按 start/turn、compaction、process lease 三个事务域拆分。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E5 产品闭环与当前文档权威 | `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts` | 1808 | 新文件 | 危险 | 产品发送、生命周期、模型网关、工具桥、当前文档读取凭证与发布门禁集中在一个组合入口，已经同时承载多个可独立验证的边界。E8 按 gateway/lifecycle/tool/resource composition 拆成叶子组合，保留单一公开装配入口。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E5 原生持久化验收 | `src/__tests__/codex-binding-repository-native.test.ts` | 2789 | E1-E5 净 +1767 | 危险 | 单一 Electron SQLite 套件已混合启动、工具、压缩、恢复、进程租约和当前资源发布屏障，失败定位成本过高。E8 按同一事务域拆套件并共享原生 fixture。 | E8 必拆；交付时提醒 |
| 2026-08-10 | Ready 模型设置接入 Codex 网关 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2508 | 本轮小幅接线 | 危险 | 本轮让 Ready 明确设置的输出上限进入既有上游请求，并在固定 ChatGPT OAuth 通道裁剪服务返回的扩展字段；工具额度用完后的唯一收尾轮仍先校验冻结工具面，但向上游强制无工具回答。请求准入、上游转发和 native Responses 流验证仍集中。E8 将响应流验证和 listener/upstream 组合拆开，保留同一请求准入合同。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E3-E5 网关对抗验证 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 2792 | 新文件 | 危险 | 请求准入、Chat/native 流、泄漏与终态反例已明显妨碍定位。E8 按请求准入、Chat 响应、native 响应拆套件，并保留统一门禁入口。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E5 绑定 schema | `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts` | 1779 | E1-E5 净 +1078 | 危险 | 文件已同时承载启动、工具、压缩、进程租约和恢复凭证 DDL，失败定位与迁移复核成本过高。E8 按 binding/tool/compaction/process-lease schema 拆分，保留统一导出。 | E8 必拆；交付时提醒 |
| 2026-08-10 | Ready 模型设置真实子进程验收 | `src/__tests__/codex-model-gateway-sidecar.e2e.ts` | 1379 | 本轮小幅接线 | 一般 | 同一固定版本真进程流程新增冻结推理程度和上下文长度验证，仍是单一外部边界验收。2026-09-10 复查是否按正常流、失败流和工具边界拆分。 | 已排期：2026-09-10 |
| 2026-08-10 | Ready 模型输出上限接入 Chat 网关 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway-chat.ts` | 1078 | 本轮小幅接线 | 一般 | 文件仍只负责 Chat 请求转换和流响应映射，本轮把 Ready 明确设置的输出上限接入上游请求。2026-09-10 复查请求转换与响应状态机的拆分收益。 | 已排期：2026-09-10 |
| 2026-08-10 | Ready 模型设置网关合同验证 | `src/__tests__/codex-model-gateway-contract.test.ts` | 1256 | 本轮净增 | 一般 | 单一合同套件新增推理程度、上下文长度、输出上限、固定 OAuth 返回裁剪，以及两种上游接口的无工具收尾正反验证，边界仍清晰；2026-09-10 复查是否需按接口族拆分。 | 已排期：2026-09-10 |
| 2026-08-08 | Codex Runtime E5 真实验收脚本 | `scripts/run-codex-runtime-e5-live-proof.mjs` | 1693 | 新文件 | 危险 | 单一隔离验收驱动已混合预检、连续对话、手动压缩、真实进程重启、自动压缩与离线数据库取证。E8 必须迁出共享启动、CDP、进程身份和证据断言辅助，保留一个薄入口。 | E8 必拆；交付时提醒 |
| 2026-08-11 | Codex engine-terminal 用户停止适配 | `src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts` | 1161 | 本轮小幅接线 | 一般 | 文件仍聚焦 Ready 生命周期到 Codex 原生生命周期的单一适配，本轮只把 stop 从等待改为调用持久结算，并保证提前到达的终态可由原任务接收、去重记录有固定上限。2026-09-11 复查用户生命周期操作与收口编排是否需拆分。 | 已排期：2026-09-11 |
| 2026-08-11 | Ready 模型设置与工具结果交付接线 | `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts` | 1104 | 本轮小幅接线 | 一般 | 文件仍聚焦固定版本 JSON-RPC 会话、turn 与压缩协议；本轮在真实 write callback 成功后确认工具结果，并阻止跨 call 或同 RPC 双响应。2026-09-11 复查请求方法、事件解析与 server response 边界的拆分收益。 | 已排期：2026-09-11 |
| 2026-08-08 | Codex Runtime E5 真进程崩溃恢复 | `src/__tests__/codex-sidecar-crash-recovery.e2e.ts` | 1270 | E1-E5 净 +131 | 一般 | 仍是同一六中断点真进程合同，新增压缩恢复和冻结身份使 fixture 继续增长。2026-09-08 按共享 fixture 与故障场景拆分。 | 已排期：2026-09-08 |
| 2026-08-10 | Ready 模型设置真进程租约验证 | `src/__tests__/codex-sidecar-process-lease.e2e.ts` | 1190 | 本轮小幅接线 | 一般 | 套件仍聚焦真子进程租约、正式重启和受限清理，本轮只补线程与轮次模型设置字段。2026-09-10 按正常流与进程生命周期拆分。 | 已排期：2026-09-10 |
| 2026-08-08 | Codex Runtime E5 顺序迁移 | `src/main/modules/migrations.ts` | 4138 | E1-E5 净 +135 | 健康 | 只追加受机器合同和 Electron SQLite 测试约束的顺序迁移，仍是单一机械聚合。 | 无需处理 |
| 2026-08-11 | Codex engine-terminal 用户停止验收 | `src/__tests__/ready-codex-lifecycle-adapter.test.ts` | 1722 | 本轮增加时序反例 | 一般 | 仍是生命周期适配的单一行为套件，本轮加入 stop 持久成功、失败保留界面、停止先赢、正常收口先赢、发布失败重做与有界去重的直接行为。2026-09-11 按发送收口、压缩与用户生命周期拆套件。 | 已排期：2026-09-11 |
| 2026-08-08 | Codex Runtime E5 运行服务装配 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2379 | E1-E5 净 +80 | 危险 | 本轮只接入 Codex 启停与收口参与者，产品判断仍在叶子模块；总装配职责依然过多。E8 继续按既定运行服务边界迁出 Codex 组合接线。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E5 IPC 组合入口 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1637 | E1-E5 净 +26 | 一般 | 只绑定新的 Renderer 工具桥并移除本地 pending map，身份校验和清理在独立模块；入口仍是跨域装配面。2026-09-08 复查按产品域拆分接线。 | 已排期：2026-09-08 |
| 2026-08-08 | Codex Runtime E5 Renderer 发送入口 | `src/renderer/stores/useAgent.ts` | 1518 | E1-E5 净 +7 | 危险 | 本轮只在发送前取得当前文档版本锚点，计算与读取均已下沉；store 仍混合会话、发送和投影职责。E8 前不再扩张，并按既有边界迁出发送编排。 | E8 必拆；交付时提醒 |
| 2026-08-08 | Codex Runtime E5 工具执行入口 | `src/main/modules/tools/tool-executor.ts` | 1335 | E1-E5 净 +5 | 一般 | 只接入工具效果阶段通知，具体计时与确认政策留在独立模块。2026-09-08 复查统一工具路由密度。 | 已排期：2026-09-08 |
| 2026-08-08 | Codex Runtime E5 Renderer 跨进程声明 | `src/renderer/types/electron.d.ts` | 4015 | E1-E5 净 +3 | 健康 | 只机械补齐 durable generation 回读字段，由类型检查、行为测试和原生 SQLite 测试覆盖。 | 无需处理 |
| 2026-08-08 | Codex Runtime E5 Preload 汇总 | `src/preload/index.ts` | 1596 | E1-E5 净 +3 | 一般 | 只透传既有 Agent 生命周期与工具事件，无产品判断。2026-09-08 复查按产品域拆分 API 组装。 | 已排期：2026-09-08 |
| 2026-08-08 | Codex ConversationScope generation 真值修复 | `src/renderer/types/electron.d.ts` | 4014 | 净 +1 | 健康 | 只补齐 Main 已从 durable binding 回读的 alias generation 跨进程字段；声明文件仍是单一机械合同，并由类型检查、Renderer 行为测试和 Electron SQLite 测试覆盖。 | 无需处理 |
| 2026-08-07 | Codex Runtime E4 工具桥 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 2395 | E4 净 +44 | 危险 | E4 没有继续把约 400 行工具事务堆入总仓储，而是保留同一公开入口并下沉到受门禁限制的内部工具仓储；总文件只保留委托和准入交叉校验。其余启动、压缩与进程事务仍过多，E8 前继续按既定边界拆分。 | E4 工具事务已拆；其余待 E8 前独立拆分；交付时提醒 |
| 2026-08-07 | Codex Runtime E4 工具桥 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2304 | E4 净 +5 | 危险 | 只把 Codex run 中止权威接入开始、停止、重置与关闭组合点，未加入工具或产品域判断；运行服务装配职责仍过多，沿用既定拆分约束。 | 待独立拆分合同；交付时提醒 |
| 2026-08-07 | Codex Runtime E4 工具桥 | `src/__tests__/codex-binding-repository-native.test.ts` | 1498 | E4 净 +379 | 一般 | 原生 SQLite 套件新增工具绑定、动作凭证、迁移升级、伪造身份、过期 owner、跨 turn 同 call id 和完整桥接路径，仍属同一数据库合同，但失败定位成本已明显上升。2026-09-07 前按启动绑定、工具绑定与压缩/进程租约拆套件。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E4 工具桥 | `src/main/modules/tools/tool-executor.ts` | 1335 | E4 净 +5 | 一般 | 统一工具入口只新增效果阶段开始/结束通知，让用户确认等待不误消耗真实执行时限；确认政策与计时仍在独立模块。2026-09-07 复查工具路由是否需要继续下沉。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E4 工具桥 | `src/__tests__/codex-sidecar-crash-recovery.e2e.ts` | 1159 | E4 净 +11 | 一般 | 只把 E4 新的冻结身份补入既有真进程假执行器，没有增加新的产品场景。2026-09-07 仍按既定计划拆分通用 fixture 与故障场景。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E4 工具桥 | `src/__tests__/codex-sidecar-process-lease.e2e.ts` | 1064 | E4 净 +12 | 一般 | 只把 E4 新的冻结身份和连接关闭中止证据补入既有真进程假执行器，没有扩张生命周期职责。2026-09-07 仍按正常产品流与进程生命周期拆分。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E4 工具桥 | `src/main/modules/migrations.ts` | 4075 | E4 净 +7 | 健康 | 只追加顺序迁移 092 的注册入口；表升级与不可改写约束由独立机器合同和 Electron SQLite 测试承担。 | 无需处理 |
| 2026-08-07 | Codex Runtime E3 模型网关 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2136 | 新文件 | 危险 | 请求准入、上游调度和 native Responses 流验证仍集中在同一实现；E4 没有触及或继续增长该文件。下次需要修改网关前，应先以当前响应行为合同为边界，把 native 响应流验证与 listener/upstream 组合拆开。 | 下次网关改动前独立拆分；交付时提醒 |
| 2026-08-07 | Codex Runtime E3 Chat 转换网关 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway-chat.ts` | 1076 | 新文件 | 一般 | 文件仍聚焦 Chat 请求转换和流响应映射，本轮增加严格字段、参数与用量验证。2026-09-07 复查是否需要把请求转换与响应状态机拆开。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E3 模型网关对抗验证 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 2708 | 新文件 | 危险 | 请求准入、Chat/native 流式响应、泄漏、边界和终态反例已经明显妨碍定位；E4 没有触及或继续增长该套件。下次修改网关测试前应按请求准入、Chat 响应和 native 响应拆成独立套件，并保留同一机器合同入口。 | 下次网关测试改动前独立拆分；交付时提醒 |
| 2026-08-07 | Codex Runtime E3 真实子进程验收 | `src/__tests__/codex-model-gateway-sidecar.e2e.ts` | 1203 | 新文件 | 一般 | 单一固定版本验收流程覆盖产品请求、压缩、路由、失败候选与工具零执行；当前仍是同一真进程合同，但继续增长会降低定位速度。2026-09-07 复查是否按正常流、失败终态和工具边界拆分 fixture。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E2-E3 sidecar、绑定与模型网关 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 2351 | E3 净 +222 | 危险 | 六张 Codex 持久表仍由这一唯一写者维护；E3 只增加网关活动绑定裁决与首次 Provider 轮次身份锁定，避免网关成为第二个直接写者，但事务族已过多。E8 前应保留一个对外 facade 和写向 gate，再按 start/turn、manual compaction、process lease 三类内部事务边界拆分。 | 待 E8 前独立拆分合同；交付时提醒 |
| 2026-08-07 | Codex Runtime E2 真进程恢复补证 | `src/__tests__/codex-sidecar-crash-recovery.e2e.ts` | 1148 | 新文件后 E3 净 +9 | 一般 | 单一验收流程覆盖六个启动中断位置、早到事件和三路恢复，共享搭建与故障注入使文件过线，但职责仍限于同一真进程合同。2026-09-07 复查是否将通用 provider/transport fixture 与断言场景拆开。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E2 sidecar 与恢复 | `src/__tests__/codex-sidecar-process-lease.e2e.ts` | 1052 | 新文件后 E3 净 +8 | 一般 | 单一真子进程验收流程覆盖会话、工具、压缩、并发、正式重启和受限清理；继续增长会降低故障定位速度。2026-09-07 复查是否按正常产品流与进程生命周期拆分。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E2-E3 持久约束复核 | `src/__tests__/codex-binding-repository-native.test.ts` | 1119 | 新文件后 E3 净 +97 | 一般 | 单一原生 SQLite 套件覆盖六表关系、启动隔离、原子收口、进程证据和模型路由冻结；继续增长会降低失败定位速度。2026-09-07 复查是否按启动绑定、产品收口和进程租约拆套件。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E2 sidecar 与恢复 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2299 | 净 +4 | 危险 | 本轮只在既有组合根注入 Codex 收口事务参与者，新判断在叶子仓储内；但文件仍承载过多运行时装配职责，沿用既有拆分约束。 | 待独立拆分合同；交付时提醒 |
| 2026-08-07 | Codex Runtime E2 sidecar 与恢复 | `src/main/modules/database.ts` | 3089 | 净 +1 | 危险 | 本轮只补充原生 SQLite 事务状态的窄类型读回，没有新增数据域；多产品数据入口仍集中，沿用既有仓储下沉计划。 | 待拆分规划；交付时提醒 |
| 2026-08-07 | Codex Runtime E2-E3 sidecar 与模型网关 | `src/main/modules/migrations.ts` | 4068 | E3 净 +65 | 健康 | 只追加顺序迁移 090-091，建立 Ready 自有的不可变上游快照、请求凭证与首次 Provider 轮次身份锁定；实际结构受机器合同、Electron SQLite 迁移和不可改写测试约束。 | 无需处理 |
| 2026-08-07 | Codex Runtime E2 sidecar 与恢复 | `src/__tests__/ready-codex-lifecycle-adapter.test.ts` | 1058 | 净 +61 | 一般 | 仍是 Codex 生命周期适配的单一行为套件，本轮只补无效原生结果与收口失败反例。2026-09-07 复查是否按发送收口与用户生命周期拆套件。 | 已排期：2026-09-07 |
| 2026-08-07 | Codex Runtime E1 原生接缝 | `src/main/modules/agent-control/contracts/run-contracts.ts` | 1010 | 净 +1 | 健康 | 只为既有协调结果补充产品收口证据字段；文件仍是单一合同声明面，并由类型检查、Codex 专项行为测试和正式构建覆盖。 | 无需处理 |
| 2026-08-07 | Codex Runtime E1 原生接缝 | `src/main/modules/agent-control/runtime-core/remote-channel-service.ts` | 1254 | 净 +8 | 一般 | 只把旧本地协调器请求改为显式注入的入站执行端口，渠道身份、附件和投递职责没有扩张。2026-09-07 复查入站执行端口能否继续下沉到独立渠道入口。 | 已排期：2026-09-07 |
| 2026-07-24 | ChatGPT OAuth 实验接入 | `src/preload/index.ts` | 1601 | 净 +4 | 一般 | 只增加登录状态读取、发起登录与退出登录的跨进程透传，仍是跨进程 API 汇总面。2026-08-24 复查是否按设置域拆分接口组装。 | 已排期：2026-08-24 |
| 2026-07-24 | ChatGPT OAuth 实验接入 | `src/renderer/types/electron.d.ts` | 4081 | 净 +31 | 健康 | 机械补齐登录状态、回调结果与可选模型能力的跨进程声明，由类型检查、专项测试和构建检查覆盖。 | 无需处理 |
| 2026-07-23 | 飞书 CLI 与超时闭环 | `src/main/modules/tools/skills-tools.ts` | 3101 | 净 +13 | 危险 | 技能工具注册、执行分派、授权与投影仍集中；本轮只把已验证的技能声明程序并入当前技能临时白名单，判断已留在解析和授权叶子层。后续仍需按既有独立合同拆分全局技能工具宿主。 | 待独立拆分合同；交付时提醒 |
| 2026-07-23 | 飞书 CLI 与超时闭环 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1537 | 净 +3 | 一般 | 只让统一工具定义携带现有 timeout profile 的执行上限，并注册 command_exec profile；没有加入飞书业务判断。2026-08-23 复查跨域注册密度。 | 已排期：2026-08-23 |
| 2026-07-23 | 飞书 CLI 与超时闭环 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1134 | 净 +12 | 一般 | 只把所有宿主工具调用统一包进执行开始/结束生命周期，具体时钟和收口均在独立模块。2026-08-23 复查 SDK 工具包装与事件发布边界。 | 已排期：2026-08-23 |
| 2026-07-23 | 飞书 CLI 与超时闭环 | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1314 | 净 +10 | 一般 | 只把“脚本存在”授权判定替换为统一可执行面判定，并修正同轮选中技能先解析、后授权的顺序；技能解析和同意策略仍在叶子模块。2026-08-23 复查技能授权组装密度。 | 已排期：2026-08-23 |
| 2026-07-23 | 飞书 CLI 与超时闭环 | `src/main/modules/skills-runtime/runtime-manager.ts` | 1172 | 净 +5 | 一般 | 只透传声明程序；技能中心的同意状态继续只面向技能自带脚本，解析和策略均在叶子模块。2026-08-23 复查运行时装配密度。 | 已排期：2026-08-23 |
| 2026-07-23 | 飞书 CLI 与超时闭环 | `src/renderer/components/layout/SkillsCenterPanel.tsx` | 1402 | 净 +1 | 一般 | 只透传声明程序信息并明确既有同意开关仍仅为技能自带脚本显示，没有增加新的交互流程。2026-08-23 复查技能配置与卡片呈现是否继续下沉。 | 已排期：2026-08-23 |
| 2026-07-23 | 飞书 CLI 与超时闭环 | `src/renderer/types/electron.d.ts` | 4051 | 净 +1 | 健康 | 机械补齐声明程序和执行同意返回形状，由跨进程类型检查与真实应用回读覆盖。 | 无需处理 |
| 2026-07-23 | Provider checkpoint 纠偏（复核补录） | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2603 | 净 -545 | 危险 | 拆分后仍是最大运行服务装配文件；危险评级不因净减撤销。后续按既有拆分合同继续迁出交互生命周期与 continuation 组合。 | 待独立拆分合同；交付时提醒 |
| 2026-07-23 | Provider checkpoint 纠偏 | `src/main/modules/agent-control/runtime-core/orchestrator.ts` | 1040 | 净 +12 | 一般 | 仍是 Agent 运行组合入口，本轮只接入 Browser continuation 窄委派；业务判断已在叶子模块。2026-08-23 复查组合接线密度。 | 已排期：2026-08-23 |
| 2026-07-23 | Provider checkpoint 纠偏 | `src/renderer/components/agent/ChatPanel.tsx` | 1167 | 净 +17 | 一般 | 仍是聊天面板组合宿主，本轮只透传结构化暂停与 canonical 终态。2026-08-23 复查任务面板接线是否继续下沉。 | 已排期：2026-08-23 |
| 2026-07-23 | Provider checkpoint 纠偏 | `src/renderer/components/ready/TaskPanel.tsx` | 1155 | 净 +24 | 一般 | 仍是任务面板宿主，本轮只按 `waitingFor` 和续跑句柄呈现等待/暂停/未完成。2026-08-23 复查详情与列表呈现边界。 | 已排期：2026-08-23 |
| 2026-07-23 | Provider checkpoint 纠偏 | `src/renderer/pages/modes/BrowserMode.tsx` | 1451 | 净 +2 | 一般 | 页面仍只组合 Browser 工作面，本轮只透传监督面的结构状态。2026-08-23 复查 BrowserView 可见性与监督接线。 | 已排期：2026-08-23 |
| 2026-07-23 | Provider checkpoint 纠偏拆分 | `agent-session-checkpoint-resume.ts` / `run-finalizer.ts` / `browser-engine/ipc-handler.ts` / `renderer/modules/agent/runtimeDriver.ts` / `agentPanelTestHarness.ts` | 59 / 231 / 218 / 689 / 19 | 均为净减 | 健康 | 原超限 facade 已分别降为窄委派或组合入口；叶子模块最大为 760 行（browser-controller-contract-base.ts，复核修正），模块边界脚本强制方向与上限。 | 拆分完成 |
| 2026-07-22 | Provider 可靠性第三批 | `src/main/modules/repositories/agent-session-checkpoint-resume.ts` | 1478 | 净 +24 | 危险 | typed 续跑、确认、接管和 owner-crash 事务混合，已妨碍 P7 恢复重数修复。2026-07-23 计划要求先按四个事务域做 move-only 拆分，再改 marker。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-22 | Provider 可靠性第三批 | `src/main/modules/browser-engine/ipc-handler.ts` | 2829 | 净 +4 | 危险 | BrowserController 与 IPC 注册、target 接管、tab/捕获服务仍混合。2026-07-23 计划要求保留稳定 facade，将接管、tab、capture、live-proof 和 composition 下沉。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-22 | Provider 可靠性第三批 | `src/renderer/modules/agent/agentPanelTestHarness.ts` | 1483 | 净 +9 | 危险 | 类型、快照、诊断与交互驱动已集中过多，并导致 P9 报告对“可见”的证明模糊。2026-07-23 计划要求拆成 types/snapshot/diagnostics/driver，原安装入口保持不变。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/main/modules/repositories/agent-session-checkpoint-resume.ts` | 1454 | 净 +126 | 危险 | 本轮又加入确认过期、拒绝回执和事务内续跑判定，证明该入口已同时承担多类状态转移。后续应先以现有原生门禁固定合同，再迁出确认生命周期事务。 | 待独立拆分合同；交付时提醒 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 3148 | 净 +3 | 危险 | Browser/continuation 组合入口已成独立迁出边界。2026-07-23 计划只迁移本次相关域并建立禁止回流 gate，不借机重写日程/渠道/记忆域。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1314 | 净 +40 | 危险 | 终态类型、投影、任务事实、裁决和持久化必须在 checkpoint canonical 修复前拆分；`finalizeRunOutcome()` 仍保留为唯一公开入口。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/__tests__/agent-session-checkpoint-native.test.ts` | 1595 | 净 +162 | 一般 | checkpoint 写入、确认生命周期和 target 恢复场景已肥大到妨碍缺口定位。2026-07-23 计划要求在共享原生 SQLite fixture 基础上按行为域拆套件。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/__tests__/run-finalizer-checkin.test.ts` | 1327 | 净 +4 | 一般 | 终态判决、canonical 收口与验收回执已应分组，否则后续修复会继续把新变体堆进单文件。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/renderer/components/ready/TaskPanel.tsx` | 1131 | 净 +53 | 一般 | 文件仍是任务面板宿主，本轮只增加结构化确认展示与类型化选择。2026-08-22 复查任务详情和列表展示是否继续拆分。 | 已排期：2026-08-22 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/renderer/modules/agent/scopeRunState.ts` | 1061 | 净 +7 | 一般 | 仍聚焦运行状态归一化，本轮只完整读取结构化确认续跑字段。2026-08-22 复查事件归一化边界。 | 已排期：2026-08-22 |
| 2026-07-22 | Provider 可靠性与确认可见性 | `src/renderer/types/electron.d.ts` | 4050 | 净 +1 | 健康 | 只补齐结构化确认的跨进程声明，由类型检查、行为测试和真实应用验收覆盖。 | 无需处理 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/repositories/agent-session-checkpoint-resume.ts` | 1329 | 净 +407 | 危险 | 目标级接管、同任务多目标恢复和任务级竞态已集中到同一恢复入口，虽有原生并发门禁，但继续增长会妨碍判定事务边界。后续应先固定单目标与多目标恢复合同，再迁出目标恢复事务。 | 待独立拆分合同；交付时提醒 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 3145 | 净 +168 | 危险 | 本轮接入人工交互生命周期、浏览器目标恢复与启动 handoff 结算路由，但运行服务装配仍过度集中。后续应把交互生命周期与 Browser/continuation 组合 facade 迁出。 | 待独立拆分合同；交付时提醒 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/browser-engine/ipc-handler.ts` | 2825 | 净 +5 | 危险 | 本轮删除旧归属路径并接入目标接管和真实页面判定，但浏览器宿主控制、服务装配与入口仍集中。后续应继续下沉目标接管与宿主协调。 | 待独立拆分合同；交付时提醒 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/tools/browser-act-tools.ts` | 2536 | 净 +17 | 危险 | 本轮只补目标级接管前的页面实况判断；交互、表单、导航、上传与采集仍共用巨大分派器。后续按既有动作族拆分合同继续下沉。 | 待独立拆分合同；交付时提醒 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1280 | 净 +28 | 危险 | 本轮让目标归属与任务终态在同一收口事务内关闭；通用终态、投影和持久收口仍集中。后续应分离通用终态事务与产品目标收口。 | 待独立拆分合同；交付时提醒 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/database.ts` | 3088 | 净 +1 | 危险 | 本轮只改用显式隔离数据库路径；多产品域数据库入口仍集中。后续应继续迁出产品仓储装配。 | 待独立拆分合同；交付时提醒 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/__tests__/agent-session-checkpoint-native.test.ts` | 1316 | 净 +241 | 一般 | 仍只验证原生 SQLite checkpoint、目标归属与并发恢复生命周期。2026-08-22 复查是否按写入、单目标恢复和多目标竞态拆分夹具。 | 已排期：2026-08-22 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/tools/tool-executor.ts` | 1330 | 净 +43 | 一般 | 统一工具入口只接入结构化续跑与人工交互调用，具体判断留在叶子模块。2026-08-22 复查续跑与交互 handler 是否可整体下沉。 | 已排期：2026-08-22 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/preload/index.ts` | 1597 | 净 +6 | 一般 | 只增加目标恢复与真机验收身份透传，仍是跨进程 API 汇总面。沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/renderer/pages/modes/BrowserMode.tsx` | 1449 | 净 +4 | 一般 | 只把目标恢复动作交给既有监督面板，页面职责未扩散。2026-08-22 复查原生层可见性与监督接线是否继续下沉。 | 已排期：2026-08-22 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/index.ts` | 1164 | 净 +2 | 一般 | 只注册隔离的真机验收身份入口，仍是主进程组合入口。沿用 2026-07-25 的组合根复查。 | 已排期：2026-07-25 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/main/modules/migrations.ts` | 3983 | 净 +116 | 健康 | 只追加顺序迁移 087，为目标归属和接管回执提供结构；连续编号和真实 Electron SQLite 门禁覆盖。 | 无需处理 |
| 2026-07-22 | 浏览器目标归属与续跑闭环 | `src/renderer/types/electron.d.ts` | 4049 | 净 +26 | 健康 | 机械补齐目标监督、恢复与真机验收身份声明，由类型检查和真实安装包核验覆盖。 | 无需处理 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `scripts/run-browser-grounded-orchestration-live-proof.mjs` | 1062 | 净 +57 | 一般 | 仍是单一真实应用验收入口；本轮修正 Renderer/Main 标签一致性并复用一例验证纯键盘提交。2026-08-20 复查是否迁出标签准备与报告读取。 | 已排期：2026-08-20 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/__tests__/agent-session-checkpoint-native.test.ts` | 1075 | 净 +108 | 一般 | 仍只验证原生 SQLite checkpoint 生命周期，本轮补接管提示与可继续动作持久化。2026-08-20 复查是否按写入、恢复拆分夹具。 | 已排期：2026-08-20 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/__tests__/browser-engine-services.test.ts` | 1389 | 净 +7 | 一般 | 仍是浏览器引擎服务行为集；本轮只在现有键盘投递用例中核对 CDP 焦点模拟的开启与恢复。2026-08-20 复查是否按 automation/lifecycle 拆分。 | 已排期：2026-08-20 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/__tests__/runtime-driver-terminal-unlock.test.ts` | 1283 | 净 +37 | 一般 | 人工暂停、终态解锁和 Renderer 看门狗场景已可独立拆分。2026-07-23 计划要求把 Browser checkpoint 场景迁出，原套件保留通用终态合同。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/__tests__/scope-run-state.test.ts` | 1293 | 净 +28 | 一般 | 仍聚焦 scope 运行状态归一化，本轮补人工暂停的完成与错误对照。2026-08-20 复查按终态族拆分。 | 已排期：2026-08-20 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2977 | 净 +1 | 危险 | 本轮只透传接管提示，运行服务装配仍过度集中；后续应继续迁出 Browser/continuation 组合 facade。 | 待独立拆分合同；交付时提醒 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/main/modules/browser-engine/ipc-handler.ts` | 2820 | 净 +13 | 危险 | 本轮只让 detached/hidden 宿主在受保护的发键期间临时 offscreen park 并按原状态恢复，但浏览器宿主控制、服务装配与入口仍集中。后续应把输入 presentation 与 layout 协调继续下沉。 | 待独立拆分合同；交付时提醒 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/main/modules/tools/browser-act-tools.ts` | 2519 | 净 +17 | 危险 | 本轮只修提交结果与部分写入回执；交互、表单、导航、上传与采集仍共用巨大分派器。后续按既有动作族拆分合同继续下沉。 | 待独立拆分合同；交付时提醒 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/main/modules/tools/browser-input-actions.ts` | 1273 | 净 +58 | 一般 | 文件仍聚焦可信输入，本轮把文字写入、定向键盘投递和部分生效回读分开验证，不再引入原生聚焦路径。2026-08-20 复查是否按文字与键盘通道拆分。 | 已排期：2026-08-20 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/renderer/modules/agent/runtimeDriver.ts` | 1884 | 净 +5 | 一般 | 监听器、运行状态、超时、终态消息和 scope 事件映射已集中过多。2026-07-23 计划要求保留安装入口，拆出 session/watchdog/canonical/scope 事件域。 | 已纳入 2026-07-23 纠偏实施计划 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/renderer/modules/agent/scopeRunState.ts` | 1055 | 净 +1 | 一般 | 仍是运行状态归一化单一职责，本轮只增加人工暂停枚举。2026-08-20 复查事件归一化边界。 | 已排期：2026-08-20 |
| 2026-07-20 | 浏览器填字、回车与暂停闭环 | `src/renderer/types/electron.d.ts` | 4023 | 净 +1 | 健康 | 只补齐跨进程人工暂停声明，类型检查和真实应用验收覆盖。 | 无需处理 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/agent-acceptance-checklist.test.ts` | 2789 | 净 +20 | 危险 | 产品验收矩阵仍聚合多个独立能力域；本轮只补最终工具面与浏览器能力地板验收。后续应按产品域拆成独立验收套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/agent-sdk-product-acceptance.test.ts` | 1025 | 净 +19 | 一般 | 仍是产品级 SDK 验收单一职责，本轮补浏览器调度与终态合同。2026-08-19 复查是否按能力面拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/agent-sdk-runtime.test.ts` | 7583 | 净 +46 | 危险 | 共享 SDK 宿主测试继续聚合大量状态场景；本轮新增跨轮工具面与恢复回归，后续应先建立隔离 fixture 再按生命周期拆分。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/browser-engine-services.test.ts` | 1382 | 净 +36 | 一般 | 仍集中验证浏览器引擎服务，本轮只补物理标签、页面身份和恢复边界。2026-08-19 按会话与目标身份复查拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/run-finalizer-checkin.test.ts` | 1323 | 净 +1 | 一般 | 仍是终态判决与验收回执的单一行为域。2026-08-19 复查来源证明与终态验收拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/runtime-driver-terminal-unlock.test.ts` | 1246 | 净 +188 | 一般 | 文件仍聚焦 Renderer 终态解锁，本轮补任务投影与暂停恢复变体。2026-08-19 复查是否迁出 Browser 专项场景。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/stores.test.ts` | 3329 | 净 +36 | 危险 | 多个 store 产品域仍共用一个大套件；本轮只补任务卡无框与投影消费回归。后续应拆出 Agent 与工作区套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/__tests__/task-projection-sync.test.ts` | 1719 | 净 +69 | 一般 | 文件仍聚焦任务投影同步，本轮补 Browser child 与 Parent 单一真值。2026-08-19 复查按终态与续跑拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/agent-control/contracts/run-contracts.ts` | 1009 | 净 +33 | 健康 | 只聚合运行合同声明，本轮增加结构化 Browser 终态与恢复字段，并由类型检查和行为测试覆盖。 | 无需处理 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1305 | 净 +66 | 一般 | 仍是 SDK 组合宿主，具体 Browser 判断已下沉到独立模块。2026-08-19 复查 composition 接线密度。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/agent-control/runtime-core/orchestrator.ts` | 1028 | 净 +5 | 一般 | 只透传浏览器运行合同，没有写产品分支。2026-08-19 复查编排入口密度。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1252 | 净 +211 | 危险 | 通用终态、投影和持久收口仍集中；本轮虽把 Browser 证据检查下沉，宿主增长仍明显。后续应把通用终态事务与产品证据适配分离。 | 待独立拆分合同；交付时提醒 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2976 | 净 +375 | 危险 | 多类运行服务装配仍集中；本轮核心 Browser 生命周期已下沉，但宿主接线继续增长。后续应迁出 Browser/continuation 组合 facade。 | 待独立拆分合同；交付时提醒 |
| 2026-07-19 | 浏览器长任务终态一致性 | `src/renderer/modules/agent/agentPanelTestHarness.ts` | 1474 | 净 +1 | 一般 | 仍是开发期 Agent 面板验收入口，本轮只补新的暂停终态枚举。2026-08-19 复查是否按诊断与驱动拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器长任务终态一致性 | `src/renderer/modules/agent/scopeRunState.ts` | 1054 | 净 +1 | 一般 | 仍聚焦 Renderer 运行状态归一化，本轮只补新的暂停终态枚举。2026-08-19 复查事件归一化边界。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器长任务终态一致性 | `src/renderer/types/electron.d.ts` | 4022 | 净 +5 | 健康 | 单一用途的 Renderer 跨进程声明合同，本轮补齐浏览器暂停原因与继续句柄，由类型检查和真实应用验收覆盖。 | 无需处理 |
| 2026-07-19 | 浏览器长任务真实验收 | `scripts/run-browser-grounded-orchestration-live-proof.mjs` | 1005 | 净 +51 | 一般 | 单一真实应用验收入口，本轮补 normal/Boost 切换及终态预算、归属和续跑清理读回。2026-08-19 复查是否拆出报告读取工具。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1534 | 净 +9 | 一般 | 只注册统一 Browser 能力定义，具体行为不在注册表。2026-08-19 复查跨域注册密度。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/database.ts` | 3087 | 净 +62 | 危险 | 多产品域数据库入口仍集中；本轮 Browser workflow 数据已下沉仓储，但总管理器仍承担装配。后续应继续迁出任务仓储 facade。 | 待独立拆分合同；交付时提醒 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/migrations.ts` | 3867 | 净 +142 | 健康 | 只追加顺序迁移，为 Browser workflow、checkpoint 和确认账本提供结构；连续编号与真实 Electron SQLite 门禁覆盖。 | 无需处理 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/skills-runtime/runtime-manager.ts` | 1167 | 净 +1 | 一般 | 只透传技能与 Browser 的组合身份。2026-08-19 复查运行时装配密度。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/tools/browser-input-actions.ts` | 1215 | 净 +279 | 一般 | 文件仍聚焦可信输入动作，本轮补 target 兼容、表单提交和动作回读。2026-08-19 复查按文字、键盘与表单通道拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/tools/browser-observe-tools.ts` | 1207 | 净 +34 | 一般 | 文件仍聚焦只读观察工具，本轮补 grounded receipt 与页面身份。2026-08-19 复查按结构与媒体观察拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/tools/browser-probe.ts` | 1026 | 净 +345 | 一般 | 文件仍是页面探针的单一实现，本轮补 frame、shadow 与结构目标证据。2026-08-19 复查采集器分层是否需要继续下沉。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/main/modules/tools/skills-tools.ts` | 3088 | 净 +12 | 危险 | 技能工具注册、调度和授权仍集中；本轮只接入 Browser 能力组合。后续需在独立合同下拆分，避免扩大全局工具宿主。 | 待独立拆分合同；交付时提醒 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/preload/index.ts` | 1591 | 净 +16 | 一般 | 只增加 Browser 任务与 UI 投影透传，仍是跨进程 API 汇总面。沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/renderer/components/ready/TaskPanel.tsx` | 1087 | 净 +7 | 一般 | 仍是任务面板宿主，本轮只移除任务卡外框。2026-08-19 复查任务详情与列表呈现拆分。 | 已排期：2026-08-19 |
| 2026-07-19 | 浏览器 grounded 调度与能力闭环 | `src/renderer/stores/useAgent.ts` | 2158 | 净 +44 | 危险 | 会话、发送、任务与投影状态仍集中；本轮只消费 Main 的 Browser 终态并移除 UI 猜测。后续应把任务投影和发送编排拆出。 | 待独立拆分合同；交付时提醒 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/renderer/components/document/BoardEditor.tsx` | 1683 | 净 +37 | 危险 | 本轮补齐失败保存的真实重试入口与保存期间新变更的稳定收敛，但画布渲染、节点操作、缩放、选择和快捷键仍集中。后续应先以现有行为合同固定边界，再拆分节点交互与画布视口协调。 | 待独立拆分合同；交付时提醒 |
| 2026-07-18 | 0.7.5 文档保存竞态收口 | `src/renderer/modules/agent/document-actions/execute.ts` | 1934 | 净 +37 | 危险 | 文档工具动作、命令、目标解析后的写入与保存编排仍集中；本轮只将所有已有文档保存入口收入同路径串行合同。后续应先迁出保存/另存与工具写入提交流程，再按动作族拆分。 | 待独立拆分合同；交付时提醒 |
| 2026-07-18 | 0.7.5 文档保存竞态收口 | `src/renderer/components/document/MarkdownEditor.tsx` | 1118 | 净 +7 | 一般 | 仍是文档编辑面的单一宿主；本轮只把保存归属与同路径排队键接入共享模块。2026-08-17 复查是否继续迁出上下文菜单和资源拖入编排。 | 已排期：2026-08-17 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/index.ts` | 1162 | 净 +31 | 一般 | 本轮接入普通关窗、整体退出和重复请求的共享保存协调，具体状态机已下沉到独立模块；该文件仍是主进程组合入口。2026-08-18 复查菜单、协议与退出编排是否继续下沉。 | 已排期：2026-08-18 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/__tests__/stores.test.ts` | 3293 | 净 +133 | 危险 | 多个 store 产品域仍共用一个大套件。后续应把文档标签和工作区监听分别迁入独立套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/renderer/stores/useWorkspace.ts` | 1290 | 净 +80 | 危险 | 工作区导航、文件操作与监听生命周期已集中在同一 store。后续应在保留现有竞态行为测试后，迁出 watcher registry/reconcile 状态机。 | 待独立拆分合同；交付时提醒 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/__tests__/run-finalizer-checkin.test.ts` | 1322 | 净 +38 | 一般 | 仍是终态判决与验收回执的单一行为域，但继续增长会妨碍定位。2026-08-18 复查是否按来源证明与终态验收拆分。 | 已排期：2026-08-18 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/modules/database.ts` | 3025 | 净 +19 | 危险 | 多产品域数据操作仍集中在总管理器。后续应把浏览器任务执行身份与投影同步下沉到独立仓储。 | 待拆分规划；交付时提醒 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/modules/migrations.ts` | 3725 | 净 +15 | 健康 | 只追加顺序迁移，为浏览器任务执行身份与投影同步补齐持久字段；连续编号和真实 Electron SQLite 验证覆盖该机械聚合。 | 无需处理 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/modules/tools/browser-observe-tools.ts` | 1173 | 净 +14 | 一般 | 文件仍聚焦浏览器观察类工具，本轮只补严格输入。2026-08-18 复查是否需按页面观察与媒体解析分组。 | 已排期：2026-08-18 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/preload/index.ts` | 1575 | 净 +16 | 一般 | 只补浏览器研究、文件监听失败与关窗/退出保存结果透传，仍是跨进程 API 汇总面。沿用 2026-07-24 的按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/renderer/types/electron.d.ts` | 4055 | 净 +6 | 健康 | 单一用途的 Renderer 跨进程声明合同，本轮增量由类型检查、IPC 行为测试和真实应用验收覆盖。 | 无需处理 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1239 | 净 +4 | 一般 | 只接入浏览器研究的本轮工具面与运行上下文，仍是 SDK 组合宿主。2026-08-18 复查 composition 接线密度。 | 已排期：2026-08-18 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1198 | 净 +11 | 一般 | 本轮让显式社媒运营技能在站内研究任务中继续保留状态查询、续跑与接管能力；工具包装与跟踪发布仍集中。2026-08-18 复查是否继续下沉。 | 已排期：2026-08-18 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/renderer/pages/WorkbenchMode.tsx` | 1010 | 净 +2 | 一般 | 只在工作台编排层消费文件监听错误提示。2026-08-17 继续复查分栏与模式切换协调的下沉空间。 | 已排期：2026-08-17 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/modules/tools/tool-executor.ts` | 1327 | 净 +1 | 一般 | 统一工具调度入口只增加新浏览器工具的路由接线。2026-08-18 复查独立 handler 路由的下沉进展。 | 已排期：2026-08-18 |
| 2026-07-18 | 0.7.5 文档性能与站内研究收口 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1041 | 净 +1 | 一般 | 只将浏览器研究完成真值纳入现有终态判决。2026-08-18 复查终态事实解析是否应继续下沉。 | 已排期：2026-08-18 |
| 2026-07-17 | 文档模式性能与多面负载优化 | `src/renderer/components/document/BoardEditor.tsx` | 1646 | 净 +359 | 危险 | 本轮已将拖动几何、动画帧调度、保存排队、退出冲刷、外部素材收件箱与活动画板句柄拆入叶子模块，但画布渲染、节点操作、缩放、选择和快捷键仍集中在同一文件。后续应先以行为合同固定边界，再拆分节点交互与画布视口协调。 | 待独立拆分合同；交付时提醒 |
| 2026-07-17 | 文档模式性能与多面负载优化 | `src/renderer/pages/modes/DocumentMode.tsx` | 1015 | 净 -75 | 一般 | 本轮把隐藏场景、外部刷新、退出冲刷和画板句柄管理下沉到独立模块，总体净缩减；它仍是文档标签、双栏、阅读会话与滚动状态的编排宿主。2026-08-17 复查阅读会话与滚动锚点是否继续迁出。 | 已排期：2026-08-17 |
| 2026-07-17 | 文档模式性能与多面负载优化 | `src/renderer/components/document/MarkdownEditor.tsx` | 1108 | 净 +53 | 一般 | 仍是文档编辑面的单一宿主，本轮已把保存归属、签名计算和滚动状态下沉到叶子模块；文件仍同时接线加载、编辑、预览、Widget 与菜单。2026-08-17 复查是否继续迁出上下文菜单和资源拖入编排。 | 已排期：2026-08-17 |
| 2026-07-17 | 文档模式性能与多面负载优化 | `src/renderer/components/document/note-preview-parser.ts` | 1465 | 净 +8 | 一般 | 本轮只增加诊断计数和同次解析得到的行数，仍保持结构化预览解析单一职责。沿用 2026-08-11 对分段解析阶段的复查。 | 已排期：2026-08-11 |
| 2026-08-10 | 文档预览分行修复 | `src/renderer/styles/markdown.css` | 1337 | 净 +1 | 健康 | 本轮只补文档预览正文的原始换行呈现；样式表仍是单一 Markdown 呈现职责，并由级联层检查、行为测试和真实应用验收覆盖。 | 无需处理 |
| 2026-07-17 | 文档模式性能与文件监听生命周期收口 | `src/__tests__/stores.test.ts` | 3293 | 净 +135 | 危险 | 本轮补齐双栏不变量以及监听启动、退出、延迟失败、跨路由恢复与重复重试竞态；测试文件仍混合多个 store 产品域。后续应把文档标签和工作区监听分别迁入独立套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-17 | 浏览器性能与动态负载优化 | `src/renderer/pages/modes/BrowserMode.tsx` | 1449 | 净 +27 | 一般 | 收紧 store 订阅、稳定书签投影，并只接入独立的窗口缩放冻结帧边界；页面仍是浏览器工作面编排宿主。2026-08-17 复查是否把分栏与标签投影继续下沉。 | 已排期：2026-08-17 |
| 2026-07-17 | 工作台性能与原生覆盖面收口 | `src/renderer/pages/WorkbenchMode.tsx` | 1010 | 净 +38 | 一般 | 本轮把分栏拖动期间的高频宽度更新留在界面层并在结束时一次写回，收紧全局状态订阅，同时只消费共享的文件监听错误提示；页面仍承载工作台总编排。2026-08-17 复查分栏和模式切换协调是否应下沉。 | 已排期：2026-08-17 |
| 2026-07-17 | 文件监听生命周期与跨路由恢复 | `src/renderer/stores/useWorkspace.ts` | 1290 | 净 +80 | 危险 | 工作区导航、文件操作与监听生命周期已集中在同一 store；本轮虽把监听真值、失败可见性和竞态合同统一在一处，但体量已妨碍独立演进。后续应先保留现有行为测试，再把 watcher registry/reconcile 状态机迁入独立模块。 | 待独立拆分合同；交付时提醒 |
| 2026-07-17 | RSS 列表性能优化 | `src/renderer/components/rss/RSSFeed.tsx` | 1133 | 净 +50 | 一般 | 本轮把单行抽成可跳过重复渲染的叶子组件，并让视口外条目延后绘制；筛选、菜单、批量操作与列表编排仍在同一宿主。2026-08-17 复查列表编排是否继续拆分。 | 已排期：2026-08-17 |
| 2026-07-17 | RSSHub 动态生命周期收口 | `src/main/modules/rss-engine/ipc-handler.ts` | 1237 | 净 +8 | 一般 | 本轮只给内嵌服务请求增加活动期所有权、批处理让步并删除启动预热，生命周期判断留在 manager；沿用 2026-08-13 的 RSS IPC 组合根复查。 | 已排期：2026-08-13 |
| 2026-07-17 | 原生覆盖面遮挡合同 | `src/renderer/components/layout/SkillsCenterPanel.tsx` | 1401 | 净 +1 | 一般 | 只给既有技能配置弹窗补充统一覆盖面标记，文件仍是技能中心主宿主。2026-08-17 复查配置弹窗是否应迁出。 | 已排期：2026-08-17 |
| 2026-07-17 | 原生覆盖面遮挡合同 | `src/renderer/pages/modes/CalendarMode.tsx` | 1397 | 净 +3 | 一般 | 只给既有订阅、远程建议与提醒浮层补充统一覆盖面标记，日历页面主职责不变。2026-08-17 复查浮层编排是否应迁出。 | 已排期：2026-08-17 |
| 2026-07-17 | 浏览器 Agent 工具面重组与可靠性强化 | `src/main/modules/tools/browser-act-tools.ts` | 2531 | 净 +263 | 危险 | 本轮虽已把公开工具目录、统一执行器与低频工具按需可见性抽离，但页面交互、表单、导航、上传与收集动作仍集中在一个巨大分派器。后续应按“导航与观察 / 可信输入与表单 / 上传与持久采集”拆分，并保留单一执行入口。 | 待独立拆分合同；交付时提醒 |
| 2026-07-17 | 浏览器 Agent 工具面重组与动态负载优化 | `src/main/modules/browser-engine/ipc-handler.ts` | 2942 | 净 -10 | 危险 | 动态负载和可见性协调已下沉到 `browser-performance-runtime.ts` 与 `browser-visibility-runtime.ts`，同时把 dormant 登记、排序和生命周期逻辑收回对应 service，使大入口在本轮净缩减。文件仍集中大量跨进程装配与会话协调，后续仍应按服务簇继续下沉。 | 待拆分规划；交付时提醒 |
| 2026-07-17 | 浏览器 Agent 工具面重组与动态负载优化 | `src/__tests__/browser-engine-services.test.ts` | 1346 | 净 +314 | 一般 | 仍是浏览器引擎服务行为集合，本轮增加休眠、进程归属、合并、dormant 物化、profile 恢复与保护期结束后自动回收的证据。2026-08-17 按会话、负载、权限与恢复边界拆套件。 | 已排期：2026-08-17 |
| 2026-07-17 | 浏览器 Agent 工具面重组与可靠性强化 | `src/main/modules/database.ts` | 3006 | 净 +54 | 危险 | 本轮只接入浏览器 Power 审计和长任务恢复账本，但多产品域数据读写仍集中在总管理器。后续应把浏览器审计、任务检查点与会话持久化下沉到独立仓储。 | 待拆分规划；交付时提醒 |
| 2026-07-17 | 浏览器 Agent 工具面重组与可靠性强化 | `src/main/modules/browser-engine/content-task-runner.ts` | 1937 | 净 +29 | 危险 | 本轮补齐检查点恢复和终态合同，但可见发现、逐项采集、多任务种类与投影组装仍共存。后续先迁出投影与检查点序列化，再按任务种类拆 runner。 | 待独立拆分合同；交付时提醒 |
| 2026-07-17 | 浏览器 Agent 工具面重组与可靠性强化 | `src/main/modules/migrations.ts` | 3710 | 净 +24 | 健康 | 只追加顺序迁移，为浏览器 Power 审计与任务恢复补齐持久字段；连续编号和真实 Electron SQLite 验证覆盖该机械聚合。 | 无需处理 |
| 2026-07-17 | 浏览器 Agent 工具面重组与可靠性强化 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1162 | 净 +16 | 一般 | 只把新浏览器目录、低频交互按需可见性与旧入口退役接入现有工具面组装。沿用 2026-08-15 对 SDK 工具包装与跟踪发布拆分的复查。 | 已排期：2026-08-15 |
| 2026-07-17 | 浏览器与文档性能跨进程合同 | `src/renderer/types/electron.d.ts` | 4053 | 净 +19 | 健康 | 机械补齐休眠标签、命名 profile、文档文本大小、退出冲刷、画板活动目标/回执与文件监听失败事件，由类型检查、IPC 行为测试和真实应用验收覆盖。 | 无需处理 |
| 2026-07-17 | 浏览器性能、文档退出冲刷与监听失败通知 | `src/preload/index.ts` | 1567 | 净 +11 | 一般 | 只补齐休眠标签登记、画板目标/回执、退出确认与文件监听失败事件透传；仍是 API 汇总面。沿用 2026-07-24 的按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-17 | 浏览器 Agent 工具面重组与可靠性强化 | `src/main/modules/browser-engine/browser-collector-actions.ts` | 1567 | 净 +2 | 危险 | 本轮只把长任务恢复返回值统一为完整检查点，但多类采集动作与站点适配仍集中。后续应以通用采集合同为入口，把站点适配和各任务动作拆成独立模块。 | 待独立拆分合同；交付时提醒 |
| 2026-07-17 | 工具能力可见性与开启同意链路 | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1235 | 净 +17 | 一般 | 只增加活跃配置身份读取、单字段更新依赖及 turn host 接线；指纹核对、写入规则和确认流程均在独立叶子模块。沿用 2026-08-14 对 SDK composition 接线密度的复查。 | 已排期：2026-08-14 |
| 2026-07-17 | 工具能力可见性与开启同意链路 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1146 | 净 +13 | 一般 | 只把同一份 live capability resolution 回传给本轮准备层，并显式区分用户请求、否定意图与默认技能目录曝光；冲突判断和提示均在独立模块。沿用 2026-08-15 的工具面组装拆分复查。 | 已排期：2026-08-15 |
| 2026-07-17 | 工具能力可见性与开启同意链路 | `src/main/modules/agent-control/runtime-core/remote-channel-service.ts` | 1246 | 净 +15 | 一般 | 只在既有远程反问卡桥接点拒绝本机设置卡的转发与回答，普通卡片的远程回答路径不变。2026-08-15 复查远程渠道确认策略是否应下沉为独立 policy。 | 已排期：2026-08-15 |
| 2026-07-17 | 工具能力可见性与开启同意链路 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1846 | 净 +4 | 一般 | 只把本地卡片提交入口标记为本机 Renderer，不扩张 IPC 主控职责。沿用 2026-08-15 对大入口按产品域拆分的复查。 | 已排期：2026-08-15 |
| 2026-07-17 | 运营 agent 与社媒运营技能包 | `src/main/modules/migrations.ts` | 3685 | 净 +315（Migration 079 + 080） | 健康 | 顺序迁移 079 补种 operator 并保护所有保留 slug 用户冲突；080 只修复账本与精确占位内容共同证明的历史人格错绑。连续编号、fresh/upgrade/含糊状态保护和真实 Electron SQLite 行为测试覆盖该机械迁移聚合。 | 无需处理 |
| 2026-07-16 | Ready 窗口截图与快捷键校准 | `src/main/index.ts` | 1249 | 净 +20 | 一般 | 仅注册独立窗口截图服务的 IPC 与单次并发门，捕获、圆角与 PNG 写入均留在叶子模块；沿用 2026-07-25 的组合根复查。 | 已排期：2026-07-25 |
| 2026-07-16 | Ready 窗口截图与快捷键校准 | `src/preload/index.ts` | 1542 | 净 +1 | 一般 | 仅增加窗口截图跨进程透传；沿用 2026-07-24 的按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-16 | Ready 窗口截图与快捷键校准 | `src/renderer/types/electron.d.ts` | 4019 | 净 +1 | 健康 | 机械补齐窗口截图返回类型，由类型检查和真实应用验收覆盖。 | 无需处理 |
| 2026-07-15 | 兼容模型能力与迟到错误收口 | `src/renderer/modules/agent/runtimeDriver.ts` | 1942 | 净 +6 | 一般 | 只给已恢复回答的迟到错误去重记录增加固定上限，不扩张事件职责；沿用 2026-08-11 的 scope-run 事件映射拆分复查。 | 已排期：2026-08-11 |
| 2026-07-15 | 兼容模型能力收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 7547 | 净 +2 | 危险 | 仅把两条确实依赖文本工具桥的场景改为显式开启工具；共享 SDK 宿主测试仍明显过大，后续应把 provider/text-bridge 场景迁入独立集成套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 兼容模型能力收口 | `src/__tests__/agent-sdk-product-acceptance.test.ts` | 1006 | 净 +1 | 一般 | 仅让兼容接口文本桥验收明确声明工具能力，仍保持产品级验收单一职责；2026-08-15 复查是否按工具、技能与交付面拆分。 | 已排期：2026-08-15 |
| 2026-07-15 | 文档打开延迟收口 | `src/renderer/components/layout/FileTree.tsx` | 1954 | 净 +10 | 危险 | 文件树仍同时承担树/网格、拖放、剪藏占位和文件涌现接线；本轮已把空闲合并调度与稳定结构签名下沉独立叶子，正文、dirty 和激活时间不再触发涌现刷新，但真实卡顿再次证明宿主职责密度正在妨碍性能定位。后续优先把文件涌现状态与 pending clip 生命周期整体移出。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 文档打开延迟收口 | `src/renderer/pages/modes/DocumentMode.tsx` | 1090 | 净 +10 | 一般 | 只让隐藏 keep-alive 页面停止响应文件选择，去除同一打开动作的重复 stat/open/activity，并把空缓存首次读盘留给编辑器单一入口；磁盘 clean hydrate 已走 store 叶子。沿用 2026-08-11 复查，优先迁出阅读会话或滚动锚点。 | 已排期：2026-08-11 |
| 2026-07-15 | 历史错误终态修复 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1040 | 净 +34 | 一般 | 只统一“直接回答”在结束时的任务类型、验收条件和用量记录，并保留明确研究、浏览及续跑任务的原有要求；沿用 2026-08-15 复查终态事实解析是否应拆出。 | 已排期：2026-08-15 |
| 2026-07-15 | 历史错误终态修复 | `src/main/modules/migrations.ts` | 3370 | 净 +6（Migration 077） | 健康 | 只注册一次性历史修复；识别、修复和反例保护均在独立叶子模块，并由真实 Electron SQLite 幂等测试覆盖。 | 无需处理 |
| 2026-07-15 | 偏好与本地会话身份闭环 | `src/main/modules/agent-control/prompt-assembly.ts` | 1524 | 净 +8 | 一般 | 用户画像、Agent 语气和运行指令改为 L0 不可丢核心，格式化已下沉独立叶子模块；沿用 2026-08-15 复查静态触发、预算报告与资产装配的拆分空间。 | 已排期：2026-08-15 |
| 2026-07-15 | 偏好与本地会话身份闭环 | `src/main/modules/database.ts` | 2952 | 净 +1 | 危险 | 本轮只让本地旧入口显式绑定默认用户，并在更新时保留既有归属；多产品域数据操作仍集中在单一管理器，后续应把会话持久化下沉到独立仓储。 | 待拆分规划；交付时提醒 |
| 2026-07-15 | 偏好与本地会话身份闭环 | `src/main/modules/migrations.ts` | 3370 | 净 +12（Migration 078） | 健康 | 只追加顺序迁移 078，修复本地会话空用户归属；连续编号、幂等、远程隔离和真实 Electron SQLite 均有门禁。 | 无需处理 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/__tests__/agent-sdk-runtime.test.ts` | 7545 | 净 +61 | 危险 | 本轮补了“显式采集后切换到普通账号分析也不能继承写权限”的真实运行时回归；共享宿主测试继续膨胀，后续应把浏览器意图与工具面场景迁入独立集成套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/types/electron.d.ts` | 4017 | 净 +3 | 健康 | 只补齐浏览器任务停止入口的跨进程声明，类型检查和 IPC 合同测试覆盖。 | 无需处理 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/__tests__/stores.test.ts` | 3123 | 净 +78 | 危险 | 本轮补齐“空消息可补全、已有流式正文不得重复追加”的真实 store 顺序回归；文件已聚合多个 store 产品域，后续应把回答交付与持久化场景迁入独立套件。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/__tests__/browser-tools.test.ts` | 2745 | 净 +30 | 危险 | 本轮把状态查询锁为纯读取并补任务归属；浏览器工具测试仍把采集、下载、查询与接力混在同一套件，后续应先拆出采集生命周期合同。 | 待独立测试拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/browser-engine/ipc-handler.ts` | 2668 | 净 +16 | 危险 | 本轮只移除查询触发采集并接入 source-aware 停止；浏览器控制器和跨进程装配仍集中，后续应把采集控制 facade 与 IPC 注册继续下沉。 | 待拆分规划；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/stores/useAgent.ts` | 2116 | 净 +4 | 一般 | 只收紧后端正文补全规则，避免覆盖已流式显示的回答；沿用 2026-08-11 的发送与交付编排下沉复查。 | 已排期：2026-08-11 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/browser-engine/content-task-runner.ts` | 1908 | 净 +51 | 危险 | 本轮补齐任务归属、执行绑定和输出路径投影，但可见发现、逐篇采集、卡片循环与投影组装仍共存；后续应先迁出投影元数据组装和各任务种类 runner。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/tools/browser-collection-tools.ts` | 1762 | 净 +78 | 危险 | 本轮将查询改为紧凑纯读取并传递任务归属；状态控制、确认、发现、下载与采集启动仍集中在一个大分派器，后续应先拆出状态/生命周期与采集启动两个边界。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/preload/index.ts` | 1539 | 净 +1 | 一般 | 只增加浏览器任务停止透传；沿用 2026-07-24 的按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/tools/tool-executor.ts` | 1255 | 净 +6 | 一般 | 统一入口只把当前 Agent、run、父任务与执行绑定交给浏览器工具，生命周期判断留在浏览器域；沿用 2026-08-14 的全局工具入口复查。 | 已排期：2026-08-14 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/components/agent/ChatPanel.tsx` | 1156 | 净 +2 | 一般 | 仅把停止采集处理器传给既有任务卡子树，展示和交互均留在叶子组件；沿用 2026-08-11 的宿主接线复查。 | 已排期：2026-08-11 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1133 | 净 +15 | 一般 | 本轮把普通页面观察与持久采集工具面分开，未在宿主内加入站点特例；2026-08-15 复查工具面组装是否可继续下沉。 | 已排期：2026-08-15 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/renderer/components/agent/chat-panel/task/TaskCard.tsx` | 1010 | 净 +131 | 危险 | 本轮补齐固定卡边界、停止与清除分离、右滑清除和结果入口；文件已同时承担状态摘要、进度、产物、记忆、反馈及多类任务动作，后续应先拆出产物区与动作区，再收缩主卡壳。 | 待独立拆分合同；交付时提醒 |
| 2026-07-15 | 浏览器采集与任务卡闭环 | `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | 1006 | 净 +8 | 一般 | 文件刚过线，本轮只让明确采集轮承担采集验收条件，非采集浏览器分析不再被误判；2026-08-15 复查终态事实解析是否应拆出。 | 已排期：2026-08-15 |
| 2026-07-15 | 工具真实可见性验收统一 | `src/__tests__/agent-sdk-product-acceptance.test.ts` | 1005 | 净 +1 | 一般 | 仅改用共享的真实工具可见性判定，避免把运行时已禁用的潜在工具误算为可用；文件刚过线且仍是产品级验收单一职责，2026-08-15 复查是否按工具、技能与交付面拆分。 | 已排期：2026-08-15 |
| 2026-07-15 | Ready 系统提示词生产接入 | `src/main/modules/agent-control/prompt-assembly.ts` | 1516 | 净 +17 | 一般 | 本轮只接入版本化常驻核心、按需产品背景和统一的本地日历日期，并移除虚假的工具索引；记忆、预算和领域片段仍沿原分层组装。2026-08-15 复查静态触发、预算报告和资产装配能否继续下沉到独立层。 | 已排期：2026-08-15 |
| 2026-07-15 | SQLite 测试覆盖声明收口 | `src/__tests__/tag-forge-batch.test.ts` | 1058 | 净 +31 | 一般 | 只在每个真实 SQLite 测试块入口增加统一环境保护，未继续混入新场景；沿用 2026-08-15 的容量、归属和审核恢复拆分复查。 | 已排期：2026-08-15 |
| 2026-07-15 | Tag Forge 丰富标签低干预收口 | `src/__tests__/tag-forge-batch.test.ts` | 1027 | 净 +924 | 一般 | 首次过线；文件仍只覆盖 Tag Forge 批量写入这一条真实链路，但场景与临时数据库夹具已经较密。2026-08-15 复查是否按容量、手工归属和审核恢复拆成并行测试文件。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/main/index.ts` | 1229 | 净 +2 | 一般 | 仅装配独立生图 IPC，生成、缓存与复制均留在叶子服务；沿用 2026-07-25 的组合根复查。 | 已排期：2026-07-25 |
| 2026-07-15 | AI 生图服务闭环 | `src/main/modules/agent-control/tools-runtime/tool-registry.ts` | 1538 | 净 +16 | 一般 | 只注册一项生图工具和投影整形，生成行为在独立服务；2026-08-15 复查跨域注册表是否需要按能力拆分。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/main/modules/tools/tool-executor.ts` | 1249 | 小幅接线 | 一般 | 统一入口只转发生图请求，校验、调用与缓存全部下沉；沿用 2026-08-14 的全局工具入口复查。 | 已排期：2026-08-14 |
| 2026-07-15 | AI 生图服务闭环 | `src/preload/index.ts` | 1538 | 小幅接线 | 一般 | 仅增加生图测试、复制与拖存的跨进程透传；沿用 2026-07-24 的按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/components/document/MarkdownEditor.tsx` | 1054 | 净 +68 | 一般 | 首次过线；只让编辑和预览两种已有文档表面共享同一图片拖入处理，复制逻辑在独立服务。2026-08-15 复查拖入编排是否应下沉。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/components/layout/FileTree.tsx` | 1944 | 净 +38 | 一般 | 仅在现有外部拖放分支接入生图缓存文件的保存与刷新，并明确了失败会向用户显示而不会冒充成功；沿用 2026-08-11 的文件树拖放职责复查。 | 已排期：2026-08-11 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/pages/modes/BrowserMode.tsx` | 1422 | 净 +37 | 一般 | 只在生图拖动期间隐藏原生网页层并复用既有网页上传链；2026-08-15 复查原生层可见性编排是否需要继续下沉。 | 已排期：2026-08-15 |
| 2026-07-15 | AI 生图服务闭环 | `src/renderer/types/electron.d.ts` | 4014 | 小幅接线 | 健康 | 机械补齐生图测试、缓存复制与拖存声明，类型检查和真实应用验收覆盖。 | 无需处理 |
| 2026-07-14 | Tag Forge 打包版低干预收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 7500 | 净 +418 | 危险 | 本轮只追加显式选技、自然选技、续跑恢复和文本桥连续批处理的真实工具面回归；共享 SDK 宿主测试已明显过大，后续应把 Tag Forge 场景迁入独立集成套件。 | 待独立测试拆分合同 |
| 2026-07-14 | Tag Forge 打包版低干预收口 | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1218 | 净 +1 | 一般 | 仅把已选技能身份交给现有工具授权计算，Tag Forge 特例判断保留在独立 skill-intent 叶子模块；2026-08-14 复查 SDK 组装根接线密度。 | 已排期：2026-08-14 |
| 2026-07-14 | Tag Forge 打包版低干预收口 | `src/renderer/stores/useAgent.ts` | 2112 | 净 +8 | 一般 | 发送入口只把本轮实际引用的历史文件夹复用为可信附件，不新增授权状态或第二套附件池；沿用 2026-08-11 的发送编排下沉复查。 | 已排期：2026-08-11 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1112 | 净 +19 | 一般 | 本轮只补齐已选只读研究技能的能力地板与工具面收窄，避免显式 AnySearch 请求同时暴露无关浏览器和文件工具；2026-08-14 复查 SDK 工具面组装是否需要继续下沉。 | 已排期：2026-08-14 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/main/modules/skills-runtime/runtime-manager.ts` | 1166 | 净 +1 | 一般 | 仅把内置技能 manifest 的 `allowed_tools` 传入现有运行时描述，未增加新的加载分支；沿用 2026-08-11 的技能运行时装配复查。 | 已排期：2026-08-11 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/main/modules/tools/tool-executor.ts` | 1251 | 净 +30 | 一般 | 本轮只在统一工具入口解析已选技能的搜索/正文服务绑定并透传配置，搜索、垂直领域和回退行为都在独立叶子模块。沿用 2026-08-14 的全局工具入口路由复查。 | 已排期：2026-08-14 |
| 2026-07-14 | AnySearch 搜索与调研接入 | `src/renderer/types/electron.d.ts` | 4000 | 净 +1 | 健康 | 只在外部服务类型合同中增加 AnySearch 枚举值，类型检查和 IPC 合同检查均已覆盖。 | 无需处理 |
| 2026-07-14 | RSS 重复内容修复 | `src/main/modules/migrations.ts` | 3352 | 净 +6 | 健康 | 只注册顺序 migration 076，具体身份归一和历史合并留在 RSS 叶子模块；连续编号、真实 Electron SQLite 和用户数据库副本迁移均已验证。 | 无需处理 |
| 2026-07-14 | RSS 重复内容修复 | `src/main/modules/rss-engine/ipc-handler.ts` | 1229 | 净 +16 | 一般 | 仅在统一抓取出口归一文章身份，让新增、单源刷新和全部刷新共用同一规则；沿用 2026-08-13 的 RSS IPC 组合根复查。 | 已排期：2026-08-13 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/tools/file-management-tools.ts` | 2037 | 净 +465 | 危险 | 批次全量扫描、不透明 item id、持久续跑、集中确认、真实路径复核与幂等审核都仍与搜索、读取、整理共存一文件，已明显妨碍定位和并行修改。下一步应整体迁出 Tag Forge batch executor 与状态存储；本轮不在交付前混入无行为收益的大规模搬移。 | 已于 2026-07-15 拆分至 819 行并收口 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/tools/tool-executor.ts` | 1221 | 净 +32 | 一般 | 全局入口只保留 Tag Forge 宿主确认调用，具体流程已下沉到 `tag-forge-host-review.ts`；2026-08-14 复查文件域路由与结果整形是否还能继续下沉。 | 已排期：2026-08-14 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/migrations.ts` | 3336 | +37 | 健康 | 只追加顺序 migration 074，把存疑提案改为批次、文档与 scope 隔离；连续迁移和真实 Electron SQLite 门禁覆盖。 | 无需处理 |
| 2026-07-14 | Tag Forge 低干预打标闭环 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1863 | +4 | 一般 | 只为自动创建标签的存疑提案补齐创建凭证作为隔离身份；沿用 2026-08-13 的 IPC 入口装配密度复查。 | 已排期：2026-08-13 |
| 2026-07-14 | 知识图谱动态浏览 | `src/preload/index.ts` | 1526 | 6 | 一般 | 仅增加索引完成事件的订阅透传；仍是跨进程 API 汇总面，沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-14 | 知识图谱动态浏览 | `src/renderer/types/electron.d.ts` | 4003 | 2 | 健康 | 只补齐索引完成事件的类型声明，类型检查与索引通知行为测试覆盖。 | 无需处理 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2645 | 净 +343 | 危险 | 调度判断、时间计算、恢复判断和队列均已下沉，但 runtime 宿主仍新增了较多定时任务装配、专用会话和运行回流接线，继续扩大已会妨碍定位。后续应把 schedule runtime facade 整体移到定时任务域，只保留生产主链调用入口。 | 待独立拆分；交付时提醒 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/migrations.ts` | 3299 | 206 | 健康 | 只追加顺序 migration 073，完成结构化任务、occurrence 账本、旧数据迁移和旧表退役；原生 SQLite 连续迁移测试已通过。 | 无需处理 |
| 2026-07-13 | Agent 定时任务 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1859 | 净 +19 | 一般 | 只装配定时任务 IPC 与生命周期清理，业务判断留在 schedule group/runtime。2026-08-13 复查入口装配密度。 | 已排期：2026-08-13 |
| 2026-07-13 | Agent 定时任务 | `src/preload/index.ts` | 1520 | 约 +22 | 一般 | 只增加结构化定时任务读写与失效通知透传；沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-13 | Agent 定时任务 | `src/renderer/components/agent/ChatPanel.tsx` | 1155 | 净 +15 | 一般 | 只保留圆形时钟入口和受控开关接线，独立工作界面已移到 Workbench 宿主。沿用 2026-08-11 宿主接线复查。 | 已排期：2026-08-11 |
| 2026-07-13 | Agent 定时任务 | `src/main/index.ts` | 1227 | 约 +8 | 一般 | 只在数据库与 Agent runtime 可用后启动调度器，并在休眠恢复和退出时走同一生命周期；沿用 2026-07-25 组合根拆分复查。 | 已排期：2026-07-25 |
| 2026-07-13 | RSS Main 自动刷新 | `src/main/index.ts` | 1219 | 净 +63 | 一般 | 只组装独立 RSS 调度器、设置变更回调和有序退出清理，调度判断留在叶子模块；主进程组合根继续沿用 2026-07-25 的菜单与协议拆分复查。 | 已排期：2026-07-25 |
| 2026-07-13 | RSS Main 自动刷新 | `src/main/modules/rss-engine/ipc-handler.ts` | 1213 | 净 +43 | 一般 | 仅增加自动刷新设置读取、最近完成时间读取、完成通知和现有 `fetchAll` 入口导出；抓取与调度逻辑分别留在 fetch group 和独立调度器。2026-08-13 复查组合根增长。 | 已排期：2026-08-13 |
| 2026-07-13 | RSS Main 自动刷新 | `src/preload/index.ts` | 1505 | 净 +7 | 一般 | 仅增加自动刷新状态查询和完成事件透传；仍是跨进程 API 汇总面，沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-13 | RSS Main 自动刷新 | `src/renderer/types/electron.d.ts` | 4020 | 净 +3 | 健康 | 只补齐 RSS 自动刷新状态与事件的跨进程类型声明，类型检查与 IPC 合同 gate 覆盖。 | 无需处理 |
| 2026-07-13 | Tag Forge 统一入口与终态修复 | `src/__tests__/run-finalizer-checkin.test.ts` | 1278 | 净 +46 | 一般 | 只增加“失败回执不能冒充完成”的终态回归，并补强原有部分完成对照；沿用 2026-08-12 按来源证明与终态验收拆分复查。 | 已排期：2026-08-12 |
| 2026-07-13 | Tag Forge 待审核续跑 | `src/main/modules/tools/file-management-tools.ts` | 1572 | 净 +8 | 危险 | 只补充批次的待审核状态、审核位置和原批次续跑回执；批次职责仍应整体迁出此文件。 | 待独立拆分；交付时提醒 |
| 2026-07-12 | Tag Forge + Boost 文件夹批量打标四层收口 | `src/main/modules/tools/file-management-tools.ts` | 1564 | 约 116 | 危险 | 本轮专用批次准备、断点与受控写回直接复用文件盘点和授权边界，避免另造一套越界判断；但该文件再次承担批次状态，已明显跨越搜索、读取、整理和打标职责。后续应把 Tag Forge batch executor 与状态存储整体移入独立模块，只保留工具路由。 | 待独立拆分；交付时提醒 |
| 2026-07-12 | 文件涌现与 Tag Forge 对抗复审 | `src/main/modules/migrations.ts` | 3093 | 37 | 健康 | 追加 071 反馈账本和 072 不可变评估快照头、成员键与诊断字段；仍是顺序迁移注册表，已由 72 段连续检查和真实 Electron SQLite 验证。 | 无需处理 |
| 2026-07-12 | 文件涌现与 Tag Forge 对抗复审 | `src/preload/index.ts` | 1498 | 8 | 一般 | 反馈、本地评估和真实创建回执只增加跨进程透传；沿用 2026-07-24 按产品域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | 文件涌现与 Tag Forge 对抗复审 | `src/renderer/types/electron.d.ts` | 4017 | 5 | 健康 | 机械补齐反馈、评估与创建回执声明，类型检查和行为测试覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P4 双投影 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1840 | 2 | 一般 | 仅把文件 intent card 数据源接入现有 Agent feed 组装；业务判断在独立 group/service。2026-08-11 复查组装根密度。 | 已排期：2026-08-11 |
| 2026-07-12 | 文件涌现 P4 双投影 | `src/renderer/types/electron.d.ts` | 4012 | 3 | 健康 | 只补齐 `projectKey` 和文件打开定位的跨进程类型，由类型检查、行为测试和真应用验收覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P4 Tag Forge 拆分 | `src/main/modules/tools/file-management-tools.ts` | 1416 | 1 | 危险 | Tag Forge 执行已移至独立 `tag-forge-tool.ts`，本文件不再承担其校验、写回与对账；但仍集中搜索、读取、分类、移动和批量整理，后续应按剩余工具域继续拆分。 | Tag Forge 危险已解除；剩余文件级危险待单独重构 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/renderer/components/layout/FileTree.tsx` | 1906 | 13 | 一般 | 仅组装命名标签页组并传给现有涌现入口；沿用 2026-08-11 的涌现状态/文件树职责拆分复查。 | 已排期：2026-08-11 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/main/modules/migrations.ts` | 2938 | 61 | 健康 | 只追加一次性 068 身份账本迁移，文件是顺序迁移注册表；已由连续编号、重复运行和原生 SQLite 行为测试覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P2 长期注意力 | `src/main/modules/migrations.ts` | 3056 | 118 | 健康 | 只追加一次性 069 长期注意力、明确意图和低敏预测账本；顺序迁移表职责未扩散，并由真实 Electron SQLite 测试覆盖。 | 无需处理 |
| 2026-07-12 | Tag Forge P3 | `src/main/modules/migrations.ts` | 3055 | 117 | 健康 | 只追加一次性 070 受控词表、待审核、标签归属和创建回执表；顺序迁移表职责未扩散，原生 SQLite 连续迁移已通过。 | 无需处理 |
| 2026-07-12 | Tag Forge P3 | `src/main/index.ts` | 1156 | 2 | 一般 | 仅增加 Tag Forge IPC 组装；主进程组合根继续沿用既定拆分复查。 | 已排期：2026-07-25 |
| 2026-07-12 | Tag Forge P3 | `src/preload/index.ts` | 1490 | 10 | 一般 | 新增 Tag Forge 创建、校验、回执和审核透传；仍是跨进程 API 汇总面，沿用按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | Tag Forge P3 | `src/renderer/types/electron.d.ts` | 4009 | 8 | 健康 | 仅补齐 Tag Forge 跨进程类型合同，类型检查与真实界面读回通过。 | 无需处理 |
| 2026-07-12 | Tag Forge P3 | `src/main/modules/tools/file-management-tools.ts` | 1448 | 30 | 危险 | 文件搜索、读取、分类、移动、批量整理和 Tag Forge 执行继续集中；本轮仅接入受控打标，但文件已跨多个独立职责。 | P4 前先把 Tag Forge executor 移入独立服务，避免继续增长 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/preload/index.ts` | 1480 | 7 | 一般 | 只增加项目重命名、文件归属和从文件新建项目三条 IPC 透传；沿用 2026-07-24 按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | 文件涌现 P1 项目身份 | `src/renderer/types/electron.d.ts` | 4001 | 6 | 健康 | 机械补齐三条身份交互的类型声明，已由类型检查与行为测试覆盖。 | 无需处理 |
| 2026-07-12 | 文件涌现 P0 信号修复 | `src/renderer/components/layout/FileTree.tsx` | 1893 | 4 | 一般 | 只在现有涌现刷新入口并行重读阅读进度，没有继续扩张文件树职责；沿用 2026-08-11 的 pendingClips/涌现状态拆分复查。 | 已排期：2026-08-11 |
| 2026-07-12 | 浏览器标签浮层跨窗口停留修复 | `src/preload/index.ts` | 1471 | 2 | 一般 | 仅新增浮层鼠标位置核对的 invoke 透传；仍是跨进程 API 汇总面。沿用 2026-07-24 按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-12 | 浏览器标签浮层跨窗口停留修复 | `src/renderer/types/electron.d.ts` | 3995 | 1 | 健康 | 机械跨进程声明，新增单一位置核对方法，已由类型检查与行为测试覆盖。 | 无需处理 |
| 2026-07-11 | Boost 60 秒误停修复 | `src/main/modules/agent-control/runtime-core/orchestrator.ts` | 1023 | 16 | 一般 | 仅增加按 requestId 查询活跃运行的无副作用入口，不承担业务判断。2026-08-11 复查编排入口密度。 | 已排期：2026-08-11 |
| 2026-07-11 | Boost 60 秒误停修复 | `src/renderer/modules/agent/runtimeDriver.ts` | 1936 | 15 | 一般 | 只将 60 秒看门狗改为活性查询并处理 active 回执，事件桥职责未扩张。沿用 2026-08-11 的 scope-run 事件映射拆分复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Boost 模式一次性发送加固 | `src/renderer/components/agent/ChatPanel.tsx` | 1140 | 11 | 一般 | 仅增加同步锁存，保证点击 Boost 后立即发送也会消费 thorough；沿用 2026-08-11 宿主接线复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2303 | 小幅接线 | 一般 | 仅增加启动中断收口、模式转发和活动计划会话持久化接线，判断均在叶子模块。沿用 2026-08-11 复查，优先继续下沉宿主编排。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/renderer/stores/useAgent.ts` | 2104 | 小幅接线 | 一般 | 仅在发送入口读取持久模式并转发；状态仍集中但职责边界偏重。2026-08-11 复查发送编排能否继续下沉。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts` | 1217 | 小幅接线 | 一般 | 只作为 coordinator 组装 owner、贡献学习和活动计划持久层的接线点，核心逻辑均在叶子模块。2026-08-11 复查 composition 接线密度。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/main/modules/agent-control/runtime-core/orchestrator.ts` | 1007 | 小幅接线 | 一般 | 首次略过线，仅透传 typed mode；不在此加入业务判断。2026-08-11 复查参数对象化是否能降低位置参数风险。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/renderer/components/agent/ChatPanel.tsx` | 1136 | 小幅接线 | 一般 | 仅持有一次性彻底模式并在发送时消费，行为函数已下沉。沿用 2026-08-11 解析器拆分复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Dynamic Delivery | `src/preload/index.ts` | 1469 | 1 | 一般 | 仅增加 deliveryMode 参数透传；仍是跨进程 API 汇总面。沿用 2026-07-24 按域拆分复查。 | 已排期：2026-07-24 |
| 2026-07-11 | Dynamic Delivery | `src/renderer/types/electron.d.ts` | 3994 | 2 | 健康 | 机械跨进程声明，新增 typed mode 字段且类型检查和 wire 测试覆盖。 | 无需处理 |
| 2026-07-11 | info_card 键值速览行（W10c） | `src/shared/document-widget-openui.ts` | 1187 | 24 | 一般 | 21 组件的 schema+编译器+目录三合一聚合面；今日大重构已净缩 ~400 行（关系图/流程图/图表提取共享模块），本次仅 info_card facts 字段与渲染。继续增长时优先把 componentSchemas 与 catalog 元数据拆出（编译函数留守）。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | widget 插入位置语义（W10b） | `src/renderer/modules/agent/document-actions/execute.ts` | 1897 | 30 | 一般 | renderer 文档动作执行器聚合了全部 document.* 动作分支与纯文本变换 helper；本次新增 prepend_start 分支与未知 position 响亮报错（纯函数已导出供行为测试）。继续增长时优先把 insertWidgetIntoDocument/upsert 等纯文本变换层拆到独立模块（与 target-resolve/write-locks 同级）。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-12 | Boost 长任务与技能选取收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 7082 | 净 +44 | 危险 | 单套件继续聚合 SDK runtime 的共享宿主与大量状态场景，本轮只补工具面保真回归，但体量已明显妨碍定位和并行修改。后续应先建立可隔离的 runtime fixture，再按目标文档、压缩、provider wire、技能授权拆分。 | 待独立测试拆分合同 |
| 2026-07-12 | Boost 长任务与真实验收收口 | `src/__tests__/run-finalizer-checkin.test.ts` | 1232 | 88 | 一般 | 仍是终态判决与验收回执的单一行为测试域；本轮新增真实来源回执、伪正文反例和非完成态禁验收用例。若继续增长，优先按来源证明与终态验收拆成两个套件。2026-08-12 复查。 | 已排期：2026-08-12 |
| 2026-07-12 | Boost 长任务可见终态收口 | `src/__tests__/runtime-driver-terminal-unlock.test.ts` | 1058 | 净 +22 | 一般 | 仍集中验证 renderer 运行驱动的终态解锁与晚到事件仲裁；本轮只补长任务活性和可见终态回归。若继续增长，优先把活性探测场景拆成独立套件。2026-08-12 复查。 | 已排期：2026-08-12 |
| 2026-07-12 | 模型选技同轮开放 | `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | 1093 | 净 +121 | 一般 | 工具面构建与执行仍集中在同一宿主，但本轮同轮激活状态更新已下沉叶子模块，宿主只负责动态可见性和激活结果回灌。若继续增长，优先把 SDK tool 包装与 trace 发布拆开。2026-08-12 复查。 | 已排期：2026-08-12 |
| 2026-07-11 | 文档导出按钮（PDF / MD 压缩包） | `src/renderer/pages/modes/DocumentMode.tsx` | 1080 | 2 | 一般 | 仅 +2 行接线（导入 + 顶栏挂 `DocumentExportButton`）；导出逻辑全部在新叶子模块（DocumentExportButton / document-export-capture / document-export-html）。沿用既有判断：继续增长时优先把阅读会话跟踪或滚动锚点管理拆出。2026-08-11 复查不变。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档导出按钮（PDF / MD 压缩包） | `src/preload/index.ts` | 1467 | 4 | 一般 | 仅新增 exportPdf / exportMarkdownBundle 两条 invoke 包装；仍是跨进程 API 汇总面。沿用 2026-07-24 复查（是否按产品域拆分定义与组装）。 | 已排期：2026-07-24 |
| 2026-07-11 | 文档导出按钮（PDF / MD 压缩包） | `src/renderer/types/electron.d.ts` | 3992 | 9 | 健康 | 单一用途的 renderer 跨进程声明合同；本次新增 document-export 共享类型导入与两个方法签名，IPC/typecheck 一致性检查在位。 | 无需处理 |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/components/document/note-preview-parser.ts` | 1457 | 153 | 一般 | 仍是"笔记结构化预览解析"单一职责；本次新增的块级源码区间必须与解析逻辑同步演进，故留在同文件（合同由 note-preview-source-ranges.test.ts 钉住）。下次增长时优先把 parseBodyBlocks 分段阶段拆为独立模块。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/pages/modes/DocumentMode.tsx` | 1078 | 34 | 一般 | 文档工作台编排页（标签/分栏/滚动锚点/阅读会话/模式状态）；本次仅 +34 行接线（previewEditActive、外观映射、untitled 拖拽载荷）。继续增长时优先把阅读会话跟踪或滚动锚点管理拆出。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/components/layout/FileTree.tsx` | 1889 | 43 | 一般 | 文件树容器：树渲染、拖放调度、剪藏占位、菜单仍聚在一处，但拖放判定/载荷解析已在 fileTreeExternalDrop/drag-utils 等叶子模块；本次沿现有分支缝隙加 untitled-doc-tab 直存分支（落盘逻辑在 modules/document/untitledDocSave.ts）。下次增长优先把 pendingClips 占位生命周期拆出。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | 文档模式三功能（预览内编辑/标签拖存/外观同步） | `src/renderer/styles/markdown.css` | 1091 | 172 | 健康 | 首次过线：markdown/笔记预览域的单一用途平铺样式表（本次新增预览内编辑的块壳/编辑器/落点线样式段），无逻辑分支，css 级联层 gate 在位；拆分收益不足。 | 无需处理 |
| 2026-07-11 | 启动动画秒出（主进程微入口拆分 + 抗冻结让步点） | `src/main/index.ts` | 1146 | 净 -155（移出 splash 与 pre-ready 块；whenReady 各阶段加 yieldToPresentation 让步点） | 一般 | 主进程组合根：窗口生命周期、菜单、协议 handler、IPC 装配仍聚在一处，本次已把 splash 窗口与 pre-ready 配置拆出（boot-entry / startup-splash-window）。继续增长时优先把菜单与 local-file 协议 handler 移出。2026-07-25 复查增长趋势。 | 已排期：2026-07-25 |
| 2026-07-11 | 启动提速：embedded 技能同步记忆化 | `src/main/modules/skills-runtime/runtime-manager.ts` | 1165 | 15 | 一般 | 技能运行时管理器仍聚合 sync/loader/pipeline/scheduler 装配；本次仅加进程内同步缓存（含启动风暴根因注释）。继续增长时优先把 embedded sync 簇拆到独立模块。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-10 | 浏览器数据 / Cookie 设置页 | `src/main/modules/browser-engine/ipc-handler.ts` | 2652 | 6 | 危险 | 浏览器宿主控制、服务装配与跨进程入口仍集中在同一文件；建议后续把服务装配和入口注册继续移出宿主控制文件。任务结项需提醒。 | 待拆分规划 |
| 2026-07-10 | 浏览器数据 / Cookie 设置页 | `src/main/modules/database.ts` | 3027 | 24 | 危险 | 多个产品域的数据操作集中在单一管理器中；建议后续把浏览历史与下载数据边界下沉到独立持久化模块，并保留现有仓储入口。任务结项需提醒。 | 待拆分规划 |
| 2026-07-10 | 浏览器数据 / Cookie 设置页 | `src/preload/index.ts` | 1463 | 10 | 一般 | 仍是清晰的跨进程 API 汇总面，但持续增长会增加冲突和人工同步成本；2026-07-24 复查是否按产品域拆分定义与组装。 | 已排期：2026-07-24 |
| 2026-07-10 | 工具事件 L3 详情 + Skill 输出上限 | `src/renderer/types/electron.d.ts` | 3983 | 3 | 健康 | 单一用途的 renderer 跨进程声明合同，且 IPC/typecheck 一致性检查在位；本日累计增加 tool trace 两字段和 `maxOutputTokensOverride` 一字段。 | 无需处理 |
| 2026-07-10 | 任务卡/工具调用 activity-capsule 重设计 | `src/renderer/components/agent/chat-panel/task/TaskCard.tsx` | 843 | 重设计 +144 后拆分 −186（885→1029→843） | 一般（已按预留缝拆分收口） | 同日 L3 扩展任务把 `ToolTimeline`/`ToolTimelineRow`/`CapsuleChevron` 拆到 `ToolTimeline.tsx`（209 行），placement 合同 grep 已同步retarget；TaskCard 回到 1000 行以内。后续再增长按新总行数重新评估。 | 已拆分收口（2026-07-10） |
| 2026-07-10 | 工具事件 L3 详情（main 侧结构扩展） | `src/renderer/modules/agent/runtimeDriver.ts` | 1921 | 12 | 一般 | 主职责单一（agent 运行时事件 → store 的桥接枢纽），行为由 runtime-driver-*、agent-stream-segmentation 等多组测试覆盖；但监听器体量持续增长会妨碍定位。若下次任务再加行，优先把 onScopeRunEvent 大闭包与快照 meta 构建器拆成独立模块。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | 工具事件 L3 详情（main 侧结构扩展） | `src/renderer/components/agent/ChatPanel.tsx` | 1113 | 10 | 一般 | Stage V 已把大块区域抽到 chat-panel/* 子模块，剩余是宿主接线与两个序列化解析器（后者被 source-grep 合同钉在本文件）；本次仅类型字段与解析映射 +10 行。继续增长时优先评估把 Serialized* 类型与解析器移到独立模块并同步 chat-task-projection 合同锚点。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/migrations.ts` | 2798 | 9 | 健康 | 按版本顺序聚合的数据库迁移表，单一职责且 `verify:native` 真实加载验证在位；本轮仅增加 completion declaration 两列迁移。 | 无需处理 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/tools/tool-executor.ts` | 1182 | 1 | 一般 | 仍是统一工具调度入口，本轮只把验收声明更新为结构化 patch；继续增长时优先把独立工具 handler 路由下沉到现有分组模块。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2092 | 16 | 一般 | B8 后仍为 runtime 宿主与服务接线面，本轮仅接入统一 closeout wrapper；新终态逻辑已留在独立 finalizer。下次增长时复查 stale/manual closeout 编排能否继续下沉。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-10 | Skill 模块复审收口 | `src/main/modules/tools/skills-tools.ts` | 3076 | 33 | 危险 | 技能工具注册、调度、读根分类仍集中；本轮已把真实路径派生和沙箱执行留在独立叶子模块，本文件只传递只读根与种类。进一步拆分被明确阻塞于“需要独立合同重锚全工具授权/执行 gate”，不在本轮收尾阶段扩大搬移面。 | 待独立拆分合同（阻塞原因已记录） |
| 2026-07-10 | Skill 模块复审收口 | `src/__tests__/agent-sdk-runtime.test.ts` | 6975 | 2291 | 危险 | 集成级 SDK 共享宿主与大量状态场景仍集中。本轮已把输出上限、预算、准入和终态优先级的新独立域分流到专项测试文件；剩余用例依赖共享 singleton 宿主，继续搬移需先建立隔离 fixture，否则会伪造并发通过。 | 待独立测试拆分合同（阻塞原因已记录） |
| 2026-07-10 | Skill 真实 Electron 验收 | `scripts/run-agent-panel-mimo-acceptance.mjs` | 1200 | 90 | 一般 | 仍是面板验收入口与套件调度器；本轮增加独立双技能套件与文件真值检查。若再增加套件，优先把各 suite 的 prompt/assertions 拆到独立定义模块。2026-08-10 复查。 | 已排期：2026-08-10 |
| 2026-07-11 | Agent 根基修复 | `src/main/modules/agent-control/runtime-core/runtime.ts` | 2243 | 154 | 一般 | 本轮只增加冻结身份解析、接管恢复和累计用量的宿主接线，核心判断均已下沉到独立叶子模块；宿主仍偏大。下次增长优先继续下沉 handoff/usage 编排。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/main/modules/agent-control/prompt-assembly.ts` | 1497 | 净 +51 | 一般 | 本轮将人格、规则和知识改为消费同一冻结 profile，并保留知识目录裁剪提示；文件仍是提示组装单一职责。下次增长优先把 agent 段的格式化移到 profile 叶子模块。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/main/modules/migrations.ts` | 2868 | 70 | 健康 | 按版本顺序聚合数据库迁移，单一职责；Migration 066 已通过真实 Electron SQLite 连续迁移和数据保全检查。 | 无需处理 |
| 2026-07-11 | Agent 根基修复 | `src/main/modules/database.ts` | 3045 | 净 +18 | 危险 | 多产品域数据库入口继续集中；本轮仅接入会话 active Agent 与 handoff generation 的持久化读写。建议后续把 conversation agent state 下沉到独立仓储，避免继续扩大总管理器。 | 待拆分规划 |
| 2026-07-12 | Agent 根基修复与同轮选技 | `src/main/modules/tools/tool-executor.ts` | 1186 | 净 +4 | 一般 | 本轮只把冻结 execution profile 传入工具运行上下文并校正 use_skill 激活说明；统一调度职责未扩张。沿用 2026-08-10 复查，优先下沉独立 handler 路由。 | 已排期：2026-08-10 |
| 2026-07-11 | Agent 根基修复 | `src/renderer/components/agent/ChatPanel.tsx` | 1129 | 净 +20 | 一般 | 本轮只解析并传递任务 owner、执行者与消息身份快照；展示逻辑留在子组件。下次增长优先迁出序列化类型和解析器。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/renderer/modules/agent/runtimeDriver.ts` | 1931 | 25 | 一般 | 本轮只把主进程给出的执行身份写入消息与任务快照；事件桥职责未扩张。下次增长优先拆出 scope-run 事件映射器。2026-08-11 复查。 | 已排期：2026-08-11 |
| 2026-07-11 | Agent 根基修复 | `src/renderer/components/agent-system/studio/AgentSystemStudioView.tsx` | 1535 | 净 +20 | 一般 | 本轮展示代码侧 readiness，并把 RULES / FOUNDATION / 知识卡的编辑器从页面末尾移到被点击内容的原位，未复制保存逻辑。下次增长优先把 roster/detail 或内容提案区拆成纯展示子组件。2026-08-11 复查。 | 已排期：2026-08-11 |


### 2026-09-22 四模块切换与真实长会话阻塞

| 日期 | 任务 | 文件 | 行数 | 本轮变化 | 风险 | 判断与后续 | 复查 |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| 2026-09-22 | 历史回执批读去重 | `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts` | 10655 | 净 +21 | 危险 | 原有巨型仓储集中多类生命周期；本次只合并同一读事务内的 head 读取，输出与逐条读取完全一致。后续应以现有原生合同将 product presentation 读取整体迁至同域叶子，不在此次性能修复扩展重构。 | 交付时提醒 |
| 2026-09-22 | 批读同值及新请求重读检查 | `src/__tests__/codex-binding-repository-native.test.ts` | 9108 | 净 +7 | 一般 | 复用现有真实失败会话夹具验证批读行为，避免另造不完整 fixture。2026-10-22 复查按原生合同拆分测试夹具。 | 2026-10-22 |
| 2026-09-22 | 纯模式刷新与完整失效分流 | `src/renderer/stores/useAgent.ts` | 2478 | 净 +6 | 危险 | 原 store 已集中多类会话职责；本次仅让既有队列携带刷新原因并消费 Main 来源阻断，未另建状态源。后续将既有 hydration 所有权整体迁出，而不是继续在根 store 堆积。 | 交付时提醒 |
| 2026-09-22 | 模式与失效回归 | `src/__tests__/codex-action-surface-event-bridge.test.ts` | 1168 | 净 +35 | 一般 | 沿现有真实 store 与 IPC 替身验证，保留队列竞态、记忆下界和旧事件拒绝覆盖。 | 2026-10-22 |

## 2026-09-26 第三方模型接入

| 日期 | 范围 | 文件 | 总行数 | 本轮净增 | 评级 | 说明 | 后续 |
|---|---|---|---:|---:|---|---|---|
| 2026-09-26 | Codex 供应商转换 | `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2849 | +36 | 危险 | 继续复用既有事件校验和工具准入；新增 Messages 转换、Z.ai 规范化和连接测试已放独立模块。主文件仍同时承担 HTTP 与原生流验证。 | 后续按既有协议边界拆分，交付时提醒 |
| 2026-09-26 | 固定内核行为验收 | `src/__tests__/codex-model-gateway-sidecar.e2e.ts` | 1317 | +10 | 一般 | 补齐现行续聊准入合同，避免旧夹具在第二轮提前退出；仍单一真实 app-server 场景。 | 2026-10-26 复查场景拆分 |


## 2026-09-26 接入模块拆分复核

基线 `c16d5e13` 的接入模块已按现有职责拆分，先前该范围的大文件风险已处理。函数/类实现体逐项核对保持不变；公开入口、模型路线和历史协议不变。

| 原文件 | 拆分前 | 当前 | 评级 | 归属与验证 |
|---|---:|---:|---|---|
| `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts` | 2849 | 681 | 健康 | 只持有监听生命周期与转发协调；请求校验、事件状态机、流交付、脱敏均移到具名模块 |
| `src/main/modules/agent-control/codex-runtime/codex-model-gateway-chat.ts` | 1132 | 287 | 健康 | 只做请求转换；Chat 响应流独立为 728 行，跨协议凭据过滤独立为 104 行 |
| `src/main/modules/agent-control/codex-runtime/codex-model-gateway-authority.ts` | 1029 | 113 | 健康 | 保留公开入口及宿主端口接线；同一数据库聚合的事务和查询归入 924 行 repository，未新增账本 |

当前接入相关文件均少于 1000 行；协议层不反向依赖 HTTP/数据库，运行时依赖无环，已有自动检查防止重新聚合。此复核不代表其他历史大文件已完成整理。


## 2026-09-29 测试集清理

| 日期 | 任务 | 文件 | 总行数 | 本轮净增 | 评级 | 理由与后续 | 状态 |
|---|---|---|---:|---:|---|---|---|
| 2026-09-29 | 修复并发读取测试死锁 | `src/__tests__/codex-renderer-lifecycle-contract.test.ts` | 1734 | +8 | 一般 | 仍是单一会话动作生命周期的行为验收；本轮只修等待次序、补合并次数与超时，不扩大测试宿主。 | 2026-10-29 复查是否按动作场景拆分 |
| 2026-09-29 | E6 环境身份隔离 | `scripts/__tests__/e6-live-proof-runner-preflight.test.cjs` | 1644 | +53 | 一般 | 沿用进程恢复场景；临时依赖、身份和启动逻辑已放独立 helper，新增正式身份不可被环境切换与漂移拒绝反例。 | 2026-10-29 复查按进程恢复/身份边界分组 |

## 2026-09-29 阅读模式位置同步

| 日期 | 文件 | 总行数 | 本轮净增 | 评级 | 说明与复查 |
|---|---|---:|---:|---|---|
| 2026-09-29 | `src/renderer/pages/modes/DocumentMode.tsx` | 1096 | +9 | 一般 | 仅接入切换前采集、书本期间暂停隐藏预览及退出位置交接；定位算法仍在既有阅读模块。2026-10-29 复查阅读会话编排边界。 |

## 2026-09-30 本轮上下文去重修复

| 日期 | 文件 | 总行数 | 评级 | 说明与复查 |
|---|---|---:|---|---|
| 2026-09-30 | `src/__tests__/codex-model-gateway-adversarial.test.ts` | 3547 | 一般 | 仅更新本轮资源格式并补 owner 拒绝反例；2026-10-30 复查按网关协议与路由拆分。 |
| 2026-09-30 | `src/__tests__/codex-model-gateway-contract.test.ts` | 1271 | 一般 | 仅更新本轮资源格式并补 owner 拒绝反例；2026-10-30 复查按网关协议与路由拆分。 |

## 2026-09-30 聊天框图片粘贴

| 日期 | 文件 | 总行数 | 本轮净增 | 评级 | 说明与复查 |
|---|---|---:|---:|---|---|
| 2026-09-30 | `src/main/modules/claude-bridge/ipc-handler.ts` | 1334 | +2 | 一般 | 仅挂接独立图片导入函数；2026-10-30 复查组合入口大小。 |
| 2026-09-30 | `src/preload/index.ts` | 1540 | +1 | 一般 | 单个既有 chat IPC 接口；2026-10-30 复查分组边界。 |
| 2026-09-30 | `src/renderer/types/electron.d.ts` | 3544 | +1 | 一般 | 仅声明共享附件返回类型；2026-10-30 复查接口拆分。 |
