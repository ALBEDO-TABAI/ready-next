#!/usr/bin/env node

console.log(JSON.stringify({
  status: 'error',
  message: 'send-im must be executed through Ready Agent tool dispatch.',
}))
process.exitCode = 1
