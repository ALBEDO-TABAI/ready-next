'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { validateScheduleOutcomeSource } = require('../check-schedule-tick-outcome-funnel.cjs')

function sourceWithBodies(createBody, runBody) {
  return `
class SkillsRuntimeManager {
  createSchedule(request: CreateSkillScheduleRequest): SkillScheduleRecord {
${createBody}
  }

  private async runScheduledTask(schedule: SkillScheduleRow): Promise<void> {
${runBody}
  }
}
`
}

test('rejects createSchedule without action validation', () => {
  const result = validateScheduleOutcomeSource(sourceWithBodies(`
    const knownSkill = this.listSkills().some((skill) => skill.id === request.skillId)
    if (!knownSkill) throw new Error('Unknown skill')
    this.getRawDatabase().prepare('INSERT INTO skills_schedules').run()
`, `
    await this.runSkill({ skillId: schedule.skill_id, action: schedule.action })
    const nextRunAt = new Date(Date.now() + schedule.interval_minutes * 60_000).toISOString()
    this.getRawDatabase().prepare('UPDATE skills_schedules').run(nextRunAt)
`))

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /validate request\.action/)
})

test('rejects runScheduledTask that ignores runSkill success', () => {
  const result = validateScheduleOutcomeSource(sourceWithBodies(`
    const skill = this.listSkills().find((item) => item.id === request.skillId)
    if (!skill) throw new Error('Unknown skill')
    if (!skill.actions.some((action) => action.name === request.action)) throw new Error('Unknown action')
    this.getRawDatabase().prepare('INSERT INTO skills_schedules').run()
`, `
    await this.runSkill({ skillId: schedule.skill_id, action: schedule.action })
    const nextRunAt = new Date(Date.now() + schedule.interval_minutes * 60_000).toISOString()
    this.getRawDatabase().prepare('UPDATE skills_schedules').run(nextRunAt)
`))

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /must store the runSkill result/)
  assert.match(result.errors.join('\n'), /branch on !result\.success/)
})

test('accepts action validation and success-based schedule advancement', () => {
  const result = validateScheduleOutcomeSource(sourceWithBodies(`
    const skill = this.listSkills().find((item) => item.id === request.skillId)
    if (!skill) throw new Error('Unknown skill')
    if (!skill.actions.some((action) => action.name === request.action)) throw new Error('Unknown action')
    this.getRawDatabase().prepare('INSERT INTO skills_schedules').run()
`, `
    const result = await this.runSkill({ skillId: schedule.skill_id, action: schedule.action })
    if (!result.success) {
      this.getRawDatabase().prepare('UPDATE skills_schedules SET next_run_at = ?').run()
      return
    }
    const nextRunAt = new Date(Date.now() + schedule.interval_minutes * 60_000).toISOString()
    this.getRawDatabase().prepare('UPDATE skills_schedules SET last_run_at = ?, next_run_at = ?').run(nextRunAt)
`))

  assert.equal(result.ok, true, result.errors.join('\n'))
})
