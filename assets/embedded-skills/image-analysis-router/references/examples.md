# High-risk Examples

These are compact anchors for cases where route choice often drifts. They are not exhaustive examples for every route. This file is linked from [route-matrix.md](./route-matrix.md) (tie-breakers) and [output-contract.md](./output-contract.md) (sample skeleton); read it when two routes stay plausible after visual inspection.

## Batch mixed domain

Input: `poster.jpg`, `room-render.png`, `xray.png`; prompt says "分析这组混合参考图".

- Route: `generic-mixed`
- Batch type: `mixed_domain`
- Output: group poster under `graphic-design`, room render under `interior-design`, x-ray under `scientific-medical-imaging`, then synthesize why these references do or do not belong together.
- A strong prompt keyword ("海报") must not flatten the batch: the x-ray still gets its own route and the medical-safety rule still applies.

## Architecture vs photography

Input: `tower-facade-photo.jpg`.

- If prompt says "看摄影构图和光线", route to `photography`.
- If prompt says "看建筑立面比例和街道关系", route to `architecture-urban`.

The same image can route differently because the user's lens changes the useful critique.

## Generic analysis words are not photography signals

Input: "分析这幅油画的构图" with a neutral filename like `IMG_3001.jpg`.

- Route: `painting-illustration`. "构图" and "光线" are shared vocabulary across every visual route; they do not imply camera critique.
- A camera-default filename (IMG_/DSC_) is a weak hint, not proof of a photography question — the subject named in the prompt wins.

## Product ad vs product design

Input: `earbuds-render.jpg`.

- If prompt asks about ad persuasion, CTA, layout, or selling power, route to `graphic-design`.
- If prompt asks about form, material, CMF, ergonomics, seams, or manufacturing, route to `product-industrial-design`.

## Medical evidence inside a graphic

Input: `xray-health-campaign-poster.jpg`; prompt asks about poster persuasion.

- Primary route can be `graphic-design`.
- Medical safety still applies because the visual evidence contains an x-ray.
- Avoid diagnostic language and judge the poster's communication instead.
- The reverse guard also matters: a `contract-scan.png` or a `product-ct.jpg` is NOT medical evidence; do not let generic words like "scan" trip the safety flag.

## Dashboard and UI

Input: `sales-dashboard-report.png` or `settings-screen.png`.

- If the prompt asks about reporting, decision support, KPI scan path, or executive readability, route to `presentation-document`.
- If the prompt asks about data encoding correctness or misreading risk, route to `infographic-diagram`.
- If the prompt asks about a screen someone operates — app states, controls, interaction clarity, empty/loading/error handling — route to `ui-product`.
- In-game menus, HUD, and inventory screens stay in `game-visual-design` even though they are interfaces.

## Sample report skeleton

A `standard`-depth single-image answer should look like this (headings in the user's language):

```markdown
**路由判定**: graphic-design · status ok · route_confidence high · intent_confidence high · standard
一句话理由：画面以标题层级与 CTA 排布为主，用户关心版式说服力。

## 分析报告
### 快速解读
- 3-5 条最重要的发现，每条绑定可见证据

### 详细分析
（按 method 文件的 Core lenses 逐层展开；证据分 FACT / 推断 / 假设三档措辞）

### 总体判断
这张图想做什么、实际落在哪里、最大的强项与短板。

## 学习报告
### 现在该学什么
### 练习
- 练习名 — Do: 具体动作 / Finish: 完成标准
### 下次注意
```
