#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const tests = [
  'database-domain-stores', 'database-readiness', 'database-pragmas', 'database',
  'rss-classification-persistence', 'migration-076-rss-item-identity',
  'rss-organization-store', 'rss-processing', 'rss-result-restoration', 'rss-result-migration', 'rss-method-validity', 'rss-events', 'rss-digests', 'rss-catalog', 'rss-workspace-read-store', 'rss-content-migration', 'rss-article-analysis', 'rss-analysis-report',
  'browser-task-persistence', 'browser-privacy-service',
  'ask-user-questions-boot-and-session-sweep', 'local-conversation-user-binding',
  'agent-sdk-scoped-run-persistence', 'session-recall-agent-scope',
  'session-recall-service', 'chat-message-persistence', 'calendar-wire-round-trip',
].map((name) => `src/__tests__/${name}.test.ts`)

const result = spawnSync(require('electron'), [
  'node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', ...tests,
], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
