export const LOCAL_FEISHU_DOCUMENT_OPERATION_PATTERN = /(?:读|查|搜索|找|列出|获取|写|改|更新|编辑|新增|删除|填写|润色|总结|分析|翻译|对比|下载|导出|创建|移动|重命名|\bread\b|\bsearch\b|\bfind\b|\blist\b|\bfetch\b|\bwrite\b|\bedit\b|\bupdate\b|\bdelete\b|\bpolish\b|\bsummari[sz]e\b|\banaly[sz]e\b|\btranslate\b|\bcompare\b|\bdownload\b|\bexport\b|\bcreate\b|\bmove\b|\brename\b)/i
export const LOCAL_FEISHU_DOCUMENT_RESOURCE_PATTERN = /(?:文档|表格|工作表|云盘|云空间|文件|评论|\bdocuments?\b|\bdocx?\b|\bwiki\b|\bsheets?\b|\bspreadsheet\b|\bdrive\b|\bfiles?\b|\bcomments?\b)/i

export function hasExplicitLocalFeishuCliMention(text: string): boolean {
  return /(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))/i.test(text)
}

export function hasExplicitLocalFeishuCliIntent(text: string): boolean {
  const cli = String.raw`(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))`
  const segments = text.split(/(?:，|,|。|；|;|\bbut\b|但是|但|而是)/i)
  const negatedBefore = new RegExp(
    String.raw`(?:不要|别|禁止|避免|无需|不用|不使用|(?:不是|并非)(?:要)?(?:用|使用|通过)|不想(?:用|使用)|不希望(?:用|使用)|永远不要(?:用|使用)|不通过|非通过|do\s+not\s+(?:want(?:\s+to\s+use)?|use|run|execute)|don['’]?t\s+(?:want(?:\s+to\s+use)?|use|run|execute)|not\s+(?:using|running|executing|via|through)|never\s+(?:use|run|execute)|without).*${cli}`,
    'i',
  )
  const negatedAfter = new RegExp(
    String.raw`${cli}.*(?:(?:不要|别|禁止|不想|不希望).*(?:用|使用|调用|通过)|禁用|避免|do\s+not\s+want\s+to\s+use|don['’]?t\s+want\s+to\s+use|do\s+not\s+use|don['’]?t\s+use|never\s+use)`,
    'i',
  )
  return segments.some((segment) => (
    hasExplicitLocalFeishuCliMention(segment)
    && !negatedBefore.test(segment)
    && !negatedAfter.test(segment)
  ))
}

export function hasLocalFeishuCliLocalInputIntent(text: string): boolean {
  return /(?:(?:本地|本机).{0,6}(?:文件|附件)|(?:文件|附件).{0,6}(?:本地|本机)|\blocal\b.{0,24}\b(?:files?|attachments?)\b|\b(?:files?|attachments?)\b.{0,24}\blocal\b|剪贴板|\bclipboard\b)/i.test(text)
    && /(?:读|写|改|更新|编辑|上传|导入|插入|嵌入|\bread\b|\bwrite\b|\bupdate\b|\bedit\b|\bupload\b|\bimport\b|\binsert\b|\bembed\b)/i.test(text)
}

export function withoutQuotedLocalFeishuCliMentions(text: string): string {
  return text
    .replace(/《[^》]*(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))[^》]*》/gi, '')
    .replace(/\b(?:titled|named|called)\s+(["'`])[^"'`\r\n]*(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))[^"'`\r\n]*\1/gi, '')
    .replace(/(?:标题为|名为|叫作|叫做|题为)\s*[“‘"'`][^”’"'`\r\n]*(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))[^”’"'`\r\n]*[”’"'`]/gi, '')
}

export function hasExplicitLocalFeishuCliTaskIntent(text: string): boolean {
  if (!hasExplicitLocalFeishuCliIntent(text)) return false
  const taskText = withoutQuotedLocalFeishuCliMentions(text)
  if (hasLocalFeishuCliLocalInputIntent(taskText)) return false
  const cli = String.raw`(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))`
  const referencedCli = String.raw`["'“”‘’\x60]?${cli}["'“”‘’\x60]?`
  const explicitUseBefore = new RegExp(
    String.raw`(?:用|使用|调用|通过|让|交给|\buse\b|\busing\b|\brun\b|\bexecute\b|\bvia\b)\s*(?:现有的|本地的|全局的|the\s+|existing\s+|local\s+|global\s+)*${referencedCli}`,
    'i',
  )
  const operationAfterCli = new RegExp(
    String.raw`${referencedCli}\s*(?:来|去|帮我|替我|to)?\s*(?:${LOCAL_FEISHU_DOCUMENT_OPERATION_PATTERN.source})`,
    'i',
  )
  return (explicitUseBefore.test(taskText) || operationAfterCli.test(taskText))
    && LOCAL_FEISHU_DOCUMENT_OPERATION_PATTERN.test(taskText)
    && LOCAL_FEISHU_DOCUMENT_RESOURCE_PATTERN.test(taskText)
}

export function hasExplicitLocalFeishuCliStatusIntent(text: string): boolean {
  const statusText = withoutQuotedLocalFeishuCliMentions(text)
  if (!hasExplicitLocalFeishuCliIntent(statusText)) return false
  const cli = String.raw`["'“”‘’\x60]?(?:\b(?:lark|feishu)[-_ ]?cli\b|飞书\s*(?:cli|命令行))["'“”‘’\x60]?`
  const status = String.raw`(?:登录状态|认证状态|是否(?:已经)?登录|有没有登录|是不是(?:已经)?登录|登录了(?:吗|没有)|已登录|\bauth\s+status\b|\blogin\s+status\b|\bwhoami\b)`
  const inspectBefore = new RegExp(
    String.raw`(?:用|使用|查看|看看|检查|验证|\buse\b|\bcheck\b|\bverify\b|\bshow\b)\s*(?:现有的|本地的|全局的|the\s+|existing\s+|local\s+|global\s+)*${cli}[^。；;\r\n]{0,32}${status}`,
    'i',
  )
  const directStatus = new RegExp(String.raw`^\s*${cli}\s+(?:${status})\s*[?？。.]?\s*$`, 'i')
  return inspectBefore.test(statusText) || directStatus.test(statusText)
}

export function hasExplicitLocalFeishuCliSkillIntent(text: string): boolean {
  return hasExplicitLocalFeishuCliTaskIntent(text) || hasExplicitLocalFeishuCliStatusIntent(text)
}
