# 已有数据的 Ready 覆盖升级修复

## 事实与范围

真实旧库已到 117。其网关记录表由早期表经记忆迁移增加可空列，727 条请求中有 332 条早于该证据，摘要与数量均为 NULL。118 重建表时把新请求的证据要求回溯应用于这些旧行，导致启动失败。此前空表升级证明未覆盖这种已有记录的形态。

不删除历史事件、不生成虚构摘要、不新增运行期兼容分支、不改真实用户请求或凭证。保留完整私有备份，在副本验证后重新打包安装。

## 可验证合同

1. `gateway migration preserves populated historical unknown evidence and requires complete new evidence`：迁移前后历史字段、顺序、身份、摘要逐项相同；未知仍为成对 NULL；新请求必须有有效摘要和整数数量；单请求单终态与不可变约束仍生效。
2. `gateway migration rolls back populated history when final guard installation fails`：复制后安装约束失败时，整个事务恢复原表、行与索引。
3. `migration 119 installs the same new-write guard for already-upgraded databases`：已完成 118 的库通过新增 119 获得同一套新写入、不可变与单终态约束，补回此前重建可能丢失的索引；不假设修改旧迁移会自动补到既有库。
4. 118 与全新建库仍得到一致的表与约束；重建只在旧表移除之后安装统一索引和触发器，避免同名旧索引占位后丢失。
5. 在真实备份的私有副本执行正式迁移，检查事件逐项保持、外键完整、重复启动幂等；原资料不进入仓库或安装包。
6. 新安装包完成本机覆盖安装，核对安装身份、工作界面与原资料恢复。原基线验收记录保留其真实范围，新增本次已有数据的验收记录。
