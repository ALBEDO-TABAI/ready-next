import { resolveBrowserCollectionIntent } from './browser-collection-intent'
import type { BrowserTaskDecisionMode } from './browser-agent-task'

export type BrowserWorkflowIntentKind = 'observe' | 'collection' | 'transaction'
export type BrowserTransactionIntentKind = 'publish' | 'upload' | 'submit' | 'form'

export interface BrowserWorkflowIntent {
  kind: BrowserWorkflowIntentKind
  transactionKind?: BrowserTransactionIntentKind
  reason: string
}

const BROWSER_SURFACE_RE = /(?:网页|浏览器|网站|当前页|页面|链接|url|https?:\/\/|www\.|browser|website|web page|current page|click|download|小红书|微博|抖音|快手|公众号|B站|bilibili|creator\.xiaohongshu\.com|\/publish\/publish)/i
const DOCUMENT_SURFACE_RE = /(?:文档|文稿|原文|文章|段落|章节|markdown|\.md\b|@\[.*?\.(?:md|txt|docx?)\]|widget|show-widget|图表|趋势图|人物关系图|卡片|信息卡|表格|保存|写入|追加|替换|编辑|改写|润色|排版|格式)/i
const COLLECTION_ACTION_RE = /(?:采集|抓取|爬取|爬|收集|下载|保存|整理|批量|扒|存档|归档|落到|放到|存到|文件夹|download|save)/i
const RESEARCH_ACTION_RE = /(?:搜索|查找|查一下|检索|研究|资料|来源|引用|最新|今天|新闻|天气|股价|汇率|比分|赛程|官网|公告|价格|source|citation|research|search|latest|today|news)/i
const LOCAL_DELIVERY_RE = /(?:发到|发给|发送到|发送给|转发到|转发给).{0,24}(?:我)?(?:微信|wechat|wx|群|好友|朋友|联系人|手机|短信|im)/i

const PUBLISH_RE = /(?:发帖|发笔记|发一篇|发一条|发条|发到|发小红书|写一篇|写(?:一条|个|篇)?(?:小红书|笔记|帖子)|新建(?:普通)?(?:长文)?笔记|创建(?:普通)?(?:长文)?笔记|普通长文笔记|长文笔记|文字配图|图文笔记|提交草稿|发布(?:笔记|帖子|动态|内容|作品|小红书|微博|推文)|投稿|creator\.xiaohongshu\.com|\/publish\/publish|(?:创作|创作者)(?:中心|后台|平台))/i
const UPLOAD_RE = /(?:(?:上传|提交|发布|发送|选择).{0,30}(?:附件|文件|图片|图像|视频|upload|attach|file|image|video)|(?:附件|文件|图片|图像|视频|file|image|video).{0,30}(?:上传|提交|发布|发送|upload|attach)|(?:upload|attach).{0,30}(?:file|image|video))/i
const SUBMIT_RE = /(?:提交(?:表单|内容|申请|订单|信息)?|发送(?:消息|内容|表单)?|确认提交|submit|send form|post form)/i
const FORM_RE = /(?:填写|填入|填表|输入.{0,18}(?:表单|网页|页面|字段)|表单.{0,18}(?:填写|提交|输入)|fill form|complete form)/i

export function resolveBrowserWorkflowIntent(text: string | null | undefined): BrowserWorkflowIntent {
  const source = String(text || '').trim()
  if (!source) return { kind: 'observe', reason: 'empty' }

  const hasBrowserSurface = BROWSER_SURFACE_RE.test(source)
  if (LOCAL_DELIVERY_RE.test(source)) {
    return { kind: 'observe', reason: 'local_delivery' }
  }
  if (PUBLISH_RE.test(source)) {
    return { kind: 'transaction', transactionKind: 'publish', reason: 'publish_intent' }
  }
  if (hasBrowserSurface && UPLOAD_RE.test(source)) {
    return { kind: 'transaction', transactionKind: 'upload', reason: 'upload_intent' }
  }
  if (hasBrowserSurface && SUBMIT_RE.test(source)) {
    return { kind: 'transaction', transactionKind: 'submit', reason: 'submit_intent' }
  }
  if (hasBrowserSurface && FORM_RE.test(source)) {
    return { kind: 'transaction', transactionKind: 'form', reason: 'form_intent' }
  }
  if (resolveBrowserCollectionIntent(source) && COLLECTION_ACTION_RE.test(source)) {
    return { kind: 'collection', reason: 'collection_intent' }
  }
  if (DOCUMENT_SURFACE_RE.test(source) && !hasBrowserSurface) {
    return { kind: 'observe', reason: 'document_surface' }
  }
  if (hasBrowserSurface || RESEARCH_ACTION_RE.test(source) || /(?:打开|点击|输入|下载)/i.test(source)) {
    return { kind: 'observe', reason: 'browser_observe' }
  }
  return { kind: 'observe', reason: 'fallback' }
}

export function browserWorkflowIntentToDecisionMode(intent: BrowserWorkflowIntent): BrowserTaskDecisionMode {
  if (intent.kind === 'transaction') {
    return intent.transactionKind === 'upload' ? 'browser_upload_workflow' : 'browser_workflow'
  }
  if (intent.kind === 'collection') return 'free_tool_loop'
  if (intent.reason === 'document_surface' || intent.reason === 'local_delivery' || intent.reason === 'fallback' || intent.reason === 'empty') return 'free_tool_loop'
  return 'browser_workflow'
}

export function isBrowserTransactionIntent(intent: BrowserWorkflowIntent): boolean {
  return intent.kind === 'transaction'
}
