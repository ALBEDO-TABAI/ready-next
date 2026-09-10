# 多标签与侧栏收放性能修复

日期：2026-09-10。范围：浏览器标签更新、原生页面几何同步、文档重复预览计算。

## 完成合同

1. 浏览器真实 store 更新一个标签后，其余标签与分组对象保持不变；切换活动标签不重建整列。分组连续性、成员清理与持久化快照继续由现有归一化入口负责。
2. 点击侧栏收放和拖动改变内容尺寸时，ResizeObserver 直接提交本次测量，不能再等待下一帧；重复尺寸不重复发送，隐藏与卸载后的旧请求不得显示网页。
3. 已显示的原生页面重复收到 show 时不拆卸重挂；分栏尺寸更新也遵守同一规则。窗口重建、隐藏后恢复仍正确挂载。
4. 纯主页面位置更新不重新检查全部后台标签的负载状态；显示、隐藏与分栏变更继续检查。保留过期意图拦截和 overlay hide acknowledgement。
5. 文档切换复用有界、绑定完整内容和路径的预览计算；编辑或文件路径变化必须得到新结果。继续释放隐藏的普通编辑面与媒体，不以无限保活换速度。
6. 近期段落可复用 Markdown 语法树，但 HTML 节点、链接安全处理和当前组件回调每次重新生成；GFM 表格、任务列表、删除线与危险链接反例必须通过。文档重新进入可见场景时恢复滚动位置。

## 验证

- `verify:workbench-performance`：真实 store、React hook 与原生 host service 的行为回归，包含反例。
- `verify:browser-perf`、`verify:document-perf`、`typecheck`、CSS 规则；持久化和包体阶段运行 `verify:native`。
- 真实 Electron：多标签连续切换、文档滚动与编辑状态、左栏点击收放及拖动、分栏、遮罩与快速反向切换。记录安装版、修复源码、构建和安装的独立证据。

## 当前证据

- 2026-09-10 安装版为 `/Applications/Ready.app`，版本 0.8.0；已打开约 20 个浏览器标签及多份文档。
- 浏览器日志同次操作可见多个 `show`。源码中 `sanitizeSnapshot` 每次克隆全部标签、`showHost` 每次 remove/add、click-toggle 的 ResizeObserver 再排一次 rAF。
- Time Profiler 在本机不可用；使用 macOS `sample` 与 Electron 页面性能记录，不把缺失的 trace 当通过。
- 首轮真实 Electron CPU profile 显示长文档切回仍重复运行 Markdown parser；后续优化限定在近期文档的纯解析树，不延长媒体实例生命。
