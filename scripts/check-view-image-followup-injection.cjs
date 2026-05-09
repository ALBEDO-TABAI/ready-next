#!/usr/bin/env node
/**
 * Stage S (PR-S6 / W4.3) — view_image followup injection hook.
 *
 * `turn-engine.ts::consumeExecutedToolBatch` must carry a hook that
 * detects `view_image` tool calls and signals the next round to inject
 * the image bytes back into the model input. Today the tool does not
 * ship — the hook is a TODO-marked placeholder that records the
 * detection metric so the wiring is in the right place when the tool
 * lands.
 *
 * Gate:
 *   (a) literal `view_image` token referenced in turn-engine.ts
 *   (b) reference to a follow-up / next-round injection token
 *   (c) the hook lives inside the `consumeExecutedToolBatch` body
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/main/modules/agent-control/turn-engine.ts'

function checkViewImageFollowupInjection({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const targetAbs = path.join(root, TARGET_REL)
  if (!fs.existsSync(targetAbs)) {
    errors.push(`Missing target: ${TARGET_REL}`)
    return { ok: false, errors }
  }
  const src = fs.readFileSync(targetAbs, 'utf8')

  if (!/['"]view_image['"]/.test(src)) {
    errors.push(`${TARGET_REL}: missing literal \`'view_image'\` tool name`)
  }
  // Look for a next-round / followup / pending injection signal.
  if (!/(view_image_followup_injection|pendingNextRoundInjection|next round.*image|followup.*injection)/i.test(src)) {
    errors.push(`${TARGET_REL}: missing next-round / followup injection marker (metric or comment)`)
  }
  // The hook must live inside the tool-batch consumer.
  const consumeIdx = src.indexOf('consumeExecutedToolBatch')
  const viewImageIdx = src.indexOf("'view_image'")
  if (consumeIdx >= 0 && viewImageIdx >= 0 && viewImageIdx < consumeIdx) {
    errors.push(`${TARGET_REL}: \`view_image\` reference must appear at or after \`consumeExecutedToolBatch\` (it is the post-batch hook)`)
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkViewImageFollowupInjection()
  if (!result.ok) {
    console.error('[check-view-image-followup-injection] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-view-image-followup-injection] OK')
}

module.exports = { checkViewImageFollowupInjection }
