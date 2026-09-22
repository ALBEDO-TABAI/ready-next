---
name: ready-human-touch-ppt-skill
description: 制作 Ready 点阵理性或 Human Touch 温感人文风格的单 HTML 演示文稿；用于用户指定这两种风格的网页 PPT。
---

# Ready / Human Touch 双风格网页 PPT Skill

生成**单文件 HTML** 横向翻页 deck。两种风格是两套完整的设计人格，不是换皮：

| | 风格 R · Ready 点阵理性 | 风格 H · Human Touch 温感人文 |
|---|---|---|
| 底色 | 暖纸白 `#F6F5F1` | 蛋壳白 `#F4F3ED` |
| 身份 | 橘红 `#FF4B2B` 点阵字标 / 点阵场 / mono 标签 | 水木明体标题 / 琥珀 `#C85B1E` / 竖排引导语 |
| 几何 | 圆角 12/16/18，内高光玻璃浮层 | **0 圆角、零阴影、纯平面** |
| 图表 | 橘红点阵图 | 琥珀点阵图（更安静） |
| 动效 | 点阵逐列点亮（86ms/列）、机械干脆 | 只有柔和淡入，近乎无 |
| 适合 | 产品发布、技术分享、数据汇报、极客场合 | 品牌叙事、人文分享、生活美学、白皮书 |

共享：横向翻页（← → / 滚轮 / 触屏 / ESC 索引 / B 静态低功耗）、图片槽位协议、点阵图表、`?slide=N` 深链、渲染与校验脚本。

## 工作流

### Step 1 · 需求澄清（动手前）

用户给全大纲+素材可直接进 Step 2。否则先对齐（在 Claude Code 里用 ask 工具，一次问最关键的 1-3 个）：

1. **风格 R 还是 H？**（决定一切；见上表。说"点阵/科技/Ready/极客"→R；说"温度/诗意/生活/品牌/Human Touch"→H）
2. 受众与场合？时长？（15min≈10 页，30min≈18 页）
3. 有无原始素材/数据/截图？图片处理要求？
4. 硬约束？（必含数据 / 禁出现内容）

无大纲时用叙事弧搭骨架：钩子 1 页 → 定调 1-2 页 → 主体 3-6 页 → 转折 1 页 → 收束 1-2 页。

**图片约定告知用户**：图放 `ppt/images/`，命名=槽位 id（如 `p06-scene.jpg`）；没图先用空槽铭牌出结构，后期把图给 agent 说"放到某槽位"即可（协议见 `references/image-slots.md`）。

### Step 2 · 写入模板

在 Ready 内不要用 `cp`/`mv`/`npm`。先用 `skill_read_artifact` 读取对应模板：

- 风格 R：`assets/template-ready.html`
- 风格 H：`assets/template-human-touch.html`

然后用 `skill_write_artifact` 写到 `ppt/index.html`，图片先放/引用在 `ppt/images/`。如果用户指定本地目录或说"相同目录下"，先写 artifact，再用 `skill_export_artifact` 导出到目标目录下的 `ppt/index.html`。

模板完整可运行（引擎/动效/图表/点阵组件全内置），带 3 个示例页。写入后立刻：

1. 改 `<title>`（grep `[必填]` 确认后续全部替换）；
2. 两种风格**不能混用**——类名体系互斥，校验器会拦。

**颜色是品牌锁定的，不提供主题选择**；不要接受自定义 hex（保护品牌一致性，委婉说明）。

### Step 3 · 填充内容

1. **先读对应版式登记**：R → `references/layouts-ready.md`（R01-R14），H → `references/layouts-human-touch.md`（H01-H13）。每页 `data-layout` 必写；骨架直接粘贴改文案。
2. **先排节奏再填页**：列出 `页码 → 版式 → 主题(light/warm/white/dark/amber) → 图片槽位` 草稿；dark/hero 呼吸位每 3-4 页一个。
3. **风格细节查设计语言规范**：`references/style-ready.md` / `references/style-human-touch.md`（token、accent 纪律、母题用法、Do/Don't）。
4. **图表**：读 `references/dot-charts.md` 再写 `.dot-chart`（真数据 + unit 图例 + emphasis 单色纪律）。
5. **图片**：全部走槽位协议 `references/image-slots.md`；没图用 `is-empty` 空槽（自带铭牌，可演示可后补）。

### Step 4 · 校验 + 渲染自检

```bash
node "$CLAUDE_SKILL_DIR/scripts/validate-deck.mjs" ppt/index.html
node "$CLAUDE_SKILL_DIR/scripts/render-deck.mjs" ppt/index.html ppt/renders
```

`validate-deck.mjs` 是必跑；`render-deck.mjs` 需要当前环境已有 Playwright/Chrome，若报"未找到 playwright"或无浏览器，不要在 Ready 内安装依赖，改为交付 HTML + validator 结果，并明确说明本轮未生成 PNG 预览。validator 过了再逐页看截图，对照 `references/checklist.md`（P0：占位残留/版式登记/风格红线/槽位协议/图表诚实/标题行长/底部安全区）。**代码对不等于版式舒服，必须看图。**

### Step 5 · 预览与交付

浏览器直接打开 `index.html`（无需服务器）。告知用户：← → 翻页、ESC 索引、B 静态模式、`?slide=N` 直达。交付时附槽位清单（`list-image-slots.mjs` 输出），标注哪些空槽等图。

### Step 6 · 迭代与换图

- 90% 调整=改 inline style（字号 `min(Xvw,Yvh)` / 间距 / 图表 data-*）。
- **换图请求**（"把这张图放到第 N 页"）：严格按 `references/image-slots.md` §3 的 playbook 执行——列槽位 → 定位 → 同名覆盖或换 src → 定 object-position → 重渲染该页验证。只动被点名的槽。

## 硬规则（违反=返工）

1. 一份 deck 一种风格；类名/母题/字体不得跨风格借用（dotword、玻璃、mono 属于 R；明体、直角、琥珀属于 H）。
2. 颜色只用模板 token；不自造 hex、不加第二 accent。
3. 图表数据必须真实并标来源；点阵量化必须带 unit 图例 + 精确值直标。
4. 本地图片必须住槽位；槽位 id 全文件唯一；比例用标准比例类。
5. 底部 8vh 是导航安全区，任何内容不得进入。
6. 动效是渐进增强：断网/低功耗/reduce-motion 下内容必须完整可读（模板已保证，不要破坏 `[data-anim]` 初始可见的机制）。
7. 中文标题行长：R ≤8 字/行，H ≤12 字/行；放不下改文案不硬缩。

## 资源导览

```
ready-human-touch-ppt-skill/
├── SKILL.md                      ← 本文件
├── assets/
│   ├── template-ready.html       ← 风格 R 种子（引擎+点阵组件+图表全内置）
│   └── template-human-touch.html         ← 风格 H 种子
├── references/
│   ├── style-ready.md            ← R 设计语言规范（token/纪律/Do-Don't）
│   ├── style-human-touch.md              ← H 设计语言规范
│   ├── layouts-ready.md          ← R01-R14 版式登记 + 骨架
│   ├── layouts-human-touch.md            ← H01-H13 版式登记 + 骨架
│   ├── dot-charts.md             ← 点阵图表手册（形态/颜色/诚实/API/自检）
│   ├── image-slots.md            ← 图片槽位协议 + agent 换图 playbook
│   └── checklist.md              ← P0/P1/P2 质检清单
└── scripts/
    ├── validate-deck.mjs         ← 零依赖静态校验（版式/槽位/图表/风格红线）
    ├── render-deck.mjs           ← Playwright 逐页截图（默认静态确定性模式）
    └── list-image-slots.mjs      ← 槽位清单（换图第一步）
```

**加载顺序**：SKILL.md → 选风格 → 对应 style-*.md + layouts-*.md → 有图表读 dot-charts.md → 有图读 image-slots.md → 交付前 checklist.md。

## 核心设计原则

> 两种风格共同的底线：**版面永远让位给核心内容或图像**。每页一个主角；能删的都删。

**风格 R**（违反任何一条，Ready 感即垮）：
1. 橘红一只手数得过来——它的语义是"此刻"，不是装饰。
2. 点阵是母语但只在身份位出现（字标/序号/图表/状态点），正文页素底。
3. 秩序来自留白、对齐列和 hairline；横向分隔优先留白，竖向才画线。
4. 阴影趋近于零；深度用内高光和玻璃，且玻璃只为压图。
5. 标题 500-600 从容字重；mono 只管标签、数字、元数据。

**风格 H**（违反任何一条，温度即失）：
1. 明体只承担标题与金句，weight 400 + 正字距；正文永远悠黑/系统 sans。
2. 直角与无阴影是品牌尊严；层次靠色带交替与留白。
3. 红是温度，一页最多一处；琥珀承担日常强调与数据。
4. 留白是内容——金句页敢于只放一句话；影像页敢于让图占 60%。
5. 不抢不燥：动效只有淡入，静态模式气质零损失。
