const REMOTE_FILE_WORD_SOURCE = [
  '文件',
  '文档',
  '附件',
  'md',
  'markdown',
  'pdf',
  'docx?',
  'xlsx?',
  '笔记',
  '脚本',
  '报告',
  '方案',
  '资料',
  '表格',
  '稿件?',
  '图片',
  '照片',
  '图像',
  'image',
  'png',
  'jpe?g',
  'webp',
].join('|')
const REMOTE_FILE_WORD_GROUP = `(?:${REMOTE_FILE_WORD_SOURCE})`

const REMOTE_SEND_VERB_SOURCE = '(?:发送|传|发(?!现|起|生|挥|展|表))'
const REMOTE_DIRECTED_SEND_SOURCE =
  `${REMOTE_SEND_VERB_SOURCE}(?:给我|我|一下(?:给我)?|一份|一个|这份|这个|过来|来|到(?:微信|这里|这边|群里|聊天里)|到我这(?:里|边)?)`
const REMOTE_SEND_FILE_SOURCE =
  `${REMOTE_SEND_VERB_SOURCE}(?:一下|一份|一个|这份|这个)?${REMOTE_FILE_WORD_GROUP}`
const REMOTE_RETRY_SEND_SOURCE = '(?:没发成功|没有发成功|发送失败|没收到|未收到|收不到|再发|重发|重新发)'
const REMOTE_GENERATED_CONTENT_SEND_SOURCE =
  '(?:帮我|请)?(?:写|撰写|整理|搜集|收集|搜|搜索|查|生成|制作|起草|找).{0,24}(?:资料|报告|学习笔记|笔记|方案|脚本|稿件|图片资料).{0,16}(?:发给我|发送给我|传给我|发我|发一下|发到(?:微信|这里|这边)|发送到(?:微信|这里|这边)|传到(?:微信|这里|这边))'
const REMOTE_CONCRETE_ATTACHMENT_SOURCE =
  '(?:文件|文档|附件|md|markdown|pdf|docx?|xlsx?|png|jpe?g|webp|图片文件|照片文件)'
const NEGATED_SEND_SOURCE = '(?:不要|别|先别|不用|无需|不必)'
const CANCEL_SEND_SOURCE = '(?:取消|算了|不用了|先算了)'
const SUMMARY_ONLY_SOURCE = '(?:只发|只要|只需要|只给).{0,8}(?:总结|文字|文本|结论|内容)'
const REMOTE_NEGATED_FILE_DELIVERY_SOURCE =
  `(?:${NEGATED_SEND_SOURCE}.{0,16}${REMOTE_SEND_VERB_SOURCE}.{0,16}${REMOTE_FILE_WORD_GROUP}|${NEGATED_SEND_SOURCE}.{0,16}${REMOTE_FILE_WORD_GROUP}.{0,16}${REMOTE_SEND_VERB_SOURCE}|${REMOTE_FILE_WORD_GROUP}.{0,16}${NEGATED_SEND_SOURCE}.{0,16}${REMOTE_SEND_VERB_SOURCE}|${REMOTE_FILE_WORD_GROUP}.{0,24}${REMOTE_DIRECTED_SEND_SOURCE}.{0,16}${CANCEL_SEND_SOURCE}|${SUMMARY_ONLY_SOURCE})`
const LOCAL_IM_TARGET_SOURCE = '(?:微信|远程\\s*IM|remote\\s*im|\\bim\\b|wechat|weixin|wx)'
const LOCAL_RECENT_MEDIA_SOURCE = [
  '(?:这(?:些|几|[一二两三四五六七八九十0-9]+)?张?(?:图|图片|照片|素材))',
  '(?:(?:最近|刚刚|刚才|下载|已下载|保存|选中).{0,12}(?:图|图片|照片|素材))',
  '(?:(?:图|图片|照片|素材).{0,12}(?:最近|刚刚|刚才|下载|已下载|保存|选中))',
].join('|')
const LOCAL_ATTACHED_FILE_SOURCE =
  '(?:这(?:个|些|几张|张)?|它们?|附件|文件|文档|图片|照片|图像|素材|上面(?:的)?|刚(?:传|拖|放|选|上传)(?:的)?)'
const LOCAL_GENERATED_CONTENT_SEND_SOURCE =
  `(?:帮我|请)?(?:写|撰写|整理|搜集|收集|搜|搜索|查|生成|制作|起草|找).{0,24}(?:资料|报告|学习笔记|笔记|方案|脚本|稿件|图片资料|图片|照片).{0,16}(?:发|发送|传).{0,12}${LOCAL_IM_TARGET_SOURCE}`

const remoteFileWordPattern = new RegExp(REMOTE_FILE_WORD_SOURCE, 'i')
const remoteGeneratedContentSendPattern = new RegExp(REMOTE_GENERATED_CONTENT_SEND_SOURCE, 'i')
const remoteConcreteAttachmentPattern = new RegExp(REMOTE_CONCRETE_ATTACHMENT_SOURCE, 'i')
const remoteNegatedFileDeliveryPattern = new RegExp(REMOTE_NEGATED_FILE_DELIVERY_SOURCE, 'i')
const localNegatedSendImPattern = new RegExp(
  `${NEGATED_SEND_SOURCE}.{0,40}${LOCAL_IM_TARGET_SOURCE}|${NEGATED_SEND_SOURCE}.{0,24}@\\[[^\\]]+\\].{0,24}${LOCAL_IM_TARGET_SOURCE}|${LOCAL_IM_TARGET_SOURCE}.{0,24}${NEGATED_SEND_SOURCE}.{0,8}${REMOTE_SEND_VERB_SOURCE}|${LOCAL_IM_TARGET_SOURCE}.{0,24}${CANCEL_SEND_SOURCE}`,
  'i',
)
const localGeneratedContentSendPattern = new RegExp(LOCAL_GENERATED_CONTENT_SEND_SOURCE, 'i')
const remoteFileDeliveryPatterns = [
  new RegExp(`${REMOTE_FILE_WORD_GROUP}.{0,24}${REMOTE_DIRECTED_SEND_SOURCE}`, 'i'),
  new RegExp(`${REMOTE_DIRECTED_SEND_SOURCE}.{0,24}${REMOTE_FILE_WORD_GROUP}`, 'i'),
  new RegExp(REMOTE_SEND_FILE_SOURCE, 'i'),
  new RegExp(`${REMOTE_FILE_WORD_GROUP}.{0,32}${REMOTE_RETRY_SEND_SOURCE}`, 'i'),
  new RegExp(`${REMOTE_RETRY_SEND_SOURCE}.{0,32}${REMOTE_FILE_WORD_GROUP}`, 'i'),
]

export function hasRemoteFileDeliveryIntent(text: string): boolean {
  const value = text.trim()
  if (!value || !remoteFileWordPattern.test(value)) return false
  if (remoteNegatedFileDeliveryPattern.test(value)) return false
  if (remoteGeneratedContentSendPattern.test(value) && !remoteConcreteAttachmentPattern.test(value)) return false
  return remoteFileDeliveryPatterns.some((pattern) => pattern.test(value))
}

export function hasNegatedLocalSendImFileIntent(text: string): boolean {
  const value = text.trim()
  return Boolean(value && localNegatedSendImPattern.test(value))
}

export interface LocalSendImFileIntentOptions {
  hasAttachmentContext?: boolean
}

export function hasLocalSendImFileIntent(
  text: string,
  options: LocalSendImFileIntentOptions = {},
): boolean {
  const value = text.trim()
  if (!value) return false
  if (hasNegatedLocalSendImFileIntent(value)) return false
  if (!new RegExp(LOCAL_IM_TARGET_SOURCE, 'i').test(value)) return false
  if (localGeneratedContentSendPattern.test(value)) return false
  const sendVerb = '(?:发送|传|发(?!现|起|生|挥|展|表|散|的))'
  const directedSend = new RegExp(`${sendVerb}(?:给|到|往)?(?:我|我的)?${LOCAL_IM_TARGET_SOURCE}`, 'i').test(value)
    || new RegExp(`${LOCAL_IM_TARGET_SOURCE}.{0,12}${sendVerb}(?:一下|给我|给|这份|这个|文件|@\\[)`, 'i').test(value)
  if (!directedSend) return false
  if (/@\[[^\]]+\]/.test(value)) return true
  if (options.hasAttachmentContext === true && new RegExp(LOCAL_ATTACHED_FILE_SOURCE, 'i').test(value)) return true
  return new RegExp(LOCAL_RECENT_MEDIA_SOURCE, 'i').test(value)
}
