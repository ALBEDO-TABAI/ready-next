# 版式登记 · 风格 H（Human Touch 温感人文）H01–H13

> 正文页**只能**使用本文件登记的版式，每页 `<section class="slide ...">` 必须写 `data-layout="Hxx"`。
> 骨架类名全部来自 `assets/template-human-touch.html`。直角、无阴影、无 mono、明体标题——四条铁律在任何版式内都不许破。
> 页底手写页码 `NN / NN`；`[必填]` 全部替换；底部内容不进 `--nav-safe`（8vh）。

## 色带节奏（先排节奏再填页）

- 每页选 `（默认蛋壳白）` / `white`（纯白）/ `dark`（炭黑）/ `amber`（琥珀渐变，**整份 deck ≤1 页**）。
- 相邻页优先蛋壳白 ↔ 白交替（印刷品的换纸感）；`dark` 做金句/收尾的呼吸位。
- `grain`（纸纹）只给封面/金句/收尾这类仪式页。
- 动效只有柔和淡入；`data-animate` 从登记 recipe 选。

## 版式速查

| ID | 名称 | 用途 | recipe |
|---|---|---|---|
| H01 | Cover Serif | 封面 | statement |
| H02 | Section Band | 章节幕封 | statement |
| H03 | Poem Statement | 金句页 | statement |
| H04 | Image Hero | 满幅影像 | image-hero |
| H05 | Split Text-Image | 左文右图 | image-hero |
| H06 | Note Ledger | 手记清单 | rows |
| H07 | Data Quiet | 数据页 | chart |
| H08 | Duo Compare | 双栏对比 | duo |
| H09 | Quote Long | 引用+长注 | statement |
| H10 | Steps | 步骤 | rows |
| H11 | Twin Gallery | 双图对页 | image-hero |
| H12 | Closing | 收尾 | statement |
| H13 | Amber Hero | 琥珀渐变页（≤1） | statement |

---

### H01 · Cover Serif · 封面

模板内置示例即是：amber rule + 明体大标题（每行 ≤8 字）+ 悠黑副题 + 信物标签 + 右缘竖排引导语。

### H02 · Section Band · 章节幕封

**用途**：每幕开场，用色带切换 + 大序号。

```html
<section class="slide white" data-layout="H02" data-animate="statement">
  <div class="chrome"><div>[必填] 章节</div><div>04 / NN</div></div>
  <div class="grid-2-5-7" style="flex:1;align-items:center">
    <div class="stack gap-6">
      <div class="kicker" data-anim="up">CHAPTER</div>
      <div class="serif" data-anim="up" style="font-size:min(9vw,15vh);line-height:1;color:var(--amber)">贰</div>
      <h2 class="h-display-sm" data-anim="up">[必填] 章节名</h2>
      <p class="lead" data-anim="up">[必填] 这一章要说的事，一句讲完。</p>
    </div>
    <div style="display:flex;justify-content:flex-end">
      <div class="v-kicker" data-anim="up">[必填] 章节引语</div>
    </div>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>04 / NN</div></div>
</section>
```

### H03 · Poem Statement · 金句页

**用途**：一句明体大字站住整页。留白是内容。

```html
<section class="slide grain" data-layout="H03" data-animate="statement">
  <div class="chrome"><div>[必填] 章节</div><div>05 / NN</div></div>
  <div class="stack gap-7" style="margin:auto 0;max-width:64vw">
    <hr class="rule-amber" data-anim="up">
    <p class="h-display" data-anim="up">[必填] 金句本体，<br>两行以内。</p>
    <p class="body-sm" data-anim="up">[必填] 一行小注：语境或出处。</p>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>05 / NN</div></div>
</section>
```

### H04 · Image Hero · 满幅影像

**用途**：影像是主角，文字退到底带。直角、无浮层玻璃（那是 Ready 的）；文字压图需先确认图有安静区，否则用本骨架的图下留白带。

```html
<section class="slide white" data-layout="H04" data-animate="image-hero">
  <div class="chrome"><div>[必填] 章节</div><div>06 / NN</div></div>
  <figure class="img-slot r-21x9" data-image-slot="p06-scene" data-slot-ratio="21:9" data-slot-desc="[必填] 影像内容">
    <img src="images/p06-scene.jpg" alt="[必填]" style="object-position:center 45%">
  </figure>
  <div class="grid-2-7-5" style="margin-top:4vh;align-items:baseline">
    <h2 class="h-xl" data-anim="up">[必填] 影像要说的一句话</h2>
    <p class="img-cap" data-anim="up" style="text-align:right"><span class="cap-serif">[必填] 图注</span> · 自然光 · 未修饰</p>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>06 / NN</div></div>
</section>
```

### H05 · Split Text-Image · 左文右图

```html
<section class="slide" data-layout="H05" data-animate="image-hero">
  <div class="chrome"><div>[必填] 章节</div><div>07 / NN</div></div>
  <div class="grid-2-6-6" style="flex:1;align-items:center">
    <div class="stack gap-6">
      <div class="kicker" data-anim="up">[必填] KICKER</div>
      <h2 class="h-display-sm" data-anim="up">[必填] 标题</h2>
      <p class="body max-w-28" data-anim="up">[必填] 2-4 句正文，行距是呼吸。</p>
      <span class="ing-tag" data-anim="up">[必填] 关键词</span>
    </div>
    <figure class="img-slot r-4x3" data-image-slot="p07-object" data-slot-ratio="4:3" data-slot-desc="[必填] 图的内容">
      <img src="images/p07-object.jpg" alt="[必填]" style="object-position:center 50%">
    </figure>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>07 / NN</div></div>
</section>
```

### H06 · Note Ledger · 手记清单

**用途**：3–6 项要点，像手写清单一样诚实陈列。

```html
<section class="slide white" data-layout="H06" data-animate="rows">
  <div class="chrome"><div>[必填] 章节</div><div>08 / NN</div></div>
  <div class="grid-2-5-7" style="flex:1;align-items:center">
    <div class="stack gap-6">
      <div class="kicker" data-anim="up">[必填] KICKER</div>
      <h2 class="h-display-sm" data-anim="up">[必填] 清单标题</h2>
      <p class="body-sm max-w-28" data-anim="up">[必填] 一段引导。</p>
    </div>
    <div class="ledger">
      <div class="ledger-row"><div class="ledger-no">01</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句描述</div></div><div class="ledger-meta">[必填] 备注</div></div>
      <div class="ledger-row"><div class="ledger-no">02</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句描述</div></div><div class="ledger-meta">[必填] 备注</div></div>
      <div class="ledger-row"><div class="ledger-no">03</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句描述</div></div><div class="ledger-meta amber-text">[必填] 重点</div></div>
      <div class="ledger-row"><div class="ledger-no">04</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句描述</div></div><div class="ledger-meta">[必填] 备注</div></div>
    </div>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>08 / NN</div></div>
</section>
```

### H07 · Data Quiet · 数据页

模板内置示例即是：sans 300 大数 + 琥珀点图 + 来源注。图表规则读 `dot-charts.md`（一页红琥珀不同框、E48421 只能配直标）。

### H08 · Duo Compare · 双栏对比

```html
<section class="slide" data-layout="H08" data-animate="duo">
  <div class="chrome"><div>[必填] 章节</div><div>09 / NN</div></div>
  <div class="stack gap-5" style="margin-bottom:4vh">
    <div class="kicker" data-anim="up">[必填] KICKER</div>
    <h2 class="h-display-sm" data-anim="up">[必填] 对比主题</h2>
  </div>
  <div class="grid-2" style="flex:1;align-content:start">
    <div class="card-inset" data-anim="left">
      <div class="label plain" style="margin-bottom:14px">以前 · [必填]</div>
      <h3 class="h-md serif">[必填] 旧状态</h3>
      <p class="body-sm" style="margin-top:10px">[必填] 2-3 句。</p>
    </div>
    <div class="card" data-anim="right">
      <div class="label" style="margin-bottom:14px">现在 · [必填]</div>
      <h3 class="h-md serif">[必填] 新状态</h3>
      <p class="body-sm" style="margin-top:10px">[必填] 2-3 句。</p>
    </div>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>09 / NN</div></div>
</section>
```

### H09 · Quote Long · 引用+长注

```html
<section class="slide white grain" data-layout="H09" data-animate="statement">
  <div class="chrome"><div>Quote</div><div>10 / NN</div></div>
  <div class="grid-2-7-5" style="flex:1;align-items:center">
    <div class="stack gap-6">
      <p class="h-xl" data-anim="up" style="line-height:1.6">「[必填] 引文本体，明体，<br>可以到三行，让它慢慢说。」</p>
      <p class="t-meta" data-anim="up">—— [必填] 出处 · 年份</p>
    </div>
    <p class="body-sm" data-anim="up" style="align-self:end;border-left:1px solid var(--hair);padding-left:20px">[必填] 长注：为什么此刻引用这句话，它和你的论点是什么关系。</p>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>10 / NN</div></div>
</section>
```

### H10 · Steps · 步骤

```html
<section class="slide" data-layout="H10" data-animate="rows">
  <div class="chrome"><div>[必填] 章节</div><div>11 / NN</div></div>
  <div class="grid-2-5-7" style="flex:1;align-items:center">
    <div class="stack gap-6">
      <div class="kicker" data-anim="up">[必填] KICKER</div>
      <h2 class="h-display-sm" data-anim="up">[必填] 步骤标题</h2>
    </div>
    <div class="steps-v">
      <div class="step-row"><div class="step-no">一</div><div><div class="step-title">[必填] 步名</div><div class="step-desc">[必填] 一句描述</div></div></div>
      <div class="step-row"><div class="step-no">二</div><div><div class="step-title">[必填] 步名</div><div class="step-desc">[必填] 一句描述</div></div></div>
      <div class="step-row"><div class="step-no">三</div><div><div class="step-title">[必填] 步名</div><div class="step-desc">[必填] 一句描述</div></div></div>
    </div>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>11 / NN</div></div>
</section>
```

### H11 · Twin Gallery · 双图对页

**用途**：两张影像并置对话。同比例、同高、各配图注。

```html
<section class="slide white" data-layout="H11" data-animate="image-hero">
  <div class="chrome"><div>[必填] 章节</div><div>12 / NN</div></div>
  <h2 class="h-xl" data-anim="up" style="margin-bottom:4vh">[必填] 两张图之间的那句话</h2>
  <div class="grid-2" style="flex:1;align-content:start">
    <figure class="img-slot r-3x2" data-image-slot="p12-left" data-slot-ratio="3:2" data-slot-desc="[必填] 左图内容">
      <img src="images/p12-left.jpg" alt="[必填]" style="object-position:center 50%">
    </figure>
    <figure class="img-slot r-3x2" data-image-slot="p12-right" data-slot-ratio="3:2" data-slot-desc="[必填] 右图内容">
      <img src="images/p12-right.jpg" alt="[必填]" style="object-position:center 50%">
    </figure>
    <p class="img-cap"><span class="cap-serif">左 · [必填]</span> 图注</p>
    <p class="img-cap"><span class="cap-serif">右 · [必填]</span> 图注</p>
  </div>
  <div class="foot"><div class="mark">human-touch deck</div><div>12 / NN</div></div>
</section>
```

### H12 · Closing · 收尾

模板内置示例即是（炭黑 + amber rule + 明体收束句）。

### H13 · Amber Hero · 琥珀渐变页

**用途**：整份 deck 唯一一次"发光"。产品/成果的仪式性亮相，或最重要的一个数字。**≤1 页**。

```html
<section class="slide amber" data-layout="H13" data-animate="statement">
  <div class="chrome"><div>[必填] 章节</div><div>13 / NN</div></div>
  <div class="stack gap-6" style="margin:auto 0;max-width:66vw">
    <div class="kicker" data-anim="up" style="color:var(--ink-2)">[必填] KICKER</div>
    <p class="h-display" data-anim="up">[必填] 琥珀时刻，<br>只有这一页发光。</p>
    <div class="stat-num" data-anim="up" style="color:var(--ink)">36<span class="stat-unit">个月 · [必填]</span></div>
  </div>
  <div class="foot" style="color:var(--ink-3)"><div class="mark" style="color:var(--ink-2)">human-touch deck</div><div>13 / NN</div></div>
</section>
```

---

## 中文明体标题分档（防溢出）

| 形态 | 类 / 字号 |
|---|---|
| 1–2 行、每行 ≤8 字 | `.h-display` 原档 |
| 2 行、任一行 9–12 字 | `.h-display-sm` |
| 每行 >12 字 | 改写文案（Human Touch 铁律：标题每行 ≤12 字） |
| 分栏内标题 | `.h-display-sm` 或 `.h-xl` |

## 版式多样性硬规则

- 7–8 页至少 5 个不同 Hxx；10 页以上至少 7 个。
- 不允许连续 3 页同一版式；金句页（H03/H09）之间至少隔 2 页。
- 色带交替：蛋壳白 ↔ 白按章节轮换；`dark` 至多 2 页；`amber` 至多 1 页。
- 图片版式（H04/H05/H11）同组图必须同比例同高；影像优先给足面积（≥45% 版面）。
