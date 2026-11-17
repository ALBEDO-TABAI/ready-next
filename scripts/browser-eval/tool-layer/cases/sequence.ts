// One model call that carries several steps (plan 2026-11-18, Q1–Q8): the chains a model would
// actually write, run through the real tools against a real page in the hidden window.
import type { AgentRun, CaseGroup, ToolCallResult } from '../harness'
import { errorKind, fail, observe, pass, recordsOf, summarize, waitForRecord } from './helpers'

interface StepRecord { step: number; tool: string; ok: boolean; delivery?: string; effect?: string; errorKind?: string }

function steps(result: ToolCallResult): StepRecord[] {
  return Array.isArray(result.data.steps) ? result.data.steps as StepRecord[] : []
}

function notExecuted(result: ToolCallResult): number[] {
  return Array.isArray(result.data.notExecuted)
    ? (result.data.notExecuted as Array<{ step: number }>).map((item) => item.step)
    : []
}

const fieldValue = (run: AgentRun, selector: string) => (
  run.pageEval<string>(`return document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
)

export const sequenceGroup: CaseGroup = {
  site: 'sequence',
  title: '连续动作',
  async run(ctx) {
    const run = await ctx.run('sequence-fill')
    await run.open(ctx.url('/form/'))
    await ctx.check(
      'fill-submit-read',
      '一次调用里填两个字段、提交、等完成页、读完成页',
      ['browser_sequence'],
      async () => {
        const page = await observe(run)
        const result = await run.call('browser_sequence', {
          steps: [
            { tool: 'browser_type', args: { target_id: page.pick('姓名', { purpose: 'input' }).targetId, text: '白' } },
            { tool: 'browser_type', args: { target_id: page.pick('邮箱', { purpose: 'input' }).targetId, text: 'seq@example.test' } },
            {
              tool: 'browser_fill_form',
              args: { fields: [{ target_id: page.pick('留言', { purpose: 'input' }).targetId, value: '连续动作 SEQ-1' }], submit: true },
            },
            { tool: 'browser_wait', args: { condition: 'text', text: '已收到' } },
            { tool: 'browser_read', args: {} },
          ],
        })
        await waitForRecord(run, 'form.submit', 1, 4_000)
        const row = recordsOf(run, 'form.submit').map((item) => item.data).find((item) => item.message === '连续动作 SEQ-1')
        const done = steps(result)
        const observation = result.data.observation as { step?: number; tool?: string; data?: unknown } | null
        if (result.data.ok !== true || done.length !== 5 || done.some((step) => !step.ok)) {
          return fail(`连续动作没有走完：${summarize(result, 700)}`)
        }
        if (!row) return fail(`服务端没有收到提交：${summarize(result, 500)}`)
        if (row.name !== '白' || row.email !== 'seq@example.test') return fail(`提交内容不对：${JSON.stringify(row)}`)
        if (observation?.step !== 5 || observation.tool !== 'browser_read'
          || !JSON.stringify(observation.data).includes('已收到 白 的留言')) {
          return fail(`完成页没有随结果带回：${summarize(result, 500)}`)
        }
        if (done[0].delivery !== 'delivered' || done[1].delivery !== 'delivered') return fail(`输入步骤未记为送达：${JSON.stringify(done)}`)
        return pass('5 步全部成功；提交内容与填写一致；完成页随结果带回', { steps: done })
      })

    const stopped = await ctx.run('sequence-stop')
    await stopped.open(ctx.url('/form/'))
    await ctx.check(
      'stops-at-first-failure',
      '第二步等不到条件：停在第二步，后面的输入和读取不执行，第一步的输入保留',
      ['browser_sequence'],
      async () => {
        const page = await observe(stopped)
        const result = await stopped.call('browser_sequence', {
          steps: [
            { tool: 'browser_type', args: { target_id: page.pick('姓名', { purpose: 'input' }).targetId, text: '停' } },
            { tool: 'browser_wait', args: { condition: 'text', text: '这段文字不会出现', timeout_ms: 800 } },
            { tool: 'browser_type', args: { target_id: page.pick('邮箱', { purpose: 'input' }).targetId, text: 'never@example.test' } },
            { tool: 'browser_read', args: {} },
          ],
        })
        const name = await fieldValue(stopped, '#name')
        const email = await fieldValue(stopped, '#email')
        const done = steps(result)
        if (result.data.ok !== false || result.data.stoppedAt !== 2 || errorKind(result) !== 'wait_not_matched') {
          return fail(`没有停在第二步：${summarize(result, 600)}`)
        }
        if (done.length !== 2 || !done[0].ok || done[1].ok) return fail(`步骤记录不对：${JSON.stringify(done)}`)
        if (notExecuted(result).join(',') !== '3,4' || result.data.observation !== null) return fail(`未执行清单不对：${summarize(result, 400)}`)
        if (name !== '停' || email !== '') return fail(`页面状态不对：name=${String(name)} email=${String(email)}`)
        return pass('停在第 2 步（wait_not_matched）；第 3、4 步未执行；第 1 步的输入保留')
      })

    const refused = await ctx.run('sequence-refuse')
    await refused.open(ctx.url('/form/'))
    await ctx.check(
      'bad-list-runs-nothing',
      '清单里有一步参数不合法、或观察步骤不在最后：一步都不执行',
      ['browser_sequence'],
      async () => {
        const page = await observe(refused)
        const name = page.pick('姓名', { purpose: 'input' }).targetId
        const invalid = await refused.call('browser_sequence', {
          steps: [
            { tool: 'browser_type', args: { target_id: name, text: '错' } },
            { tool: 'browser_type', args: { target_id: name, text: 42 } },
          ],
        })
        const early = await refused.call('browser_sequence', {
          steps: [
            { tool: 'browser_type', args: { target_id: name, text: '错' } },
            { tool: 'browser_snapshot', args: {} },
            { tool: 'browser_type', args: { target_id: name, text: '错' } },
          ],
        })
        const nested = await refused.call('browser_sequence', {
          steps: [{ tool: 'browser_sequence', args: { steps: [{ tool: 'browser_snapshot', args: {} }] } }],
        })
        const value = await fieldValue(refused, '#name')
        if (value !== '') return fail(`被拒绝的清单仍然改了页面：name=${String(value)}`)
        if (errorKind(invalid) !== 'input_validation' || steps(invalid).length !== 0) return fail(`参数不合法没有整单拒绝：${summarize(invalid, 400)}`)
        if (errorKind(early) !== 'browser_sequence_observation_not_last' || steps(early).length !== 0) {
          return fail(`中途的观察没有整单拒绝：${summarize(early, 400)}`)
        }
        if (errorKind(nested) !== 'input_validation') return fail(`嵌套没有被拒绝：${summarize(nested, 400)}`)
        return pass('三种不合规的清单都没有执行任何一步，页面未变')
      })
  },
}
