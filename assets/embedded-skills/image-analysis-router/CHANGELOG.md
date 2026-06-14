# Changelog / 更新日志

本文件记录 image-analysis-router 的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号与 `references/routes.json` 的 `version` 字段保持一致。

## [2.0.0] - 2026-06-12

本次为一次系统性重构与修复：路由数据全部声明化、新增 `ui-product` 路由、修复多个实测确认的误路由 / 误判 bug、补齐 eval 盲区，并精简文档阅读链（默认每次运行少读约 200 行参考文档）。

### 新增

- **`ui-product` 路由（第 18 条）**：App 界面、网页应用、设置页、表单、引导流程、空/加载/错误态、设计稿（Figma/Sketch）。包含 `references/method-ui-product.md`（8 个分析 lens，吸收原 "UI Screenshot Handling" 临时段落的四个维度并扩展状态清晰度与可达性韧性）、route-matrix 行与 4 条 tie-breaker、routes.json 关键词 / 文件名模式 / goal 规则。
- **`--source-url` 真正生效**：URL 计入视觉证据，basename 参与文件名打分；URL-only 请求不再被判 `visual_input_missing`。
- **视觉扩展名补齐**：`.svg` / `.pdf` / `.avif` / `.jxl`。
- **`router_unavailable` 降级状态**：routes.json 缺失或损坏时输出结构化 JSON（`--strict-exit` 下 exit code 13）而非 import 崩溃；SKILL.md 与 route-matrix 状态门均写明处理方式（转入纯视觉路由）。
- **深度覆盖通道**：SKILL.md 第 9 步将 `response_depth` 定义为"默认值而非判决"，允许模型覆盖并以 `depth_override` 记录在 `处理说明` 中。
- **英文深浅线索**：DEEP/QUICK 线索补齐英文（in-depth、detailed、deep dive、quick look、tl;dr 等）。
- **输出语言约定**：output-contract 新增 Language 节——报告正文与标题跟随用户语言，路由名 / 状态值等机器标识保留英文。
- **样例报告骨架**：examples.md 末尾新增 standard 深度的金标准报告骨架，从 output-contract 链接，不进默认阅读链。
- **18 条新 eval（21 → 39）**：18 条路由全覆盖（原缺 interior-design、comics-sequential、fashion-styling、sculpture-installation-craft、film-frame）；8 个实测失败案例固化为对抗性 eval；补 versioned 批类型用例；`manual_checks` 机制启用（eval 12 / 26 输出人工核查 TODO）。
- **校验器 `check_scoring_schema`**：验证 routes.json 中关键词非空、goal 规则与语料修正引用的路由 / goal 均存在；eval 覆盖检查升级为强制全路由覆盖、至少 30 条。

### 变更

- **routes.json 成为唯一数据源（schema v2）**：全部路由关键词、文件名模式（支持 `{pattern, weight}` 权重）、11 条语料修正、12 个 goal 定义、11 条 goal 规则声明化进 JSON；`route_image_request.py` 改写为通用打分引擎，终结逐例硬编码补丁（原 D1–D6）的演化方式。
- **评分语料分离**：关键词只对 prompt + hints 打分，文件名只走 pattern 匹配，消除同一信号重复计分（如 `poster.jpg` 同时命中关键词与 pattern）。
- **文档阅读链精简**：output-contract.md 314 → 140 行（17 段 per-route minimums 删除，改为"以所选 method 文件的 Core lenses 为结构来源"）；SKILL.md 154 → 126 行（17 条 Prefer 路由规则收敛为指向 route-matrix 的指针 + 两条凌驾性原则；frontmatter description 砍约 45%）；新增 quick 深度时可略读 contract 路由细节的捷径规则。
- **examples.md 接入阅读链**：原为校验器要求存在但无任何文档指向的孤儿文件，现从 SKILL.md、route-matrix（tie-breakers）、output-contract 三处条件式链接，并补充本次发现的高危案例锚点。
- **深度判定校准**：短 prompt 仅在 intent 同样不明确时才降为 `quick`；"看看这张海报的层级"现在得到 `standard` 而非 `quick`。
- **goal 词表剔除跨路由通用词**：构图、光线、镜头、material、form 不再作为 photography / product 的独占信号。
- **相机默认文件名降权**：`IMG_*` / `DSC_*` pattern 权重 3 → 1（是"相机拍的"弱提示，不是"摄影批评"证据）。
- **medical_safety 收紧**：医学词只查 prompt + hints，文件名只认特异 pattern（xray / mri / ct-scan / .dcm 等）。
- **批量检测**：versioned 判定收紧（需成对线索或明确修订词，"after the rebrand" 不再误触发）；无文件名批量线索词补齐"两张 / 三张 / 几幅 / 这几张 / 多图"。
- **附图矛盾消解**：SKILL.md 第 4 步明文规定——模型可直接看到附图时 `visual_input_missing` 失效，按视觉路由继续。
- **FastNote 耦合泛化**：SKILL.md 措辞改为"上游调用方"，`--source-note-path` 保留兼容。
- README / README.zh-CN：路线数 17 → 18，新增 `ui-product` 条目与 `--source-url` 参数说明，项目结构补全 evals/ 与 routes.json。

### 修复

- **"this is ai" 子串误判**：`keyword_matches` 对含空格的 ASCII 短语做词边界检查；"this is aimed at..." 不再被判 `ai_content_check: stated`（该误报会被 output-contract 放大为"来源声明 AI 生成"的错误事实）。同时顺带消除 "oil" 匹配 "soil" 一类隐患。
- **OCR hint 误触发阻断**：不可读判定（压缩 / 模糊 / 裁切等词）只看 prompt；hint "JPEG压缩技术大会海报" 不再令分析被 `visual_evidence_insufficient` 阻断。
- **高置信误路由**："分析这幅油画的构图" + `IMG_3001.jpg` 原判 photography/high，现判 painting-illustration；"这个客厅的光线" + 微信图名原判 photography/high，现判 interior-design。
- **逐图路由被 prompt 淹没**：`classify_one` 不再纳入 prompt；"拆一下这组海报" + `xray.png` 现正确判 `mixed_domain`，x 光图单独路由到 scientific-medical-imaging 且医学安全标志保留。
- **medical_safety 误报**：`contract-scan.png`（文档扫描）与 `product-ct.jpg`（连字符边界命中 `\bct\b`）不再触发医学安全标志。
- **SVG / URL 输入被拒**：`brand-logo.svg` 与图片 URL 不再返回 `visual_input_missing`。
- **英文深度请求失灵**："Give me an in-depth, detailed breakdown..." 原只得 standard，现正确得 deep + full Study Report。

### 移除

- SKILL.md "UI Screenshot Handling" 临时段落及两处 "Until a dedicated ui-product route exists" 兜底规则（专属路由已落地）。
- SKILL.md 中与 route-matrix 重复的 17 条 "Prefer ..." 路由规则。
- `needs_clarification` 的 D1 分支（数学上不可达的死代码：满足其条件的输入必然先落入 tie-cluster → generic-mixed 分支）。
- 裸 "scan" / "ct" 文件名医学信号（由特异 pattern 替代）。
- `_assert_routes_consistent` import 期硬断言（数据与引擎合一后漂移不可能发生，残余一致性检查由校验器承担）。

## [1.1.0] - 2026-05-15

- 新增 evals 体系与 `validate_image_router.py` 结构校验。
- 引入 routes.json 作为路由名单的 single source。
- 一批路由质量修复：状态门（`visual_input_missing` / `visual_evidence_insufficient` / `needs_clarification`）、AI 内容三档判定、医学安全标志、批量类型先验。

## [1.0.1] - 2026-03-25

- 明确 OpenAI 与 Claude 双生态支持，刷新项目页文案。

## [1.0.0] - 2026-03-25

- 首次发布：17 条路由、关键词分流脚本、route-matrix / output-contract / method-*.md 参考体系，Analysis Report + Study Report 双产出契约。
