---
name: ready-human-touch-card-skill
description: 制作 Ready 点阵理性或 Human Touch 温感人文风格的社交信息卡与微信封面；仅用于用户指定这两种风格的图组。
---

# Ready / Human Touch 双风格社交信息卡 Skill

一个 HTML 装一组卡（`.poster.xhs` 1080×1440 / `.square` 1080×1080 / `.wide` 2100×900），Playwright 按 id 逐卡截 PNG。两种风格是两套设计人格（对照表与铁律见 `references/style-ready.md` / `style-human-touch.md`）：Ready=点阵理性（橘红 `#FF4B2B`、mono 标签、圆角 18、玻璃压图），Human Touch=温感人文（明体、琥珀 `#C85B1E`、直角零阴影、无 mono）。

**核心原则：表达先行。** 每张卡先回答"看的人一眼要懂什么、什么证据、哪些字必须大"，再挑配方；能删的都删——版面让位给内容与影像。

## 工作流

### 1. Intake（只问会改变产出的事）

- 平台与比例（小红书组？微信封面对？两者都要？）
- 源文本/文章/大纲；**风格 R 还是 H**（说"点阵/科技/Ready"→R；"温度/诗意/生活/Human Touch"→H）
- 图片素材与去处：News/教程/数据/测评类**主动索要截图或实拍**——没有真实物料的卡容易空。用户全无图时问一次三选一（自己传 / 帮找免费图库 / AI 生成），推荐自己传，问一次即止。
- 硬约束（标题字、必含数据、遮挡信息…）

### 2. 提炼页计划

```text
xhs-01 / 封面钩子 / RC01 / 图：无（点网底）
xhs-02 / 论点 A + 证据截图 / RC05 / 槽位 xhs-02-shot
...
```

小红书：封面 1 张钩子 + 每张只讲一件事，5–9 张；微信：21:9 长标题 + 1:1 短标题（4-8 字提炼，规则见 `references/platform-specs.md`）。

### 3. 写入种子模板

在 Ready 内不要用 `cp`/`mv`/`npm`。先用 `skill_read_artifact` 读取对应模板：

- 风格 R：`assets/template-ready-card.html`
- 风格 H：`assets/template-human-touch-card.html`

然后用 `skill_write_artifact` 写到 `cards/index.html`，图片先放/引用在 `cards/assets/`。如果用户指定本地目录或说"相同目录下"，先写 artifact，再用 `skill_export_artifact` 导出到目标目录下的 `cards/index.html`。

种子已内置：全部 token/组件类、三种画板、微信 pair-preview、点阵图表渲染 JS、空槽铭牌。只在 `<!-- POSTERS_HERE -->` 区增删 `<section class="poster ...">`。颜色品牌锁定，不接受自定义 hex。生成物一律进 `cards/` 或用户指定目录，**禁止**落在 skill 根目录。

### 4. 填卡

- 配方骨架：R → `references/recipes-ready.md`（RC01-RC10），H → `references/recipes-human-touch.md`（HC01-HC10）；每卡 `data-layout` 必写、id 唯一。
- 3:4 密度铁律：闭合量法下内容 ≥52% 画布高且无相邻空带（C4）；禁 `flex:1` 空 div 夹击；金句/影像卡加 `data-density-exempt` 且必须有视觉主角。
- 图表：读 `references/dot-charts.md`（卡片档参数：点径 18-22、bar ≤5 列）。
- 图片：全走槽位协议 `references/image-slots.md`（id=`{posterId}-{语义}`；没图用 `is-empty` 空槽出结构）。
- 文案是给读者看的场景语言，不是生产术语；标题读一遍，像任务需求的改掉。

### 5. 渲染 → 给用户看 → 校验

```bash
node "$CLAUDE_SKILL_DIR/scripts/validate-cards.mjs" cards/index.html
node "$CLAUDE_SKILL_DIR/scripts/render-cards.mjs" cards/index.html cards/output
```

HTML 写入与槽位清单是必达；`validate-cards.mjs` 和 `render-cards.mjs` 需要当前环境已有 Playwright/Chrome。若报"未找到 playwright"或无浏览器，不要在 Ready 内安装依赖，改为交付 HTML + 槽位清单，并明确说明本轮未生成 PNG 预览/DOM 校验。渲染成功后**立即把 PNG 绝对路径展示给用户**（封面优先），随后跑校验器（秒级），修掉 FAIL 再交付；WARN 如实提示。人眼核对项见 `references/checklist.md`。

### 6. 交付与换图

交付内容：输出目录、尺寸核对、空槽清单（`list-image-slots.mjs`）、外源图的来源与署名决定。
后续换图请求按 `references/image-slots.md` §2 playbook：列槽位 → 定位 → 同名覆盖 → 定 object-position → `--only` 重渲染该卡验证。只动被点名的槽。

## 硬规则

1. 一组卡一种风格；不混用两套语汇（校验器 C5 拦截）。
2. 尺寸由画板类保证；卡内禁 vw/vh。
3. `.foot` 用 `margin-top:auto` 钉底，禁止 absolute 盖内容。
4. 文字放不下删字不缩号（C3 红线 18px；目标正文 ≥28）。
5. 图表真数据 + unit 图例 + 直标；无双轴彩虹多色。
6. 微信 1:1 不裁 21:9 交差，分开构图。
7. 不放使用说明/快捷键进卡面；不造装饰性 SVG 团块。

## 资源导览

```
ready-human-touch-card-skill/
├── SKILL.md
├── assets/template-ready-card.html / template-human-touch-card.html   ← 厚种子
├── references/
│   ├── style-ready.md / style-human-touch.md      ← 设计语言（与 PPT skill 同源）
│   ├── recipes-ready.md / recipes-human-touch.md  ← RC/HC 配方 + 骨架 + 密度线
│   ├── dot-charts.md                      ← 图表（卡片档参数）
│   ├── image-slots.md                     ← 槽位协议 + 换图 playbook
│   ├── platform-specs.md                  ← 尺寸/命名/安全区/封面对
│   └── checklist.md                       ← P0/P1/P2
└── scripts/
    ├── render-cards.mjs                   ← 按 poster id 逐卡 PNG
    ├── validate-cards.mjs                 ← DOM 实测（C1-C6），FAIL 退出码 1
    └── list-image-slots.mjs               ← 槽位清单
```
