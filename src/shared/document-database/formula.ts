type Expression = { kind: 'literal'; value: unknown } | { kind: 'unary'; op: string; value: Expression } | { kind: 'binary'; op: string; left: Expression; right: Expression } | { kind: 'call'; name: string; args: Expression[] }
export class FormulaError extends Error { constructor(readonly code: string, message: string) { super(message) } }
const fail = (message: string): never => { throw new FormulaError('syntax', message) }
const precedence: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }
export function parseFormula(source: string): Expression {
  if (source.length > 4096) return fail('Expression is too long')
  const tokens: string[] = []
  let offset = 0
  while (offset < source.length) {
    const space = /^\s+/.exec(source.slice(offset)); if (space) { offset += space[0].length; continue }
    const match = /^(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|[a-zA-Z_][a-zA-Z_0-9]*|==|!=|<=|>=|&&|\|\||[+*/%<>()!,-])/.exec(source.slice(offset))
    if (!match) return fail(`Invalid token at ${offset}`)
    tokens.push(match[0]); offset += match[0].length
  }
  let at = 0
  const parse = (minimum: number, depth: number): Expression => {
    if (depth > 64) return fail('Expression nesting exceeds 64')
    const token = tokens[at++]
    let left: Expression
    if (!token) return fail('Expected expression')
    if (token === '(') { left = parse(0, depth + 1); if (tokens[at++] !== ')') return fail('Expected )') }
    else if (['!', '+', '-'].includes(token)) left = { kind: 'unary', op: token, value: parse(7, depth + 1) }
    else if (/^\d/.test(token)) left = { kind: 'literal', value: Number(token) }
    else if (token.startsWith('"')) left = { kind: 'literal', value: JSON.parse(token) }
    else if (['true', 'false', 'null'].includes(token)) left = { kind: 'literal', value: JSON.parse(token) }
    else {
      if (!['prop', 'if', 'coalesce', 'abs', 'round', 'min', 'max'].includes(token) || tokens[at++] !== '(') return fail(`Unknown function ${token}`)
      const args: Expression[] = []
      if (tokens[at] !== ')') { do { args.push(parse(0, depth + 1)) } while (tokens[at] === ',' && ++at) }
      if (tokens[at++] !== ')') return fail('Expected )')
      if (token === 'prop' && (args.length !== 1 || args[0].kind !== 'literal' || typeof args[0].value !== 'string')) return fail('prop requires one literal field id')
      if ((['abs', 'round'].includes(token) && args.length !== 1) || (token === 'if' && args.length !== 3) || (['min', 'max', 'coalesce'].includes(token) && !args.length)) return fail(`Invalid arguments for ${token}`)
      left = { kind: 'call', name: token, args }
    }
    while (Object.hasOwn(precedence, tokens[at]) && precedence[tokens[at]] >= minimum) {
      const op = tokens[at++], right = parse(precedence[op] + 1, depth + 1)
      left = { kind: 'binary', op, left, right }
    }
    return left
  }
  const result = parse(0, 0)
  if (at !== tokens.length) return fail(`Unexpected token ${tokens[at]}`)
  return result
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new FormulaError('type', 'Expected finite number')
  return value
}
export function evaluateFormula(tree: Expression, prop: (id: string) => unknown): unknown {
  const run = (node: Expression): unknown => {
    if (node.kind === 'literal') return node.value
    if (node.kind === 'unary') { const value = run(node.value); return node.op === '!' ? !value : node.op === '-' ? -number(value) : number(value) }
    if (node.kind === 'call') {
      if (node.name === 'prop') return prop(String(run(node.args[0])))
      if (node.name === 'if') return run(node.args[run(node.args[0]) ? 1 : 2])
      if (node.name === 'coalesce') { for (const arg of node.args) { const value = run(arg); if (value !== undefined && value !== null) return value } return null }
      const values = node.args.map(arg => number(run(arg)))
      if (node.name === 'abs') return Math.abs(values[0])
      if (node.name === 'round') return Math.round(values[0])
      return node.name === 'min' ? Math.min(...values) : Math.max(...values)
    }
    const a = run(node.left)
    if (node.op === '&&') return a && run(node.right)
    if (node.op === '||') return a || run(node.right)
    const b = run(node.right)
    if (node.op === '==') return a === b
    if (node.op === '!=') return a !== b
    if (['<', '<=', '>', '>='].includes(node.op)) {
      if (!(typeof a === 'string' && typeof b === 'string') && !(typeof a === 'number' && typeof b === 'number')) throw new FormulaError('type', 'Comparison requires matching numbers or strings')
      const order = a < b ? -1 : a === b ? 0 : 1
      return node.op === '<' ? order < 0 : node.op === '<=' ? order <= 0 : node.op === '>' ? order > 0 : order >= 0
    }
    if (node.op === '+' && typeof a === 'string' && typeof b === 'string') return a + b
    const x = number(a), y = number(b)
    if ((node.op === '/' || node.op === '%') && y === 0) throw new FormulaError('division_by_zero', 'Division by zero')
    return node.op === '+' ? x + y : node.op === '-' ? x - y : node.op === '*' ? x * y : node.op === '/' ? x / y : x % y
  }
  const value = run(tree)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new FormulaError('non_finite', 'Non-finite formula result')
  return value
}
