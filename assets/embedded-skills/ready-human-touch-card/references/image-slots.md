# 图片槽位协议（卡片版 · 为"后期换图"而设计）

> 目标：后续 agent 一句话指令（"把这张放到第 3 张卡"）可靠换图。DOM 即清单；空槽自带铭牌。

## 1. 槽位结构

```html
<!-- 已填图 -->
<figure class="img-slot r-3x2"
        data-image-slot="xhs-03-scene"       ← id = 卡 id + 语义，整文件唯一
        data-slot-ratio="3:2"
        data-slot-desc="山间晨光的产品场景">
  <img src="assets/xhs-03-scene.jpg" alt="山间晨光"
       style="object-position:center 45%">
</figure>

<!-- 空槽（等图） -->
<figure class="img-slot r-3x2 is-empty"
        data-image-slot="xhs-03-scene" data-slot-ratio="3:2"
        data-slot-desc="山间晨光的产品场景"></figure>
```

规则：

1. **id 命名 = `{posterId}-{语义}`**（如 `xhs-05-shot`、`wechat-21x9-hero`），语义短英文。
2. 一图一槽；本地 `<img>` 必须住 `.img-slot`；禁止裸 img。
3. 比例从 `r-21x9 / r-16x9 / r-16x10 / r-4x3 / r-3x2 / r-1x1 / r-3x4` 选；满幅井可 `style="flex:1"`（配 `data-slot-ratio="fill"`）。截图保真加 `fit-contain`。
4. `object-position` 逐张写：主体在顶 `center 25-35%`；居中 50%；中下 60-70%；人脸 `center 35%`。
5. 空槽 `is-empty` 自动渲染铭牌（id + 比例 + 用途）——没图先出结构，用户看铭牌指挥换图。
6. 图片文件放任务目录 `assets/`，文件名 = 槽位 id；**同名覆盖是最稳换图方式**。

## 2. Agent 换图 playbook

1. `node scripts/list-image-slots.mjs <index.html>` 列全部槽位。
2. 按用户描述匹配槽位（id/desc）；歧义时列候选让用户选。
3. 落图：同名覆盖 assets/ 文件（首选）｜改 src｜空槽去 `is-empty` 插 img。
4. Read 看图定 `object-position`；文字密集截图给 `fit-contain`。
5. 重渲染该卡验证：`node scripts/render-cards.mjs <index.html> output --only <posterId>`，Read 截图确认主体完整、铭牌消失。
6. 回报改动（槽位/方式/裁切参数）。**只动被点名的槽**，不顺手改版式。

## 3. 校验强制项（validate-cards C6 + 静态检查）

- `is-empty` 里出现 `<img>` → FAIL
- 已填图缺 inline `object-position`（非 fit-contain）→ WARN
- 槽位 id 重复 / 本地图不在槽位里 → 交付前必须清零
