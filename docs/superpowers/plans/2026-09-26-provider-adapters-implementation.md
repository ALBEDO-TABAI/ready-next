# 第三方模型接入现有 Codex 网关

状态：已完成，验收见 `../audits/2026-09-26-provider-adapters-validation.md`。对应实测：`../audits/2026-09-26-provider-connectivity-audit.md`。

## 单一执行边界

保留 Codex 的模型循环和 Ready 的准入、工具授权、历史、凭据与收口。扩展现有网关，不新增服务、调度器或供应商自己的工具循环。供应商转换只能转换协议；任何工具仍经过当前参数验证和 durable response admission。

## 可执行合同（先于实现）

- `codex-provider-adapters.test.ts`：真实形态的 Responses 原始思考流、正文、工具和用量可以完成；篡改 item、缺终态、未授权工具失败，不能发布工具。
- 同一测试：Messages 请求按角色和连续工具结果转换；流式文字立即可见，工具完整 JSON 校验后才交付；签名思考块通过原生历史完整回传；取消、截断、错误均不转成成功。
- 同一测试：GLM 能力只匹配明确官方地址和两个已测模型；陌生代理不继承其能力。原有 Chat/OAuth 回归保持通过。
- `provider-connection-test.test.ts`：连接测试真实请求模型；400/401/403/404、错误 JSON、缺有效正文不能显示成功；与网关共用协议及准入判断。

## 交付检查

1. 小型离线行为测试与既有网关/流式/历史测试。
2. `npm run typecheck`；涉及真实持久化验收时 `npm run verify:native`。
3. 固定 0.149.0 app-server 经过 Ready 网关的三模型真实两轮工具测试；隔离用户设置和数据。NovaCode 若限制客户端，则保留明确外部阻碍，不伪装 Claude Code 身份。
4. 与风险相称的真实 Electron 验收；记录源码、构建与已安装应用边界。
5. 更新受影响的运行合同与超千行文件健康记录；删除临时凭据。
