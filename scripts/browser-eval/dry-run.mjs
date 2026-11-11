import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startEvalSites } from './server.mjs'
import { writeAttachmentFixtures } from './fixtures.mjs'
import { collectOutcome } from './outcome.mjs'
import { TASKS, validateTasks, renderPrompt } from './tasks/index.mjs'
import { createOracleHttp } from './tasks/oracle-http.mjs'

export async function runDryRun({ taskIds, log = console.log } = {}) {
  const validationErrors = validateTasks()
  if (taskIds)
    for (const id of taskIds)
      if (!TASKS.some(t => t.id === id)) validationErrors.push(`未知任务：${id}`)
  const tasks = []
  if (validationErrors.length) return { ok: false, tasks, validationErrors }
  const server = await startEvalSites({ quiet: true })
  try {
    for (const task of TASKS.filter(t => !taskIds || taskIds.includes(t.id))) {
      server.reset()
      const dir = await mkdtemp(join(tmpdir(), 'ready-browser-eval-'))
      const steps = []
      try {
        const workspaceDir = join(dir, 'workspace')
        const downloadsDir = join(dir, 'downloads')
        await Promise.all([mkdir(workspaceDir), mkdir(downloadsDir)])
        const attachments = await writeAttachmentFixtures(
          join(dir, 'attachments'),
          task.attachments,
        )
        const http = createOracleHttp()
        const ctx = {
          server,
          origins: server.origins,
          url: server.url,
          workspaceDir,
          downloadsDir,
          attachments,
          http,
        }
        const start = await http.get(server.url(task.start.path, task.start.origin))
        steps.push({ id: 'start', ok: start.status === 200, detail: `HTTP ${start.status}` })
        steps.push({
          id: 'prompt',
          ok: !renderPrompt(task, server.origins).includes('{{'),
          detail: '来源占位符已替换',
        })
        const collect = () =>
          collectOutcome({
            server,
            roots: { workspace: workspaceDir, downloads: downloadsDir },
            metrics: { interventions: 0 },
          })
        const before = task.judge(await collect())
        steps.push({
          id: 'before',
          ok: before.pass === false,
          detail: JSON.stringify(before.checks),
        })
        await task.oracle(ctx)
        const after = task.judge(await collect())
        steps.push({ id: 'after', ok: after.pass === true, detail: JSON.stringify(after.checks) })
      } catch (error) {
        steps.push({ id: 'error', ok: false, detail: error.stack || error.message })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
      const entry = {
        id: task.id,
        category: task.category,
        ok: steps.every(step => step.ok),
        steps,
      }
      tasks.push(entry)
      log(`${task.id}: ${entry.ok ? 'PASS' : 'FAIL'}`)
    }
  } finally {
    await server.close()
  }
  return { ok: tasks.every(task => task.ok), tasks, validationErrors }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await runDryRun({
    taskIds: process.argv.slice(2).length ? process.argv.slice(2) : undefined,
  })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 1
}
