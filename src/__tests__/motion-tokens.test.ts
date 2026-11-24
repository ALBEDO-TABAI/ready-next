import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { EASE, MOTION_MS } from '../renderer/design/next/motion'

// Motion language M1: script and CSS time and ease motion with the same values; motion.ts mirrors tokens.css.
const css = readFileSync(join(process.cwd(), 'src/renderer/design/next/tokens.css'), 'utf8')
const token = (name: string) => {
  const match = css.match(new RegExp(`--rn-${name}:\\s*([^;]+);`))
  assert.ok(match, `--rn-${name} is defined`)
  return match![1].trim()
}
const ms = (value: string) => value.endsWith('ms') ? Number(value.slice(0, -2)) : Number(value.slice(0, -1)) * 1000
const bezier = (value: string) => value.replace(/^cubic-bezier\(|\)$/g, '').split(',').map(Number)

test('motion.ts durations equal the --rn-d-* tokens', () => {
  for (const [key, name] of [['d1', 'd-1'], ['d2', 'd-2'], ['d3', 'd-3'], ['d4', 'd-4'], ['d5', 'd-5'], ['release', 'd-release'], ['flash', 'd-flash']] as const) {
    assert.equal(MOTION_MS[key], ms(token(name)), `${key} = --rn-${name}`)
  }
})

test('motion.ts curves equal the --rn-ease-* tokens', () => {
  for (const [key, name] of [['out', 'ease-out'], ['in', 'ease-in'], ['std', 'ease-std'], ['inOut', 'ease-in-out']] as const) {
    assert.deepEqual([...EASE[key]], bezier(token(name)), `${key} = --rn-${name}`)
  }
})

test('reduced motion zeroes every distance and the pop, and the spring settles without overshoot', () => {
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  for (const name of ['shift-1', 'shift-2', 'shift-3']) assert.match(block, new RegExp(`--rn-${name}:\\s*0px`))
  assert.match(block, /--rn-pop:\s*1;/)
  assert.match(block, /--rn-ease-spring:\s*var\(--rn-ease-std\)/)
})
