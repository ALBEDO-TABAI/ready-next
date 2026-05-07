#!/usr/bin/env node
/**
 * Stage O §3.3 gate — confirm that the four sites needed to deliver the
 * `agent:taskProjectionsChanged` push event are still in place.
 *
 *   (1) `task-projection-repository.ts` emits `'change'` on the
 *       internal EventEmitter (any of `emit('change'` /
 *       `emitter.emit('change'` / `this.emitter.emit('change'`).
 *
 *   (2) `claude-bridge/ipc-handler.ts` forwards the event via
 *       `webContents.send('agent:taskProjectionsChanged'`.
 *
 *   (3) `preload/index.ts` exposes a subscription named
 *       `onTaskProjectionsChanged` (the channel literal must appear).
 *
 *   (4) `renderer/components/agent/ChatPanel.tsx` consumes the
 *       subscription via `onTaskProjectionsChanged(`.
 *
 * Removing any of the four breaks the push contract: the renderer would
 * stop refetching projections after a write, sliding back into stale
 * task-card state. CI catching the regression is a hard requirement;
 * this gate is the static-time peer of the runtime test in
 * `src/__tests__/agent-task-projections-changed-ipc.test.ts`.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

const REQUIREMENTS = [
  {
    file: 'src/main/modules/repositories/task-projection-repository.ts',
    pattern: /\.emit\(\s*['"]change['"]/,
    detail: 'TaskProjectionRepository must emit the `change` event',
  },
  {
    file: 'src/main/modules/claude-bridge/ipc-handler.ts',
    pattern: /webContents\.send\(\s*['"]agent:taskProjectionsChanged['"]/,
    detail: 'ipc-handler must forward agent:taskProjectionsChanged via webContents.send',
  },
  {
    file: 'src/preload/index.ts',
    pattern: /['"]agent:taskProjectionsChanged['"]/,
    detail: 'preload must reference the agent:taskProjectionsChanged channel',
  },
  {
    file: 'src/renderer/components/agent/ChatPanel.tsx',
    pattern: /\bonTaskProjectionsChanged\s*\(/,
    detail: 'ChatPanel must subscribe via onTaskProjectionsChanged(...)',
  },
]

function main() {
  const violations = []
  for (const req of REQUIREMENTS) {
    const abs = path.join(ROOT, req.file)
    if (!fs.existsSync(abs)) {
      violations.push({ file: req.file, kind: 'file_missing', detail: req.detail })
      continue
    }
    const text = fs.readFileSync(abs, 'utf8')
    if (!req.pattern.test(text)) {
      violations.push({ file: req.file, kind: 'pattern_missing', detail: req.detail })
    }
  }

  if (violations.length === 0) {
    console.log('check-projection-push-event-wired: ok')
    return
  }
  console.error('check-projection-push-event-wired: violations:')
  for (const v of violations) {
    console.error(`  ${v.file} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
