// Majority vote, aggregation and the written result of a task-layer run. Pure functions.

/** Attempts needed for a decision out of `planned` (2 of 3 by default). */
export function majorityThreshold(planned) {
  return Math.floor(planned / 2) + 1
}

/** 'pass' | 'fail' once decided, otherwise null (more attempts could still change it). */
export function decide(attempts, planned) {
  const counted = attempts.filter((attempt) => attempt.status !== 'skipped_budget')
  const passes = counted.filter((attempt) => attempt.pass === true).length
  const fails = counted.length - passes
  const need = majorityThreshold(planned)
  if (passes >= need) return 'pass'
  if (fails >= need) return 'fail'
  return null
}

/** Whether another attempt can change the outcome (used to stop early and save cost). */
export function needsAnotherAttempt(attempts, planned, earlyStop = true) {
  if (attempts.length >= planned) return false
  return earlyStop ? decide(attempts, planned) === null : true
}

function mean(values) {
  const numbers = values.filter((value) => Number.isFinite(value))
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
}

export function summarizeTask(task, attempts, planned) {
  const verdict = decide(attempts, planned)
  const counted = attempts.filter((attempt) => attempt.status !== 'skipped_budget')
  return {
    id: task.id,
    category: task.category,
    title: task.title,
    verdict: verdict ?? 'undecided',
    passes: counted.filter((attempt) => attempt.pass === true).length,
    attempts: counted.length,
    meanSteps: mean(counted.map((attempt) => attempt.steps)),
    meanTokens: mean(counted.map((attempt) => attempt.tokens?.total)),
    meanSeconds: mean(counted.map((attempt) => (attempt.durationMs ?? NaN) / 1000)),
    meanInterventions: mean(counted.map((attempt) => attempt.interventions?.total)),
  }
}

export function aggregate(taskSummaries) {
  const categories = {}
  for (const category of ['A', 'B', 'C', 'D']) {
    const tasks = taskSummaries.filter((task) => task.category === category)
    const passed = tasks.filter((task) => task.verdict === 'pass').length
    categories[category] = { tasks: tasks.length, passed, rate: tasks.length ? passed / tasks.length : null }
  }
  const passed = taskSummaries.filter((task) => task.verdict === 'pass').length
  const total = taskSummaries.length
  const overall = total ? passed / total : null
  const undecided = taskSummaries.filter((task) => task.verdict === 'undecided').length
  return {
    overall: { tasks: total, passed, rate: overall, undecided },
    categories,
    g9: {
      overallAtLeast90: overall !== null && overall >= 0.9,
      everyCategoryAtLeast80: Object.values(categories).every((item) => item.rate !== null && item.rate >= 0.8),
    },
  }
}

const percent = (rate) => (rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`)
const round = (value, digits = 0) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits))

export function renderMarkdown(result) {
  const lines = []
  lines.push(`# 浏览器 Agent 任务层评测 ${result.date}`)
  lines.push('')
  lines.push(
    `> 运行器：\`npm run verify:browser-agent-eval -- ${result.config.argv.join(' ')
    }\`；结果原始数据见同目录 \`results.json\`。`
  )
  lines.push('')
  lines.push('## 配置')
  lines.push('')
  lines.push(
    `- 代码：\`${result.config.gitHead}\`（${result.config.gitDirty ? '有未提交改动' : '工作区干净'}）`
  )
  lines.push(
    `- 模型：${result.config.model || '未知'
    }；窗口：${result.config.window
    }；行动授权：${result.config.authorizationMode
    }`
  )
  lines.push(
    `- 每个任务计划 ${result.config.repeats
    } 次、取多数${result.config.earlyStop ? '（结果已定时提前停）' : ''
    }`
  )
  lines.push(
    `- 上限：总令牌 ${result.budget.limits.maxTokens
    }，单次 ${result.budget.limits.maxTokensPerAttempt
    }，费用 $${result.budget.limits.maxCostUsd
    }${result.budget.prices ? '' : '（未给单价，费用上限不生效）'
    }，尝试 ${result.budget.limits.maxAttempts
    } 次`
  )
  lines.push(
    `- 实际：${result.budget.spent.attempts
    } 次尝试，${result.budget.spent.tokens
    } 令牌${result.budget.spent.estimatedAttempts
      ? `（其中 ${result.budget.spent.estimatedAttempts} 次为估算）`
      : ''
    }，约 $${round(result.budget.spent.costUsd, 2)
    }`
  )
  if (result.stoppedReason) lines.push(`- 提前停止：${result.stoppedReason}`)
  lines.push('')
  lines.push('## 通过率')
  lines.push('')
  lines.push('| 范围 | 通过 / 任务 | 通过率 |')
  lines.push('| --- | --- | --- |')
  for (const [category, item] of Object.entries(result.aggregate.categories)) {
    lines.push(`| ${category} | ${item.passed} / ${item.tasks} | ${percent(item.rate)} |`)
  }
  lines.push(
    `| 合计 | ${result.aggregate.overall.passed
    } / ${result.aggregate.overall.tasks
    } | ${percent(result.aggregate.overall.rate)
    } |`
  )
  lines.push('')
  lines.push(
    `路线图 G9（整体 ≥ 90%、四类各 ≥ 80%）：${result.aggregate.g9.overallAtLeast90
      && result.aggregate.g9.everyCategoryAtLeast80 ? '达到' : '未达到'
    }。`
  )
  lines.push('')
  lines.push('## 每个任务')
  lines.push('')
  lines.push('| 任务 | 结果 | 通过/尝试 | 平均步数 | 平均令牌 | 平均秒数 | 平均介入 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const task of result.tasks) {
    lines.push(
      `| ${task.id
      } ${task.title
      } | ${task.verdict
      } | ${task.passes
      }/${task.attempts
      } | ${round(task.meanSteps, 1)
      } | ${round(task.meanTokens)
      } | ${round(task.meanSeconds)
      } | ${round(task.meanInterventions, 1)
      } |`
    )
  }
  lines.push('')
  lines.push('## 未通过的判定项')
  lines.push('')
  for (const attempt of result.attempts.filter((item) => !item.pass && item.status !== 'skipped_budget')) {
    const failed = (attempt.checks || []).filter((check) => !check.pass).map((check) => check.id)
    lines.push(
      `- ${attempt.taskId
      } 第 ${attempt.attempt
      } 次（${attempt.status
      }${attempt.failureKind ? `，${attempt.failureKind}` : ''
      }）：${failed.join('、') || '无判定（运行未完成）'
      }`
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
