# 版式登记 · 风格 R（Ready 点阵理性）R01–R14

> 正文页**只能**使用本文件登记的版式，每页 `<section class="slide ...">` 必须写 `data-layout="Rxx"`。
> 骨架里的类名全部来自 `assets/template-ready.html` 的 `<style>`——不要发明新类，需要微调用 inline style。
> 通用规则：每页一个主角；`[必填]` 全部替换；页脚页码手写 `NN / NN`；底部内容不得进入 `--nav-safe`（8vh）区。

## 主题节奏（先排节奏再填页）

- 每页选 `light`（默认素纸）/ `warm`（暖米，仪式感）/ `dark`（炭夜，hero 用）之一。
- ≥8 页的 deck 至少 1 个 `dark` hero 页；连续 3 页同主题=视觉疲劳，不允许。
- 点阵场画布 `<canvas class="dot-field">` 只放 R01/R02/R03(dark)/R13，正文页素底。
- 动效：每页 `data-animate` 从登记的 recipe 里选，元素用 `data-anim="up|left|right|chart|dotword"` 标角色。

## 版式速查

| ID | 名称 | 用途 | recipe |
|---|---|---|---|
| R01 | Cover Dotword | 封面 | cover-dotword |
| R02 | Section Marker | 章节幕封 | statement |
| R03 | Statement | 观点陈述/金句 | statement |
| R04 | Data Hero | 单一大数字 | chart |
| R05 | Dot Chart | 图表页 | chart |
| R06 | Duo Compare | 双栏对比 | duo |
| R07 | Setting Rows | 要点行列表 | rows |
| R08 | Image Hero | 大图 + 玻璃浮层 | image-hero |
| R09 | Split Text-Image | 左文右图 | image-hero |
| R10 | Pipeline | 横向流程 | pipeline |
| R11 | Matrix Cards | 卡片矩阵 | matrix |
| R12 | Quote | 引用 | statement |
| R13 | Closing | 收尾 | cover-dotword |
| R14 | Timeline | 竖向时间线 | pipeline |

---

### R01 · Cover Dotword · 封面

**用途**：第 1 页。dotword 字标（品牌词/产品名，拉丁或数字，≤7 字符）+ 中文主标题 ≤2 行（每行 ≤8 字）。
**骨架**：模板内置示例即是（chrome → 内容 stack `margin:auto 0` → foot）。dotword `data-dot` 10–14。

### R02 · Section Marker · 章节幕封

**用途**：每幕开场。dotword 大序号 + 章节名。light/warm/dark 轮换。

```html
<section class="slide warm" data-layout="R02" data-animate="statement">
  <canvas class="dot-field" aria-hidden="true"></canvas>
  <div class="chrome"><div>Section</div><div>04 / NN</div></div>
  <div class="stack gap-6" style="margin:auto 0">
    <div class="dotword" data-text="02" data-dot="16" data-anim="up"></div>
    <h2 class="h-display-zh" data-anim="up">[必填] 章节名</h2>
    <p class="lead" data-anim="up">[必填] 这一幕要回答的问题。</p>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>04 / NN</div></div>
</section>
```

### R03 · Statement · 观点陈述

**用途**：一句站得住的话。dark 变体做 deck 呼吸位。

```html
<section class="slide dark" data-layout="R03" data-animate="statement">
  <canvas class="dot-field" aria-hidden="true"></canvas>
  <div class="chrome"><div>Statement</div><div>05 / NN</div></div>
  <div class="stack gap-6" style="margin:auto 0;max-width:78vw">
    <div class="t-label" data-anim="up">[必填] Kicker</div>
    <p class="h-display-zh" data-anim="up">[必填] 一句话观点，<br>最多两行。</p>
    <p class="body-sm" data-anim="up">[必填] 一行支撑：证据/出处/边界条件。</p>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>05 / NN</div></div>
</section>
```

### R04 · Data Hero · 单一大数字

**用途**：一个数字就是主角。`kpi-num`（mono）承载精确值；想要品牌感可换 dotword 数字（仅整数/百分数）。

```html
<section class="slide" data-layout="R04" data-animate="chart">
  <div class="chrome"><div>Data · [必填]</div><div>06 / NN</div></div>
  <div class="grid-2-7-5" style="flex:1;align-items:center">
    <div class="stack gap-5">
      <div class="t-label" data-anim="up">[必填] 指标名</div>
      <div class="kpi-num" data-anim="up">4.2<span class="kpi-unit">万 / 月</span></div>
      <p class="lead max-w-40" data-anim="up">[必填] 这个数字意味着什么。</p>
      <p class="t-meta" data-anim="up">来源 · [必填]（真实数据）</p>
    </div>
    <div class="dot-chart" data-type="waffle" data-percent="62" data-label="[必填] 口径说明"
         data-dot="14" data-anim="chart" style="justify-self:center"></div>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>06 / NN</div></div>
</section>
```

### R05 · Dot Chart · 图表页

**用途**：bar/hbar/line 图表 + 左侧结论。模板内置示例即是。图表规则读 `dot-charts.md`（unit 显式、真数据、hot 强调）。

### R06 · Duo Compare · 双栏对比

**用途**：Before/After、旧新模式。中缝竖 hairline（横向分隔靠留白，竖向才画线——Ready 铁律）。

```html
<section class="slide" data-layout="R06" data-animate="duo">
  <div class="chrome"><div>Compare</div><div>07 / NN</div></div>
  <div class="t-label" data-anim="up" style="margin-bottom:3vh">[必填] 对比主题</div>
  <div class="cols" style="flex:1;align-items:stretch">
    <div class="stack gap-4" style="flex:1" data-anim="left">
      <span class="pill">Before · [必填]</span>
      <h3 class="h-md">[必填] 旧方式</h3>
      <p class="body">[必填] 2-3 句：代价与摩擦。</p>
      <p class="t-meta">[必填] 一行量化</p>
    </div>
    <div class="vr"></div>
    <div class="stack gap-4" style="flex:1" data-anim="right">
      <span class="pill hot"><span class="status-dot now"></span>After · [必填]</span>
      <h3 class="h-md">[必填] 新方式</h3>
      <p class="body">[必填] 2-3 句：改变了什么。</p>
      <p class="t-meta">[必填] 一行量化</p>
    </div>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>07 / NN</div></div>
</section>
```

### R07 · Setting Rows · 要点行列表

**用途**：3–6 个要点，设置页式秩序（icon + 标题/描述 + 右侧 mono meta）。橘点只标"当前/进行中"那一行。

```html
<section class="slide" data-layout="R07" data-animate="rows">
  <div class="chrome"><div>[必填] 小节</div><div>08 / NN</div></div>
  <div class="grid-2-5-7" style="flex:1;align-items:center">
    <div class="stack gap-5">
      <div class="t-label" data-anim="up">[必填] Kicker</div>
      <h2 class="h-xl" data-anim="up">[必填] 清单标题</h2>
      <p class="body max-w-40" data-anim="up">[必填] 一段引导。</p>
    </div>
    <div class="row-list">
      <div class="row-item">
        <div class="row-icon"><i data-lucide="folder" style="width:18px"></i></div>
        <div><div class="row-title">[必填] 要点一</div><div class="row-desc">[必填] 一句描述</div></div>
        <div class="row-meta"><span class="status-dot done"></span> done</div>
      </div>
      <div class="row-item">
        <div class="row-icon"><i data-lucide="zap" style="width:18px"></i></div>
        <div><div class="row-title">[必填] 要点二</div><div class="row-desc">[必填] 一句描述</div></div>
        <div class="row-meta"><span class="status-dot now"></span> now</div>
      </div>
      <div class="row-item">
        <div class="row-icon"><i data-lucide="calendar" style="width:18px"></i></div>
        <div><div class="row-title">[必填] 要点三</div><div class="row-desc">[必填] 一句描述</div></div>
        <div class="row-meta">next</div>
      </div>
    </div>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>08 / NN</div></div>
</section>
```

### R08 · Image Hero · 大图 + 玻璃浮层

**用途**：截图/产品图是主角。玻璃面板是 Ready 唯一允许的压图方式（一页 ≤2 块）。
**图片槽位**：`data-image-slot="p09-hero"`，比例 `r-21x9`（≤54vh），`object-position` 必须内联指定。

```html
<section class="slide" data-layout="R08" data-animate="image-hero">
  <div class="chrome"><div>Case · [必填]</div><div>09 / NN</div></div>
  <figure class="img-slot r-21x9" data-image-slot="p09-hero" data-slot-ratio="21:9" data-slot-desc="[必填] 图的内容">
    <img src="images/p09-hero.png" alt="[必填]" style="object-position:center 35%">
    <div class="glass-panel" style="position:absolute;left:2.2vw;bottom:3.6vh;max-width:34vw">
      <div class="t-label" style="margin-bottom:8px">[必填] Kicker</div>
      <div class="h-md">[必填] 图上标题</div>
    </div>
  </figure>
  <div class="cols gap-7" style="margin-top:3.4vh" data-anim="up">
    <div class="stack gap-2" style="flex:1"><hr class="rule"><div class="t-label">Metric 01</div><div class="kpi-num" style="font-size:min(2.8vw,4.8vh)">12×</div></div>
    <div class="stack gap-2" style="flex:1"><hr class="rule"><div class="t-label">Metric 02</div><div class="kpi-num" style="font-size:min(2.8vw,4.8vh)">3.4s</div></div>
    <div class="stack gap-2" style="flex:1"><hr class="rule"><div class="t-label">Metric 03</div><div class="kpi-num accent-text" style="font-size:min(2.8vw,4.8vh)">98%</div></div>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>09 / NN</div></div>
</section>
```

无图时：`<figure class="img-slot r-21x9 is-empty" data-image-slot="p09-hero" data-slot-ratio="21:9" data-slot-desc="产品界面全景"></figure>`（占位铭牌自动渲染，玻璃浮层先不放）。

### R09 · Split Text-Image · 左文右图

```html
<section class="slide" data-layout="R09" data-animate="image-hero">
  <div class="chrome"><div>[必填] 小节</div><div>10 / NN</div></div>
  <div class="grid-2-6-6" style="flex:1;align-items:center">
    <div class="stack gap-5">
      <div class="t-label" data-anim="up">[必填] Kicker</div>
      <h2 class="h-xl" data-anim="up">[必填] 标题</h2>
      <p class="body max-w-40" data-anim="up">[必填] 2-4 句正文。</p>
      <span class="pill" data-anim="up"><span class="status-dot now"></span>[必填] 一行状态/结论</span>
    </div>
    <figure class="img-slot r-16x10" data-image-slot="p10-detail" data-slot-ratio="16:10" data-slot-desc="[必填] 图的内容">
      <img src="images/p10-detail.png" alt="[必填]" style="object-position:center 40%">
    </figure>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>10 / NN</div></div>
</section>
```

### R10 · Pipeline · 横向流程

**用途**：3–6 步工作流。橘点=当前步。

```html
<section class="slide" data-layout="R10" data-animate="pipeline">
  <div class="chrome"><div>Workflow</div><div>11 / NN</div></div>
  <div class="stack gap-5" style="margin-bottom:5vh">
    <div class="t-label" data-anim="up">[必填] Kicker</div>
    <h2 class="h-xl" data-anim="up">[必填] 流程标题</h2>
  </div>
  <div class="pipe-h" style="flex:1;align-content:start">
    <div class="pipe-node done"><div class="t-label">Step 01</div><h3 class="h-sub" style="margin:8px 0 6px">[必填] 步名</h3><p class="body-sm">[必填] 一句描述</p></div>
    <div class="pipe-node done"><div class="t-label">Step 02</div><h3 class="h-sub" style="margin:8px 0 6px">[必填] 步名</h3><p class="body-sm">[必填] 一句描述</p></div>
    <div class="pipe-node now"><div class="t-label">Step 03</div><h3 class="h-sub" style="margin:8px 0 6px">[必填] 步名</h3><p class="body-sm">[必填] 一句描述</p></div>
    <div class="pipe-node"><div class="t-label">Step 04</div><h3 class="h-sub" style="margin:8px 0 6px">[必填] 步名</h3><p class="body-sm">[必填] 一句描述</p></div>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>11 / NN</div></div>
</section>
```

### R11 · Matrix Cards · 卡片矩阵

**用途**：4/6 个并列概念。全部 `card`（白卡 hairline），突出一张换 `card-quiet` + pill hot，**最多一张**。

```html
<section class="slide" data-layout="R11" data-animate="matrix">
  <div class="chrome"><div>[必填] 小节</div><div>12 / NN</div></div>
  <div class="stack gap-5" style="margin-bottom:4vh">
    <div class="t-label" data-anim="up">[必填] Kicker</div>
    <h2 class="h-xl" data-anim="up">[必填] 矩阵标题</h2>
  </div>
  <div class="grid-12" style="flex:1;align-content:start">
    <div class="card span-4"><div class="t-label" style="margin-bottom:10px">01</div><h3 class="h-sub">[必填] 概念</h3><p class="body-sm" style="margin-top:6px">[必填] 一句描述</p></div>
    <div class="card span-4"><div class="t-label" style="margin-bottom:10px">02</div><h3 class="h-sub">[必填] 概念</h3><p class="body-sm" style="margin-top:6px">[必填] 一句描述</p></div>
    <div class="card span-4"><div class="t-label" style="margin-bottom:10px">03</div><h3 class="h-sub">[必填] 概念</h3><p class="body-sm" style="margin-top:6px">[必填] 一句描述</p></div>
    <div class="card span-4"><div class="t-label" style="margin-bottom:10px">04</div><h3 class="h-sub">[必填] 概念</h3><p class="body-sm" style="margin-top:6px">[必填] 一句描述</p></div>
    <div class="card span-4"><div class="t-label" style="margin-bottom:10px">05</div><h3 class="h-sub">[必填] 概念</h3><p class="body-sm" style="margin-top:6px">[必填] 一句描述</p></div>
    <div class="card span-4"><div class="t-label accent-text" style="margin-bottom:10px">06 ·<span class="status-dot now" style="margin-left:6px"></span></div><h3 class="h-sub">[必填] 关键概念</h3><p class="body-sm" style="margin-top:6px">[必填] 一句描述</p></div>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>12 / NN</div></div>
</section>
```

### R12 · Quote · 引用

```html
<section class="slide warm" data-layout="R12" data-animate="statement">
  <div class="chrome"><div>Quote</div><div>13 / NN</div></div>
  <div class="stack gap-6" style="margin:auto 0;max-width:70vw">
    <div class="dotword dw-dim" data-text=":" data-dot="10" data-anim="up"></div>
    <p class="h-display-zh" data-anim="up" style="font-weight:500">[必填] 引文本体，控制在两行以内。</p>
    <p class="t-label" data-anim="up">—— [必填] 出处 · 年份</p>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>13 / NN</div></div>
</section>
```

### R13 · Closing · 收尾

模板内置示例即是（dark + dotword THANKS + 一句收束）。dotword 词可换 `NEXT` / `Q+A` / 品牌词。

### R14 · Timeline · 竖向时间线

**用途**：3–5 个阶段的演进。橘点=现在。

```html
<section class="slide" data-layout="R14" data-animate="pipeline">
  <div class="chrome"><div>Timeline</div><div>14 / NN</div></div>
  <div class="grid-2-5-7" style="flex:1;align-items:center">
    <div class="stack gap-5">
      <div class="t-label" data-anim="up">[必填] Kicker</div>
      <h2 class="h-xl" data-anim="up">[必填] 时间线标题</h2>
      <p class="body max-w-40" data-anim="up">[必填] 一段引导。</p>
    </div>
    <div class="tl-v">
      <div class="tl-item done"><div class="tl-dot"></div><div><div class="t-label">2024</div><div class="h-sub" style="margin:4px 0">[必填] 阶段名</div><p class="body-sm">[必填] 一句描述</p></div></div>
      <div class="tl-item done"><div class="tl-dot"></div><div><div class="t-label">2025</div><div class="h-sub" style="margin:4px 0">[必填] 阶段名</div><p class="body-sm">[必填] 一句描述</p></div></div>
      <div class="tl-item now"><div class="tl-dot"></div><div><div class="t-label accent-text">2026 · NOW</div><div class="h-sub" style="margin:4px 0">[必填] 阶段名</div><p class="body-sm">[必填] 一句描述</p></div></div>
      <div class="tl-item"><div class="tl-dot"></div><div><div class="t-label">NEXT</div><div class="h-sub" style="margin:4px 0">[必填] 阶段名</div><p class="body-sm">[必填] 一句描述</p></div></div>
    </div>
  </div>
  <div class="foot"><div><span class="brand-dot"></span>READY DECK</div><div>14 / NN</div></div>
</section>
```

---

## 中文大标题分档（防溢出）

| 形态 | 类 / 字号 |
|---|---|
| 1 行 ≤6 字 | `.h-display-zh` 原档 |
| 2 行、每行 ≤8 字 | `.h-display-zh` 原档 |
| 2 行、任一行 9–12 字 | inline 降到 `font-size:min(4.6vw,8vh)` |
| 章节页内标题 | `.h-xl`（每行 ≤10 字） |

放不下先删字，再降档；不要把下方内容往 nav 区挤。

## 版式多样性硬规则

- 7–8 页至少 5 个不同 Rxx；10 页以上至少 7 个。
- 不允许连续 3 页同一版式；图表页（R04/R05）与图片页（R08/R09）之间至少隔 1 页文字版式。
- 每 3–4 页一个 hero 节奏位（R02/R03/R12 任一）。
