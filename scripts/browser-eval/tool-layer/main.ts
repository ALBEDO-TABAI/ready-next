// Tool-layer eval entry (W7-T2): runs every case group against the local benchmark sites
// and writes a JSON report. Loaded by app.mjs inside a hidden Electron Main process.
import { session } from 'electron'

import { getDatabase } from '../../../src/main/modules/database'
import {
  buildBrowserAdmissionAuthoritySnapshot,
  composeBrowserAdmissionToolNames,
} from '../../../src/main/modules/agent-control/codex-runtime/codex-browser-admission'
import { BROWSER_CAPABILITY_REGISTRY } from '../../../src/shared/browser-capability-registry'
import { startEvalSites } from '../server.mjs'
import { writeAttachmentFixtures } from '../fixtures.mjs'
import { CASE_GROUPS } from './cases/index'
import {
  AgentRun,
  createEnvironment,
  fail,
  type CaseOutcome,
  type CaseResult,
  type CaseStatus,
  type EvalServer,
  type GroupContext,
} from './harness'

export async function runToolLayerEval(input: {
  profile: string
  downloads: string
  only: string[]
  guardViolations: Array<{ call: string; detail: string }>
}): Promise<Record<string, unknown>> {
  const started = Date.now()
  // server.mjs is plain JS; its returned shape is the EvalServer contract checked by its tests.
  const server = await startEvalSites({ quiet: true }) as unknown as EvalServer
  const env = await createEnvironment(server, input.profile)
  const attachmentInfo = await writeAttachmentFixtures(env.attachmentsDir)
  const results: CaseResult[] = []
  const groups = input.only.length > 0 ? CASE_GROUPS.filter((group) => input.only.includes(group.site)) : CASE_GROUPS
  try {
    for (const group of groups) {
      const runs: AgentRun[] = []
      const ctx: GroupContext = {
        env,
        server,
        url: (path, origin = 'main') => server.url(path, origin),
        run: async (label, options = {}) => {
          const attachments = (options.attachments || []).map((name) => {
            const found = attachmentInfo.find((item: { name: string }) => item.name === name)
            if (!found) throw new Error(`attachment fixture missing: ${name}`)
            return found
          })
          const agentRun = new AgentRun(env, `${group.site}-${label}`, { attachments })
          runs.push(agentRun)
          return agentRun
        },
        loginAsUser: async () => {
          const cookie = server.login()
          await session.fromPartition('persist:browser').cookies.set(
            { url: cookie.url, name: cookie.name, value: cookie.value, path: cookie.path, httpOnly: cookie.httpOnly }
          )
        },
        check: async (id, title, tools, body) => {
          const caseStarted = Date.now()
          let outcome: CaseOutcome
          try {
            outcome = await body()
          } catch (error) {
            outcome = fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
          }
          results.push(
            {
              site: group.site,
              id: `${group.site}.${id}`,
              title,
              status: outcome.status,
              tools,
              detail: outcome.detail,
              evidence: outcome.evidence,
              durationMs: Date.now() - caseStarted
            }
          )
          process.stdout.write(`${outcome.status.padEnd(11)} ${group.site}.${id} — ${outcome.detail}\n`)
          return outcome
        },
      }
      try {
        server.reset()
        await group.run(ctx)
      } catch (error) {
        results.push(
          {
            site: group.site,
            id: `${group.site}.__group__`,
            title: '用例组异常',
            status: 'fail',
            tools: [],
            detail: error instanceof Error ? error.stack || error.message : String(error),
            durationMs: 0
          }
        )
        process.stdout.write(
          `fail        ${group.site}.__group__ — ${error instanceof Error ? error.message : String(error)}\n`
        )
      } finally {
        for (const run of runs) run.close()
      }
    }
  } finally {
    for (const tab of env.controller.getTabList()) {
      try { env.controller.closeTab(tab.id) } catch { /* closing best-effort during teardown */ }
    }
    env.window.destroy()
    await server.close()
    getDatabase().close()
  }
  if (input.guardViolations.length > 0) {
    results.push(
      {
        site: 'guard',
        id: 'guard.no-visible-window',
        title: '全程不显示、不聚焦、不外开',
        status: 'fail',
        tools: [],
        detail: JSON.stringify(input.guardViolations.slice(0, 10)),
        durationMs: 0
      }
    )
  } else {
    results.push(
      {
        site: 'guard',
        id: 'guard.no-visible-window',
        title: '全程不显示、不聚焦、不外开',
        status: 'pass',
        tools: [],
        detail: '没有窗口显示、聚焦或外部打开的调用',
        durationMs: 0
      }
    )
  }
  const bySite: Record<string, Record<CaseStatus, number>> = {}
  for (const result of results) {
    bySite[result.site] ||= { pass: 0, fail: 0, unavailable: 0, gap: 0 }
    bySite[result.site][result.status] += 1
  }
  const totals = { pass: 0, fail: 0, unavailable: 0, gap: 0 }
  for (const counts of Object.values(bySite)) {
    totals.pass += counts.pass
    totals.fail += counts.fail
    totals.unavailable += counts.unavailable
    totals.gap += counts.gap
  }
  const publicTools = Object.keys(BROWSER_CAPABILITY_REGISTRY).sort()
  const sampleSurface = composeBrowserAdmissionToolNames(buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'surface-sample',
    activeWorkbenchMode: 'browser',
    currentBrowserPageRef: {
      tabId: 'sample',
      physicalTargetToken: 'sample',
      mainFrameDocumentToken: 'sample',
      mainFrameId: '0',
      profileId: null
    },
    hasExplicitAttachment: true,
    hasWritableRoot: true,
  }))
  const report = {
    ok: totals.fail === 0,
    kind: 'browser-eval-tool-layer',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    window: 'hidden (show:false, activation policy prohibited, show/focus refused)',
    surface: {
      currentPageWithAttachmentAndWritableRoot: sampleSurface,
      notInCurrentPageSurface: publicTools.filter((name) => !sampleSurface.includes(name)),
    },
    totals,
    bySite,
    cases: results,
  }
  return report
}
