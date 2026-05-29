import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASR_MODEL_PACK_MISSING_MARKER,
  MODELS_RUNTIME_SETTINGS_SECTION,
  detectMissingRuntimeDependency,
} from '../shared/model-pack-types'

// The Python extractor prints this exact line shape to stderr (json.dumps with
// ensure_ascii=False, default separators -> spaces after ':' and ','). The
// detector must parse what Python actually emits, so these fixtures mirror it.
function markerLine(missing: string[]): string {
  const payload = `{"feature": "video-subtitle-asr", "missing": [${missing
    .map((role) => `"${role}"`)
    .join(', ')}]}`
  return `${ASR_MODEL_PACK_MISSING_MARKER} ${payload}`
}

test('detectMissingRuntimeDependency maps both subtitle roles to their packs', () => {
  const stderr = [
    '   ⚠️  模型目录缺少文件',
    markerLine(['asr', 'punc']),
    '❌ 缺少本地语音识别模型，请在 Ready「设置 › 模型与运行时」下载字幕识别模型后重试。',
  ].join('\n')

  const result = detectMissingRuntimeDependency(stderr)
  assert.ok(result, 'expected a missing-dependency signal')
  assert.equal(result.feature, 'video-subtitle-asr')
  assert.equal(result.settingsSection, MODELS_RUNTIME_SETTINGS_SECTION)
  assert.deepEqual([...result.missingPacks].sort(), ['funasr-fallback-asr', 'funasr-punc-ctc'])
})

test('detectMissingRuntimeDependency maps a single role to its pack', () => {
  const asrOnly = detectMissingRuntimeDependency(markerLine(['asr']))
  assert.ok(asrOnly)
  assert.deepEqual(asrOnly.missingPacks, ['funasr-fallback-asr'])

  const puncOnly = detectMissingRuntimeDependency(markerLine(['punc']))
  assert.ok(puncOnly)
  assert.deepEqual(puncOnly.missingPacks, ['funasr-punc-ctc'])
})

test('detectMissingRuntimeDependency returns null when the marker is absent', () => {
  assert.equal(detectMissingRuntimeDependency('some unrelated traceback\nRuntimeError: boom'), null)
  assert.equal(detectMissingRuntimeDependency(''), null)
  assert.equal(detectMissingRuntimeDependency(null), null)
  assert.equal(detectMissingRuntimeDependency(undefined), null)
})

test('detectMissingRuntimeDependency falls back to the full subtitle pack set on unparseable payload', () => {
  // Marker present but the payload is not valid JSON: still signal a missing
  // subtitle dependency so the user can recover, with the full fallback set.
  const result = detectMissingRuntimeDependency(`${ASR_MODEL_PACK_MISSING_MARKER} not-json-here`)
  assert.ok(result)
  assert.equal(result.feature, 'video-subtitle-asr')
  assert.deepEqual([...result.missingPacks].sort(), ['funasr-fallback-asr', 'funasr-punc-ctc'])
})

test('detectMissingRuntimeDependency ignores unknown roles but keeps known ones', () => {
  const result = detectMissingRuntimeDependency(markerLine(['asr', 'something-else']))
  assert.ok(result)
  assert.deepEqual(result.missingPacks, ['funasr-fallback-asr'])
})
