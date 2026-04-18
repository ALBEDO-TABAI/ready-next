import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import test from 'node:test'

test('renderer components do not use transition-all (theme swaps should not animate transform/filter)', () => {
  // `transition-all` transitions every animatable property including transform and filter,
  // which makes theme swaps and hover states visibly swell. Prefer explicit property allowlists,
  // e.g. `transition-[background-color,border-color,color]`.
  let output = ''
  try {
    output = execSync('git grep -n "transition-all" -- "src/renderer/**/*.tsx"', {
      encoding: 'utf8',
    })
  } catch (error) {
    // git grep exits 1 when no matches — that's the success path for us.
    const code = (error as { status?: number }).status
    if (code === 1) {
      output = ''
    } else {
      throw error
    }
  }

  assert.equal(output.trim(), '', `Found transition-all usages that should be replaced with explicit property lists:\n${output}`)
})
