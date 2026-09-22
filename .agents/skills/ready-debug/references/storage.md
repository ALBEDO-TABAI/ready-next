# 存储与原生依赖排查

仅在数据读取、迁移或本地持久化症状需要进一步取证时读取。

## 确认目标

数据库默认是目标应用 `userData` 下的 `ready.db`，也可能通过 `READY_DB_PATH` 指定。先核对实际启动参数和 `src/main/modules/database-path.ts`；不要把当前仓库、旧安装版和当前安装版的数据位置混用。

`ready-database.log` 中出现 `NODE_MODULE_VERSION`、加载失败或迁移失败时，先解释该错误和当前症状的关系。没有对应证据时，不默认重编依赖。

## ABI 验证

在故障对应的源码工作区执行：

```bash
npm run native:check
```

该检查使用 Electron 打开 `better-sqlite3` 并运行内存库查询。确认为开发依赖不匹配且修复已在范围内时，执行 `npm run rebuild:native`，再重跑检查；这不会自动更新已安装的 Ready。涉及持久化实现的修复仍须通过 `npm run verify:native`，普通 Node 的 ABI skip 不算验收。

## 只读取所需记录

需要查库时，使用实际只读连接，并先检查当前表结构：

```bash
sqlite3 -readonly "<已确认的数据库绝对路径>"
```

```sql
.schema run_meta
.schema task_projections
```

根据本次日志取得的 run 身份定向查询状态、时间和终止原因；不导出整库、消息正文或凭据。当前字段可对照 `src/main/modules/agent-control/task-projection/run-meta-repository.ts` 与 `src/main/modules/repositories/task-projection-repository.ts`。

不要把状态字符串白名单当成“卡死”判据。核对同一 run 的当前 binding、Main 活跃状态、终态事务与投影；旧 `browser_tasks` / `skill_task_runs` 只有在当前调用链确实涉及它们时才查询，其历史记录不证明当前可续跑。只读诊断中不直接修改任何状态。
