# 卡片配方 · 风格 H（Human Touch 温感人文）HC01–HC10

> 每张 `<section class="poster ...">` 必须带唯一 `id` 和 `data-layout="HCxx"`。
> 直角、无阴影、明体标题、无 mono——四条铁律卡内不许破。`.content` 自带 padding，子层不叠横向 padding。
> 3:4 硬密度：闭合量法下 ≥52% 且无相邻空带（C4）；金句/影像 hero 卡加 `data-density-exempt="statement|hero"`（影像占 ≥60% 高即视为吃满）。

## 配方速查

| ID | 名称 | 画板 | 要点 |
|---|---|---|---|
| HC01 | 封面 | xhs | 明体 + 竖排引导（模板示例） |
| HC02 | 金句卡 | xhs | 大留白宣言（exempt） |
| HC03 | 影像卡 | xhs | 大图井 + 底部题 |
| HC04 | 手记清单卡 | xhs | ledger 3–5 行 |
| HC05 | 数据卡 | xhs | stat-num + 琥珀点图 |
| HC06 | 步骤卡 | xhs | steps-v 三步 |
| HC07 | 对比卡 | xhs | 双 card 堆叠 |
| HC08 | 双图卡 | xhs | 两 r-3x2 竖排 |
| HC09 | 微信主封面 | wide | 21:9（模板示例） |
| HC10 | 微信方封面 | square | 1:1 短标题（模板示例） |

---

### HC02 · 金句卡

```html
<section class="poster xhs grain" id="xhs-02" data-layout="HC02" data-density-exempt="statement">
  <div class="content">
    <div class="chrome"><div>[必填] 栏目</div><div>02 / NN</div></div>
    <div class="stack gap-7" style="margin:auto 0;max-width:800px">
      <hr class="rule-amber">
      <p class="h-display">[必填] 金句本体，<br>两到三行。</p>
      <p class="body-sm">[必填] 一行小注：语境或出处。</p>
    </div>
    <div class="foot"><div class="mark">[必填] 署名</div><div>02 / NN</div></div>
  </div>
</section>
```

### HC03 · 影像卡

影像占 ≥60% 高；文字退到下方，像画册的图版页。

```html
<section class="poster white" id="xhs-03" data-layout="HC03" data-density-exempt="hero">
  <div class="content">
    <div class="chrome"><div>[必填] 栏目</div><div>03 / NN</div></div>
    <figure class="img-slot" data-image-slot="xhs-03-scene" data-slot-ratio="fill" data-slot-desc="[必填] 影像内容" style="flex:1">
      <img src="assets/xhs-03-scene.jpg" alt="[必填]" style="object-position:center 45%">
    </figure>
    <div class="stack gap-4" style="padding-top:44px">
      <h2 class="h-xl">[必填] 影像要说的一句话</h2>
      <p class="img-cap"><span class="cap-serif">[必填] 图注</span> · 自然光 · 未修饰</p>
    </div>
    <div class="foot"><div class="mark">[必填] 署名</div><div>03 / NN</div></div>
  </div>
</section>
```

### HC04 · 手记清单卡

```html
<section class="poster" id="xhs-04" data-layout="HC04">
  <div class="content">
    <div class="chrome"><div>[必填] 栏目</div><div>04 / NN</div></div>
    <div class="stack gap-4" style="margin-bottom:52px">
      <div class="kicker">[必填] KICKER</div>
      <h2 class="h-display-sm">[必填] 清单标题</h2>
    </div>
    <div class="ledger" style="flex:1">
      <div class="ledger-row"><div class="ledger-no">01</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句展开</div></div><div class="ledger-meta">[必填]</div></div>
      <div class="ledger-row"><div class="ledger-no">02</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句展开</div></div><div class="ledger-meta amber-text">[必填]</div></div>
      <div class="ledger-row"><div class="ledger-no">03</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句展开</div></div><div class="ledger-meta">[必填]</div></div>
      <div class="ledger-row"><div class="ledger-no">04</div><div><div class="ledger-title">[必填] 条目</div><div class="ledger-desc">[必填] 一句展开</div></div><div class="ledger-meta">[必填]</div></div>
    </div>
    <div class="foot"><div class="mark">[必填] 署名</div><div>04 / NN</div></div>
  </div>
</section>
```

Minimum density：标题块 + ≥4 行 ledger；3 行时加 `lead` 引导段或转 HC06。

### HC05 · 数据卡

```html
<section class="poster white" id="xhs-05" data-layout="HC05">
  <div class="content">
    <div class="chrome"><div>[必填] 栏目 · 实证</div><div>05 / NN</div></div>
    <div class="stack gap-4">
      <div class="kicker">[必填] KICKER</div>
      <h2 class="h-display-sm">[必填] 数据要说的那句话</h2>
    </div>
    <div class="stack gap-6" style="margin:auto 0">
      <div class="stat-num">-30.9<span class="stat-unit">%</span></div>
      <div class="dot-chart" data-type="hbar"
           data-values="14,10,7,4" data-labels="配方 A,配方 B,配方 C,对照"
           data-unit="1" data-hot="0" data-dot="18"></div>
    </div>
    <p class="t-meta">来源 · [必填]（真实数据）</p>
    <div class="foot"><div class="mark">[必填] 署名</div><div>05 / NN</div></div>
  </div>
</section>
```

### HC06 · 步骤卡

`steps-v` 三步（序号用「一 / 二 / 三」，明体琥珀）。结构同 PPT H10，字号已按卡片档。

### HC07 · 对比卡

上 `card-inset`（以前）+ 下 `card`（现在），各 `flex:1`；label plain vs label（琥珀）。

### HC08 · 双图卡

```html
<section class="poster white" id="xhs-08" data-layout="HC08" data-density-exempt="hero">
  <div class="content">
    <div class="chrome"><div>[必填] 栏目</div><div>08 / NN</div></div>
    <h2 class="h-xl" style="margin-bottom:40px">[必填] 两张图之间的那句话</h2>
    <div class="stack gap-5" style="flex:1">
      <figure class="img-slot r-3x2" data-image-slot="xhs-08-a" data-slot-ratio="3:2" data-slot-desc="[必填] 上图">
        <img src="assets/xhs-08-a.jpg" alt="[必填]" style="object-position:center 50%">
      </figure>
      <figure class="img-slot r-3x2" data-image-slot="xhs-08-b" data-slot-ratio="3:2" data-slot-desc="[必填] 下图">
        <img src="assets/xhs-08-b.jpg" alt="[必填]" style="object-position:center 50%">
      </figure>
      <p class="img-cap"><span class="cap-serif">上 · [必填]</span>　<span class="cap-serif">下 · [必填]</span></p>
    </div>
    <div class="foot"><div class="mark">[必填] 署名</div><div>08 / NN</div></div>
  </div>
</section>
```

### HC09 / HC10 · 微信封面对

模板示例即是。1:1 短标题从长标题提炼（4-8 字核心对象+动作），禁止塞长标题；两张分开构图。

---

## Human Touch 卡片纪律

- 明体只做标题/金句/图注强调；正文全部悠黑系 sans，行距 ≥1.7。
- 红每卡 ≤1 处；琥珀渐变卡整组 ≤1 张（用 `.poster.amber`）。
- 直角/无阴影/无 mono/无玻璃——校验器 C5 会拦。
- 正文 ≥28px（模板 `.body` 30px）；图注 ≥20px；图表点径 ≥16px。
- 影像不过度修饰；`object-position` 逐张指定；人脸/主体不裁。
