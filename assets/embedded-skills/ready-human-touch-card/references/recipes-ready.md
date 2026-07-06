# 卡片配方 · 风格 R（Ready 点阵理性）RC01–RC10

> 每张 `<section class="poster ...">` 必须带唯一 `id`（`xhs-01` / `wechat-21x9` / `wechat-1x1`…）和 `data-layout="RCxx"`。
> 类名全部来自 `assets/template-ready-card.html`；`.content` 内自带画板级 padding，**子层不要再叠横向 padding**。
> 3:4 硬密度：闭合量法下内容覆盖 ≥52% 画布高且无相邻空带（校验器 C4；组内 ≤48px 呼吸间距算连续占用）；禁止 `flex:1` 空 div 上下夹击；金句/hero 卡加 `data-density-exempt="statement"` 并确保视觉有主角。

## 配方速查

| ID | 名称 | 画板 | 要点 |
|---|---|---|---|
| RC01 | 封面钩子 | xhs | dotword + 大标题 + 点网底（模板示例） |
| RC02 | 大数字卡 | xhs | kpi-num + waffle 对照 |
| RC03 | 清单卡 | xhs | row-list 3–5 行 |
| RC04 | 图表卡 | xhs | bar/hbar + 结论标题 |
| RC05 | 截图证据卡 | xhs | 大图井 + 玻璃标题条 |
| RC06 | 对比卡 | xhs | 上下双 card |
| RC07 | 流程卡 | xhs | tl-v 3–5 步 |
| RC08 | 引用卡 | xhs | 点阵冒号 + 大引文 |
| RC09 | 微信主封面 | wide | 21:9（模板示例） |
| RC10 | 微信方封面 | square | 1:1 短标题（模板示例） |

---

### RC02 · 大数字卡

一个数字站住整卡。上：kicker+结论句；中：kpi-num；下：waffle 或三行 meta 对照。

```html
<section class="poster xhs" id="xhs-02" data-layout="RC02">
  <div class="content">
    <div class="chrome"><div>DATA</div><div>02 / NN</div></div>
    <div class="stack gap-5">
      <div class="t-label">[必填] 指标名</div>
      <h2 class="h-xl">[必填] 这个数字说明什么</h2>
    </div>
    <div class="stack gap-6" style="margin:auto 0">
      <div class="kpi-num">4.2<span class="kpi-unit">万 / 月</span></div>
      <div class="dot-chart" data-type="waffle" data-percent="62" data-label="[必填] 口径" data-dot="20"></div>
    </div>
    <p class="body-sm">[必填] 1-2 句解释 + 边界条件。</p>
    <div class="foot"><div><span class="brand-dot"></span>[必填] 署名</div><div>来源 · [必填]</div></div>
  </div>
</section>
```

### RC03 · 清单卡

```html
<section class="poster xhs" id="xhs-03" data-layout="RC03">
  <div class="content">
    <div class="chrome"><div>[必填] 栏目</div><div>03 / NN</div></div>
    <div class="stack gap-4" style="margin-bottom:48px">
      <div class="t-label">[必填] Kicker</div>
      <h2 class="h-display-sm">[必填] 清单标题</h2>
    </div>
    <div class="row-list" style="flex:1">
      <div class="row-item">
        <div class="row-icon"><i data-lucide="folder" style="width:26px"></i></div>
        <div><div class="row-title">[必填] 要点一</div><div class="row-desc">[必填] 一句展开</div></div>
        <div class="row-meta"><span class="status-dot done"></span></div>
      </div>
      <div class="row-item">
        <div class="row-icon"><i data-lucide="zap" style="width:26px"></i></div>
        <div><div class="row-title">[必填] 要点二</div><div class="row-desc">[必填] 一句展开</div></div>
        <div class="row-meta"><span class="status-dot now"></span></div>
      </div>
      <div class="row-item">
        <div class="row-icon"><i data-lucide="layers" style="width:26px"></i></div>
        <div><div class="row-title">[必填] 要点三</div><div class="row-desc">[必填] 一句展开</div></div>
        <div class="row-meta">next</div>
      </div>
      <div class="row-item">
        <div class="row-icon"><i data-lucide="calendar" style="width:26px"></i></div>
        <div><div class="row-title">[必填] 要点四</div><div class="row-desc">[必填] 一句展开</div></div>
        <div class="row-meta">next</div>
      </div>
    </div>
    <div class="foot"><div><span class="brand-dot"></span>[必填] 署名</div><div>03 / NN</div></div>
  </div>
</section>
```

Minimum density：标题块 + ≥4 行（每行 title+desc）+ foot 刚好吃满 1440；只有 3 行时加一段 `lead` 引导或换 RC04。

### RC04 · 图表卡

```html
<section class="poster xhs" id="xhs-04" data-layout="RC04">
  <div class="content">
    <div class="chrome"><div>DATA</div><div>04 / NN</div></div>
    <div class="stack gap-4">
      <div class="t-label">[必填] Kicker</div>
      <h2 class="h-display-sm">[必填] 图表的结论句</h2>
      <p class="body-sm">[必填] 数据从哪来、为什么重要。</p>
    </div>
    <div class="dot-chart" data-type="bar" style="margin:auto auto"
         data-values="6,9,13,11,8" data-labels="一,二,三,四,五"
         data-unit="1" data-unit-label=" 万" data-hot="2" data-dot="22"></div>
    <div class="foot"><div><span class="brand-dot"></span>[必填] 署名</div><div>来源 · [必填]</div></div>
  </div>
</section>
```

hbar 版本：`data-type="hbar"`、4–6 行、`data-dot="20"`。

### RC05 · 截图证据卡

```html
<section class="poster xhs" id="xhs-05" data-layout="RC05">
  <div class="content">
    <div class="chrome"><div>CASE</div><div>05 / NN</div></div>
    <figure class="img-slot r-3x4" data-image-slot="xhs-05-shot" data-slot-ratio="3:4" data-slot-desc="[必填] 截图内容" style="flex:1;aspect-ratio:auto">
      <img src="assets/xhs-05-shot.png" alt="[必填]" style="object-position:center 20%">
      <div class="glass-panel" style="position:absolute;left:36px;right:36px;bottom:36px">
        <div class="t-label" style="margin-bottom:10px">[必填] Kicker</div>
        <div class="h-md">[必填] 这张图证明了什么</div>
      </div>
    </figure>
    <div class="foot"><div><span class="brand-dot"></span>[必填] 署名</div><div>05 / NN</div></div>
  </div>
</section>
```

要点：井用 `flex:1` 吃满中段（inline `aspect-ratio:auto` 解除比例锁）；文字密集截图给 `fit-contain`。

### RC06 · 对比卡

```html
<section class="poster xhs" id="xhs-06" data-layout="RC06">
  <div class="content">
    <div class="chrome"><div>COMPARE</div><div>06 / NN</div></div>
    <h2 class="h-display-sm" style="margin-bottom:44px">[必填] 对比主题</h2>
    <div class="stack gap-5" style="flex:1">
      <div class="card-quiet" style="flex:1">
        <span class="pill" style="margin-bottom:20px">Before · [必填]</span>
        <h3 class="h-md">[必填] 旧方式</h3>
        <p class="body" style="margin-top:12px">[必填] 2-3 句：代价与摩擦。</p>
      </div>
      <div class="card" style="flex:1">
        <span class="pill hot" style="margin-bottom:20px"><span class="status-dot now"></span>After · [必填]</span>
        <h3 class="h-md">[必填] 新方式</h3>
        <p class="body" style="margin-top:12px">[必填] 2-3 句：改变了什么。</p>
      </div>
    </div>
    <div class="foot"><div><span class="brand-dot"></span>[必填] 署名</div><div>06 / NN</div></div>
  </div>
</section>
```

### RC07 · 流程卡

`tl-v` 竖时间线 3–5 步；当前步 `now`（橘点）。结构同 PPT R14，字号已按卡片档。

### RC08 · 引用卡

```html
<section class="poster xhs warm" id="xhs-07" data-layout="RC08" data-density-exempt="statement">
  <div class="content">
    <div class="chrome"><div>QUOTE</div><div>07 / NN</div></div>
    <div class="stack gap-6" style="margin:auto 0">
      <div class="dotword dw-dim" data-text=":" data-dot="16"></div>
      <p class="h-display" style="font-weight:500">[必填] 引文本体，三行以内，让它站住。</p>
      <p class="t-label">—— [必填] 出处 · 年份</p>
    </div>
    <div class="foot"><div><span class="brand-dot"></span>[必填] 署名</div><div>07 / NN</div></div>
  </div>
</section>
```

### RC09 / RC10 · 微信封面对

模板示例即是。规则见 `platform-specs.md`：两张分开构图（禁止裁切复用）；1:1 用 4-8 字短标题；`pair-preview` 仅审查用，交付两张单图。

---

## Ready 卡片纪律

- dotword 每卡 ≤1 处（封面/引用/方封面）；中文永远系统字。
- 点网底 `dotscape` 只给封面/收尾/方封面；内容卡素底。
- 橘红元素每卡 ≤4 处；玻璃面板每卡 ≤1 块且只为压图。
- 正文 ≥28px、图注 meta ≥20px、图表点径 ≥16px（校验器 C3 red line 18px）。
- 一组卡里 chrome/foot 格式必须完全一致（栏目名、页码、署名）。
