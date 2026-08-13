import {
  LOCAL_FEISHU_DOCUMENT_OPERATION_PATTERN,
  LOCAL_FEISHU_DOCUMENT_RESOURCE_PATTERN,
  hasExplicitLocalFeishuCliIntent,
  hasExplicitLocalFeishuCliMention,
  withoutQuotedLocalFeishuCliMentions,
} from './local-feishu-cli-intent'

const LOCAL_FEISHU_CLI_PATTERN = /(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))/i
const LOCAL_FEISHU_CLI_FOLLOWUP_PATTERN = /(?:\bcli\b|命令行)/i
const LOCAL_FEISHU_SETUP_BEFORE_CLI_PATTERN = /(?:安装|配置|初始化|接入|部署|升级|更新|重装|授权|认证|登录|修复|\binstall\b|\bsetup\b|\bset\s+up\b|\bconfigur(?:e|ation)\b|\binitiali[sz]e\b|\bupgrade\b|\bupdate\b|\bauthori[sz]e\b|\bauthenticat(?:e|ion)\b|\blog\s+in\b|\blogin\b|\bfix\b|\brepair\b|\breinstall\b)/i
const LOCAL_FEISHU_UNAMBIGUOUS_SETUP_AFTER_CLI_PATTERN = /(?:安装|配置|初始化|接入|部署|升级|重装|授权|认证|登录|修复|\binstall\b|\bsetup\b|\bset\s+up\b|\bconfigur(?:e|ation)\b|\binitiali[sz]e\b|\bupgrade\b|\bauthori[sz]e\b|\bauthenticat(?:e|ion)\b|\blog\s+in\b|\blogin\b|\bfix\b|\brepair\b|\breinstall\b)/i
const LOCAL_FEISHU_UPDATE_CLI_AFTER_PATTERN = /(?:更新|升级|\bupdate\b|\bupgrade\b).*(?:\bcli\b|命令行)/i
const LOCAL_FEISHU_NEGATED_SETUP_PATTERN = /(?:不需要|没必要|无必要|不必|无需|不要|勿|别|不|don['’]?t\s+need\s+to|do\s+not\s+need\s+to|no\s+need\s+to|don['’]?t|do\s+not)\s*(?:再\s*)?(?:安装|配置|初始化|接入|部署|升级|更新|重装|授权|认证|登录|修复|\binstall\b|\bsetup\b|\bconfigur(?:e|ation)\b|\binitiali[sz]e\b|\bupgrade\b|\bupdate\b|\bauthori[sz]e\b|\bauthenticat(?:e|ion)\b|\blog\s+in\b|\blogin\b|\bfix\b|\brepair\b|\breinstall\b)/i
function hasLocalFeishuCliSetupClause(text: string): boolean {
  const clauses = text.split(/(?:，|,|。|；|;|然后|之后|随后|再去|再来|并且|同时)/i)
  return clauses.some((clause) => {
    const cliMatch = LOCAL_FEISHU_CLI_PATTERN.exec(clause)
      || (hasExplicitLocalFeishuCliMention(text) ? LOCAL_FEISHU_CLI_FOLLOWUP_PATTERN.exec(clause) : null)
    if (!cliMatch || cliMatch.index === undefined) return false
    const normalizedClause = `${clause.slice(0, cliMatch.index)}飞书 CLI${clause.slice(cliMatch.index + cliMatch[0].length)}`
    if (!hasExplicitLocalFeishuCliIntent(normalizedClause)) return false
    if (LOCAL_FEISHU_NEGATED_SETUP_PATTERN.test(normalizedClause)) return false
    const before = clause.slice(0, cliMatch.index)
    const after = clause.slice(cliMatch.index + cliMatch[0].length)
    const setupContext = before.split(/(?:并且|并|以及|\band\b)/i).at(-1) || before
    if (
      LOCAL_FEISHU_DOCUMENT_OPERATION_PATTERN.test(setupContext)
      && LOCAL_FEISHU_DOCUMENT_RESOURCE_PATTERN.test(setupContext)
    ) return false
    const setupBefore = LOCAL_FEISHU_SETUP_BEFORE_CLI_PATTERN.exec(setupContext)
    if (setupBefore?.index !== undefined
      && !LOCAL_FEISHU_DOCUMENT_OPERATION_PATTERN.test(setupContext.slice(0, setupBefore.index))) {
      return true
    }
    if (LOCAL_FEISHU_UPDATE_CLI_AFTER_PATTERN.test(after)) return true
    const setupAfter = LOCAL_FEISHU_UNAMBIGUOUS_SETUP_AFTER_CLI_PATTERN.exec(after)
    if (!setupAfter || setupAfter.index === undefined) return false
    const between = after.slice(0, setupAfter.index)
    return !LOCAL_FEISHU_DOCUMENT_OPERATION_PATTERN.test(between)
  })
}

export function hasExplicitSetupCommandIntent(text: string): boolean {
  let intentText = withoutQuotedLocalFeishuCliMentions(text)
  if (hasExplicitLocalFeishuCliMention(intentText) && !hasExplicitLocalFeishuCliIntent(intentText)) {
    intentText = intentText
      .split(/(?:，|,|。|；|;|\bbut\b|但是|但|而是)/i)
      .filter((clause) => !hasExplicitLocalFeishuCliMention(clause))
      .join(' ')
      .trim()
    if (!intentText) return false
  }
  const setupAction =
    /(?:安装|配置|初始化|接入|部署|升级|更新|重装|授权|认证|登录|修复(?:本机|本地)?(?:环境|配置|安装)|\binstall\b|\bsetup\b|\bset\s+up\b|\bconfigur(?:e|ation)\b|\binitiali[sz]e\b|\bupgrade\b|\bupdate\b|\bauthori[sz]e\b|\bauthenticat(?:e|ion)\b|\blog\s+in\b|\blogin\b)/i
  const commandTarget =
    /(?:\b(?:cli|command(?:[ -]?line)?|binary|executable|sdk|ffmpeg|homebrew|brew|npm|npx|pnpm|yarn|pip|pipx|uv|uvx|cargo|winget|choco|apt|dnf|yum)\b|命令行|命令|本机程序|本地程序|开发环境|运行环境|依赖|软件|工具|(?:lark|feishu)[-_ ]?cli)/i
  const diagnosticOnly =
    /(?:为什么|为何|怎么回事|什么原因|报错|失败|超时|状态|是否|有没有|是不是|能否|能不能|成功了吗|好了吗|检查|查看|看看|验证|\bwhy\b|\bstatus\b|\bcheck\b|\bverify\b|\berror\b|\bfailed?\b|\btimeout\b)/i
  const explicitDirective =
    /(?:请|帮我|给我|现在|直接|开始|继续|重新|重装|修复|解决|处理|搞定|走.{0,8}流程|\bplease\b|\bfix\b|\brepair\b|\bstart\b|\bretry\b|\breinstall\b)/i
  const remediationDirective = /(?:修复|解决|重装|重新安装|重新配置|\bfix\b|\brepair\b|\breinstall\b|\breconfigure\b)/i
  if (hasExplicitLocalFeishuCliIntent(intentText)) {
    if (!hasLocalFeishuCliSetupClause(intentText)) return false
  }
  return setupAction.test(intentText)
    && commandTarget.test(intentText)
    && (!diagnosticOnly.test(intentText) || remediationDirective.test(intentText) || (explicitDirective.test(intentText) && !/(?:查看|看看|检查|验证|状态|有没有|是否)/i.test(intentText)))
}
