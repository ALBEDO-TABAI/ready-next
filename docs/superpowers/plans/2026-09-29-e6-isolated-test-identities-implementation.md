---
enforce: true
---

# E6 预检测试的隔离身份输入

范围：只调整验收脚本的依赖组织与测试夹具，不重钉正式身份，不进行真实账号验收。

## 可执行合同（实现前定义）

统一入口：`node --test scripts/__tests__/e6-live-proof-runner-preflight.test.cjs`。

1. `production identities ignore fixture environment variables`：未加载测试 bootstrap 的独立子进程必须仍读取固定生产身份与全局锁目录，环境变量不能切换身份。
2. `isolated provenance rejects mutated fixture identities`：真实校验函数须拒绝夹具 lockfile、依赖内容、Electron、Python 环境和 SQLite 二进制漂移；不得 mock 校验返回值。
3. `trusted build launcher uses an isolated offline fixture`：真实构建启动器在临时目录运行无网络的夹具命令，核对隔离配置、进程身份与产物；不编译或写入真实仓库。
4. 原有冻结数据库、进程组回收、主进程/sidecar 接管、持久确认恢复用例继续通过；测试全部使用独立锁目录、临时数据库与临时输出，且源库指纹不变。

## 最小实现

- 从 `live-proof-runtime.mjs` 与共享 manifest 脚本原样提取固定身份到一个只读 CJS 模块；运行脚本仍固定导入它，不新增环境变量或 CLI 身份配置。
- 全局 lease 的默认目录也从同一个固定模块读取，值保持不变。
- 测试夹具显式替换测试进程的模块缓存，并为子进程提供专用 `--require` bootstrap。替换仅发生在 `scripts/__tests__/helpers` 中；它不模拟数据库/进程回收/身份校验逻辑。
- 文件/目录身份计算提取为同一份纯函数，由生产与夹具共同调用，不复制算法。
- 夹具用小型依赖树、Python 探针与构建命令；SQLite、Node、Git、macOS lockf/ps 仍是真实工具。Codex sidecar 二进制只复制到临时工作区，保持真实进程身份回收验证；不读取账户配置、不访问外部服务。CLI 的本机身份查询在测试 bootstrap 中返回明确夹具身份；外部 CLI 读取入口在同一个测试进程内强制抛错，实际身份解析由它自己的专项测试覆盖。
- 正式 E6 因旧环境身份漂移拒绝运行仍是有效结果。隔离测试通过不等于正式 E6 真实账号验收通过。


## 验收记录

- E6 原有场景与新增反例共 30 项通过，0 skip；真实数据库冻结与进程组回收均保留。
- 正式 runtime 与 Git 固定身份声明与提取前逐字相同；只有测试进程显式加载 bootstrap 时才使用临时身份。
- 后续全量脚本测试结果记录在 [测试清理审计](../audits/2026-09-29-test-suite-cleanup-checklist.md) §10。
