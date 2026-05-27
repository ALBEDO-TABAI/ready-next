import assert from 'node:assert/strict'
import test from 'node:test'

import { compactAnalysisDetail } from '../renderer/modules/rss/analysisLabels'

test('RSS analysis detail hides raw Python dependency logs in compact UI labels', () => {
  const detail = compactAnalysisDetail(
    `============================================================
🎬 视频文案分析工具
============================================================
❌ 下载失败: /Users/user/Library/Application Support/ready/skill-runtime/python/lib/python3.9/site-packages/urllib3/__init__.py:35: NotOpenSSLWarning: urllib3 v2 only supports OpenSSL 1.1.1+`,
  )

  assert.equal(detail, 'Python 网络环境不兼容，下载失败')
})

test('RSS analysis detail keeps short actionable messages and truncates long generic logs', () => {
  assert.equal(compactAnalysisDetail('下载失败: 请求超时'), '下载失败')
  assert.equal(compactAnalysisDetail('agent 分析中'), 'agent 分析中')
  assert.equal(compactAnalysisDetail('x'.repeat(120)), `${'x'.repeat(95)}…`)
})
