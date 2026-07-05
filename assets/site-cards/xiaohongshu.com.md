---
title: 小红书站点经验
description: 采集小红书的反爬、登录墙与选择器经验
confidence: H
tag: knowledge
created: 2026-06-11
status: active
site: xiaohongshu.com
---

- 反爬：脚本检测严格；Safe Mode 走视觉/工具通道和命名只读模板，Power Mode 可在用户授权下用 eval/CDP 做页面结构、控件定位和网络观察，动作要低频并保留审计。
- 登录墙：详情页需登录态；未登录只能看到列表摘要。
- 发布后台：优先探测 file input、文本编辑区、发布按钮和 disabled/校验状态；每步操作后读回验证，不要只凭截图猜。
- 写长文发布流程（避免在"找发布按钮"上空转耗尽预算）：① 创作页默认停在"上传视频"tab，发文字长文必须先点"写长文"tab（map 里角色可能是 clickable "写长文"）并 read map 确认已切换（页面出现标题输入框 + 正文富文本编辑器，而不是 file input/上传视频）；② 标题为必填项——用户只给正文时，用正文首句或一句话摘要作标题；③ 正文填入 .tiptap/ProseMirror 编辑器后 read map 读回确认已入文；④ **长文编辑器没有直接的"发布"按钮**：底部只有「暂存离开」和「一键排版」，必须先点「一键排版」进入排版预览，预览页才会出现「发送/发布」入口——不要在编辑页反复找"发布/下一步"按钮；⑤ 点「发送/发布」后以成功页信号（发布成功/跳转）作为完成证据。
- 发布页 read map 目标数异常少（例如 <5）：几乎总是 SPA 尚未渲染完——先 browser_wait 或 wait_for_condition(page_readable) 再重读 map；不要转 Power CDP 猜 frame tree（"写长文"等控件不在 iframe，是主文档的委托型元素，渲染完成后 map 可见）。
- map 里找不到明确看到过的按钮（如底部「发布/发送/一键排版」）：直接用 browser_click_text 按精确文本点击——它自带 cursor:pointer owner 回退、shadow root 穿透与跨帧回退，不依赖 map 枚举；不要花多轮 Power eval 自查 DOM。
- 发布类主按钮是 Web Component（实测 `<xhs-publish-btn>`，真实按钮藏在 closed shadow root 里，且 **host 包围盒横跨「暂存离开」+「发布」整个按钮组**，中心点是两按钮之间的死区）：直接 act_on_target 点它——工具会**自动在 host 内扫描真实内部按钮再补可信指针点击**（结果 `escalation.via` 显示匹配方式、`escalation.pointTarget` 显示实际点到的元素）。给 act 传 disambiguation 时写上目标按钮的可见文字（如「发布」），扫描靠它消歧；若结果返回 `skipped=ambiguous_shadow_candidates`，直接从 `candidates` 里选「发布」，按其 normalized 坐标 browser_click_at，一步完成，不要重复 act 同一 target。若 `escalation.changed=false` 且 pointTarget 已是「发布」，先滚动让按钮完整入视口再重试。
- 发布设置页可能弹「站点想使用定位」权限请求：agent 驾驶期间会被自动拒绝并继续（下一个工具结果带 sitePermissionNotices），发布不需要定位，不要因此中断流程。
- 选择器：feed 卡片为 data-v 动态属性，优先用角色+可访问名或截图坐标，不要依赖类名。
- 限速：连续翻页/快速滚动易触发验证，放慢节奏、分批采集。
- 轮播：图文笔记常为多图轮播，逐帧采集并按 URL 去重。
- **严禁用 power_eval 给标题/正文赋值**（第十三轮实锚）：`el.value=`/innerText 直写会被 React/ProseMirror 吞掉，页面进入"发布按钮点了没反应、人点也无效"的坏状态且不可恢复（只能新开 tab 重来）。
- **标题和正文都优先 act fill 对应 target**（第十四轮实锚：act fill 正文 contenteditable 编辑器 target 一次成功，坐标打字盲试了 4 分钟）：标题 target 是「输入标题」textarea，正文 target 用 read map 或 browser_probe_readonly(scope=forms) 拿 contenteditable/.tiptap 编辑器条目。type_at 只作兜底：结果 typedInto（label+textHead）显示文字真实落点，落点不对立即全选删除、改 act fill；返回 `type_target_not_editable` 说明坐标点在死区，别原地重试。
- **标题 textarea 会随内容自动增高**：标题一旦多行，正文编辑器整体下移，之前量的坐标全部过期——填写期间不要复用旧坐标，改用 target 定位。
- click_at/type_at 坐标是 0-1000 归一化：power_eval 量出的像素要除以视口宽高再乘 1000；点完看结果里的 pointTarget（label/tag/editable）是否是你要的目标。
