import { FIXTURE_FILES } from '../fixtures.mjs'
import { A_TASKS } from './a.mjs'
import { B_TASKS } from './b.mjs'
import { C_TASKS } from './c.mjs'
import { D_TASKS } from './d.mjs'

export const TASKS = [...A_TASKS, ...B_TASKS, ...C_TASKS, ...D_TASKS].sort((a, b) =>
  a.id.localeCompare(b.id),
)
export function renderPrompt(task, origins) {
  return task.prompt.replace(
    /\{\{ORIGIN_(MAIN|ALT|THIRD)\}\}/g,
    (_, origin) => origins[origin.toLowerCase()],
  )
}
export function validateTasks(tasks = TASKS) {
  const errors = []
  if (!Array.isArray(tasks)) return ['任务必须是数组']
  const seen = new Set()
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      errors.push('任务必须是对象')
      continue
    }
    const id = task.id
    if (!/^[ABCD][1-6]$/.test(id)) errors.push(`无效任务 id：${id}`)
    if (seen.has(id)) errors.push(`重复任务：${id}`)
    seen.add(id)
    if (!['logged_in', 'logged_out'].includes(task.session)) errors.push(`${id} session 不正确`)
    if (task.category !== id?.[0]) errors.push(`${id} 分类不匹配`)
    for (const key of ['title', 'prompt'])
      if (typeof task[key] !== 'string' || !task[key].trim()) errors.push(`${id} 缺少 ${key}`)
    if (
      !['main', 'alt', 'third'].includes(task.start?.origin) ||
      typeof task.start?.path !== 'string' ||
      !task.start.path.startsWith('/') ||
      task.start.path.startsWith('//')
    )
      errors.push(`${id} 起始页面不正确`)
    if (
      !Array.isArray(task.attachments) ||
      task.attachments.some(name => !Object.hasOwn(FIXTURE_FILES, name))
    )
      errors.push(`${id} 附件不正确`)
    if (!Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== 'string'))
      errors.push(`${id} 标签不正确`)
    for (const key of ['maxSteps', 'maxMinutes'])
      if (!Number.isFinite(task.limits?.[key]) || task.limits[key] <= 0)
        errors.push(`${id} ${key} 必须为正数`)
    for (const key of ['oracle', 'judge'])
      if (typeof task[key] !== 'function') errors.push(`${id} 缺少 ${key}`)
  }
  for (const category of ['A', 'B', 'C', 'D'])
    if (tasks.filter(t => t?.category === category).length !== 6)
      errors.push(`${category} 类必须恰好 6 个任务`)
  return errors
}
