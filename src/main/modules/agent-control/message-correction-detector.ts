/**
 * Detect user correction / reinforcement signals in messages.
 *
 * Stage R W10.4 — helper only. Long-term memory main path is backlog;
 * this lands the detection primitives so future PRs can wire feedback
 * loops without re-deriving.
 *
 * Source: deer-flow agents/memory/message_processing.py:88, 100
 *   detect_correction / detect_reinforcement
 */

const CORRECTION_PATTERNS_ZH = [
  /不对/, /错了/, /错误/, /不是/, /重新/, /别这样/, /别那样/, /先别/, /等等/, /我说错/, /改一下/, /调整/,
]

const CORRECTION_PATTERNS_EN = [
  /\bactually\b/i, /\bwait\b/i, /\bnot quite\b/i, /\blet me clarify\b/i, /\bthat's wrong\b/i, /\bcorrection\b/i,
  /\bno,? actually\b/i, /\bnope\b/i, /\bthat's not\b/i,
]

const REINFORCEMENT_PATTERNS_ZH = [
  /没错/, /对的/, /对啊/, /就这样/, /可以/, /没问题/, /继续/, /好/, /棒/,
]

const REINFORCEMENT_PATTERNS_EN = [
  /\byes,? exactly\b/i, /\bperfect\b/i, /\bkeep going\b/i, /\bthat's right\b/i, /\bcorrect\b/i,
  /\bgood\b/i, /\bright\b/i, /\bok(ay)?\b/i,
]

export interface DetectionResult {
  detected: boolean
  signal?: string
}

export function detectCorrection(message: string): DetectionResult {
  const text = (message || '').trim()
  if (text.length === 0) return { detected: false }
  for (const pattern of [...CORRECTION_PATTERNS_ZH, ...CORRECTION_PATTERNS_EN]) {
    const match = text.match(pattern)
    if (match) return { detected: true, signal: match[0] }
  }
  return { detected: false }
}

export function detectReinforcement(message: string): DetectionResult {
  const text = (message || '').trim()
  if (text.length === 0) return { detected: false }
  for (const pattern of [...REINFORCEMENT_PATTERNS_ZH, ...REINFORCEMENT_PATTERNS_EN]) {
    const match = text.match(pattern)
    if (match) return { detected: true, signal: match[0] }
  }
  return { detected: false }
}
