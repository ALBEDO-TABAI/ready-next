/**
 * W10c — widget 脚本 CSP nonce 合同（2026-07-11 dogfood 第五例）。
 *
 * 实锚：index.html 的 script-src 同时声明 'unsafe-inline' 与 'nonce-…'——按 CSP
 * 规范 nonce 在场时 'unsafe-inline' 被忽略；该 nonce（base64("ready-widget")）
 * 全仓却无任何盖章代码，导致 srcdoc iframe（继承宿主 CSP）里的接收器脚本被静默
 * 拦截，widget:ready 永远不来，文档 widget 的交互预览自诞生起恒降级为
 * "交互预览加载较慢，先显示静态回退内容"。
 *
 * 合同：
 *   C1 常量与 index.html CSP 的 nonce 逐字一致（单一信源防漂移）。
 *   C2 接收器脚本与净化后的 widget 内联/白名单脚本必须盖 nonce。
 *   C3 静态回退（stripWidgetScripts）不受影响。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  WIDGET_SCRIPT_NONCE,
  buildWidgetReceiverSrcdoc,
  sanitizeWidgetHtml,
  stripWidgetScripts,
} from '../renderer/components/document/widget-sanitizer'

test('C1 常量与 index.html CSP 的 script-src nonce 逐字一致', () => {
  const html = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
  const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] || ''
  const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] || ''
  const nonce = scriptSrc.match(/'nonce-([^']+)'/)?.[1]
  assert.ok(nonce, 'index.html script-src 必须声明 nonce（否则本合同前提失效，需同步调整盖章策略）')
  assert.equal(nonce, WIDGET_SCRIPT_NONCE, 'CSP nonce 与盖章常量漂移会让 widget 脚本再次被静默拦截')

  const inlineScripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes, body]) => !/\bsrc\s*=/.test(attributes) && body.trim().length > 0)
  assert.ok(inlineScripts.length > 0, 'index.html 应保留首帧主题 bootstrap')
  for (const [, attributes] of inlineScripts) {
    assert.match(
      attributes,
      new RegExp(`\\bnonce=["']${WIDGET_SCRIPT_NONCE}["']`),
      'CSP 含 nonce 时 unsafe-inline 会失效，宿主页面内联脚本也必须使用同一 nonce',
    )
  }
})

test('C2 接收器脚本盖 nonce（srcdoc 继承宿主 CSP 后仍可执行）', () => {
  const srcdoc = buildWidgetReceiverSrcdoc(':root{}', false, '<div class="card">x</div>', 'tok-1')
  assert.match(srcdoc, new RegExp(`<script nonce="${WIDGET_SCRIPT_NONCE}">`))
  assert.ok(!/<script>(?!<)/.test(srcdoc), '不得残留无 nonce 的内联脚本标签')
})

test('C2 净化后的 widget 内联脚本盖 nonce', () => {
  const out = sanitizeWidgetHtml('<div>x</div><script>console.log(1)</script>')
  assert.match(out, new RegExp(`<script nonce="${WIDGET_SCRIPT_NONCE}">console\\.log\\(1\\)</script>`))
})

test('C2 白名单 CDN 脚本保留 src 并盖 nonce；非白名单仍被剥除', () => {
  const cdn = sanitizeWidgetHtml('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>')
  assert.match(cdn, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js"/)
  assert.match(cdn, new RegExp(`nonce="${WIDGET_SCRIPT_NONCE}"`))
  const evil = sanitizeWidgetHtml('<script src="https://evil.example.com/x.js"></script>')
  assert.equal(evil.includes('<script'), false)
})

test('C2 widget 自带的伪造 nonce 会被替换为盖章值', () => {
  const out = sanitizeWidgetHtml('<script src="https://unpkg.com/x" nonce="forged"></script>')
  assert.ok(!out.includes('forged'))
  assert.match(out, new RegExp(`nonce="${WIDGET_SCRIPT_NONCE}"`))
})

test('C3 静态回退剥除全部脚本（不因盖章改变）', () => {
  const out = stripWidgetScripts('<div>x</div><script nonce="whatever">console.log(1)</script>')
  assert.equal(out.includes('<script'), false)
  assert.match(out, /<div>x<\/div>/)
})
