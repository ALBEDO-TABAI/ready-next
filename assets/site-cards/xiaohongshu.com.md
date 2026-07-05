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
- 发布类主按钮是 Web Component（实测 `<xhs-publish-btn>`，真实按钮藏在 closed shadow root 里，且 **host 包围盒横跨「暂存离开」+「发布」整个按钮组**，中心点是两按钮之间的死区）：直接 act_on_target 点它——工具会**自动在 host 内扫描真实内部按钮（含 disabled/遮挡状态）再补可信指针点击**。给 act 传 disambiguation 时写上目标按钮的可见文字（如「发布」），扫描靠它消歧。读结果的裁决链（第十七轮实锚，逐项看）：① `escalation.skipped=target_disabled` = 按钮 disabled，页面校验未通过——**停止点击**，去补必填项；② `escalation.pageNotices` = 页面弹过的校验 toast 原文（delta 看不见它，这里才是页面给的拒绝理由）——照提示补；③ `escalation.directInvoke` = 可信指针无效后组合树直接 invoke 的结果；④ `skipped=ambiguous_shadow_candidates` = 从 `candidates` 选「发布」按其 normalized 坐标 browser_click_at。全链都无变化且无提示时，检查「输入正文描述」是否为空、封面是否已生成，补齐后再点；不要原地重复点击。
- 发布设置页可能弹「站点想使用定位」权限请求：agent 驾驶期间会被自动拒绝并继续（下一个工具结果带 sitePermissionNotices），发布不需要定位，不要因此中断流程。
- 选择器：feed 卡片为 data-v 动态属性，优先用角色+可访问名或截图坐标，不要依赖类名。
- 限速：连续翻页/快速滚动易触发验证，放慢节奏、分批采集。
- 轮播：图文笔记常为多图轮播，逐帧采集并按 URL 去重。
- **严禁用 power_eval 给标题/正文赋值**（第十三轮实锚）：`el.value=`/innerText 直写会被 React/ProseMirror 吞掉，页面进入"发布按钮点了没反应、人点也无效"的坏状态且不可恢复（只能新开 tab 重来）。
- **标题和正文都优先 act fill 对应 target**（第十四/十六轮实锚）：标题 target=「输入标题」textarea（**上限 64 字**）；正文 target=**「输入文字，内容将自动保存」**（tiptap contenteditable，map 里 role=textbox 以此占位符命名）。正文绝不塞标题：收到 `type_field_capacity_exceeded` 即打错框，立刻 act fill 正文 target，不要微调坐标重试。type_at 只作兜底：typedInto 显示真实落点；`type_target_not_editable` 说明点在死区。全选删除（Cmd+A+Backspace）前必看 send_keys 结果的 focus 回读，落错框会清掉正文。
- **标题 textarea 会随内容自动增高**：标题一旦多行，正文编辑器整体下移，之前量的坐标全部过期——填写期间不要复用旧坐标，改用 target 定位。
- click_at/type_at 坐标是 0-1000 归一化：power_eval 量出的像素要除以视口宽高再乘 1000；点完看结果里的 pointTarget（label/tag/editable）是否是你要的目标。click_at 打在 `<xhs-publish-btn>` 这类 dash-tag 宿主上时，结果会带 `composedTarget`（组合树真实命中的内部按钮，含 disabled）或 `shadowCandidates`（内部候选连坐标）与 `pageNotices`——按这些事实行动，不要凭空 label 猜测脱靶。
- **长文发布终页（暂存离开+发布）发布前自检**（第十七轮实锚：坐标正确、点击可信但页面无反应）：「输入正文描述」为空时先用正文首段/一句话摘要 act fill 该 target（占位符「输入正文描述，真诚有价值的分享予人温暖」），确认封面图已生成，再点「发布」；成功证据 = URL 跳转/发布成功页，而不是"点了没报错"。
- 编辑页底部按钮组实测已是「暂存离开」+「下一步」（旧「一键排版」文案已下线）：点「下一步」进发布终页；两页的按钮组都是 `<xhs-publish-btn>` closed shadow 宿主，act 扫描/click_at composedTarget 同样适用。
