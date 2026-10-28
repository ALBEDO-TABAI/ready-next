const {spawnSync}=require('node:child_process')
const result=spawnSync(require('electron'),['node_modules/tsx/dist/cli.mjs','--test','--test-concurrency=1','src/__tests__/calendar-union-native.test.ts','src/__tests__/codex-workbench-surface-native.test.ts'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',maxBuffer:32*1024*1024})
if(result.error)throw result.error
process.stdout.write(result.stdout);process.stderr.write(result.stderr)
if(/(?:skipped|# skipped) [1-9]\d*/.test(result.stdout))throw new Error('Calendar native checks must not skip')
process.exit(result.status??1)
