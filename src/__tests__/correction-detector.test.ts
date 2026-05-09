/**
 * Stage R W10.4 — correction / reinforcement detector fixture matrix.
 *
 * Asserts canonical positive and negative cases for both detectors. The
 * fixture matrix tracks the keyword sets defined in
 * message-correction-detector.ts so a regression in either pattern set is
 * caught here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectCorrection,
  detectReinforcement,
} from '../main/modules/agent-control/message-correction-detector'

const CORRECTION_POSITIVES = [
  '不对，我刚才说错了',
  '错了，重新生成一下',
  '等等，先别动',
  'wait, that is wrong',
  'actually, let me clarify',
  'no, actually I meant',
  'that\'s not what I asked',
  '改一下',
  '调整一下颜色',
  '别那样',
]

const CORRECTION_NEGATIVES = [
  '继续吧',
  '好的，谢谢',
  '请帮我研究一下 deerflow',
  '生成报告',
  '看看天气',
  '今天日期是几号',
  'open the website',
  'please summarize',
  'show me the report',
  'what is the latest',
]

const REINFORCEMENT_POSITIVES = [
  '没错',
  '就这样',
  '继续',
  'yes, exactly',
  'perfect',
  'keep going',
  '可以',
  '没问题',
  '对啊',
  'that\'s right',
]

const REINFORCEMENT_NEGATIVES = [
  '不对',
  '改一下',
  '研究 deerflow',
  '研究一下',
  '检查输出',
  'wait',
  'actually, no',
  'let me clarify',
  '错了',
  '重新生成',
]

test('detectCorrection matches canonical positives', () => {
  for (const sample of CORRECTION_POSITIVES) {
    assert.equal(detectCorrection(sample).detected, true, `expected detection: ${sample}`)
  }
})

test('detectCorrection rejects canonical negatives', () => {
  for (const sample of CORRECTION_NEGATIVES) {
    assert.equal(detectCorrection(sample).detected, false, `unexpected detection: ${sample}`)
  }
})

test('detectReinforcement matches canonical positives', () => {
  for (const sample of REINFORCEMENT_POSITIVES) {
    assert.equal(detectReinforcement(sample).detected, true, `expected detection: ${sample}`)
  }
})

test('detectReinforcement rejects canonical negatives', () => {
  for (const sample of REINFORCEMENT_NEGATIVES) {
    assert.equal(detectReinforcement(sample).detected, false, `unexpected detection: ${sample}`)
  }
})
