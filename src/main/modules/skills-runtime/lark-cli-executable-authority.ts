import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

import {
  DesktopExecutableAuthorityError,
  resolveFrozenDesktopExecutableAuthority,
  type FrozenDesktopExecutableAuthority,
} from './desktop-executable-authority'

function globalLarkCliPayloads(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli',
      '/usr/local/lib/node_modules/@larksuite/cli/bin/lark-cli',
    ]
  }
  if (platform === 'win32') {
    return [
      env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe') : '',
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'lark-cli', 'lark-cli.exe') : '',
    ].filter(Boolean)
  }
  return [
    '/usr/local/lib/node_modules/@larksuite/cli/bin/lark-cli',
    '/usr/lib/node_modules/@larksuite/cli/bin/lark-cli',
  ]
}

export async function resolveGlobalLarkCliExecutableAuthority(input: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  searchDirectories?: readonly string[]
} = {}): Promise<FrozenDesktopExecutableAuthority> {
  const platform = input.platform || process.platform
  const sourceEnv = input.env || process.env
  if (!input.searchDirectories) {
    const payloadPath = globalLarkCliPayloads(platform, sourceEnv).find((candidate) => existsSync(candidate))
    if (!payloadPath) throw new DesktopExecutableAuthorityError('dependency_unavailable')
    const payloadDirectory = dirname(payloadPath)
    return resolveFrozenDesktopExecutableAuthority({
      program: 'lark-cli',
      env: { ...sourceEnv, PATH: payloadDirectory },
      platform,
      additionalSearchDirectories: [payloadDirectory],
      directPayloadRequired: true,
    })
  }
  const searchDirectories = [...input.searchDirectories]
  const sanitizedEnv = {
    ...sourceEnv,
    PATH: searchDirectories.join(delimiter),
  }
  return resolveFrozenDesktopExecutableAuthority({
    program: 'lark-cli',
    env: sanitizedEnv,
    platform,
    additionalSearchDirectories: searchDirectories,
  })
}
