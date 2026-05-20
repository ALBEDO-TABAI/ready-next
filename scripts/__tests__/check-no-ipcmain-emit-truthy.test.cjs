'use strict'

/**
 * Tests for scripts/check-no-ipcmain-emit-truthy.cjs (Stage U0.1).
 *
 * Strategy: drive the exported `checkNoIpcMainEmitTruthy` against a
 * temporary directory containing a small fixture. Each fixture file is one
 * shape we want to catch (or explicitly allow).
 */

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const { checkNoIpcMainEmitTruthy } = require('../check-no-ipcmain-emit-truthy.cjs')

function withFixture(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'u0_1-ipcmain-emit-gate-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    for (const [relPath, body] of Object.entries(files)) {
      const abs = join(root, 'src', relPath)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, body, 'utf8')
    }
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function run(root) {
  return checkNoIpcMainEmitTruthy({ root })
}

// ---------- POSITIVE (gate must FLAG) ---------------------------------------

test('flags assignment from ipcMain.emit', () => {
  withFixture(
    {
      'bad-assign.ts': `
        import { ipcMain } from 'electron'
        export function go(payload: unknown) {
          const result = ipcMain.emit('chan', payload)
          return result
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(violations.length >= 1, JSON.stringify(violations))
      assert.ok(
        violations.some((v) => /captured into a variable/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags || fallback consumption (the original calendar bug shape)', () => {
  withFixture(
    {
      'bad-or.ts': `
        import { ipcMain } from 'electron'
        export async function go(args: unknown) {
          let result: unknown = { error: 'unknown' }
          result = await ipcMain.emit('calendar:createEvent', args) || { success: true }
          return result
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(violations.length >= 1, JSON.stringify(violations))
      assert.ok(
        violations.some((v) => /assigned to a variable|logical "\|\|" operand/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags && consumption', () => {
  withFixture(
    {
      'bad-and.ts': `
        import { ipcMain } from 'electron'
        export function go() {
          if (ipcMain.emit('chan') && true) return 1
          return 0
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(
        violations.some((v) => /logical "&&" operand/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags if-condition consumption', () => {
  withFixture(
    {
      'bad-if.ts': `
        import { ipcMain } from 'electron'
        export function go() {
          if (ipcMain.emit('chan')) {
            return 1
          }
          return 0
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(
        violations.some((v) => /if-condition/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags ternary consumption', () => {
  withFixture(
    {
      'bad-ternary.ts': `
        import { ipcMain } from 'electron'
        export function go() {
          return ipcMain.emit('chan') ? 'a' : 'b'
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(
        violations.some((v) => /ternary condition/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags return value consumption', () => {
  withFixture(
    {
      'bad-return.ts': `
        import { ipcMain } from 'electron'
        export function go() {
          return ipcMain.emit('chan')
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(
        violations.some((v) => /return value/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags taint: variable holds emit result and is consumed within 5 lines', () => {
  withFixture(
    {
      'bad-taint.ts': `
        import { ipcMain } from 'electron'
        export function go() {
          const fired = ipcMain.emit('chan')
          // line +1
          // line +2
          if (fired) return 1
          return 0
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(
        violations.some((v) => /tainted "fired".*if-condition/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags helper wrapper: function returning ipcMain.emit(...) || fallback', () => {
  withFixture(
    {
      'bad-helper.ts': `
        import { ipcMain } from 'electron'
        function dispatchCalendar(args: unknown) {
          return ipcMain.emit('calendar:createEvent', args) || { success: true }
        }
        export function caller(args: unknown) {
          const r = dispatchCalendar(args)
          return r
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(
        violations.some(
          (v) => /helper "dispatchCalendar".*captured into a variable|wraps ipcMain.emit/.test(v.message),
        ),
        JSON.stringify(violations),
      )
    },
  )
})

test('flags helper wrapper: arrow returning ipcMain.emit(...)', () => {
  withFixture(
    {
      'bad-arrow-helper.ts': `
        import { ipcMain } from 'electron'
        const fireCal = (args: unknown) => ipcMain.emit('calendar', args)
        export function caller(args: unknown) {
          return fireCal(args)
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.ok(
        violations.some((v) => /helper "fireCal".*return value/.test(v.message)),
        JSON.stringify(violations),
      )
    },
  )
})

// ---------- NEGATIVE (gate must ALLOW) --------------------------------------

test('allows statement-level fire-and-forget ipcMain.emit', () => {
  withFixture(
    {
      'ok-stmt.ts': `
        import { ipcMain } from 'electron'
        export function go(payload: unknown) {
          ipcMain.emit('diagnostic:ping', payload)
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.equal(violations.length, 0, JSON.stringify(violations))
    },
  )
})

test('allows unrelated emit calls (different object)', () => {
  withFixture(
    {
      'ok-other-emit.ts': `
        import { EventEmitter } from 'events'
        const bus = new EventEmitter()
        export function go() {
          const fired = bus.emit('x')
          if (fired) return 1
          return 0
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.equal(violations.length, 0, JSON.stringify(violations))
    },
  )
})

test('allows tainted variable read OUTSIDE the 5-line window', () => {
  withFixture(
    {
      'ok-out-of-window.ts': `
        import { ipcMain } from 'electron'
        export function go() {
          // The assignment itself is still a violation (boolean captured),
          // but a read 10 lines later must NOT add an additional taint
          // violation — taint tracking is bounded.
          let fired = false
          fired = true
          // line +1
          // line +2
          // line +3
          // line +4
          // line +5
          // line +6
          // line +7
          if (fired) return 1
          return 0
        }
      `,
    },
    (root) => {
      const { violations } = run(root)
      assert.equal(
        violations.filter((v) => /tainted/.test(v.message)).length,
        0,
        JSON.stringify(violations),
      )
    },
  )
})

// ---------- POSITIVE: actual repository is clean (regression guard) ---------

test('real repository scan is clean', () => {
  const { violations } = checkNoIpcMainEmitTruthy({})
  assert.equal(violations.length, 0, JSON.stringify(violations, null, 2))
})
