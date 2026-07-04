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
- 发布类主按钮是 Web Component（实测 `<xhs-publish-btn>`，真实按钮藏在 shadow root 里）：map 会把这类自定义元素 host 收录为 clickable（名字取渲染文本，如「发布」），直接 act_on_target 点它即可——工具在合成点击无效果时会**同一次调用内自动升级为可信指针点击**（结果带 `escalation` 字段），无需手动改用 browser_click_at；若 `escalation.changed=false`，先滚动让按钮完整入视口再重试。
- 发布设置页可能弹「站点想使用定位」权限请求：agent 驾驶期间会被自动拒绝并继续（下一个工具结果带 sitePermissionNotices），发布不需要定位，不要因此中断流程。
- 选择器：feed 卡片为 data-v 动态属性，优先用角色+可访问名或截图坐标，不要依赖类名。
- 限速：连续翻页/快速滚动易触发验证，放慢节奏、分批采集。
- 轮播：图文笔记常为多图轮播，逐帧采集并按 URL 去重。
