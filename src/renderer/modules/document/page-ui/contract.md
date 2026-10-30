# T5 Renderer 合同（M3-P1 / C12 UI）

- Main 返回的 PageNode 是页面树唯一真值；Renderer 不再合并文件夹。根目录为空时树查询和目录读取均为零。资料库状态消费 VaultState，missing 根不作为可浏览根。
- 页面/文件切换保存在本机；收藏、最近访问与排序由 DocumentPagesAPI 按 objectId 持久管理。打开页面仍调用 useDocTabs.openTab，与文件树共用对象绑定。
- 树请求以根集合和请求代次绑定，迟到结果不得替换新根；订阅随挂载释放，变化通知合并刷新。操作等待回执后刷新；提交中禁止重复操作，失败明确显示。
- 删除前保存受影响的已打开脏文档；保存失败或仍为脏时禁止回收。恢复冲突保持回收项，打开位置选择器；永久删除单独确认。
- PageHeader 经 properties 读取版本，非标题字段经 patchProperties 局部写入。T2 拒绝 patchProperties.title，故标题经 rename 持久操作同步文件名，随后重新读取版本。组件只导出，由 T6 接入。
- SaveToPicker 浏览树和搜索不修改磁盘；取消不提交。确认回调负责 Main 定稿或移动，成功才记住位置；候选名称只消费 Main 的冲突结果，Renderer 不复制文件名清理规则。预览是预计路径，实际路径以回执为准。
- 移动/恢复固定原文件名，不伪装成改名；排除自己及后代。画板上下文可提供默认同名目录及保留文档卡选项，没有上下文就不显示；M4 调用方负责兑现文档卡回读。
- 行为验证：ready-page-tree.test.ts、ready-page-ui.test.tsx；真实窗口及磁盘回读：verify-ready-next-pages.cjs，由 Claude 运行。
