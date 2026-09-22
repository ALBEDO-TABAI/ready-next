# 技能与提示词指引应用记录

日期：2026-09-13。范围：本仓库的协作指引、测试规约、外部排障技能和内置技能文本。

依据：OpenAI 于 2026-09-11 发布的 [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)，本次已读取原文。采用其关于精确描述、按需读取、清晰边界和持续完成的建议；具体修改依据本项目现有文件及消费者，不复制模型迁移配置。

## 实际调整

| 入口 | 发现与修改 |
| --- | --- |
| [AGENTS](../../AGENTS.md)、[CLAUDE](../../CLAUDE.md) | 按任务选择资料；可从上下文推断的常规决定继续推进，明确授权不重复询问；完成所需验证与修正后再交付。保留架构、权限、持久化和原生界面约束，两份正文一致 |
| [测试规约](../superpowers/testing-conventions.md) | 按改动风险选择检查，区分纯文字、流程、代码、持久化与界面；不把所有测试都假定为没有外部影响，也不默认对纯文档跑全量验收 |
| [ready-debug](../../.agents/skills/ready-debug/SKILL.md) 及 `.claude` 同份入口 | 去掉“发现可修复问题也必须先问是否修复”的固定停点；按症状读日志，存储细节按需加载；不再使用全库历史状态列表作为当前 Codex 卡死判据 |
| [script-expert-ready](../../assets/embedded-skills/script-expert-ready/SKILL.md) | 把多流程正文改为按产物选择资料；取消中间稿与每批自动停点，以实际故事结构判断输入是否充分；同步分镜、自检参考与两份使用说明，保留原文约束、版本状态和信息卡格式 |
| [character-costume-forge](../../assets/embedded-skills/character-costume-forge/SKILL.md) | 已提供的角色要点与可推断信息直接使用；缺失的关键设定才提问，不要求再次填完整问卷 |
| [image-analysis-router](../../assets/embedded-skills/image-analysis-router/SKILL.md)、[study-notes](../../assets/embedded-skills/study-notes/SKILL.md) | 脚本仅提供先验；先核对真实材料，再决定是否缺输入。脚本不可用或未获准时不假称运行过，也不让关键词结果否决现有可读内容 |
| [surf-pro](../../assets/embedded-skills/surf-pro/SKILL.md) | 收窄到专题调研与资料库；按实际缺口选搜索方法和停止条件，不固定凑维度数、不为单页阅读开启整套归档；不依赖本项目没有的 `browser-v2` 技能 |
| 参考路径与脚本定位 | 修正人物造型与风格提炼入口中的 `references/` 为实际 `reference/`；补清图像分析、学习笔记和 OKF 两技能的脚本根目录解析 |

## 技能描述及真实消费

本次同步精简 15 个技能的 `SKILL.md` description 与 `ready-skill.json` description：

`character-costume-forge`、`fastnote`、`image-analysis-router`、`image-deep-read`、`image-reverse-describe`、`okf-bundle`、`okf-library`、`ready-human-touch-card`、`ready-human-touch-ppt`、`script-expert-ready`、`script-storyboard-forge`、`study-notes`、`style-grammar-distill`、`surf-pro`、`tag-forge`。

[注册扫描](../../src/main/modules/skills-runtime/manifest.ts) 优先读取 JSON 描述，[技能编译](../../src/main/modules/skills-runtime/skill-compiler.ts) 也优先使用它；因此本次同时更新两个入口，并从真实扫描和编译结果回读核对。技能原有 name/id、版本、actions、执行模式和授权声明均保持原值。

| 计量口径 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 上述 15 份 SKILL.md 的描述总字符数 | 7,532 | 790 |
| Ready 使用的 15 份 JSON 描述总字符数 | 801 | 790 |
| 剧本技能完整入口字符数 | 9,672 | 2,610 |

字符数按 JavaScript 字符串长度计算，不是 token 数。SKILL.md 描述缩短约 89.5%，不代表 Ready 常驻目录缩短同样比例；目录侧主要消除了含糊边界，正文侧减少了选中技能后的阅读负担。

## 验证

- 17 个技能目录（15 个内置 + 2 个排障入口）的 `skills:lint` 通过，零警告；Ready manifest/asset parity 检查通过。
- 调整了主要流程或参考路径的 8 个入口通过 skill-creator 的 `quick_validate.py`。保留 Ready 已支持的扩展字段，不为通用校验器删除声明。
- `embedded-manifest-scan`、`embedded-skill-creative-forge-set`、`embedded-skill-fac-three-skills` 共 12 项现有测试通过，零失败、零跳过；另用实际扫描与编译核对 15 个新描述，比较修改前后非描述字段未变。
- `study-notes/scripts/validate_study_notes.py` 的自动检查通过；其输出中列出的人工判读项不计作已执行的模型评测。
- 两份协作指引、两份排障技能及参考资料逐字同步；用 Markdown 解析器检查本次 31 份 Markdown 文件中的 956 处本地链接及技能参考路径，未发现失效目标；`git diff --check` 通过。

独立使用验证使用临时目录和虚构材料，没有接触真实账号或项目数据：

1. 完整的短故事，要求 90 秒剧本、正文和自检两个文件：实际生成并回读两份文件；没有因少于 500 字或跳过提示包而停下，没有附加中间产物。90 秒是剧本时长安排，不是成片实测。
2. 同样是完整故事，但只要求形态建议并等待确认：实际仅给建议并停在用户指定处，没有生成剧本或文件。
3. 提供违背原故事的一稿并明确要求修好：实际生成并回读二稿与自检文件，补回取物授权、修好的表与取件条，去除认亲反转并恢复原结局，没有停在建议列表或再次询问。

首次使用检查发现自检参考仍要求“建议用户进入下一稿”，已与入口统一为：生成/修订请求直接修复影响交付的问题；仅审阅请求保留用户决策边界。第三项使用检查在修正该参考之后执行。

## 证明范围

本次完成的是仓库文本、引用关系、技能注册读取与以上代表性使用检查。已核对当前运行时合同和常驻提示词；保留现有固定 runtime、模型设置、代码侧授权和停用能力，不进行模型迁移或恢复旧执行路径。未打包、安装或进行真实账号验收，不能把这些源文件修改称为安装版已经生效。

后续维护以根指引和各技能正文为准；本页是这次修改的记录，不是每次任务要通读的新规则层。
