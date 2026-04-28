import assert from 'node:assert/strict'
import test from 'node:test'

import {
  matchesConfigRepairIntent,
  matchesResumeIntent,
  RESUME_KEYWORDS,
  _LEXICON_INTERNALS_FOR_TESTS,
} from '../main/modules/agent-control/resume-lexicon'

// Phase 2.1 — single-source-of-truth tests for the resume lexicon.
//
// Bugs this lexicon is meant to fix (audit Phase 2 §B1/B2):
//   1. Three judgers in three modules diverged. Tokens added to one regex
//      didn't propagate to the others, so "你需要从头跑一轮" matched none.
//   2. Natural Chinese resume phrasings (重新跑 / 从头跑 / 再跑一次) were
//      missing from all three regex sets; users typing these landed in the
//      plain-answer channel where the model could leak `<tool_call>` text
//      into chat.
//
// These tests pin the matrix of (token, mode) → expected so a future refactor
// that drops a token surfaces immediately.

test('matchesResumeIntent — strict mode catches bare resume commands the audit flagged as missing', () => {
  // Historical contract — must keep working.
  assert.equal(matchesResumeIntent('继续', 'strict'), true)
  assert.equal(matchesResumeIntent('继续上次', 'strict'), true)
  assert.equal(matchesResumeIntent('继续任务', 'strict'), true)
  assert.equal(matchesResumeIntent('再试一次', 'strict'), true)
  assert.equal(matchesResumeIntent('重新开始', 'strict'), true)
  assert.equal(matchesResumeIntent('接着做', 'strict'), true)
  assert.equal(matchesResumeIntent('恢复上次', 'strict'), true)
  assert.equal(matchesResumeIntent('retry', 'strict'), true)
  assert.equal(matchesResumeIntent('Continue', 'strict'), true)
  assert.equal(matchesResumeIntent('resume', 'strict'), true)

  // Phase 2 additions — natural Chinese phrasings the audit caught.
  assert.equal(matchesResumeIntent('重新跑', 'strict'), true)
  assert.equal(matchesResumeIntent('重新跑一次', 'strict'), true)
  assert.equal(matchesResumeIntent('重新跑一轮', 'strict'), true)
  assert.equal(matchesResumeIntent('重新执行', 'strict'), true)
  assert.equal(matchesResumeIntent('重新执行一次', 'strict'), true)
  assert.equal(matchesResumeIntent('重新做', 'strict'), true)
  assert.equal(matchesResumeIntent('从头', 'strict'), true)
  assert.equal(matchesResumeIntent('从头跑', 'strict'), true)
  assert.equal(matchesResumeIntent('从头跑一次', 'strict'), true)
  assert.equal(matchesResumeIntent('从头跑一轮', 'strict'), true)
  assert.equal(matchesResumeIntent('从头开始', 'strict'), true)
  assert.equal(matchesResumeIntent('从头重新', 'strict'), true)
  assert.equal(matchesResumeIntent('从头重新跑', 'strict'), true)
  assert.equal(matchesResumeIntent('再从头重新跑', 'strict'), true)
  assert.equal(matchesResumeIntent('再再从头重新跑一次', 'strict'), true)
  assert.equal(matchesResumeIntent('再跑', 'strict'), true)
  assert.equal(matchesResumeIntent('再跑一次', 'strict'), true)
  assert.equal(matchesResumeIntent('再跑一遍', 'strict'), true)
  assert.equal(matchesResumeIntent('继续做', 'strict'), true)
  assert.equal(matchesResumeIntent('继续跑', 'strict'), true)
  assert.equal(matchesResumeIntent('接着跑', 'strict'), true)
  assert.equal(matchesResumeIntent('重做', 'strict'), true)
})

test('matchesResumeIntent — strict mode rejects fresh tasks even when they share root tokens', () => {
  // The strict regex anchors with ^ and $ so any trailing instruction kicks
  // the input out — "继续帮我搜索一下" / "重新弄一下页面" are clearly new asks.
  assert.equal(matchesResumeIntent('继续帮我搜索一下', 'strict'), false)
  assert.equal(matchesResumeIntent('继续，我想换个方向', 'strict'), false)
  assert.equal(matchesResumeIntent('帮我继续', 'strict'), false)
  assert.equal(matchesResumeIntent('从头到尾', 'strict'), false)
  assert.equal(matchesResumeIntent('重新来过吧', 'strict'), false, '"吧" suffix is not in strict')
  assert.equal(matchesResumeIntent('', 'strict'), false)
  assert.equal(matchesResumeIntent('   ', 'strict'), false)
})

test('matchesResumeIntent — liberal mode accepts continuation roots with trailing context', () => {
  // Audit Phase 2 §B2 — natural extensions of strict roots that were
  // previously missed.
  assert.equal(matchesResumeIntent('继续之前任务', 'liberal'), true)
  assert.equal(matchesResumeIntent('继续上次的视频分析', 'liberal'), true)
  assert.equal(matchesResumeIntent('继续完成视频分析', 'liberal'), true)
  assert.equal(matchesResumeIntent('接着上次做', 'liberal'), true)
  assert.equal(matchesResumeIntent('重新跑刚才那个', 'liberal'), true)
  assert.equal(matchesResumeIntent('重新执行视频分析', 'liberal'), true)
  assert.equal(matchesResumeIntent('从头跑一遍刚才的', 'liberal'), true)
  assert.equal(matchesResumeIntent('从头重新跑一次', 'liberal'), true)
  assert.equal(matchesResumeIntent('再从头重新跑一次看看', 'liberal'), true)
  assert.equal(matchesResumeIntent('再再从头重新跑一次看看', 'liberal'), true)
  assert.equal(matchesResumeIntent('再跑一次刚才那个', 'liberal'), true)

  // Liberal still rejects when text doesn't START with a root.
  assert.equal(matchesResumeIntent('帮我继续', 'liberal'), false)
  assert.equal(matchesResumeIntent('我要继续做', 'liberal'), false)
  assert.equal(matchesResumeIntent('你需要从头跑一轮', 'liberal'), false, 'starts with 你 not a root')
})

test('matchesResumeIntent — anywhere mode is permissive and catches the user-as-instruction phrasing', () => {
  // Audit Phase 2 §B2 — the example phrase that triggered this whole audit:
  // "你需要从头跑一轮 / 从头重新跑一次看看" — strict + liberal both fail
  // (user text doesn't START with a root) but anywhere catches it because
  // "从头" appears in the text. The continuation lookup that this gates is
  // safe even on false positives because Phase 2.5's selectContinuationProjection
  // returns null when no live candidate exists.
  assert.equal(matchesResumeIntent('你需要从头跑一轮', 'anywhere'), true)
  assert.equal(matchesResumeIntent('从头重新跑一次看看', 'anywhere'), true)
  assert.equal(matchesResumeIntent('我之前的任务继续做', 'anywhere'), true)
  assert.equal(matchesResumeIntent('刚才的任务再跑一遍', 'anywhere'), true, '再跑 substring matches')
  assert.equal(matchesResumeIntent('能不能重新跑刚才那个', 'anywhere'), true, '重新 substring matches')

  // Anywhere mode rejects text with no continuation tokens at all.
  assert.equal(matchesResumeIntent('帮我看看今天的天气', 'anywhere'), false)
  assert.equal(matchesResumeIntent('启动一个新对话', 'anywhere'), false)
  // Tokens have to actually appear; separated characters don't match.
  assert.equal(matchesResumeIntent('再帮我跑一遍', 'anywhere'), false, '再 and 跑 separated by 帮我 — no 再跑 substring')
})

test('matchesResumeIntent — strict ⊆ anywhere (lexicon self-consistency)', () => {
  // A fresh-strict match must also be an anywhere match. If this ever fails,
  // the strict regex has drifted away from the canonical token list.
  const strictSamples = [
    '继续', '重新跑', '从头跑', '再跑一次', '重做', '继续完成',
    '接着做', '恢复上次', '重试', 'continue', 'resume',
  ]
  for (const sample of strictSamples) {
    assert.equal(matchesResumeIntent(sample, 'strict'), true, `strict matches ${sample}`)
    assert.equal(matchesResumeIntent(sample, 'anywhere'), true, `anywhere also matches ${sample}`)
  }
})

test('matchesResumeIntent — empty / whitespace returns false in all modes', () => {
  for (const mode of ['strict', 'liberal', 'anywhere'] as const) {
    assert.equal(matchesResumeIntent('', mode), false)
    assert.equal(matchesResumeIntent('   ', mode), false)
    assert.equal(matchesResumeIntent('\n\t', mode), false)
  }
})

test('matchesConfigRepairIntent — catches credential/model/provider repair turns without a short-sentence cap', () => {
  assert.equal(matchesConfigRepairIntent('key 改成 sk-new-value，继续跑'), true)
  assert.equal(matchesConfigRepairIntent('api key换成新的了，麻烦沿用上次的视频分析目标再试一次'), true)
  assert.equal(matchesConfigRepairIntent('token 更新为 abc123'), true)
  assert.equal(matchesConfigRepairIntent('令牌改成这个，应该可以了'), true)
  assert.equal(matchesConfigRepairIntent('模型换成 mimo-v2.5 再试一次'), true)
  assert.equal(matchesConfigRepairIntent('model 改成 gpt-5.4'), true)
  assert.equal(matchesConfigRepairIntent('provider 换成 OpenRouter'), true)
  assert.equal(matchesConfigRepairIntent('渠道改成备用供应商'), true)
  assert.equal(matchesConfigRepairIntent('供应商换成硅基流动'), true)
  assert.equal(matchesConfigRepairIntent('配置好了，应该可以了，再试一下'), true)
  assert.equal(matchesConfigRepairIntent('更新了，修好了再试'), true)

  assert.equal(matchesConfigRepairIntent('帮我换个标题'), false)
  assert.equal(matchesConfigRepairIntent('把摘要改成短一点'), false)
  assert.equal(matchesConfigRepairIntent('今天的模型行业新闻'), false)
})

test('RESUME_KEYWORDS lists all canonical roots used by the regex modes', () => {
  // Sanity: every root that appears in either anywhere or strict regex must
  // be represented in RESUME_KEYWORDS. Catches a contributor adding a regex
  // token without updating the documented lexicon.
  const requiredCnRoots = ['继续', '接着', '恢复', '再来', '重做', '重新', '从头', '再跑', '上次', '重试']
  for (const root of requiredCnRoots) {
    assert.ok(
      (RESUME_KEYWORDS as readonly string[]).includes(root),
      `RESUME_KEYWORDS must include CN root "${root}"`,
    )
  }
  const requiredEnRoots = ['try again', 'retry', 'continue', 'resume']
  for (const root of requiredEnRoots) {
    assert.ok(
      (RESUME_KEYWORDS as readonly string[]).includes(root),
      `RESUME_KEYWORDS must include EN root "${root}"`,
    )
  }
})

test('lexicon internals are exposed for self-consistency checks', () => {
  assert.ok(_LEXICON_INTERNALS_FOR_TESTS.STRICT_FULL_MATCH instanceof RegExp)
  assert.ok(_LEXICON_INTERNALS_FOR_TESTS.LIBERAL_START_PREFIX instanceof RegExp)
  assert.ok(_LEXICON_INTERNALS_FOR_TESTS.ANYWHERE_PATTERN instanceof RegExp)
  // The 3 modes must be different regex instances; collapsing them would
  // defeat the design.
  assert.notEqual(
    _LEXICON_INTERNALS_FOR_TESTS.STRICT_FULL_MATCH,
    _LEXICON_INTERNALS_FOR_TESTS.LIBERAL_START_PREFIX,
  )
  assert.notEqual(
    _LEXICON_INTERNALS_FOR_TESTS.LIBERAL_START_PREFIX,
    _LEXICON_INTERNALS_FOR_TESTS.ANYWHERE_PATTERN,
  )
})
