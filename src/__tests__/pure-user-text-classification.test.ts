/**
 * 2026-07-04 真机回归第二轮根因 — 意图/交易判定输入必须是用户话语。
 *
 * 实锚：采集原话「采集@[夜空中的孤岛 - 小红书]头 5 个笔记的图片到@[cos]」
 * 词表判 collection ✓；但注入后消息含站点卡发布类词（长文笔记/
 * creator.xiaohongshu.com）→ 被判 browser_transaction。本测试钉住：
 * 1) 纯文本解析优先级 envelope.pureUserText → primaryInstruction → 回退；
 * 2) 真实污染场景（采集话语 + 发布类注入前缀）在纯文本输入下不再误判。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolvePureUserTextForClassification,
  resolveTaskTypeFromBrowserWorkflowText,
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'

const REAL_COLLECT_TEXT = '采集@[夜空中的孤岛 - 小红书]头 5 个笔记的图片到@[cos]'
const REAL_PUBLISH_TEXT = '帮我发一条长文笔记，内容就一句话 今天天气不错'
const POLLUTED_BOOTSTRAP = [
  '【站点卡】小红书写长文发布流程：进入 creator.xiaohongshu.com/publish/publish，',
  '切到"写长文"标签，先填标题再填正文，最后点击发布。',
  REAL_COLLECT_TEXT,
].join('\n')

test('envelope pure text wins; primaryInstruction is the second choice; fallback last', () => {
  assert.equal(
    resolvePureUserTextForClassification({ pureUserText: ' hello ', primaryInstruction: 'p' }, 'f'),
    'hello',
  )
  assert.equal(
    resolvePureUserTextForClassification({ pureUserText: '', primaryInstruction: 'primary' }, 'f'),
    'primary',
  )
  assert.equal(resolvePureUserTextForClassification({}, 'fallback'), 'fallback')
  assert.equal(resolvePureUserTextForClassification(null, 'fallback'), 'fallback')
  assert.equal(resolvePureUserTextForClassification('not-an-object', 'fallback'), 'fallback')
})

test('真实污染场景：注入后文本会误判为交易，纯用户文本不会', () => {
  // 直接暴露此前的缺陷形态：带发布类注入的全文=browser_transaction。
  assert.equal(resolveTaskTypeFromBrowserWorkflowText(POLLUTED_BOOTSTRAP), 'browser_transaction')
  // 修复后的输入（envelope 纯文本）：采集话语不判交易。
  const pure = resolvePureUserTextForClassification(
    { pureUserText: REAL_COLLECT_TEXT },
    POLLUTED_BOOTSTRAP,
  )
  assert.equal(resolveTaskTypeFromBrowserWorkflowText(pure), null)
})

test('真实发布话语仍正确判交易（不误伤）', () => {
  const pure = resolvePureUserTextForClassification({ pureUserText: REAL_PUBLISH_TEXT }, 'x')
  assert.equal(resolveTaskTypeFromBrowserWorkflowText(pure), 'browser_transaction')
})
