# 图片槽位协议（双风格共用 · 为"后期换图"而设计）

> 目标：让任何一个后续 agent（或未来的你）能用一句话指令——"把 X 图换到第 3 页主图"——可靠地完成换图。
> 手段：**每个图片位置都是一个有身份的槽位**。DOM 即清单，脚本可枚举，空槽自带铭牌。

## 1. 槽位结构（唯一写法）

```html
<!-- 已填图 -->
<figure class="img-slot r-16x10"
        data-image-slot="p10-detail"        ← 槽位 id，整份文件唯一
        data-slot-ratio="16:10"             ← 铭牌显示用
        data-slot-desc="产品界面局部">        ← 这张图应该是什么
  <img src="images/p10-detail.png" alt="产品界面局部"
       style="object-position:center 40%">  ← 逐张指定，不许省
</figure>

<!-- 空槽（等图）：不放 <img>，加 is-empty -->
<figure class="img-slot r-16x10 is-empty"
        data-image-slot="p10-detail" data-slot-ratio="16:10"
        data-slot-desc="产品界面局部"></figure>
```

规则：

1. **id 命名**：`p{页号两位}-{语义}`（deck）/ `c{卡序两位}-{语义}`（卡片），语义用短英文（hero/detail/scene/object/left/right…）。改页序时 id 跟着页号改。
2. **一图一槽**：所有 `<img>`（本地图）必须住在 `.img-slot` 里并带 `data-image-slot`；禁止裸 img。
3. **比例由槽位定**：从 `r-21x9 / r-16x9 / r-16x10 / r-4x3 / r-3x2 / r-1x1 / r-3x4` 选一个；禁止照抄原图奇葩比例。截图必须保真时加 `fit-contain`。
4. **`object-position` 逐张写**：主体在顶 `center 25-35%`；居中 `center 50%`；中下 `center 60-70%`；人像面部 `center 35%`。默认值只是兜底，不是决定。
5. **空槽即铭牌**：`is-empty` 状态自动渲染槽位 id + 比例 + 用途说明——deck 没图也能先讲结构，用户看到铭牌就知道怎么指挥换图。

## 2. 文件约定

- 图片放在 `index.html` 同级的 `images/` 目录；文件名 = 槽位 id（`images/p10-detail.png`）。
- 规格：单张 ≥1600px 宽；照片/截图 JPG、透明 UI PNG；整包 ≤10MB。
- **同名覆盖是最稳的换图方式**（HTML 零改动）。

## 3. Agent 换图 playbook（逐字可执行）

用户说："把 A.png 放到第 10 页的图上 / 把封面图换成 B"：

1. **列槽位**：`node scripts/list-image-slots.mjs <index.html>` → 得到全部槽位表（id / 页 / 比例 / 状态 / 当前 src / 用途）。
2. **定位目标槽**：按用户描述匹配 id 或 desc；有歧义时把候选槽位列给用户选。
3. **落图**（三选一）：
   - 同名覆盖：把新图存为 `images/<slot-id>.<ext>`（原 src 不变，最推荐）；
   - 换 src：改该槽 `<img src="...">` 指向新文件；
   - 填空槽：去掉 `is-empty`，插入 `<img src="images/<slot-id>.<ext>" alt="<desc>" style="object-position:center 50%">`。
4. **定 object-position**：Read 看一眼图（主体在哪），按 §1.4 写值；文字密集的截图改 `fit-contain`。
5. **验证**：重渲染该页（`node scripts/render-deck.mjs <index.html> renders --slides <页号>`），Read 截图确认主体没被裁掉、没有变形、铭牌消失。
6. **回报**：告知用户改了哪个槽、用哪种方式、object-position 定在哪。

换图**不许**顺手改版式、字号、别的槽位；一次指令只动被点名的槽。

## 4. 校验器强制项（`validate-deck.mjs`）

- 本地 `<img>` 缺 `data-image-slot` → error
- 槽位 id 重复 → error
- `.img-slot` 缺比例类（且无 inline aspect-ratio）→ error
- 已填图缺 inline `object-position`（非 fit-contain）→ warn
