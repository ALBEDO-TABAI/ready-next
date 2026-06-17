---
name: okf-library
description: 定期盘点整个工作区里的所有 OKF 知识包（knowledge bundle）——通过母题索引（OKF-INDEX.md）+ 全盘扫描定位它们，再归并去重、重新归纳、并涌现新的跨包知识包，沉淀进一个更收拢受控（canonical）的知识库目录。当用户说"盘点一下工作区有哪些知识包"、"整理/合并现有的知识库"、"把零散的知识包归整到受控知识库"、"重新归纳整理这些 OKF 知识包"、"更新母题索引"、"看看知识库里有什么重复/冲突/缺口"、"做一次知识库治理"、"okf library"时触发——即使只说"帮我把这些知识包理一理/并一并"也要用。本 skill 负责"工作区级"的盘点与治理；若只是把某一批新资料提炼成单个知识包，请改用 okf-bundle（本 skill 在需要重新提炼某范围时会调用它）。
compatibility: 需要 bash + Python 3 与 PyYAML（pip install pyyaml --break-system-packages）。
---

# OKF Library（母）— 盘点工作区、收拢进受控知识库

定期把工作区里**零散、暂存**的 OKF 知识包，盘点清楚，然后归并、重组、并让跨包新知识涌现，沉淀进一个**收拢受控**的知识库。你是知识库的"治理者 · 馆长（librarian）"，对应"消费者/治理"那一端。

## 做什么 / 不做什么
- **做**：定位工作区**所有**知识包 → 评估（重复/冲突/重叠/缺口）→ 归并/提升/消解/涌现 → 写进受控目录（canonical）→ 重建母题索引。
- **不做**：从零把某一批原始资料提炼成单个包——那是 `okf-bundle`。本 skill 需要"干净重提炼某范围"时会**调用** okf-bundle。
- **不激进**：受控库是要被长期信赖的，**不**每轮都大改。做**有节制、可复核**的变更。

## 先读规范与治理纪律
动手前先读 `references/okf-spec.md`（OKF v0.1 要点）与 `references/consolidation-playbook.md`（归并方法与治理自检）。把握底线：**索引是缓存、磁盘是事实**；**变更先让用户确认**；**合并不丢证据、冲突不悄悄抹**；**不静默删除**（只标 `superseded`）。

## 约定的工作区结构（首次可与用户确认）
默认三处位置，可被用户覆盖；它们记录在 `OKF-INDEX.md` 头部：
- **staging**（暂存）：项目过程中 okf-bundle 产出的零散包，默认 `knowledge/`。
- **canonical**（受控）：本 skill 维护的单一权威知识库，默认 `knowledge-base/`。
- **母题索引**：默认 `<workspace-root>/OKF-INDEX.md`（大写，刻意区别于 OKF 包内保留的小写 `index.md`，不会被误认成包内目录）。

## 工作流

### 1. 定位 + 对账（locate + reconcile）
```bash
python <skill>/scripts/okf_tools.py scan <workspace-root> \
    --canonical <canonical-dir> --staging <staging-dir>
```
读已有 `OKF-INDEX.md`（人工字段在末尾 `<!-- OKF-INDEX-DATA … -->` JSON 块），与 scan 的地面真值对账：索引有而磁盘无 → Missing（提示用户）；磁盘有而索引无 → 漏登记的新包，纳入。这一步先把"工作区到底有哪些包、各自状态如何"摸清。

### 2. 评估版图（assess）
基于 scan 输出（type 直方图、概念数、tags、时间戳、合规、zone）+ 抽读各包 `index.md` 与关键概念，识别四类信号：**重复 / 冲突 / 重叠割裂 / 缺口**。判定方法见 playbook（看内容而非仅看文件名）。

### 3. 定计划（plan）
对每处信号选一种动作：**Promote**（高质量无冲突，原样提升进 canonical）/ **Merge**（同母题或同概念合并为权威版，保留全部出处与 Citations）/ **Reconcile**（消解冲突：采纳正确口径并标注，或并列分歧列入待人审）/ **Deprecate**（过时知识标弃用，保留可追溯）。同时规划**涌现**：术语表、架构全景、归属地图、关系总览等只有跨包才显现的新概念/新包。

### 4. 交用户确认（confirm）
把计划讲清楚再动手：要并哪些、要消解哪些冲突、要新增哪些涌现包、staging 里哪些会被标 superseded。这是有后果的治理动作，**先拿到拍板**。

### 5. 执行进 canonical（execute）
按计划在 canonical 目录落地：套用**单一、描述性的 type 词表**与一致目录结构；写/更包根 `index.md`（带 `okf_version`）与子目录 `index.md`；在 `log.md` 记本轮动作（来自哪些 staging 包、并了什么、消解了什么）。需要从原始资料**干净重提炼**某范围时，**调用 okf-bundle skill**（读其 SKILL.md 并按其工作流产出一个新包到 canonical）。每个 canonical 包写完即校验：
```bash
python <skill>/scripts/okf_tools.py validate <canonical-bundle> --verbose   # 须 CONFORMANT
```

### 6. 重建母题索引（reindex）
```bash
python <skill>/scripts/okf_tools.py index <workspace-root> --out <root>/OKF-INDEX.md \
    --canonical <canonical-dir> --staging <staging-dir>
```
在末尾 JSON 块更新状态：并入 canonical 的 staging 包标 `superseded`（`note` 写"已并入 <canonical 包>"）；canonical 包标 `canonical`。重跑 `index` 固化。

### 7. 报告（report）
见下。明确列出**仍需人工决策**的事项（无法自动消解的冲突、归属未定、建议删除项）。

## 安全与边界
- **OKF 不管权限**：知识库只是知识，访问控制/账号/审计仍靠外部系统。合并迁移时不要把密钥/凭据/隐私带进 canonical；遇到则脱敏并只留引用。
- **保留可追溯**：合并保 Citations，弃用记日志，删除走 Deprecation；canonical 优先放进 git 以获得 diff 与历史。
- **不照搬版权原文**：镜像外部来源时只做摘要要点 + 引用链接。

## 报告格式
```
## 知识库治理报告 @ <date>
- 工作区：<root>（staging=<…>，canonical=<…>）
- 盘点：staging <a> 包 / canonical <b> 包；对账发现 Missing <m> 个
- 本轮动作：Promote <…> / Merge <…> / Reconcile <…> / Deprecate <…>
- 涌现新包：<术语表 / 架构全景 / …>
- canonical 合规：全部 CONFORMANT ✅（或列出待修）
- 母题索引已重建：<OKF-INDEX.md 路径>

### 仍需人工决策
- <未能自动消解的冲突 / 归属未定 / 建议删除的 superseded 包>
```

## 资源
- `references/okf-spec.md` — OKF v0.1 规范要点（**先读**）。
- `references/consolidation-playbook.md` — 去重/合并/冲突/涌现的具体方法 + 每轮治理自检清单。
- `scripts/okf_tools.py` — `scan`（盘点工作区）、`validate`（校验单包）、`index`（生成/重建母题索引）。
