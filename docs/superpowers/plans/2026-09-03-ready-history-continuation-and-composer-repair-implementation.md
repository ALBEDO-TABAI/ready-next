---
title: Ready 历史会话续聊、草稿编辑与恢复闭环修复
date: 2026-09-03
updated: 2026-09-05
status: implemented
review_status: see_package_bound_installed_proof
enforce: false
revision: 7
baseline_commit: 7f6e378b6e202259af34c874cf25638b5bfdb7ef
supersedes_after_approval:
  - 2026-09-01-codex-native-continuity-terminal-and-reply-surface-implementation.md 的升级兼容与恢复限制
  - 2026-09-03-codex-native-continuity-blockers-and-simplification-proposal.md 的输入锁定与动作恢复方案
---

> 2026-09-06 文档核对：本文保留当前仍使用的专项合同及原验收记录；后文的日期、阶段状态和现场缺口按原记录理解，不据此推导今天全部已验收或仍未实现。当前应用边界以 [运行时合同](../../architecture/current-runtime-contracts.md) 为准，近期状态见 [PROGRESS](../../../PROGRESS.md)。

# Ready 历史会话续聊、草稿编辑与恢复闭环修复

> 本文是施工合同，不是包体通过凭证。Revision 7 的复查与根因处置见 [2026-09-05 记录](../audits/2026-09-05-history-continuation-root-cause-review.md)。源码施工已落地；安装是否通过只消费同一 DMG 的 v2 发布回执及 `outputs/history-continuation-installed/<DMG sha256>/<run>/installed-proof.json`。§2 的普查快照、§10 的阶段顺序和 §13 的开工前意见均保留为历史，不代表当前未施工，也不能代替安装证明。

## 1. 产品目标与完成标准

用户应当能够打开历史会话、起草下一条消息，并在可延续原生历史时继续对话。禁止重放旧任务的安全要求，不得扩展成本地草稿不可编辑或正常升级后一律重新开始。

完成必须同时满足：

1. 已有会话在运行中、发送暂不可用、状态读取失败时仍可编辑草稿。成功、失败、停止、切换会话、迟到回执均不得清除后来编辑的草稿与附件。
2. 14 个旧 active head 在 S3 前均完成同 thread 全前提分类。runtime 兼容、cwd、instruction、model/thread config 均满足，当前本轮工具子集能由**该 thread 自己的 frozen tool contract**精确承接，且原生历史仍有效的旧会话，经正式 Ready 入口发送新输入后，保持同一 scope、可见消息范围及原生 thread；正文、终态、下一动作一致。再次发送和重启后发送也通过。适用性按 head 判断，不按 release 或一个全局 tool digest 分组猜测；首要七个 head 不能因漏查另一道门在 S3 才缩成 N 个。若 S0b 发现真实严格变化或误设阻断，须先按 §4.2 定性并修订适用范围/兼容合同。
3. 真正缺失有效关联、接续能力未获证明或已确认不支持直接接续时，显示具体原因和可执行恢复操作。恢复保留可见消息与草稿，并永久显示上下文断点；不能以静默清空上下文充当续聊。
4. 动作读取失败不让“停止当前运行”的意图入口消失；执行停止前仍重新确认精确目标。只有终态通知、没有原发送回调时，动作状态也能收敛到 Main 的当前事实。
5. UI、量具、发送准备、原子保存、fork、重启读回使用同一兼容判据。历史审计数据保持原值；旧任务、旧授权、旧 Retry 回执不能获得新的执行资格。
6. 从同一安装包验证旧数据升级与既有会话的新一轮，不能用 reset 后的新会话替代。独立复审无未关闭的本范围 P0/P1/P2；未验证的接续类别必须明确列出，不能写成通过。

产品边界明确为：started native thread 固定它创建时的模型可见工具集合与 Ready 工具执行合同。`resolved` 是本轮完整授权工具面，不是对“模型实际会调用哪个工具”的预测；它由输入意图、资源、技能、环境和能力地板共同决定，并不等于整个应用的静态全局工具表。

- 本轮 resolved 出现 frozen surface 没有的新工具：标准 continuation 路径不能给已启动 thread 追加，必须走 §7。
- 同名工具的模型可见描述/输入 schema 改变，或 Ready 执行元数据改变：按 §4.2 分名后走 §7，不能伪装成 runtime 版本问题。
- frozen 中存在、但本轮 resolved 已不再包含的工具：单向包含检查允许继续；本轮授权不含它，gateway 发给 provider 的工具会按 allowed subset 过滤，不能让已移除工具重新获得执行资格。

因此安装 MCP、启用技能或增加工具定义并不会按配置事件直接终结全部历史；只有某一轮的 resolved surface 实际需要新增/变更 entry 时，该 thread 才失去同 thread 适用性。若新增工具进入所有普通轮次的默认 surface，效果才是所有旧 thread 都需恢复。此时输入仍可编辑，原因须具体，并由 §7 保留记录开始新上下文。S0b 若显示大量 head 命中此边界，验收报告必须把它作为产品限制公开，不能藏在“版本不兼容”下面。

本批保留已修好的 exact Retry 资源激活、原任务输入定位、继续/重试词义分离、真实 consequence 与 action admission，以及历史 gateway 事件的无损迁移。不恢复旧模型循环、旧 worker、旧通用空 generation fallback，也不扩大成任意工具/模型切换架构改造。

## 2. 已确认事实与样本分层

事实来源：[现场诊断](../audits/2026-09-03-ready-history-composer-diagnosis.md)、[前一版方案复审](../audits/2026-09-03-history-composer-repair-proposal-review.md)。源码基线与安装 app.asar 已核对；以下是 2026-09-03 诊断时快照，不得作为以后运行时的硬编码名单。

| 样本类别 | 数量 | 当前事实 | 本批要求 |
| --- | ---: | --- | --- |
| 0.149 已启动旧 head | 7 | 原生版本/二进制/通信 schema 与当前相同；仅整包摘要不同 | 首要非 reset 续聊验收对象；不允许仅解锁按钮后交付 |
| 0.149 旧空 head | 1 | 无原生 thread、无消息/turn | 严格空白证明通过后刷新到当前空 head；不称“同一 thread 续聊” |
| 0.146.1 已启动旧 head | 4 | 已知版本/schema 不同；尚未证明能否兼容 | 单独探测，成功才准入；不能按 schema 不同直接宣告不兼容 |
| 0.146.1 旧空 head | 1 | 无原生 thread、无消息/turn | 同一严格空白证明，不需要编造旧历史 |
| 0.146.1 未启动但有失败记录 | 1 | 另有历史不确定阻断 | 不得当成 pristine；走确认状态/明确恢复 |
| scope 开放、全部 head 已退役 | 9 | 备份中已存在；退役原因 publication_diverged | 具名恢复，不能反复显示暂时读取失败 |

当时共有 166 条消息、134 个旧 e1 run，未终态 run 和 dispatch fence 均为 0。另有一个已关闭旧会话、一个诊断开始前新建的空白会话，分别作“不复活”和新建基线。

历史 manifest 可以追溯：`8b2e1f3f4f80…` 对应 Git `f175a25f` 及原应用私有备份；`d47a3b863ed1…` 对应 Git `74f81644`。来源可追溯不等于兼容已获证明。真实数据、路径、账号和会话正文不得进入公开 fixture、仓库或安装包。

Revision 5 已完成的 S0a 普查见[逐 head / turn 去隐私证据](../audits/2026-09-04-history-continuation-s0/README.md)：14 个旧 head 有 25 条 turn 记录，24 条实际进入原生对话，均能通过 epoch 定位 process lease，且与有效 admission receipt 中的 runtime 摘要一致。首要七个已启动 head 的 20 条 turn 全部通过这项来源检查。唯一 NULL epoch 是 `thread_start_delivery_proven_absent`，未产生原生 thread/turn，不能当成历史写入。11 个已启动 head 的 stored cwd、instruction digest、tool surface/snapshot、model 与 profile/thread config 证据也全部存在、自洽且 cwd 当前可达。此结果只证明历史侧输入齐全；尚未用正式生产者生成并比较当前构建候选，不能据此宣告同 thread 发送可行。

这 11 个 head 的 instruction/profile 各只有 1 种，frozen tool surface/snapshot 有 3 个配对（7/3/1），且同一 `d47a3b…` 来源内出现两种，证明 tool surface 是 thread 级事实而非 release 常量。该分布不构成“当前最多匹配 7 个”的上限：现有 `resolveReadyToolTurnSnapshot` 对 existing thread 传入并返回该 binding 自己的 frozen surface，只核对本轮当前工具子集的完整 entries 是否能由它承接；repository 看到的 candidate 不是一个全局 current surface。S0b 仍须逐 head 实测，不得从三组摘要推断通过数量。

## 3. 方案取舍：保留历史证据格式，统一当前兼容决策

### 3.1 本批明确不采用的两条路径

- 不新增可空“窄指纹”后让旧行退回只比较协议。所有记录必须经过同一判断，缺信息不会换用更宽的标准。
- 不更换 `nativeInheritedContractDigest` 的 v1 算法，不重算旧 inherited digest、coverage、terminal facts 或物化回执。它们证明过去实际继承了什么，不是当前执行器能否处理它的开关。

这是比“新列 + 多份历史摘要重写”更小的修复。兼容部分不新增数据库状态或用户级兼容账本；恢复操作所需的持久边界另见 §7。

### 3.2 唯一的版本兼容入口

新增一个小型纯函数模块 `codex-runtime-compatibility.ts`（拟新增），由生产 composition 注入当前已验证 runtime。所有历史 binding 均以其不可变来源身份作为输入，不分 e1/e2 两套兼容逻辑。

```ts
type RuntimeOperation =
  | 'ordinary_continuation'
  | 'fork_from_accepted_prefix'
  | 'reseed_uncommitted_tail'
  | 'manual_compaction'

type RuntimeCompatibility =
  | { kind: 'compatible'; sourceManifestDigest: string; targetManifestDigest: string;
      operation: RuntimeOperation; basis: 'same_verified_runtime' | 'verified_transition';
      proofDigest: string }
  | { kind: 'unverified'; sourceManifestDigest: string; targetManifestDigest: string;
      operation: RuntimeOperation; reason: 'source_unknown' | 'transition_unverified' }
  | { kind: 'unsupported'; sourceManifestDigest: string; targetManifestDigest: string;
      operation: RuntimeOperation; reason: string; proofDigest: string }
```

历史读取不是会修改原生对话的 runtime operation，因此不进 transitions 资产；它只做不可变数据的完整性校验和展示。`unsupported.reason` 收窄为实际反例支持的枚举，不能用任意异常字符串推断“不兼容”。格式损坏、身份矛盾继续走现有完整性错误，不把损坏归成可以重新尝试的未验证状态。

一个 head 可能涉及多个 runtime。上述结果先对每个去重来源分别求值，再由同一 reducer 生成一个 `RuntimeCompatibilitySet`：只有该操作要求的全部来源都 compatible，聚合结果才 compatible；任一来源有真实 unsupported 反例则整体 unsupported；否则只要有 unverified 就整体 unverified。结果包含有序来源证据及整体 digest，head/action ref 消费整体结果，不能只取创建版本、最新版本或第一个 blocker 代表整段历史。来源记录损坏优先作为完整性错误，不进入这个三态聚合。

唯一判定顺序：

1. 验证来源 manifest 的 canonical digest 与 binding 固定身份一致，协议列也必须与该来源相符；验证目标 runtime 的实际包体、二进制与合同。来源未知则返回 unverified，不凭 schema 猜来源。
2. 同一已验证 runtime 使用当前版本已有的操作能力与合同证明；仍不跳过 legacy coverage、未结束任务、效果或生命周期限制。
3. 跨版本只接受**精确有向**的 `(sourceManifestDigest, targetManifestDigest, operation)` 验证结果。A→B 与 B→C 不推出 A→C；read 成功不推出 send、fork 或 compact 成功。
4. 没有证据就返回 unverified；只有具体兼容性反例才返回 unsupported。网络失败、测试设备异常和普通任务失败不能注册为 unsupported。

不能只看 thread 创建时的版本：旧线程可能已被更新版本写入过。`readHeadActionFacts` 使用同一只读 reducer，从原始 binding、已验证 ingress admission receipt、turn dispatch epoch → process lease、resume evidence → process lease，以及 manual compaction attempt → connection epoch/lease 提取实际历史写入/恢复所涉及的 runtime 身份；automatic compaction 归属其当轮正式运行。去重后的来源证据摘要进入 head 的兼容 ref。所有涉及版本必须具有对应操作能力证据，并由实际 native readback 验证当前历史；不能利用“创建版本恰好等于目标”绕过后来写入的版本。§9.0 先区分实际写入、已证明未派发和确有缺证据的操作；连接/来源无法对账才返回 unverified，不因 NULL 本身判定旧格式，也不新增镜像 last-writer 表。旧数据没有某种操作时不凭空要求那类回执。

证据放入随应用发布的一份只读 `assets/runtime-continuity/runtime-continuity-transitions.json`（拟新增应用资产，不加入被它引用的 runtime manifest 以避免摘要循环）。记录源/目标身份、操作、结果和去隐私的探测报告摘要；对应源 manifest 置于同目录的 `manifests/`。它是发布兼容合同，不是按用户、会话或旧格式绕行的开关。生产只查这一个合同，不去 Git、备份目录或用户配置搜另一份事实。

该资产受构建打包检查及包体内容验证；在 runtime source gate 的同级补一个专用检查，确认记录唯一、源/目标内容摘要一致、报告存在且成功类别匹配、实际包包含同一文件。不得把“有 JSON 条目”当作已经做过行为验证。正式放行条目由 §9 探测产出并经复审，不能先填 pass 再开发。`proofDigest` 只计算去隐私的能力断言证书（源/目标/操作、测试合同与可观察结果），不把引用它的 head/ingress 摘要、完整 catalog 自身或最终 app 哈希纳入，避免自引用；完整轨迹另存，最终安装证明再核对证书与实际包的一致性。

本批只建立实测来源到本次目标的必要边，不构建通用版本比较框架，不按全部 manifest 字段强行二选一分类。后续发布改变 manifest 时由 §3.4 的构建门强制覆盖此前来源，不能靠人员记得补边。

目标身份取实施完成后的最终 runtime manifest，不能硬编码诊断基线 `cda6bd5f…`。本批至少覆盖 0.149 旧来源、0.146.1 旧来源的分类结果，以及当前 `cda6bd5f…` 版本生成的 e2/fork 数据。最终 schema/合同资产变更再次改变目标摘要时，原目标条目自动失效，须重跑对应证明。当前动作 ref 还应覆盖实际历史来源证据摘要；重启到新包后旧缓存 ref 不能被接受为当前发送授权。

### 3.3 审计身份与执行身份分开消费

| 事实 | 继续表达什么 | 不允许的用法 |
| --- | --- | --- |
| binding 的 runtime/protocol 固定列 | 创建/继承该原生绑定时的来源身份 | 用当前版本覆盖旧值；单靠是否等于当前决定可发送 |
| inherited digest v1、fork source/target 一致性 | 历史继承内容及回执未被改写 | 因当前代码变化重新计算历史记录；忽略原摘要验证 |
| 当前 process lease / verified runtime | 本次真正运行的二进制、进程和合同 | 为匹配旧 binding 冒填旧 runtime 到当前执行回执 |
| 新 ingress admission receipt | 本轮当前 runtime、prepared、reservation 与实际输入 | 继承旧运行状态或把旧回执当新准入 |
| 当前兼容结论 | 当前执行器可对来源历史做哪些操作 | 代替工具权限、资源激活、任务效果或 accepted-prefix 证明 |

`RuntimeCompatibility` 只作为当前 action surface 的组成与准入证据，不另存一份 mutable “ready” 字段。head 的 evidence digest 必须覆盖它；普通发送已有的 `actionAdmissionRef` 因而绑定用户实际看到的兼容结论。最终事务从同一版本证据与当前 DB 状态重算，过期则零持久化拒绝并保留草稿。

### 3.4 发布源清单与完整覆盖构建门（F2/F6/F7）

新增唯一来源目录 `assets/runtime-continuity/runtime-sources.json`，只记录 source manifest 摘要、对应 manifest 文件、来源类别及证据引用，不存 compatible/unsupported 结论。它同时保存发布候选的归类依据并推导“哪些来源进入发布支持范围”；transitions 资产回答“范围内来源对当前目标能做什么”，不复制兼容状态，也不再另建第二份 published 列表。

初始清单不能只从一台开发机数据库反推。先由 tag、CHANGELOG 版本和打包记录枚举候选，再以真实发布包、Packer 发布回执或安装证明确认哪些候选实际发布；Git 提交、tag 或 CHANGELOG 单独都不等于发布。S0/安装普查用于补充实际观察到的来源。每条来源只有一组证据引用和一个可推导范围：

- `published_support_source`：有真实发布证据，且该版本合同允许留下可续聊 active head；
- `observed_active_source`：至少一个受支持安装样本或升级 fixture 的 active head 当前依赖它；
- `published_source_manifest_unrecoverable`：有发布嫌疑但**原 manifest 无法定位**，因此身份不可核验。它留在目录内（不被静默丢弃），但**不得声明任何 transition**；运行期一律解析为 `unverified`，受影响会话走 §7 显式恢复。此类别只在既拿不到 manifest、也拿不到"从未发布"证据时使用，且必须带 `source_manifest_unrecoverable` 与证据引用。
- `retired_audit_source`：只用于追溯，已有证据证明它不属于已发布可续聊来源，也没有受支持 active head。找不到原 manifest 时记录 `source_evidence_unrecoverable`，不能伪造 compatible/unsupported。

`ordinaryContinuationSupportSet` 是前两类来源的并集。某来源在本机没有 active head，只能证明**本机**不可达，不能据此直接降为全局 `retired_audit_source`；还须核对发布种子和受支持升级语料。清单只增不静默删；构建门将当前清单与上一正式发布清单及实际 manifest 比较，不能通过同时删除 source 和 transition 绕过。当前候选 target 恒加入自兼容检查；发布后用实际包证据固化为下一版输入。

必须实现以下构建失败条件，并在 `verify:history-continuation` 和正式 Packer 路径均执行：

1. 上一发布支持来源被删或降级、manifest 内容与摘要不一致、发布候选未给出发布/未发布证据、S0 实际观察来源未入清单，均失败。`retired_audit_source` 可没有 transition，但必须有“不属于支持集合”的证据及独立复核，不能仅因资料丢失而自动获得该类别。
2. 对 `ordinaryContinuationSupportSet` 中每个来源到**当前最终 target**，ordinary_continuation 必须有一条精确 compatible，或一条附真实反例、I2 恢复证明和明确退化说明的 unsupported。缺边、unverified、目标摘要过期、结果冲突或证书缺失均失败；相同 source/target 由自兼容证书显式满足。
3. 目录中任一来源曾正式开放的 read/fork/reseed/compact 操作都不能静默丢失，不受当前是否有 active head 限定。此前 compatible 变为 unsupported 时，默认阻止普通更新发布；只有真实反例、恢复证明、更新说明及独立审查均齐全才可显式退化。本批七个首要 head 不允许用 unsupported 绕过完成标准。
4. 清单范围推导及每个支持来源没有去隐私 fixture 测试均失败。CI 不连接开发者或用户真实数据库；每次改 manifest 都重跑 S0 fixture、S0b 生产预检与 operation 证书覆盖。
5. 记录最终包内目录、支持来源 manifest、transitions、证书，以及 audit-only 来源证据的摘要。`published_support_source` 缺 manifest（无 reason 逃逸）、`published_source_manifest_unrecoverable` 带 manifest 或声明了任何 transition、audit-only 条目缺其范围证据、包内文件与已验证输入不同，均失败；不能只验证工作树。

S0a 在全部 binding/ingress 观察到 6 个来源。当前本机真正被 active continuation head 依赖的只有 `8b2e1f3f4f80…`（7 个）与 `d47a3b863ed1…`（4 个）；`cda6bd5ff082…` 只有一个未启动 active 空 head；`f981c518fe97…`、`25ebf79c723c…`、`4e73326d4988…` 在本机仅见于退役 binding/旧 ingress。后两份完整 manifest 尚未定位，因此不阻塞这台安装的 active-head S0b/S3 可行性，但必须进入发布种子审计。在拿到"从未发布"证据之前不得降为 audit-only，在拿到 manifest 之前也不得留在 `published_support_source`——两者都会让门失去意义。因此它们暂列 `published_source_manifest_unrecoverable`：保留在目录内、零 transition、运行期 `unverified`。**这是 2026-09-04 实施时对本节的修订**：原稿只给了"支持来源缺 manifest 即失败"与"确认未发布后降 audit-only"两条路，真实数据落在两者之外。若后续找到 manifest，立即升为支持来源并阻止缺边发布；若找到"从未发布"证据，则降为 audit-only。

构建端阻止已知发布支持来源漏覆盖；运行时仍保留 unverified，以处理外部导入、未发布开发版或单条历史证据损坏。两者职责不同，不用构建通过来假定任何用户数据都完整。

## 4. 必须成批覆盖的生产消费者

下表的“保留/替换”是施工清单。搜索只负责找全调用方，不能作为行为验收。

| 边界 / 当前入口 | 必须如何消费 |
| --- | --- |
| `codex-runtime-host.ts` 的包体校验、process lease、sidecar supervisor | 保留完整 runtime 身份校验；真实执行器仍记当前身份 |
| 当前 profile、cwd、instruction 与 tool surface 的生产者 | 生成 §4.2 的候选合同；复用 `activeProfile`/profile snapshot、现有 cwd 取值、`resolveCodexThreadInstructionContract`、`resolveToolTurnSnapshot`。existing thread 必须传入自己的 frozen surface；普查和 UI 不得复制算法或改拿全局 digest 比较 |
| `CodexBindingRepository.readHeadActionFacts` → `codex-action-surface.ts` | 返回当前 ordinary runtime 兼容结论及默认纯文本/无资源的同 thread 预检；删除整包不等即 blocked 的平行推断；其它 blocker 保留 |
| `readActionSurface`、boot drift 扫描、`refreshPristineFreshStartHeadAtomic` | 使用同一结论；真正空白按 §6 刷新；已启动兼容 head 保持身份；不可用不静默新起 |
| `startIdentityPort.resolveMethods` | 与 head 使用相同 ordinary 结论；仍验证 start/turn fence；不先按整包不等返回 reset_required |
| `ingressPort.prepareIngress` | 用本次输入、资源、技能和当前 profile 生成精确候选，再调用同一 §4.2 reducer；当前权限、记忆与动作义务仍由一次真实 prepare 冻结，不能把旧能力复制回来 |
| loaded admission 的 model 与 `5240–5255` thread config 检查 | 保留逐项严格；必须与 §4.2 同一候选/比较结果一致，失败返回具名“开始新上下文”恢复，不能晚到事务里只抛 reset |
| loaded admission 的 `5257–5262` cwd / instruction / runtime / protocol 检查 | cwd、instruction 保留严格，runtime/protocol 改消费唯一兼容结论；四项分开给出原因，不能继续压成 `thread_contract_change_requires_new_thread` |
| `resolveReadyToolTurnSnapshot` 的 current subset → frozen entries 检查 | 这是 tool drift 的首个真实失败点：每个本轮 current entry 必须在该 thread frozen surface 中存在且完整一致；减少本轮授权子集可继续，不能拿一个全局 surface 与所有 head 做相等比较 |
| loaded admission 的 `5263–5265` tool surface digest 检查 | 保留“prepared 仍是该 binding frozen surface”的严格校验；使用正确生产者时并非 current global digest 比较。失败为内部链路矛盾或具名恢复，不能仅在 repository 才发现 |
| loaded admission 的 `5290+` tool surface snapshot/json 检查及旧 snapshot backfill | 保留 frozen snapshot 自洽、canonical JSON 与必要 CAS；CAS 只补历史 NULL pair。已有 snapshot 不得重封或覆盖，metadata drift 不在这里通过改摘要解决 |
| `validateCodexFrozenToolExecution`、tool action identity / binding / receipts | 继续使用 frozen entry 的 schema、effect、timeout、结果/投影与 snapshot digest；current 可执行定义须能精确履行 frozen entry，否则返回 Ready 工具执行合同变化。不能把内部 metadata 当作“没人消费”删掉 |
| `admitProductBindingsInOpenTransaction` 的 action ref 与 loaded / empty 汇总 | 原子重算 runtime compatibility、默认 action ref 和本次精确候选；任何过期均零持久化。普通 pristine 空根按 §6；有 seed 的 fresh_root_with_tail 走 §4.1，不能当 pristine 刷新或丢 tail |
| admitted product readback、`resolveDeveloperInstructions(expectedDigest)` 与 `CodexModelGateway.validateBinding` | 消费 admission 已冻结的同一 model/profile、instruction 和 tool surface，继续核对实际 native/gateway 请求；这是本轮执行完整性校验，不能拿旧 thread 合同替换当前请求，也不能在此重新决定历史兼容 |
| Retry eligibility 的 `readHeadActionFacts` 调用 | 消费同一当前兼容结论；source eligibility、精确 root、效果和 direct-successor 约束不放宽 |
| `readNativeInheritedContractDigest` / `readNativeForkMaterialization` | v1 旧摘要、source/target 来源相等及物化回执照常验证；当前执行 fork 另消费同一模块的 fork 操作结论 |
| closeout 中的 fork 规划/落库/dispatch/reconcile | 首次构造与恢复派发均核对 fork 结论；target 保留真实 source 继承身份，实际 process/dispatch 仍记当前执行器 |
| `fresh_root_with_tail` 的规划、首轮普通输入/Retry、首次 seal | 使用 §4.1 的 reseed 结论及非 runtime 字段一致性；删除当前整体摘要与旧 source 摘要直接相等的判据，旧 source 与目标各自的自洽校验保留 |
| manual / automatic compaction、terminal evidence、native readback | 按各自操作验证当前执行器能力；不能因普通续聊已准入而获得 compaction 或 coverage 能力 |
| Renderer、`handleSend`、send store、量具 | 只显示/消费正式 action surface；不再凭版本、isStreaming、旧 terminal 文案重判发送 |

实施时将每处 runtime/protocol 比较标为“历史自洽校验”或“当前运行准入”，逐项提供调用与行为证据。禁止机械删掉所有比较；也禁止把 `input.runtimeManifestDigest` 改成旧值来骗过剩余检查。

head ready 只承诺“当前 profile 下的普通纯文本、无新增资源/技能”已通过同 thread 预检，不承诺尚未准备的任意附件、技能或模型变更必然满足原生线程合同。本次输入的精确候选在 prepare 与原子 admission 再用同一 reducer 核对；输入相关拒绝必须具体说明并保留草稿，不能重新退化为统一“请重置”。

### 4.1 inherited digest v1 的写入与跨版本比较（F3）

必须区分三种校验，不能把 Claude 列出的相邻代码都换成兼容判断：

- `:2027` 的 source 重算以及 `:5139` 的 existing 重算是**记录自身的完整性验证**，保留。
- native_fork 的 source/target 摘要相等是**确实复制了同一历史继承合同**，保留；其 target 固定来源列本来就复制 source，不是当前执行器身份。
- `:5203–5205` 把**当前 prepare 的整体摘要**与旧 source 整体摘要相比，会因 runtime 不同误拒绝，必须替换，不能仅在前面加 compatible gate。

新写入规则固定如下：

| target 类型 | target 固定 runtime/protocol 的取值 | inherited digest 的写入 |
| --- | --- | --- |
| native_fork | 复制已验证 source 的声明来源身份 | 复制通过 v1 自洽校验的 source digest；后续不重算覆盖。实际 fork 执行器另外记入当前 lease/dispatch |
| 新规划的 fresh_root_with_tail | 规划时当前已验证 runtime/protocol；source 来源仍由 history_source_* 绑定 | 首次准入前保持 NULL；准入时用 **target 已存声明身份 + 本轮实际冻结的非 runtime 字段** 按同一 v1 算法 seal 一次 |
| 升级前已存在、尚未启动的 fresh_root_with_tail | 保留已有不可变声明身份 | 同一公式用 target 已存身份 seal；不能拿当前 executor 身份算摘要、却仍留旧 target 列而导致自洽失败；也不能修改旧列或重新造 generation 丢 seed |
| fresh_start | 由 new/reset/recovery/pristine 正式 owner 写入的当前身份 | 同一 target 声明身份 + 本轮实际字段公式 seal |

只有一个 seal 实现，不按记录新旧双读。调整 `admissionNativeInheritedContractDigest` 的职责为“从目标声明身份及实际 prepared 字段封印继承合同”，取值源必须显式；`buildCodexIngressAdmissionReceipt(input)`、真实 lease/RPC/gateway 仍记录**实际当前 runtime**，绝不把整个 input 的 runtime 改成旧值以通过校验。

跨版本 source→当前执行器的条件为以下各项同时成立：

1. source stored digest == v1(source 的 stored fields)，如 target 已 seal 则 target 也须自洽；原始 seed、source terminal、coverage、direct-successor、epoch 和 readback 身份校验均保留。
2. 只将 inherited 输入中的 runtimeManifestDigest/protocolSchemaDigest 对当前执行器的裸相等比较交给唯一兼容模块。tool surface snapshot、instruction contract、model、thread config，以及固定的 history policy/provider/approval/sandbox 项继续逐项严格匹配；兼容 runtime 不可掩盖其它变化。
3. native_fork 要求 fork_from_accepted_prefix compatible；fresh_root_with_tail 要求独立的 reseed_uncommitted_tail compatible。后者证明 seed 重述/替换及当前准备合同，不能借一个成功的原生 fork 冒充。首轮普通 C 和 exact Retry 都要消费它，不能只修 Retry 入口。
4. ordinary 的当前准入条件仍须通过；所有比较在原子 admission 内以同一已验证证据重算。完成后新写入的 target 必须能立即通过现有 v1 reader，再验证重启及下一轮。

必须覆盖旧 e2 的已完成 fork、已规划未派发 fork、升级时未启动的 fresh_root_with_tail，以及新版本从旧 source 新建这两类 target。不能只用本次全为 e1 的用户样本证明 F3 已修复。算法不变不代表所有调用方不变，此节替代 Revision 1 中未明确写出的取值/比较规则。

### 4.2 同 thread 全合同预检（F5）

runtime 兼容只是 loaded admission 的一个输入。新增一个无写入的纯 reducer `resolveSameThreadContinuationContract`（设计名），一次比较 stored thread contract、当前候选和 `RuntimeCompatibilitySet`，返回：

```ts
type SameThreadContinuation =
  | { kind: 'ready_same_thread'; evidenceDigest: string }
  | { kind: 'requires_new_context'; reason:
      | 'runtime_unverified' | 'runtime_unsupported'
      | 'model_changed' | 'thread_config_changed'
      | 'cwd_unavailable' | 'cwd_changed'
      | 'instruction_contract_changed'
      | 'native_tool_surface_extension_required'
      | 'native_tool_definition_changed'
      | 'ready_tool_execution_contract_changed';
      evidenceDigest: string }
  | { kind: 'temporarily_unavailable'; reason: 'current_contract_read_failed';
      evidenceDigest: string }
```

这是设计合同，不是现在已有的导出。reason 实施时只按真实失败点收窄，不新增通用异常桶。完整性损坏仍是单独错误；`requires_new_context` 表示旧历史保留但不能沿用同一原生 thread，正式下一动作是 §7，而不是 reset。

当前候选必须由正式生产者生成：当前 active profile 生成 model/profile snapshot/thread config；started binding 的 cwd 使用正式发送实际会取的 `binding.isolatedThreadCwd` 并验证路径仍可达；instruction 使用 `resolveCodexThreadInstructionContract`；tool surface 使用 `resolveToolTurnSnapshot` 对**该 binding 自己的 stored frozen surface**做验证。该函数返回的 `readyToolSurface` 仍是 frozen surface，本轮变化只体现在 current subset/authorization；预检不得直接拼 JSON、重算另一种摘要或只用 `digestCodexRootToolSurface` 代替真实逐 head 检查。

工具变化分两层命名，但本批都不覆盖历史 snapshot：

- 本轮 current subset 出现 frozen surface 没有的新工具，返回 `native_tool_surface_extension_required`；这是已知标准 continuation 路径无法追加 dynamic tool 的结构限制，走 §7。
- frozen 有同名工具，但名称/描述/输入 schema 等模型可见定义改变，返回 `native_tool_definition_changed`；单独列出以便发现本可避免的工具合同漂移，仍走 §7。
- 模型可见名称/描述/输入 schema 相同，但本轮 current entry 的 effect、timeout、projection、result shape 或 explicit-allowlist 等 Ready 执行元数据与 frozen entry 不同，返回 `ready_tool_execution_contract_changed`。这些字段由工具桥、行动身份和回执实际消费，不是可丢弃的冗余。当前 bridge 不能严格履行旧 frozen entry 时，本批同样走 §7，但文案不得误称原生不兼容。

frozen-only（旧 surface 有、本轮 current subset 无）的 entries 只作为 S0b 信息项，不是 blocker；正式 provider 请求继续按本轮 allowed subset 过滤。比较函数不得把单向包含误改回集合相等。

这项拆分只能有一个 entry 比较函数，由 `resolveReadyToolTurnSnapshot`、S0b/§4.2 reducer 和 `validateCodexFrozenToolExecution` 共同调用；前者负责发送前分类，后者仍在真实 tool call 前重验。不能让预检按两层分类、工具桥继续用另一套 full-entry 公式，也不能从异常字符串二次猜类别。

不得把第二种变化接到 `5290+` 的 backfill CAS：已有 snapshot、tool action identity、旧 tool binding/receipt 和 inherited digest 都引用原值，schema trigger 也禁止覆盖。未来若产品决定跨这类变化继续，必须证明当前实现仍能按旧 frozen contract 执行，并继续使用旧 snapshot；不能重封历史或按“只改内部元数据”自动放行。本批不新增这套高频兼容账本。

当前仓库 0.149 合同与复审提供的 0.152 schema 都只在 `thread/start` 接受 `dynamicTools`，`turn/start` 没有工具字段。这证明本批已知标准续聊路径不能追加工具，不等于证明 runtime 永远不存在其它更新机制。若未来要把新增工具导致的 §7 恢复从长期边界改成可续聊能力，应另立 Stage 0 协议探测并分别验证原生更新、fork 继承、provider 工具面和 Ready 工具桥；不在本批猜测或预留 fallback。

同一 reducer 有两个明确调用场景，不形成两套规则：

1. head/action surface 传入“当前 profile + 普通纯文本 + 无新增资源/技能”的默认候选，声明这一最小发送是否可行；结果 digest 进入 head evidence 和 `actionAdmissionRef`。
2. `prepareIngress` 传入用户本次输入生成的精确候选；原子 admission 消费同一候选、同一 reducer 结果及 action ref。新增资源/技能造成的严格变化可以在这里具名拒绝，但不得清草稿或回到笼统 reset。

S0b 在 S3 前调用这套**生产候选生成器 + 同一 reducer**，对 14 个 head 逐一输出匿名结果；SQL 普查只验证 stored 侧证据，不负责计算当前值。默认动作面的候选固定为 `ContinuationProbeInputV1`：非空中性文本、当前 workbench、无资源/技能、默认授权模式，并检查真实本机可用性；它既不使用空文本，也不等同于任意用户精确请求。不得为普查另写一套 tool/instruction/profile 算法。结果按以下三类当场处理：

- 全部严格项相同且 runtime compatible：该 head 才进入同 thread S3 验收。
- 某项是应当严格的真实变化：进入 §7，并在完成标准中明确不属于同 thread 续聊适用集合；界面显示具体原因和恢复操作。
- 某项只是路径表示迁移，或未进入本轮 current subset 的无关工具变化，却仍被判阻断：先补精确反例并修正候选生产/比较范围后再进 S3；不得临时删比较、覆盖 frozen snapshot 或增加宽松 fallback。

当前代码对 started binding 直接复用 stored cwd，所以仅仅更改新会话根目录不应产生 `cwd_changed`；stored 路径丢失、不可达或原生 readback 身份不符才是具名失败。S0b 还须证明相同输入在 head 默认候选或精确请求候选、prepare 与最终 loaded admission 中保持同一结论；C6 要求“同一输入三处一致”，不要求默认候选与任意精确请求永远相同。精确请求若因资源、技能或工具变化被 prepare 拒绝，响应必须同时带 Main 签发的 `begin_new_context` action ref，绑定 source 身份、精确候选 evidence、当前草稿 revision 与后果；Renderer 仅在这些身份仍相同时显示并提交给 §7 的同一事务，不新增第二个 prepare/recovery 入口。

## 5. 草稿、发送、停止与读取恢复

### 5.1 唯一 UI 状态推导

提取一个由 ChatInput 与验收快照共同使用的小型 composer state 纯函数。真实组件测试同时断言 DOM；量具不另写公式。

| 当前情况 | editable | send | Stop / 原因 |
| --- | --- | --- | --- |
| ready、内容非空 | true | 当前授权更新等本轮本地提交条件满足才可用 | 无运行目标则不显示 Stop |
| thread_busy | true | 不可用 | 使用正式 lifecycle Stop；显示任务仍在运行 |
| 动作面读失败 | true | 不可用 | 具名重新读取；精确运行目标来自 session 的 run 身份，不依赖已被清空的 lifecycle projection，按 §5.3 第 4–5 条保留确认并停止意图 |
| runtime 接续未验证/不支持 | true | 不可用 | 显示区别；满足 §7 前提时提供“保留记录，开始新上下文” |
| 本轮新增工具不在旧 thread 工具集合 | true | 不可用 | 明确说明当前请求需要新的工具上下文，提供 §7；不称版本故障 |
| 同名模型可见工具定义已改变 | true | 不可用 | 明确说明工具合同已变化，提供 §7；与单纯新增分别记录，便于识别可避免的漂移 |
| Ready 工具执行合同已变化 | true | 不可用 | 明确说明旧工具执行规则无法安全沿用，提供 §7；不称原生不兼容，也不覆盖旧 snapshot |
| scope 存在但无 active head | true | 不可用 | 消费正式 history-only 结果及恢复动作，不能显示成临时网络错误 |
| 授权方式正在更新 | true | 不可用 | 更新成功后再提交，更新不妨碍起草 |
| 用户已发起会清理草稿的 reset/close | 操作结算前短暂不可编辑 | 不可用 | 明确操作状态；失败恢复原草稿。普通恢复操作按 §7 保留草稿 |

具体 blocker 在输入区持久可见，不依赖 disabled 按钮的 click，也不只放 tooltip。空白草稿导致发送不可用不作为错误提示。多个 blocker 按 Main 的优先级展示主要原因，次要限制不反向覆盖可执行下一动作。

移除 ChatPanel/ChatInput 用 head gate 锁 textarea、用旧 streaming flags 再否决 ready send 的消费。`sendingRef` 只防同一次未结束的点击提交，不作为第二套 run 状态；settle 必须绑定本次请求，不能让旧 finally 清除新提交的锁。

### 5.2 草稿所有权

现有 `composerAuthorityRevision` 表示会话/上下文所有权，不代表每次编辑；不要混用。每个 session 唯一拥有 `inputValue + attachments + filePool + draftRevision`，由文本、附件和文件池的所有本地编辑入口统一递增 revision；不会因为状态通知递增。删除 `TaskPanel` 的第二个输入框与其提前清空/失败回填逻辑，任务面板只展示任务事实，不能再持有另一份 composer。

- 点击发送冻结 `(session, scope, epoch, observedGeneration, draftRevision, text, attachment identities)`，进入现有 pending ingress snapshot。
- 只有准入确认属于该请求、身份仍对应，且 draftRevision 未变，才清除已发送草稿。改过又改回同一文本也不能被字符串相等判断误清。
- revision 已变则保留当前草稿整体；不把旧附件清理回调套到新附件选择。用户后来再次发送由新 revision 和新 request 拥有。
- send 成功/失败/停止/终态通知均不再二次清输入；换 scope、reset、close 或恢复返回必须先核对草稿归属。
- 搜索引用、建议填入、粘贴、拖放、附件选择、文件池选择与移除都是编辑入口；不得只给 textarea 的 onChange 加 revision。切换 session 只切换所有权，不清空另一个 session 的附件或文件池。

不新增持久草稿库；沿用现有 session 草稿保存方式。该 revision 不作为 Main 权限或执行证据。

### 5.3 统一动作刷新与停止意图

复用 `hydrateCodexLifecycleScope / refreshCodexActionSurface` 的 scope、epoch、generation、sequence 下界保护，不另建第二份缓存或持续轮询。

1. 正式终态事件、发送返回、invalidation、切 scope、用户重读进入同一刷新入口。终态事件只触发读，不自己把 head 改成 ready。
2. 同一 scope 只保留一个进行中的读及最高待处理版本；收到更高版本时在当前读后消费，不丢更新。旧/重复终态不能推进或降低身份，跨 scope 返回不影响当前草稿。
3. 传输/读取失败可复用入口做一次有限自动重读；仍失败保留明确的手动入口。不自动重复不支持判定、语义拒绝、模型请求或有副作用操作；不新增常驻重试调度器。
4. head/lifecycle 配对失效时仍同时撤销旧执行授权。已知 run 标识只允许呈现停止意图，不把旧 Stop gate 当有效授权。
5. 用户点击“确认状态并停止”后，先重新读取动作面，确认同一 scope/epoch/generation/run 的当前 Stop ref，再调用现有 lifecycle adapter。若旧 run 已结束则更新 UI；若已换成新 run 则不停止新 run；若再次读失败则保留入口与具体失败原因。
6. stopPending 的重复点击只重读既有停止结果，不创建新目标；读回不确定时按现有精确停止合同恢复。没有精确目标时不显示泛化“杀掉 Agent”。

## 6. 严格空白 head 的处理

两个历史空 head 没有可接续原生历史。沿用具名 pristine refresh 事务，但资格由**空白事实**决定，不因来自旧格式就永远不可刷新：scope 当前 epoch 零消息、零 run/turn、零原生 thread/session、零 reservation/request/dispatch/reconcile、零 effect/interaction、零 compaction/coverage/tail/source lineage，且没有未结算操作。

满足全部条件的 legacy 或 fresh_start 空根都可原子退役并创建当前 `fresh_start`，epoch 不变，generation+1。审计原值保留，invalidation 在 commit 后发布；旧 action ref 失效，原提交零持久化且保留草稿。复用同一个 absence predicate 与 transaction，不增加普通 used-head refresh 分支。

若该空根来自 §7 的已提交 boundary，零消息/turn/effect 条件限定为边界后的当前上下文，边界前保留展示的历史不算已进入这个空根；旧执行权限必须已经隔离。没有正式 boundary 时仍检查 scope 当前 epoch 的全部相关事实。这样“恢复后尚未发送的新空根”在下一次升级时不会因保留了展示历史而再次卡死。刷新不新增 boundary，不改旧 boundary 的原始 target；新 generation 继续位于其执行下界之后。

此界限不能靠消息时间或可被 VACUUM 改写的 rowid 推断。新 boundary 在自己的同一事务中冻结被保留的 scope 行标识集合，私有存储且摘要进入原 boundary 回执；空白判定消费该集合，只排除已保留的终态记录，仍拒绝当前头任何 start/turn/effect 与任何未完成的 scope 记录。新行即使回填旧时间也不能通过。历史 boundary 没有该集合时保留旧回执原值，不追认捕获时点；不能自动刷新时仍提供已结算、无原生线程的显式新上下文操作。

有失败消息、start intent 或实际效果的未启动 head 不满足此例外，即使 codex_thread_id 为 NULL。特别是 §2 的失败样本必须落到 §7，不得被“没有原生 thread”误洗成 pristine。

## 7. 保留历史的显式恢复

### 7.1 用户体验与正式读取结果

新操作固定为“保留记录，开始新上下文”。按钮旁说明：**已有消息仍保留；下一轮从这里重新开始，不自动带入此前对话；需要的内容可明确引用。** 不命名为“继续原任务”或“恢复完整记忆”。兼容的正常会话优先直接续聊，不主动推荐用户放弃旧上下文。

原因文案消费 §4.2 的正式枚举：runtime 未验证/不支持、当前请求新增旧 thread 没有的工具、同名模型可见工具合同改变、Ready 已无法按旧 frozen 工具规则安全执行，必须分别说明。不得把这些压成“版本不兼容”，也不得建议重装、重读或 reset 来掩盖确定的合同变化。

`readCodexActionSurface` 扩展为一个正式判别联合：

- `active_head`：当前 head + lifecycle，含已知兼容结果和已有动作。
- `history_only`：scope 与 epoch 有效、无 active head，携带最新退役身份及 scope-owned 的恢复/关闭动作。
- 读取失败走 API failure，不能与 history_only 混成 null。

不得用 generation=0、最新已退役 generation 冒充 active generation，或伪造 ready head。请求允许只提供 scope 和最后观察到的版本，Main 读取当前事实；读取绝不写库或隐式创建/刷新 head。启动时 drift sweep 是 pristine refresh 的唯一后台写 owner，发送前的最终 CAS 是唯一按需写 owner；动作读取本身保持纯读。已关闭 scope 继续按 closed 拒绝，不进入可恢复联合。

恢复/关闭由既有 lifecycle 域拥有。扩展其 scope owner 与 `begin_new_context` 动作，不在 Renderer 新造恢复裁决。active-head 和 history-only 的公共恢复规则只有一个 owner/事务实现。

### 7.2 操作前提与幂等事务

仅允许 scope 开放、身份可核对、没有仍可写入的旧 run/start/fence/manual compaction/交互或效果租约。正在运行或停止不确定时，先由现有生命周期 owner 停止/对账；不能清标志冒充停止。历史上已经结算但效果记为 unknown 的事实保留原值，不要求把全部历史效果重判为 absent，也不自动重做。

新增一张最小的 `codex_conversation_context_boundaries`（设计名）保存**已提交**恢复动作及上下文断点，作为这两个事实唯一的持久来源，不再复制一份聊天消息/可变恢复状态/独立当前 head 指针。行包括：

`operation_id`、scope、epoch、预期 source identity/digest、target binding/generation、previous visible message anchor、committed_at，以及在 canonical row readback 后生成并复核的 `receipt_digest`。

operation_id 由 Main 根据 scope、epoch、精确来源身份、动作和后果生成；客户端提交 Main 生成的 action ref，不能自报恢复资格。source identity 为当前 head 的 generation/revision 或“当前没有 active head + 最新退役 binding/generation/revision/退役证据”；与新 head 指针和 epoch 共同 CAS。

一个 `BEGIN IMMEDIATE` 内完成：

1. 若同 operation 已提交且 scope/epoch 未被后来 reset/close 淘汰，返回原结果；不能再创建 generation。
2. 重读开放状态、精确 source、无竞争 active owner、未完成操作及 action consequence；任一变化返回 stale/refreshed surface，不执行。
3. 有 active head 时原子退役，并沿现有 archive intent owner 登记待归档；没有 active head 时引用真实退役证据，不复活旧线程。
4. 用当前 runtime 身份创建唯一 fresh_start，generation 为该 scope 实际最大值+1；不复制 tail、coverage、旧 skill/tool/授权/执行义务，并在同一事务清除 durable implicit context。commit 后清除进程内 `lastReferenceSkill` 并发布现有 badge/state 更新；不得为当前没有消费者的“自动任务摘要”编造额外防线。
5. 写入唯一 boundary/恢复回执及可见消息锚；epoch 不变。目标唯一、operation 唯一、边界不可更新/删除（随合法 scope 物理清理的规则另由既有清理 owner 控制）。
6. commit 后广播正式 action invalidation，返回该操作回执与可重读身份。事务中不发送原生 RPC，不调用模型。归档由已有持久 owner 在事务外处理。

响应丢失时按同 operation 查询结果；重复请求返回同一回执。已提交重放不得再依赖本次开机的临时签发记录，也不得重新清除隐式提示；以确定性 operation 和持久 source/receipt 核验后，只读返回原边界与当前 action invalidation，返回 aliasGeneration 必须与当前 invalidation 一致。与 reset、close、第二个恢复点击并发只能有一个 CAS winner；后来 reset/close 使旧操作不能重新生效。新原生 thread 在用户下一条普通发送时才创建。

### 7.3 断点的实际消费者

| 消费方 | 必须实施的规则 |
| --- | --- |
| 时间线 / 历史搜索 / 重启 hydration | 从 boundary 行显示持久断点；无新消息时显示在旧消息末尾，有新消息时位于新上下文之前；不按临时 toast 或时钟猜边界 |
| Main 当前产品写入与效果准入 | 继续只以既有 active binding + generation 身份作为当前写入权威；boundary 解释为何换代并定位显示断点，不成为第二道写 gate。用真实旧 generation 迟到输入、交互、工具、产物和当前状态更新证明既有身份校验全部拒绝；普通 fork 不建立新断点 |
| `readActiveProductRunVisibilityIdentity` 等共享身份入口、closeout 与 tool/effect identity | 继续消费既有 active identity，不增加 boundary 分支；旧 exact-run 审计/不可变回执读回继续可用，不把当前权限与历史可读性混用 |
| 旧任务卡、Retry 与 action projection | 可显示历史结果，但旧 run 的当前动作失效；不能从旧 failure 推导新任务或让旧回执覆盖新 head |
| 自动 session recall、last skill hint | 不自动把 boundary 前的会话内容/旧执行意图带回新上下文；保留索引用于用户显式搜索引用。清除 durable 与进程内的隐式 skill hint，用户显式引用仍走当前资源与权限准备 |
| Ready 长期记忆 | 继续由独立产品设置及当轮快照控制。文案承诺的是不自动带入此前对话，不能误承诺关闭长期记忆；不在恢复时清理全局记忆 |
| Renderer 草稿与附件 | 保留内容与 revision，成功回执只触发同一 action surface 回读，由当前事实绑定会话身份；不得直接用历史 target generation 改当前 head/忙闲；下一次 send 重新解析资源版本和当前权限，不复制旧 prepared/授权 |

旧消息无论有没有完整 run mapping，都保留在断点前；缺失 mapping 不得被当作新上下文来源。previous visible message anchor 只定位显示边界，不成为模型输入/coverage 证据。新的 current-write CAS 必须与恢复事务序列化，不能先读边界后无条件写入。

这张表只因“保留可见历史但明确开始新上下文”的新产品事实而存在。boundary 固定表达该恢复操作的“无隐式携带”语义，不再保存恒定 `carry_mode`；不得再增加 scope 的恢复布尔、可变 `isCompatible`、冗余 current generation、第二份 boundary 消息或第二套 current-write 判据。

## 8. 数据升级与删除清单

兼容决策不修改来源 manifest 列、不新增 nullable compatibility digest、不重写 inherited digest 或已有 ingress JSON。对原有 e1 终态仍按历史读回，不就地变成 e2；旧 pending 仍须沿生命周期处理，不能在恢复事务中补造成功终态。

新增 boundary 表、相应 scope owner/action schema 和退役原因如有必要，使用实施时下一个可用 migration 序号，不改已执行迁移碰运气。fresh、已到 118、已到 119 均收敛到同一 schema；已有行、摘要、索引、触发器无损。升级自动执行只建结构，**不自动替用户开始新上下文**。

应删除/替换：

- `TaskPanel` 的第二个 composer，及其提前清空、失败时用旧文本回填的逻辑。
- textarea 消费 send gate，及 handleSend 在正式 ready 后按旧 streaming flags 再否决的逻辑。
- `SendScopedResponse` / `SendMessageResult` 中与 `disposition` 重复且造成下游重判的 `shouldClearInput` / `preserveInput`；清理决定只由 disposition 与匹配的 draft identity 产生。
- harness 的旧 `composerLocked || foregroundBusy || isStreaming` 锁定公式；`agent-panel-test-harness-snapshot.ts` 与 `ChatInput` 必须导入同一个 composer state 纯函数，不能各自重写公式。其它表面仍消费旧字段时，不能盲删字段，要按调用方逐个归类。本批产生的孤儿写入删除。
- 把已知 history-only/不支持接续都显示成暂时读取失败的路径。
- 各运行准入处独立的完整 manifest 相等性要求；历史内部一致性、真实执行器身份校验保留。

不删除事件桥、Main 最终准入或旧证据校验来获得绿测；不另建通用兼容平台、轮询服务或重试调度器。

## 9. 探测、红测与安装验收

### 9.0 S0a 历史证据普查与 S0b 生产预检先于兼容实现（F1/F5）

Revision 5 已执行 S0a：从只读打开的真实库用 SQLite backup 创建私有一致副本，在副本设置 `query_only=ON`，不启动 runtime/RPC。逐 head 列 turn 的 native identity、dispatch、epoch、lease、admission digest、实际 runtime 一致性；另查 thread start、resume、manual compaction，以及 started head 的 stored cwd、instruction、tool surface/snapshot、model/profile/thread config 自洽与 frozen surface 分布。副本只在临时私有目录，完成后删除；公开结果只有 H01 等匿名标签、状态、计数和摘要。

判定必须先固定，不能在 S3 遇到 NULL 时临时放宽：

- 有 native turn 或派发证据：检查 epoch→lease，且实际 runtime 与有效 admission receipt 相符。缺 lease、摘要冲突或不完整 lineage 均单独失败，不能按 source manifest 猜执行器。
- 已有正式 `thread_start_delivery_proven_absent` 等无执行证明，且无 native turn、turn dispatch/child write：该 turn 不计入历史写入；thread-start 尝试仍检查其自身 lease。NULL 不单独证明没有执行。
- “早于 epoch 字段的格式”只有在对应构建的原始 schema 确实没有该字段、来源与动作记录可核对时才可作为普查分类。不能仅凭 NULL 或时间早来命名。仓库可追溯的 `088_codex_runtime_bindings` 初始 schema（`29dcede1`）已经包含该字段；本次没有发现这种前置格式。
- 若以后发现真正 pre-epoch 写入，S0 必须先给出受测试约束的正式证据归一化或明确恢复策略，不能直接进入 S3 再添加宽松运行期 fallback。当前不为不存在的样本编造一条替代许可。

已实测结果：14 head、25 turn、24 native turn；24/24 lease 可解析，25/25 admission digest 有效，无 lease/receipt runtime 冲突；1 个 resume 的 lease 有效，0 个 manual compaction。11/11 started head 的 stored 续聊证据完整且自洽，stored cwd 均存在并已规范化。首要七个 head 的 20 个 native turn 均有来源证据，两个真正空 head 不凭空要求 turn lease。唯一 NULL 属于已证明 thread start 未执行的失败样本，仍保留其历史不确定阻断，不自动当 pristine 放行。

S0a 还证明本机 active continuation 只依赖两个来源；两份未定位 manifest 只存在于退役 binding/旧 ingress。这个结论只限定当前快照，发布范围仍按 §3.4 从实际发布记录建种子。

S0b 尚未执行，是进入 S1/S3 前的硬门。先实现 §3.2/§4.2 的无写入纯判断及正式候选生成，但暂不接管生产 action/admission；在不发 provider 请求、不发 native 写操作、不改变用户库的条件下，对全部 14 个 head 比较：stored/current cwd、instruction contract、model、thread config、该 head frozen tool surface 对本轮 current subset 的逐 entry 承接结果，以及 runtime compatibility。不得把当前 root/global digest 与三组 stored digest 做相等匹配。

工具差异必须分别统计：`added_to_current_subset`（frozen 中无同名 entry）、`same_name_model_contract_changed`、`same_name_ready_contract_changed`；另报不阻断的 `frozen_only` 数量。不能只给一个 `native_tool_surface_changed` 总数。第一遍即使 runtime 尚为 unverified，也须先暴露其它维度；Phase 0 产出 operation 证书后再以同一入口复跑整体结论。输出只保留 H 标签、每维结果、具名原因和 evidence digest。七个首要 head 的精确可行数量在完整 S0b 前保持“未知”，不能沿用“来源证据 7/7”冒充“发送前提 7/7”，也不能从 stored 7/3/1 分布猜上限。

普查脚本及 JSON 随 S0 审计保存，能对显式传入的 DB 重跑。它只计算 SQL 可证明的历史侧与本机 reachability；当前候选必须由 S0b 的生产入口生成。实施时两者都纳入 `verify:history-continuation`：CI 使用去隐私 fixture，扩大到 active e2、fork lineage、resume/compaction writer、严格维度变化与缺证据反例；每次改 manifest、instruction、profile/thread config 或 root tool definition 都执行。真实用户库普查是本机显式验收步骤，不成为 CI 的隐式数据依赖。来源/历史侧解析通过仍不证明读取或发送兼容，原生与正式 Ready 链继续执行 §9.1。

### 9.1 Phase 0：先获得接续证据

先留存三个独立基线：已知 0.149 历史、0.146.1 历史、当前 e2 与 native-fork 历史。当前 e2 样本须用基线应用真实生成，不能只手工填表。

隔离至少包括 Ready DB、Codex 原生历史/状态目录、cwd、进程租约和工具效果目标；只复制 DB 不足以隔离。保留私有副本的原值，运行目录重定位使用明确的测试装配方式并记录 `__breaksInvariants`，不得借改生产历史摘要让测试通过。实际用户资料不得作为外部请求输入；使用本地模型/工具替身，禁止真实收费调用或外部写入。

探测分两层：

1. 原生能力层：精确读取/恢复原 thread，旧 items 与身份保持；针对 ordinary、fork、compact 分别生成证据。不得从一次成功推导其它操作。
2. Ready 正式链：使用相同证据候选，经真实 prepare、原子 admission、gateway、工具/结果收口、UI 回读、再次发送及重启验证。测试候选是隔离 profile 的唯一兼容合同输入，不是生产 fallback，也不是第二个判断器。

执行顺序不得形成 S0/S3 循环：S0 先完成原生候选证书与非 runtime 维度预分类，但 transition 仍保持 unverified；S3 接入唯一 reducer 和正式候选生产链后，再在隔离 Ready 正式链完成 prepare、admission、gateway、收口与重启证明。只有两层都通过，才把对应 operation 的 transition 提升为 compatible，并重新执行最终 S0b/G1；不存在“先写 compatible 才能集成、又要先集成才准写 compatible”的旁路。环境故障继续排查，不能以 unsupported 记录掩盖本批修复未完成。最终 S0b 必须把首要七个 head 的 `ready_same_thread` 数量和其它具名原因写回本节；其中任何一个已判 ready 的 head 仍不能发送时，本批不得宣告历史续聊完成，判为新上下文恢复的 head 则必须完成 I2，不能从验收中消失。

### 9.2 机器可验证的行为合同

下列测试名为拟新增/扩展目标。先把真实反例跑红，再实现；测试归属按 §10 对应模块落位，不复制整套影子状态机。

| ID | 行为合同 / 主要断言 |
| --- | --- |
| E1 | `composer remains editable for busy unavailable and blocked heads`：三态可编辑，send 不可用，具体原因可见；授权更新也可起草 |
| E2 | `admission clears only the submitted draft revision`：A→B→A、晚到 admission、新附件、切 scope、失败/停止后草稿均按 revision 保留 |
| E3 | `composer harness agrees with actual DOM`：editable/send/原因/Stop 同实挂 ChatPanel，无旧标志假解锁；两者共同依赖同一纯函数，并针对该共享点加最小依赖合同检查，不允许复制实现（结构检查只证明该硬依赖，行为另测） |
| A1 | `terminal-only delivery refreshes current action authority`：无 send 回调、丢 invalidation 时仍重读；旧/重复终态与跨 scope 读不覆盖当前状态 |
| A2 | `failed surface read preserves exact stop intent`：两半授权撤销后仍可发起确认并停止；旧 run 已结束/换代/再次读失败不误停新 run |
| C1 | `runtime compatibility is exact directional and operation-scoped`：同 schema 不自动允许、不同 schema 不自动拒绝；未知、反向、传递及只读证据不放行发送/fork；线程被后续版本写入后，旧创建身份不能使降级误获许可 |
| C2 | `ordinary send uses identical compatibility through atomic admission`：UI→start preflight→prepare→loaded/empty admission 结论一致；旧整包列未改，当前回执记实际执行器 |
| C3 | `historical inherited evidence remains byte-identical across upgrade`：旧 e2/fork 完整读回、再次 fork、重启恢复；v1 摘要与引用原值相同 |
| C4 | `runtime compatibility never grants history coverage or retry authority`：legacy ordinary 可用仍不伪造 coverage；资源/工具/效果/权限不因兼容而开放 Retry |
| C5 | `cross-runtime fork and reseed seal declared inheritance and record actual execution`：旧/新 native_fork 和 fresh_root_with_tail 按 §4.1 精确取值；prepared runtime 与 source 不同仍可走已验证边；非 runtime 字段改变仍拒绝；写后读、重启和下一轮通过 |
| C6 | `same-thread preflight and loaded admission compare one contract`：model/thread config、cwd、instruction、逐 head frozen tool contract、runtime 在默认 head、精确 request、原子 admission 三处对同 fixture 同结果；同一 release 的多种 frozen surface 在 current subset 可承接时都通过，prepared/repository 始终保留各自 frozen digest；覆盖当前 `5240/5257/5263/5290+` 四组门 |
| C7 | `strict continuation changes lead to named recovery`：每个严格维度单独变化时草稿仍可编辑、send 不可用或零持久化拒绝，并提供 §7；新增模型可见工具、同名模型合同变化、Ready execution metadata 变化使用同一 entry comparator 的三个原因，resolver/S0b/tool execution 三方一致，已有 snapshot/receipt/inherited digest 字节不变；frozen-only 工具被 provider 请求过滤且不能执行，cwd root 设置变化但 stored path 仍有效均不得误拒绝 |
| S0a | `runtime-source census distinguishes actual writes proven absence and missing evidence`：实际写入全部有可核对来源，正式未执行不冒充历史，NULL 不猜前置格式；stored 续聊证据、自洽与本机来源 reachability 同时覆盖 |
| S0b | `production continuation preflight classifies every active head`：复用正式候选生产者和 C6 reducer，14 个 head 每项有结论；不得由 SQL/测试 helper 重写当前算法或把未执行写成 ready |
| G1 | `release source inventory requires complete scoped target coverage`：发布记录先枚举；删除来源/边、错误降为 retired、旧 target、unverified、伪 unsupported、证书缺失均使构建失败；支持集合及其已开放操作不能静默消失，真正 audit-only 来源不制造无用户的阻断 |
| P1 | `only genuinely empty roots refresh automatically`：两个严格空白类别及恢复后尚未发送的空根通过；失败消息/start intent/当前历史 tail 的反例拒绝自动刷新；原 boundary 保持且不重复创建 |
| R1 | `history-only is a durable read result not transient failure`：alias null 可读出明确动作；重复读取不写库、不编 generation；closed 不复活 |
| R2 | `begin-new-context commits one boundary and one head`：双击、响应丢失、重启重放、与 reset/close 并发只有一个合法结果；失败全回滚 |
| R3 | `context boundary preserves visible history and rejects old authority`：同一个 fixture、同一条真实 boundary 同时驱动时间线、Main 当前写入准入、索引/召回三方断言；旧消息/索引/新草稿保持，旧效果与迟到状态零当前写入、旧 Retry 零执行 |
| R4 | `new context cannot silently reacquire earlier conversation`：自动 recall/skill hints 不跨断点；显式引用走资源；长期记忆仍按独立设置 |
| M1 | `boundary migration preserves populated 118 and 119 databases`：fresh/upgraded schema parity、历史值不变、事务回滚、重复启动幂等 |
| I1 | `installed populated upgrade continues the existing native thread without reset`：真实旧库样本，经 UI 新输入、正式发送、终态、下一轮、重启；threadId 与旧 messages 保持 |
| I2 | `installed recovery persists a visible context boundary`：history-only/不支持类别显式恢复，新 thread 确实无隐式旧上下文；关闭重开后断点与可见历史一致 |

I1 还要用本地替身核对模型实际收到旧上下文中的随机标记，而非仅检查 threadId 和消息数量；连续两轮确保新用户输入恰好一次、旧工具效果零重放。真实历史内容不输出到公开报告，保留去隐私计数/摘要证据。

### 9.3 必跑门与证据范围

`verify:history-continuation` 已实现，聚焦行为/资产门与 Electron ABI 持久化测试按 `package.json` 执行；S0a/S0b 的真实旧数据普查、生产预检与模型请求核对由独立安装脚本执行，不能把单元命令说成已跑过真实数据。专项门进入两种 Packer 发布路径；基础门包括：

```bash
npm run typecheck
npm run verify:native
npm run verify:codex-runtime-source
npm run verify:version
```

专项还需覆盖现有 `codex-pristine-head-refresh-native`、`codex-binding-repository-native`、`codex-action-surface-event-bridge`、`codex-lifecycle-action-surface`、`codex-renderer-admission-contract`、`chat-panel-baseline`、`chat-input-authorization-mode`、`composer-authority` 等相关测试。gate 有历史失败时先核对基线，不恢复退役行为求绿；与本批路径相关的失败必须解决。

`scripts/run-history-continuation-installed-proof.mjs` 承担 I1/I2：逐一执行所有 ready+started head 的三轮，以及全部生产签发的恢复目标和 history-only 样本的边界/重启；另外制造真实首轮失败，验证 fresh-root 尾项恢复成功后再次重启和普通下一轮。模型请求由真实 runtime 生成，本地服务只响应/记录请求。既有 `run-codex-context-continuity-installed-proof.mjs` 保留失败轮、fork、精确 Retry、旧效果与 reset 的补充验收。源码身份在编译前产生，包内构建记录、DMG 回执和安装记录必须一致；未执行的场景不算通过。

## 10. 分批施工顺序与文件归属

| 批次 | 范围 | 进入下一批的条件 |
| --- | --- | --- |
| S0 | 复审本合同；S0a 已查历史来源/stored 证据及 7/3/1 frozen surface 分布；建立但不接管 action/admission 的无写入判断与 `ContinuationProbeInputV1` 候选入口；从真实发布记录建立 source 种子，完成原生候选证书与非 runtime 预分类 | S0a 已通过；每个 head 必须有匿名的 stored/current 非 runtime 结果，runtime transition 在 Ready 正式链通过前仍是 unverified。任何意外严格差异先按 §4.2 定性/修订；不得用一个全局 tool digest 算匹配数，发布范围与本机 reachability 分开记录 |
| S1 | 草稿 revision、composer 共享规则、原因呈现、量具 | E1–E3；只证明编辑恢复；9 个 history-only 会话仍没有恢复操作，不宣称发送恢复 |
| S2 | 统一刷新与停止意图恢复 | A1–A2，无新轮询/旧授权捷径 |
| S3 | 将唯一 runtime 判断与同 thread reducer 接入全部准入消费者；完成 §4.1 seal/跨版本比较、pristine 空白处理及隔离 Ready 正式探测；两层证明通过后才发布 transition 并复跑最终 S0b/G1 | C1–C7/G1/P1；最终 S0b 记录的每个 `ready_same_thread` head 均完成连续两轮和重启，记录的每个新上下文原因均进入 I2/S4，不得在此改分母；9 个 history-only 会话仍等待 S4 |
| S4 | history-only 联合、生命周期恢复、boundary 持久化与所有消费方 | R1–R4/M1，重复/并发/迟到与重启通过 |
| S5 | 统一权威文档、专项 gate、打包与独立复审 | I1/I2；范围内无未关闭问题，安装证据与提交对应 |

这些是工程批次，不是六次面向用户的“修复完成”发布。S1–S3 可在隔离开发环境验收，不能自动覆盖用户安装，不能把 9 个 history-only 会话的“原因更准确”宣称为恢复完成。中间构建如用于明确的开发验证，界面只陈述当前事实：“此会话暂时不能继续发送，历史记录已保留”；未完成状态及后续 S4 责任写入该批验收记录，不把“后续批次提供”这类开发安排或虚假承诺放进产品操作流程。正式整体交付在 S4/S5 全部通过后进行。

主要现有入口：

- Renderer：`ChatPanel.tsx`、`ChatInput.tsx`、`chat-panel/ChatPanelBody.tsx`、`ChatHeader.tsx`；`stores/useAgent.ts`、`agent-send-orchestration.ts`、草稿/附件 store；`runtime-driver-scope-events.ts`、`runtime-driver-canonical-terminal.ts`、`agent-panel-test-harness-snapshot.ts`。
- 合同边界：`src/shared/ipc-contracts/agent-runtime.ts`、`agent-lifecycle-snapshot.ts`、相应 Main IPC registration、Preload API 与 Renderer 类型必须同步，不新增只在一层存在的动作。
- Main：`codex-runtime-production-composition.ts`、`codex-binding-repository.ts`、`codex-action-surface.ts`、`codex-lifecycle-action-surface.ts`、`ready-codex-lifecycle-adapter.ts`、`codex-product-lifecycle-store.ts`、`runtime-core/conversation-scope-store.ts`；§4.2 的候选生产/比较放独立小模块并由这些入口共享；归档复用 `codex-thread-archive-owner`。
- 数据/效果：`codex-binding-schema.ts`、`migrations.ts`、现有 product visibility/closeout/tool-effect identity、session recall 消费方；禁止把 boundary 校验只落在 Renderer。
- 包体：`electron-builder.yml` 显式将新 `assets/runtime-continuity` 打到 `Resources/runtime-continuity`；核对 `Packer/pack-clean-release.mjs` 生成的 clean 配置仍包含它。开发/安装各自只有一个明确资产路径，不做用户目录 fallback；安装证明读取实际包中文件并核对身份。
- 新增限制：runtime 操作兼容与同 thread 全合同比较各只有一个纯入口；另有发布证据资产及其无兼容状态的来源清单、一个共享 composer 推导、一个恢复事务模块和一张必要的 boundary 表。可放同一小模块时不人为拆包，新模块只因明确职责或大文件拆分，不先造框架。

净增代码的原文件若超过 1000 行，按项目规则更新 large-file health log；恢复/兼容新逻辑优先放独立小模块，禁止继续把所有实现堆进 repository/composition。迁移与 SQL 定义只有一个来源。

## 11. 权威文档替换范围

批准实施时必须同批更新，不能仅在本文件末尾补一段与旧条款并存：

- 原 2026-09-01 计划第 306/726/941/1249 行：完整 runtime 摘要不等不再直接要求 reset，改为 §3–4 当前操作兼容合同；pristine 范围改为 §6。
- 原计划第 536/583/728/1246 行：保留已启动 legacy ordinary continuation 与其无 coverage/fork 权限的边界，补“在当前操作兼容已获证明时”。
- 原计划 §15 “无 active head 只能 reset / 不提供恢复”部分：由 §7 显式保留可见历史的恢复替代；不恢复通用空 generation fallback。
- `docs/architecture/current-runtime-contracts.md` §2：更新版本兼容、history-only、边界写入与可见历史关系、草稿/发送/Stop 的消费权威。
- 原 Revision 4 提案的 I-5/I-6 与已交付审计：增加指向本计划的修正说明，保留过去实际通过范围；不能改写过去记录伪装当时已测。
- 版本如有改变同步 package/lockfile/changelog；根 AGENTS/CLAUDE 只在规则真实变化时同步简短入口，不回填阶段长合同。

## 12. 给独立复审者的必答问题

1. 是否仍有任何源/当前整包摘要比较在运行准入中绕过唯一兼容结论？tool preflight 是否真的使用 current subset 对每个 head 自己的 frozen surface，而非一个全局摘要？`5240/5257/5263/5290+` 是否都与 §4.2 同结果？是否误删了历史自洽校验？
2. 证据缺失、相同 schema、不同 schema、只读成功能否错误开放新输入/fork？发布支持集合是否从真实发布证据和 active reachability 推导，还是被一台机器的退役记录误扩/误缩？
3. inherited digest v1 及所有旧引用是否原样可读？真实 e2/native-fork 升级样本是否覆盖？
4. 每个新增字段是否有正式消费方？tool entry 内部 metadata 是否沿工具桥、行动身份和回执完整消费，旧 snapshot 是否保持原值？是否出现 UI gate、Main admission、生命周期或量具各自正确但组合矛盾？
5. 可编辑性恢复后，晚到 admission、成功、失败、停止是否可能误清新草稿或附件？
6. 无 active head 的动作由谁拥有？恢复与 reset/close/重复请求的 CAS、幂等和响应未知是否完整？
7. 同 epoch 保留历史后，旧状态/效果/Retry/召回是否能跨 boundary 污染新上下文？显示断点是否与 Main 读取同一事实？
8. 读取失败时是否仍能表达精确停止意图？再次失败、旧终态和换代是否可能误停新任务？
9. S0b 是否先逐项分类 14 个 head？七个首要旧 head 是否经正式入口完成不 reset 的连续两轮和重启，还是在 S3 才因另一道门缩小了分母？旧格式其它类别是否有诚实且可执行的结果？
10. 是否为了过审新增长期 fallback、重复账本、无界重读、广泛字段分类或无证的自动兼容？若有，更小的实现是什么？

复审意见须列触发条件、实际生产消费者、反例和关闭证据。Revision 6 已通过开工前 S0 合同审查；完整施工仍须在安装验收后重新接受独立对抗审查。

## 13. Revision 6 开工前审查历史（非当前施工状态）

| 意见 | 处理 | 证据/状态 |
| --- | --- | --- |
| F1 P1 | 采纳先普查；修正“NULL 就是后加字段缺失”的推断 | §2、§9.0；真实私有只读副本逐 head/turn 结果已产出。首要七个无缺口，1 个 NULL 为正式未执行。只完成来源可行性，非发送验收 |
| F2 P1 | 采纳入库来源清单与发布失败门，并防止同时删清单/边规避检查 | §3.4、G1、§9.3；已观察 6 个 source，4 个定位到完整 Git manifest，2 个来源资产仍待取证；正式发布不得静默遗漏。生产 gate 尚未实施 |
| F3 P1 | 采纳新 seal 取值和跨版本比较必须写清；保留真正的历史自洽与 native-fork source/target 一致性 | §4.1、C5；fresh_root_with_tail 单独的 reseed 能力；算法/历史原值不改，当前实际执行身份不伪装。生产修复与原生测试尚未执行 |
| F4 P2 | 采纳明确中间态，阻止阶段结果被当作完整用户交付 | §10；S1–S3 的 9 个会话仍未恢复，不能覆盖正式安装或声称已修好；产品文案不承诺开发批次 |
| F5 P1 | 采纳同 thread 不止 runtime 一道门；拒绝让 SQL 脚本复制当前生产算法 | §4 消费表、§4.2、§9.0、C6/C7/S0b；S0a 已证明 11/11 started head 的 stored 侧完整，当前候选逐项比较仍须由生产预检执行，七个首要 head 的最终可行数量仍为未知 |
| F6 P2 | 采纳发布清单以发布记录为种子，再由真实包/安装证据确认 | §3.4/G1；tag、CHANGELOG 只枚举候选，不自行升级为已发布；现场观察只补充，不能代表全量发布史 |
| F7 P2 | 部分采纳并收窄推论 | §3.4/S0a；两个未定位来源在本机确实仅退役/旧 ingress，不阻塞本机 active-head 预检。是否免除全局边取决于发布种子和支持语料，不能用一台机器证明所有用户均不可达 |
| F8 P1 | 采纳逐 head 先测和显式产品边界；否决“3 个 stored digest ⇒ current 最多匹配一组”的推论 | §1、§2、§4.2、§9.0/§9.1、C6、§10；existing thread 的正式候选保留自身 frozen surface，只核对本轮 current subset。S0b 仍须把实际数量写回后才开工，当前不填 0/7 猜测 |
| F9 P2 | 采纳模型可见变化与 Ready 执行元数据变化分名；否决覆盖 snapshot 的 CAS 修法 | §4 消费表、§4.2、C7；entries 被工具桥、行动身份、binding/receipt 和 inherited digest 正式消费，且已有 snapshot 不可变。当前实现不能履行旧 frozen entry 时走具名恢复；未来支持也必须保留旧 snapshot 并另证执行兼容 |
| F10 P2 | 采纳单向包含的产品后果、S0b 差异来源和独立协议探测边界；收窄“所有新增工具永久终结所有会话” | §1、§4.2、§5.1、§7.1、§9.0、C7、§10；新增 current entry、同名模型合同变化、Ready metadata 变化分别统计。frozen-only 不阻断且 provider 只见 allowed subset；只有进入某轮 resolved surface 的新增工具才影响该 head。S3 分母只取 S0b 写回数，不再写固定七个 |
| S0-R1 P0 | 拆开原生候选、生产接入、Ready 实证与 transition 发布 | §9.1、§10；S3 完成正式链证明后才发布 compatible 并复跑 S0b/G1，无循环旁路 |
| S0-R2 P0 | 精确 prepare 拒绝返回 Main 签发且与草稿/候选绑定的恢复 ref | §4.2、§7；继续使用同一恢复事务，不新增第二个判断入口 |
| S0-R3 P0 | 删除 `TaskPanel` 第二个 composer；会话唯一拥有文本、附件、文件池和 revision | §5.2、§8；旧文本回填与跨会话附件清空一起删除 |
| S0-R4 P1/P2 | 动作读保持纯读；boundary 只表达语义/审计；清除真实存在的隐式 skill hint；删除重复清理布尔 | §7.1、§7.3、§8；不新增第二套 current-write 权威或无消费者防线 |
| 小修正 | 停止目标来源直接交叉引用；ChatInput/harness 同一纯函数；三方同时消费同一 boundary fixture；S0a/S0b 均进入专项回归 | §5.1、§8、E3/R3/S0a/S0b、§9.3 |

本轮只读普查脚本不是未来完整兼容 reducer：它增加了 stored 续聊证据、7/3/1 frozen surface 分布与本机来源 reachability，没有生成当前 profile/tool/instruction 候选，也没有执行 native readback、fork/compaction fixture 或修改生产行为。下一轮复审应重点核对 §4.2 是否准确复用了“本轮完整 resolved surface → per-head frozen surface 的单向包含 → allowed subset provider 过滤 → loaded admission → tool execution”的真实链路，以及 §3.4 的发布支持集合是否既不会漏掉真实发布来源，也不会被退役开发账目永久卡住。不得把文档修订、stored 11/11、三组摘要或来源计数当作发送已通过。
