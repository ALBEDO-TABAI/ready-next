---
name: okf-bundle
description: 把"指定范围"的资料/文件提炼成一个符合 Google OKF（Open Knowledge Format v0.1）规范的知识包（knowledge bundle），并登记到工作区母题索引。当用户说"把这些资料整理成知识包/知识库"、"从这个文件夹（或这批文件/这些上传）里提取知识"、"做一个 OKF 知识包"、"沉淀这个项目积累的知识"、"把项目过程文档归档成可复用的结构化知识"、"okf bundle"、"建知识包"、"knowledge bundle"，或给出一批资料希望沉淀为可被 Agent 读取、可被检索、可被复用的结构化知识时触发——即使只说"帮我把这堆文档归档成知识库"也要用。本 skill 负责"单个范围 → 单个知识包"。若用户要盘点/合并工作区里的所有知识包、做知识库治理，请改用 okf-library。
compatibility: 需要 bash + Python 3 与 PyYAML（pip install pyyaml --break-system-packages）。
---

# OKF Bundle（子）— 从一个范围提炼一个知识包

把一段**被明确圈定的资料**读懂，抽取其中**稳定、可复用、值得长期沉淀**的知识，产出**一个**符合 OKF v0.1 的知识包，并在工作区母题索引里登记它。你是"生产者（producer）"。

## 做什么 / 不做什么
- **做**：单个范围（一个文件夹 / 一批文件 / 一个 glob / 一组上传）→ 一个 conformant 知识包 + 登记到 `OKF-INDEX.md`。
- **不做**：跨整个工作区的盘点、去重、合并、重组——那是 `okf-library` 的事。如果用户的诉求是"把现有的好多包理一理/并一并"，停下并指出应使用 okf-library。
- **Ready 执行要求**：只要用户给了明确文件夹/文件范围，就必须实际创建知识包文件夹并写入 `.md` 文件；不得只在聊天中输出"知识提取结果"或分析总结。完成前必须跑 `scripts/okf_tools.py validate`，并把最终目录路径报告给用户。

## 第一步永远是读规范
动手写任何文件前，先读 `references/okf-spec.md`。务必内化三件最容易被网上图解带偏的事：
1. **只有 `type` 必填**。不要发明 `id / domain / status / version / created / updated` 等字段（`id` 来自文件路径；想加团队字段是可以的，但要清楚那是扩展，不是规范）。
2. **保留文件只有两个**：`index.md`、`log.md`。**不要**用 `README.md`、`索引.md`、`关系/`、`证据/` 这类结构——关系是**包内 Markdown 链接**，证据是正文里的 `# Citations`。
3. **`type` 要描述性**（`Metric`/`Playbook`/`Table`…），别一律写 `concept`。

## 工作流

### 1. 锁定范围（scope）
把"指定范围"落实为一个明确的文件清单。来源可能是：某个目录、用户列举的文件、一个 glob、或本次上传（`/mnt/user-data/uploads`）。范围若含糊（如"项目里的资料"指向不清），先确认再开工。**来源是只读输入**，不要改动它们。

### 2. 读懂来源
按文件类型用对的方式读：非纯文本（pdf/docx/xlsx/图片/压缩包）先看是否有对应的 reading skill（如 file-reading / pdf-reading）并据其处理；纯文本直接读。先做一次"有什么"的盘点：有哪些主题、哪些是稳定知识、哪些只是过程性噪音。

### 3. 切概念 + 定 type 词表（核心判断）
这一步决定知识包的质量。
- **切概念**：每个概念 = 一个**自洽**的知识单元（一张表、一个指标、一个 API、一段流程、一个决策、一个术语、一个 Runbook、一份规范要点…）。粒度以"能被独立引用与复用"为准。
- **定 type 词表**：先给这个包列一份**小而描述性**的 `type` 清单（OKF 的 type 由生产者自定）。把它写进报告，作为这个包的局部约定。（这呼应了"先做 type 清单"的落地建议——但注意它是**团队约定**，不是规范强制。）
- **挑值得沉淀的**：优先抽取**相对稳定、跨团队可复用、对准确性要求高**的知识；过程性闲聊、临时状态不入包。

### 4. 写概念文件
每个概念一个 `.md`，放在按 type/主题划分的子目录里。frontmatter 至少 `type`，并尽量补 `title / description /（resource）/ tags / timestamp`；正文**优先用结构化 Markdown**（标题、表、列表、代码块），适用时用约定小标题 `# Schema` / `# Examples` / `# Citations`。模板见 `references/templates.md`。

### 5. 连关系（构图）
在概念正文里用**包内相对链接**（以 `/` 开头，相对包根）把相关概念连起来，关系的性质用**周围文字**说清。这把扁平目录变成一张知识图。坏链允许存在（代表"尚未写的知识"）。

### 6. 留证据 + 记出处（provenance）
凡是来自来源材料的论断，在文末 `# Citations` 编号列出来源（链接到原文件路径或 URL）。强烈建议在每个概念的 frontmatter 里加一个**扩展键 `source:`** 记录它来自哪个源文件/位置——这对后续 library 复核与合并极其有用。若某外部文档是多个概念的共同依据，可在 `references/<slug>.md` 把它镜像成一个 `type: Reference` 概念。

### 7. 生成 index.md 与 log.md
- 给包根和每个子目录写 `index.md`（渐进式披露）。**包根 index.md 的 frontmatter 写 `okf_version: "0.1"`**——它同时充当知识包标记，让扫描可靠识别。
- 给包根写 `log.md`，加一条 `## YYYY-MM-DD` 初始化记录：从哪个范围提炼、建了什么结构、共多少概念、哪些待人审。

### 8. 校验合规（必做）
```bash
python <skill>/scripts/okf_tools.py validate <bundle-dir> --verbose
```
必须做到 `CONFORMANT`（无 ERROR）。warning（如坏链）按需处理。修掉一切 `missing or empty required type`、`missing YAML frontmatter` 类错误。

### 9. 登记到母题索引
确定工作区根、暂存目录（staging，本包所在）、受控目录（canonical）这三处位置（首次可与用户确认；默认 staging=`knowledge/`、canonical=`knowledge-base/`、索引=`<root>/OKF-INDEX.md`）。然后：
```bash
python <skill>/scripts/okf_tools.py index <workspace-root> --out <root>/OKF-INDEX.md \
    --staging <staging-dir> --canonical <canonical-dir>
```
它会扫描并把本包加入 `OKF-INDEX.md`。接着在文件末尾 `<!-- OKF-INDEX-DATA … -->` 的 JSON 块里，为本包补上有意义的 `theme`（母题）/ `status`（一般为 `draft` 或 `review`）/ `note`，再重跑一次 `index` 固化。`OKF-INDEX.md`（大写）是工作区级治理索引，**不是** OKF 包内的 `index.md`。

### 10. 报告
向用户交付一份简报（见下）。把**不确定、需人工确认**的高价值概念单独列出——关键定义、归属/Owner、边界，这些应由人确认，而不是默认正确。

## 人审与边界
- **高价值概念要人审**：核心定义、口径、归属、边界，标注"待确认"，给出你的判断依据，让人拍板。
- **OKF 不管权限**：知识包只是知识，访问控制/账号/审计仍靠外部系统。**不要**把密钥、凭据、个人隐私写进概念；遇到则脱敏并只保留引用。
- **不照搬版权原文**：来源若是受版权材料，做摘要与要点 + 引用链接，不整篇复制。

## 报告格式
```
## 知识包：<名称> （<路径>）
- 来源范围：<圈定的文件/目录>
- type 词表：<本包用到的 type 列表>
- 概念：<N> 个；关系链接：<M> 条
- 合规：CONFORMANT ✅ / 待修 ⚠️（列出）
- 已登记到母题索引：<OKF-INDEX.md 路径>，母题=<theme>，状态=<status>

### 待人审（高价值/不确定）
- <概念> — <为何需确认 + 你的初判>

### 缺口与建议
- <来源里没覆盖、或建议后续补充的点>
```

## 资源
- `references/okf-spec.md` — OKF v0.1 规范要点（**先读**）。
- `references/templates.md` — 概念 / index / log / 索引条目 / Reference 镜像 的可套用骨架。
- `scripts/okf_tools.py` — `validate`（校验单包）、`index`（生成/更新母题索引）、`scan`（盘点，主要给 library 用）。
