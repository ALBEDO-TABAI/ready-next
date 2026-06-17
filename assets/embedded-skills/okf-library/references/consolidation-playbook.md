# 归并治理手册（consolidation playbook）

> okf-library 在"评估 → 规划 → 执行"阶段的具体方法。目标是把零散、暂存的知识包，归整进一个**收拢受控**的知识库（canonical），并让跨包的新知识**涌现**出来。规范细节见 `references/okf-spec.md`。

## 受控（canonical）意味着什么
受控知识库不是"又一个堆放处"，而是有治理纪律的单一权威库：
1. **单一 type 词表**：整个 canonical 库用一套一致、描述性的 `type`（把 staging 里五花八门的 type 收敛对齐）。
2. **始终合规**：每次写完都 `okf_tools.py validate`，保持 CONFORMANT。
3. **有日志**：合并/提升/弃用都写进相应 `log.md`（`YYYY-MM-DD`，最新在前），形成审计轨迹。
4. **变更需确认**：动结构、并概念、改口径前先把计划交用户拍板。
5. **不静默删除**：被取代的 staging 包标 `superseded` 并在日志注明，由用户决定何时清理；canonical 内删除概念要在 log 记 `**Deprecation**`。
6. **链接稳定**：canonical 内一律用包内绝对链接（`/…`），移动文件后仍可用。

## 第一步：盘点与对账（locate + reconcile）
索引是缓存，**磁盘才是事实**。
1. 读 `OKF-INDEX.md`（人工维护的母题/状态/备注在末尾 JSON 块里）。
2. 跑 `okf_tools.py scan <root> --canonical <c> --staging <s>` 拿到地面真值（每个包的 type 直方图、概念数、tags、时间戳、合规、所属 zone）。
3. **对账**：索引有而磁盘无 → 进 `Missing`，提示用户（移动/合并/删了？）；磁盘有而索引无 → 是漏登记的新包，纳入。`okf_tools.py index` 会自动完成这层合并并保留人工字段。

## 第二步：看清版图（assess）
基于 scan 输出 + 抽读各包 `index.md` 和关键概念，识别四类信号：
- **重复（duplicate）**：同一概念在多个包里各写一份（如两个包都定义"订单"）。
- **冲突（conflict）**：同一概念事实/口径互相矛盾（如 WAU 一个按 7 天一个按 30 天）。
- **重叠/割裂（overlap）**：同一母题被拆在多个范围里分别提炼（项目分阶段各做了一个包）。
- **缺口（gap）**：关系链接频繁指向不存在的概念，或某主题明显缺一块。

判定"重复/同一概念"的启发式：`title`/Concept ID 高度相近、`resource` 指向同一资产、正文 Schema 或定义实质相同。不要只看文件名，要看内容。

## 第三步：定计划（plan）—— 四种动作
对每一处信号，选一种动作并写进计划：
- **Promote（直接提升）**：高质量、无冲突的包，原样搬进 canonical（必要时只调整目录/ type 命名以对齐词表）。
- **Merge（合并）**：同母题的多个包并成一个；同一概念的多份并成**一个权威概念**——
  - 取信息最全、最新、引用最足的为基底；
  - **保留所有出处与 Citations**（合并不能丢证据）；把各源的 `source:` 出处汇总；
  - 其余位置可留一个薄"指针概念"或直接重定向链接到权威概念。
- **Reconcile conflict（消解冲突）**：能判定对错就采纳正确口径并在正文显著标注被纠正项；判不了就在概念里并列两种口径、标注分歧与各自来源，列入"待人审"。**不要**悄悄抹掉矛盾。
- **Deprecate（弃用）**：过时知识标记弃用并在 log 记 `**Deprecation**`，保留可追溯。

## 第四步：让新知识涌现（emergence）
有些知识**只有跨包才看得见**，把它们合成为 canonical 里的**新概念/新包**：
- **统一术语表（Glossary）**：把散落各包的术语收成一个 `type: Term` 集合。
- **架构/全景图（Overview）**：用一个概念串起多个包的关系，正文用包内链接画出"从入口到运行"的链路。
- **归属/Owner 地图**：谁负责哪块知识/资产。
- **关系总览**：把高频跨包链接显式成一张关系概念，便于检索与构图。
涌现概念同样要带 `# Citations`，指向其综合所依据的下层概念（用包内链接即可）。

## 第五步：执行进 canonical（execute）
1. 在 canonical 目录下落地 Promote/Merge/Emergence 的结果，套用统一 type 词表与目录结构。
2. 每个 canonical 包写/更包根 `index.md`（带 `okf_version`）与子目录 `index.md`；在 `log.md` 记本次动作（来自哪些 staging 包、并了什么、消解了什么冲突）。
3. 需要"重新从原始资料干净提炼"某范围时，**调用 okf-bundle skill**（读它的 SKILL.md 并按其工作流产出一个新包到 canonical），而不是自己临时拼。
4. `okf_tools.py validate <canonical-bundle>` 必须 CONFORMANT。

## 第六步：更新母题索引（reindex）
```bash
python <skill>/scripts/okf_tools.py index <root> --out <root>/OKF-INDEX.md \
    --canonical <canonical-dir> --staging <staging-dir>
```
在末尾 JSON 块里更新状态：被并入 canonical 的 staging 包标 `superseded`（并在 `note` 写"已并入 <canonical 包>"）；canonical 包标 `canonical`。重跑 `index` 固化。

## 治理纪律小结（每轮自检）
- [ ] 索引与磁盘已对账，Missing 已向用户说明
- [ ] 计划已交用户确认后才动手
- [ ] 合并未丢任何 Citations / 出处
- [ ] 冲突已显式处理（采纳或并列），未被悄悄抹掉
- [ ] canonical 全部 CONFORMANT、单一 type 词表
- [ ] 所有动作已写入 log.md（含 Deprecation）
- [ ] 未静默删除任何 staging 包（只标 superseded）
- [ ] 母题索引已重建
