import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  CodexSidecarSupervisorError, MacCodexProcessInspector, NodeCodexSidecarSpawnPort, executableDigest,
  type CodexOwnedProcess, type CodexProcessInspectionLease, type CodexProcessInspector, type CodexSidecarSpawnPort,
} from './codex-sidecar-supervisor'

const run = promisify(execFile)
const helperName = 'ready-codex-job.exe'

function jobDigest(lease: CodexProcessInspectionLease): string {
  const markers = [lease.processLeaseId, lease.sidecarSpawnInstanceId, lease.connectionEpoch, lease.isolatedStateDir]
  return createHash('sha256').update(markers.join('\0'), 'utf16le').digest('hex')
}

function sameImage(observed: string, expected: string): boolean {
  return observed === expected || realpathSync.native(observed) === realpathSync.native(expected)
}

function parseJobRow(line: string) {
  const match = /^(\d+)\t(\d+)\t(\d+)\t([01])\t(.+)$/.exec(line)
  if (!match) throw new Error('invalid Windows process evidence')
  return {
    pid: Number(match[1]), parentPid: Number(match[2]), processStartIdentity: match[1] + ':' + match[3],
    member: match[4] === '1', executablePath: match[5],
  }
}

export function createCodexProcessPorts(executablePath: string, appPath: string): {
  inspector: CodexProcessInspector
  spawnPort: CodexSidecarSpawnPort
} {
  const nodeSpawn = new NodeCodexSidecarSpawnPort()
  if (process.platform === 'darwin') return { inspector: new MacCodexProcessInspector(), spawnPort: nodeSpawn }
  if (process.platform !== 'win32') throw new CodexSidecarSupervisorError('unsupported_process_platform')
  const helper = join(dirname(executablePath), helperName)
  // In a packaged app this digest lives in app.asar, separate from the executable in Resources.
  const expectedDigest = readFileSync(join(appPath, 'build/codex/ready-codex-job.sha256'), 'utf8').trim()
  function verifiedHelper(): string {
    if (executableDigest(helper) !== expectedDigest) throw new CodexSidecarSupervisorError('windows_job_digest_mismatch')
    return helper
  }
  const options = { windowsHide: true, timeout: 5_000, encoding: 'utf16le' } as const
  return {
    spawnPort: {
      spawn(input) {
        const child = nodeSpawn.spawn({ ...input, executablePath: verifiedHelper(), argv: [input.executablePath, ...input.argv] })
        return { ...child, launchesInJob: true }
      },
    },
    inspector: {
      async list(lease) {
        try {
          const args = ['list', String(lease?.ownerMainPid ?? process.pid)]
          if (lease) args.push(jobDigest(lease))
          const { stdout } = await run(verifiedHelper(), args, options)
          const rows = stdout.split('\n').filter(Boolean).map(parseJobRow)
          const expectedLauncher = lease && join(dirname(lease.executablePath), helperName)
          const launcher = rows.find((row) => row.member && expectedLauncher && sameImage(row.executablePath, expectedLauncher))
          const hasChild = launcher && rows.some((row) => row.member && row.parentPid === launcher.pid)
          // Before Codex appears, the launcher itself is a transient candidate. It cannot prove an empty tree.
          return rows.filter((row) => !(row === launcher && hasChild)).map((row): CodexOwnedProcess => {
            const owned = row.member ? lease : undefined
            const exactImage = owned && sameImage(row.executablePath, owned.executablePath)
            return {
              pid: row.pid, parentPid: row.parentPid, processStartIdentity: row.processStartIdentity,
              processGroupId: owned ? (launcher?.pid ?? owned.processGroupId ?? row.pid) : 0,
              executablePath: exactImage ? owned.executablePath : row.executablePath,
              executableSha256: exactImage ? executableDigest(row.executablePath) : null,
              markers: {
                processLeaseId: owned?.processLeaseId ?? null, sidecarSpawnInstanceId: owned?.sidecarSpawnInstanceId ?? null,
                connectionEpoch: owned?.connectionEpoch ?? null, stateDir: owned?.isolatedStateDir ?? null,
              },
            }
          })
        } catch (error) {
          throw new CodexSidecarSupervisorError('process_enumeration_failed', error)
        }
      },
      async terminateOwnedJob(lease) {
        try {
          await run(verifiedHelper(), ['terminate', jobDigest(lease)], options)
        } catch (error) {
          throw new CodexSidecarSupervisorError('process_job_termination_failed', error)
        }
      },
    },
  }
}
