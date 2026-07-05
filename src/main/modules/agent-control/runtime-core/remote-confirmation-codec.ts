/**
 * Phase I P0（2026-07-05）—— 远程确认链路的纯文本编解码。
 *
 * ask_user_questions / frozen-call 确认卡在本地是结构化卡片 UI，在微信等
 * IM 渠道只有纯文本一条通道。本模块把卡序列化成可读文本、把用户的文本
 * 回复解析回结构化答案。纯函数、无 IO、无 LLM——解析规则是机械的
 * （编号/选项原文/唯一前缀），解析不出就返回结构化错误提示，绝不猜测
 * （合同：`2026-07-05-phase-I-p0-remote-confirmation-implementation.md` 条款 2）。
 */
import type {
  AskUserAnswer,
  AskUserQuestionSpec,
} from '../../tools/builtins/ask-user-questions-store'

/** 整词命中即视为"取消这张卡"（大小写不敏感）。 */
const CANCEL_WORDS = new Set(['取消', '跳过', 'skip', 'cancel'])

/** 多题回复的分段符：换行 / 分号（中英） */
const SEGMENT_SPLIT_RE = /[\n;；]+/

/** 多选题内的取值分隔：空白 / 逗号（中英） / 顿号 */
const MULTI_VALUE_SPLIT_RE = /[\s,，、]+/

export interface ChannelAskCardReplyParseOk {
  kind: 'answers'
  answers: AskUserAnswer[]
}

export interface ChannelAskCardReplyCancel {
  kind: 'cancel'
}

export interface ChannelAskCardReplyError {
  kind: 'error'
  /** 直接可回发给用户的格式指引（含具体哪题没解析出来）。 */
  guidance: string
}

export type ChannelAskCardReplyParseResult =
  | ChannelAskCardReplyParseOk
  | ChannelAskCardReplyCancel
  | ChannelAskCardReplyError

/** 卡 → 渠道纯文本。选项编号从 1 开始；回复方式说明按题型给出。 */
export function formatAskUserQuestionsCardForChannel(
  questions: AskUserQuestionSpec[],
): string {
  const lines: string[] = ['【需要你确认】']
  const multi = questions.length > 1
  questions.forEach((q, index) => {
    const prefix = multi ? `问题${index + 1}：` : ''
    lines.push(`${prefix}${q.question}`)
    if ((q.kind === 'single_choice' || q.kind === 'multi_choice') && q.options) {
      q.options.forEach((option, optionIndex) => {
        lines.push(`  ${optionIndex + 1}. ${option}`)
      })
    } else if (q.kind === 'free_text' && q.placeholder) {
      lines.push(`  （${q.placeholder}）`)
    }
  })
  const hints: string[] = []
  const hasChoice = questions.some((q) => q.kind === 'single_choice' || q.kind === 'multi_choice')
  const hasMultiChoice = questions.some((q) => q.kind === 'multi_choice')
  const hasFreeText = questions.some((q) => q.kind === 'free_text')
  if (hasChoice) hints.push('回复选项编号或选项文字')
  if (hasMultiChoice) hints.push('多选用空格分隔（如「1 3」）')
  if (hasFreeText) hints.push('文字题直接回复内容')
  if (multi) hints.push(`共 ${questions.length} 题，请按顺序每行答一题（或用分号分隔）`)
  hints.push('回复「取消」跳过本次确认')
  lines.push(`（${hints.join('；')}）`)
  return lines.join('\n')
}

/** 提交成功后的回执摘要（回发渠道用）。 */
export function formatAskCardAnswerReceipt(
  questions: AskUserQuestionSpec[],
  answers: AskUserAnswer[],
): string {
  const byId = new Map(answers.map((a) => [a.id, a]))
  const parts: string[] = []
  for (const q of questions) {
    const answer = byId.get(q.id)
    if (!answer) continue
    const text = Array.isArray(answer.answer) ? answer.answer.join('、') : String(answer.answer)
    parts.push(questions.length > 1 ? `${q.question.slice(0, 20)} → ${text}` : text)
  }
  return `✅ 已收到确认：${parts.join('；')}。任务继续执行。`
}

function matchOption(segment: string, options: string[]): string | null {
  const trimmed = segment.trim()
  if (!trimmed) return null
  const asNumber = Number(trimmed)
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1]
  }
  const lower = trimmed.toLowerCase()
  const exact = options.filter((option) => option.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]
  const prefix = options.filter((option) => option.toLowerCase().startsWith(lower))
  if (prefix.length === 1) return prefix[0]
  const contains = options.filter((option) => option.toLowerCase().includes(lower))
  if (contains.length === 1) return contains[0]
  return null
}

/**
 * 渠道文本回复 → 结构化答案。
 * 单题：整条消息就是这题的答案段。多题：按行/分号切段，段数必须等于题数。
 */
export function parseChannelAskCardReply(
  rawText: string,
  questions: AskUserQuestionSpec[],
): ChannelAskCardReplyParseResult {
  const text = String(rawText || '').trim()
  if (!text) {
    return { kind: 'error', guidance: buildGuidance(questions, '回复内容为空') }
  }
  if (CANCEL_WORDS.has(text.toLowerCase())) {
    return { kind: 'cancel' }
  }
  let segments: string[]
  if (questions.length === 1) {
    segments = [text]
  } else {
    segments = text.split(SEGMENT_SPLIT_RE).map((s) => s.trim()).filter(Boolean)
    if (segments.length !== questions.length) {
      return {
        kind: 'error',
        guidance: buildGuidance(
          questions,
          `共 ${questions.length} 题，但只识别到 ${segments.length} 段回答`,
        ),
      }
    }
  }
  const answers: AskUserAnswer[] = []
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]
    const segment = segments[i]
    if (q.kind === 'free_text') {
      if (q.required !== false && segment.trim().length === 0) {
        return { kind: 'error', guidance: buildGuidance(questions, `第 ${i + 1} 题需要文字回答`) }
      }
      answers.push({ id: q.id, answer: segment.trim() })
      continue
    }
    const options = q.options || []
    if (q.kind === 'single_choice') {
      const matched = matchOption(segment, options)
      if (!matched) {
        return {
          kind: 'error',
          guidance: buildGuidance(questions, `「${segment.slice(0, 20)}」没有匹配到${questions.length > 1 ? `第 ${i + 1} 题的` : ''}任何选项`),
        }
      }
      answers.push({ id: q.id, answer: matched })
      continue
    }
    // multi_choice
    const tokens = segment.split(MULTI_VALUE_SPLIT_RE).map((s) => s.trim()).filter(Boolean)
    if (tokens.length === 0) {
      return { kind: 'error', guidance: buildGuidance(questions, `第 ${i + 1} 题（多选）没有识别到选项`) }
    }
    const values: string[] = []
    for (const token of tokens) {
      const matched = matchOption(token, options)
      if (!matched) {
        return {
          kind: 'error',
          guidance: buildGuidance(questions, `「${token.slice(0, 20)}」没有匹配到${questions.length > 1 ? `第 ${i + 1} 题的` : ''}任何选项`),
        }
      }
      if (!values.includes(matched)) values.push(matched)
    }
    answers.push({ id: q.id, answer: values })
  }
  return { kind: 'answers', answers }
}

function buildGuidance(questions: AskUserQuestionSpec[], reason: string): string {
  return `没能识别这条回复（${reason}）。\n${formatAskUserQuestionsCardForChannel(questions)}`
}
