import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateLegacyAppearanceSettings, readThemeOption, readReduceTransparency, resolveTransparency,
  THEME_SETTING_KEY, REDUCE_TRANSPARENCY_SETTING_KEY, type AppearanceSettingsStore,
} from '../main/modules/window-material/theme-appearance'

function settings(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const writes: string[] = []
  const store: AppearanceSettingsStore = {
    getSetting: (key) => values.get(key),
    setSetting: (key, value) => { writes.push(`set:${key}`); values.set(key, value) },
    deleteSetting: (key) => { writes.push(`delete:${key}`); values.delete(key) },
  }
  return { store, values, writes }
}

for (const skin of ['ready-glass', 'solid-green-glass', 'solid-blue-glass', ' READY-GLASS ']) {
  test(`migrates opaque ${skin} once without changing unrelated settings`, () => {
    const { store, values, writes } = settings({ ui_theme_skin: skin, ui_theme_option: 'dark', other: 'keep' })
    assert.deepEqual(migrateLegacyAppearanceSettings(store), { migrated: true, reduceTransparency: true })
    assert.deepEqual(Object.fromEntries(values), { ui_theme_option: 'dark', other: 'keep', ui_reduce_transparency: 'true' })
    const writeCount = writes.length
    assert.deepEqual(migrateLegacyAppearanceSettings(store), { migrated: false, reduceTransparency: null })
    assert.equal(writes.length, writeCount)
    assert.deepEqual(Object.fromEntries(values), { ui_theme_option: 'dark', other: 'keep', ui_reduce_transparency: 'true' })
  })
}

for (const skin of ['liquid-glass', 'unknown', '']) {
  test(`removes ${JSON.stringify(skin)} without enabling reduced transparency`, () => {
    const { store, values, writes } = settings({ ui_theme_skin: skin, other: 'keep' })
    assert.deepEqual(migrateLegacyAppearanceSettings(store), { migrated: true, reduceTransparency: null })
    assert.deepEqual(Object.fromEntries(values), { other: 'keep' })
    assert.deepEqual(writes, ['delete:ui_theme_skin'])
    migrateLegacyAppearanceSettings(store)
    assert.deepEqual(writes, ['delete:ui_theme_skin'])
  })
}

for (const explicit of ['true', 'false', '']) {
  test(`preserves explicitly stored switch ${JSON.stringify(explicit)}`, () => {
    const { store, values, writes } = settings({ ui_theme_skin: 'ready-glass', ui_reduce_transparency: explicit })
    assert.deepEqual(migrateLegacyAppearanceSettings(store), { migrated: true, reduceTransparency: null })
    assert.deepEqual(Object.fromEntries(values), { ui_reduce_transparency: explicit })
    assert.deepEqual(writes, ['delete:ui_theme_skin'])
  })
}

test('no legacy key means no writes', () => {
  const { store, values, writes } = settings({ ui_theme_option: 'system', other: 'keep' })
  assert.deepEqual(migrateLegacyAppearanceSettings(store), { migrated: false, reduceTransparency: null })
  assert.deepEqual(Object.fromEntries(values), { ui_theme_option: 'system', other: 'keep' })
  assert.deepEqual(writes, [])
})

test('reads and normalizes stored theme options and falls back to light', () => {
  for (const [raw, expected] of [[undefined, 'light'], ['', 'light'], ['invalid', 'light'], ['light', 'light'], ['dark', 'dark'], ['system', 'system'], [' DARK ', 'dark']]) {
    const { store, writes } = settings(raw === undefined ? {} : { [THEME_SETTING_KEY]: raw })
    assert.equal(readThemeOption(store), expected)
    assert.deepEqual(writes, [])
  }
})

test('only a normalized true enables the user preference', () => {
  for (const raw of [undefined, '', 'false', '1', 'yes', 'true', ' TRUE ']) {
    const { store, writes } = settings(raw === undefined ? {} : { [REDUCE_TRANSPARENCY_SETTING_KEY]: raw })
    assert.equal(readReduceTransparency(store), raw === 'true' || raw === ' TRUE ')
    assert.deepEqual(writes, [])
  }
})

test('either user or system can require reduced transparency', () => {
  assert.equal(resolveTransparency({ userReduce: false, systemReduce: false }), 'normal')
  assert.equal(resolveTransparency({ userReduce: true, systemReduce: false }), 'reduced')
  assert.equal(resolveTransparency({ userReduce: false, systemReduce: true }), 'reduced')
  assert.equal(resolveTransparency({ userReduce: true, systemReduce: true }), 'reduced')
})
