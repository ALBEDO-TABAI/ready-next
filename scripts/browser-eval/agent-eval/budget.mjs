// Spend control for the task-layer eval. Pure functions: the runner feeds measured or estimated
// token counts after every attempt and stops before the next attempt once a cap is reached.

export const DEFAULT_BUDGET = Object.freeze({
  maxTokens: 2_000_000,
  maxTokensPerAttempt: 400_000,
  maxCostUsd: 5,
  maxAttempts: 72,
})

/** Estimated tokens for one attempt, used only to print a plan before anything is spent. */
export const PLANNING_TOKENS_PER_ATTEMPT = 300_000

/**
 * Prices are USD per 1M tokens, given by the person running the eval for the model their
 * profile uses. Without prices the cost cap cannot be evaluated and only the token caps apply.
 */
export function parsePrices(input = {}) {
  const read = (value) => {
    if (value === undefined || value === null || value === '') return null
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0) throw new Error(`invalid price: ${value}`)
    return number
  }
  const prices = {
    input: read(input.input),
    cachedInput: read(input.cachedInput),
    output: read(input.output),
  }
  if (prices.cachedInput === null && prices.input !== null) prices.cachedInput = prices.input
  return prices.input === null || prices.output === null ? null : prices
}

/** Cost of one token record { input, cachedInput, output } in USD, or null without prices. */
export function costOf(tokens, prices) {
  if (!prices || !tokens) return null
  const cached = Math.max(0, Number(tokens.cachedInput || 0))
  const uncached = Math.max(0, Number(tokens.input || 0) - cached)
  const output = Math.max(0, Number(tokens.output || 0))
  return (uncached * prices.input + cached * prices.cachedInput + output * prices.output) / 1_000_000
}

export function createBudget(options = {}) {
  const limits = {
    maxTokens: Number(options.maxTokens ?? DEFAULT_BUDGET.maxTokens),
    maxTokensPerAttempt: Number(options.maxTokensPerAttempt ?? DEFAULT_BUDGET.maxTokensPerAttempt),
    maxCostUsd: Number(options.maxCostUsd ?? DEFAULT_BUDGET.maxCostUsd),
    maxAttempts: Number(options.maxAttempts ?? DEFAULT_BUDGET.maxAttempts),
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid budget ${key}: ${value}`)
  }
  const prices = options.prices ?? null
  const spent = { attempts: 0, tokens: 0, costUsd: 0, estimatedAttempts: 0, unmeteredAttempts: 0 }
  return {
    limits,
    prices,
    spent,
    /** Why the next attempt must not start, or null when it may. */
    blockReason() {
      if (spent.attempts >= limits.maxAttempts) return `已达尝试上限 ${limits.maxAttempts} 次`
      if (spent.tokens >= limits.maxTokens) return `已达令牌上限 ${limits.maxTokens}`
      if (prices && spent.costUsd >= limits.maxCostUsd) return `已达费用上限 $${limits.maxCostUsd}`
      if (spent.unmeteredAttempts > 0) return '上一次尝试的令牌数无法计量，为防超支停止'
      return null
    },
    /** Record one finished attempt. `tokens` is { total, input, cachedInput, output, method }. */
    record(tokens) {
      spent.attempts += 1
      if (!tokens || !Number.isFinite(Number(tokens.total))) {
        spent.unmeteredAttempts += 1
        return
      }
      if (tokens.method === 'estimated') spent.estimatedAttempts += 1
      spent.tokens += Number(tokens.total)
      const cost = costOf(tokens, prices)
      if (cost !== null) spent.costUsd += cost
    },
  }
}

export function planEstimate(attempts, prices) {
  const tokens = attempts * PLANNING_TOKENS_PER_ATTEMPT
  const cost = prices ? costOf({ input: tokens * 0.9, cachedInput: tokens * 0.5, output: tokens * 0.1 }, prices) : null
  return { attempts, tokens, costUsd: cost }
}
