const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const command = require('../../package.json').scripts['verify:rss-sieve']

test('R17 sieve verification rejects skipped tests as well as failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-sieve-runner-'))
  try {
    for (const [body, expected] of [["test('pass',()=>{})", 0], ["test.skip('skip',()=>{})", 1], ["test('fail',()=>{throw Error('fixture')})", 1]]) {
      const fixture = join(dir, 'fixture.test.cjs')
      writeFileSync(fixture, `const test=require('node:test');${body}`)
      // Preserve the configured gate. The import loader avoids tsx CLI's sandbox-denied IPC socket.
      const args = command.split(' src/__tests__/')[0].replace('./node_modules/tsx/dist/cli.mjs', '--import tsx').split(' ')
      if (args[0] === 'ELECTRON_RUN_AS_NODE=1') args.shift()
      const env = {...process.env,ELECTRON_RUN_AS_NODE:'1'}
      delete env.NODE_TEST_CONTEXT
      const result = spawnSync(args[0], [...args.slice(1), fixture], {env,encoding:'utf8'})
      assert.equal(result.status, expected, `${body}\n${result.stdout}\n${result.stderr}`)
    }
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
