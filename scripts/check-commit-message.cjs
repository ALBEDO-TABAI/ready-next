#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')

const FORBIDDEN_PHRASES = [
  /\bas a follow-up\b/i,
  /\bin a follow-up\b/i,
  /\bfollow[- ]?up\b/i,
  /\blater\b/i,
  /\bsubsequent(?:ly)?\b/i,
]

function main(argv = process.argv.slice(2)) {
  const message = readMessage(argv)
  const result = checkCommitMessage(message)
  if (!result.ok) {
    console.error(result.errors.join('\n'))
    return 1
  }
  console.log('Commit message ok.')
  return 0
}

function checkCommitMessage(message) {
  const text = String(message || '')
  const errors = []
  for (const phrase of FORBIDDEN_PHRASES) {
    if (phrase.test(text)) {
      errors.push(`Commit message defers work with forbidden phrase: ${phrase}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

function readMessage(argv) {
  const messageIndex = argv.indexOf('--message')
  if (messageIndex >= 0) return argv[messageIndex + 1] || ''
  const fileIndex = argv.indexOf('--file')
  if (fileIndex >= 0) {
    const file = argv[fileIndex + 1]
    if (!file || !existsSync(file)) return ''
    return readFileSync(file, 'utf8')
  }
  if (argv[0] && existsSync(argv[0])) return readFileSync(argv[0], 'utf8')
  return argv.join(' ')
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = {
  checkCommitMessage,
  main,
}
