import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { join } from 'path'
import { rmSync, writeFileSync } from 'fs'

// See database.ts for the full rationale. Electron's Node entry is a CJS
// string-export, so ESM `import { session } from 'electron'` breaks tsx/ESM
// tests that transitively load this file. `createRequire(...)('electron')`
// succeeds in both the real Electron runtime (named members populated) and in
// plain Node (destructuring a string yields `undefined`, which is guarded by
// the `session?.fromPartition` check below).
const electronModule = (() => {
  try { return createRequire(import.meta.url)('electron') as typeof import('electron') }
  catch { return {} as typeof import('electron') }
})()
const { session } = electronModule

import { logAgentMetric } from '../agent-control/metrics'
import type { SkillDefinition } from '../../../shared/skill-execution-types'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import type { ExternalServiceStore } from '../settings-engine/external-service-store'
import type { SkillConfigurationStore } from './skill-configuration-store'

// B8-D M1 (2026-07-05) — delegated extraction from SkillsRuntimeManager
// (surgery map §2.3 D 表). Method bodies moved verbatim; the only edits are
// the mechanical `this.X` → `this.deps.X` rewrites for the injected dependency
// face below. The FunASR env builders live in ModelPackManager and are
// injected as callbacks so this file never imports runtime-manager.

export interface ExternalEnvResolverDeps {
  runtimeRoot: string
  packagedRuntimeRoot: string | null
  externalServiceStore: ExternalServiceStore
  skillConfigurationStore: SkillConfigurationStore
  buildFunasrNanoRuntimeEnv: () => Record<string, string>
  buildFunasrFallbackModelEnv: (options: { packaged: boolean }) => Record<string, string>
}

export class ExternalEnvResolver {
  constructor(private readonly deps: ExternalEnvResolverDeps) {}

  resolveConfiguredAgentContext(definition: SkillDefinition): AgentSpawnContext | null {
    if (definition.id !== 'video-expert-analyzer') return null
    const values = this.deps.skillConfigurationStore.getValues(definition)
    const serviceId = values.serviceBindings.visionModel || 'vision-model-default'
    return this.deps.externalServiceStore.buildVisionAgentContext(serviceId)
  }

  private requiresExternalEnv(definition: SkillDefinition): boolean {
    return definition.id === 'lets-go-rss'
      || definition.id === 'video-copy-analyzer'
      || definition.id === 'video-expert-analyzer'
  }

  async resolveExternalEnv(definition: SkillDefinition): Promise<Record<string, string>> {
    if (!this.requiresExternalEnv(definition)) return {}
    // U0.2 — fail-fast: previously these catches swallowed config-load failures
    // and let the sub-agent start with a partial / empty env, which consumed
    // VEA / RSS budget before crashing deep in the long task. Throwing here
    // makes the failure surface immediately as a blocked task projection.
    let env: Record<string, string>
    try {
      env = this.deps.externalServiceStore.getSkillExternalEnv(definition.id)
    } catch (err) {
      logAgentMetric('runtime.config.load_failed', {
        skillId: definition.id,
        source: 'external_service_store',
      })
      throw new Error(
        `SkillRuntimeConfigError(external_service_unavailable): cannot resolve external env for ${definition.id} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (
      definition.id !== 'lets-go-rss'
      && definition.id !== 'video-copy-analyzer'
      && definition.id !== 'video-expert-analyzer'
    ) {
      return env
    }

    let values
    try {
      values = this.deps.skillConfigurationStore.getValues(definition)
    } catch (err) {
      logAgentMetric('runtime.config.load_failed', {
        skillId: definition.id,
        source: 'skill_configuration_store',
      })
      throw new Error(
        `SkillRuntimeConfigError(skill_configuration_corrupt): cannot read skill configuration for ${definition.id} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (definition.id === 'lets-go-rss') {
      const serviceId = values.serviceBindings.rsshub || 'rsshub-default'
      const rsshub = this.deps.externalServiceStore.getRuntimeService(serviceId)
      if (rsshub?.enabled && rsshub.baseUrl) {
        env.RSSHUB_BASE_URL = rsshub.baseUrl.replace(/\/+$/, '')
      }
    }

    if (definition.id === 'video-copy-analyzer' || definition.id === 'video-expert-analyzer') {
      const serviceId = values.serviceBindings.bilibili || 'bilibili-default'
      const bilibili = this.deps.externalServiceStore.getRuntimeService(serviceId)
      if (bilibili?.enabled) {
        if (bilibili.secrets.sessdata) env.BILIBILI_SESSDATA = bilibili.secrets.sessdata
        if (bilibili.secrets.biliJct) env.BILIBILI_BILI_JCT = bilibili.secrets.biliJct
        const cookieFile = bilibili.options.cookieFile
        if (typeof cookieFile === 'string' && cookieFile.trim()) env.BILIBILI_COOKIE_FILE = cookieFile.trim()
      }
      const videoCookieFile = await this.exportBrowserVideoCookies()
      if (videoCookieFile) {
        env.READY_VIDEO_COOKIE_FILE = videoCookieFile
        env.VIDEO_COOKIE_FILE = videoCookieFile
        env.YOUTUBE_COOKIE_FILE = videoCookieFile
      }
      Object.assign(
        env,
        this.deps.buildFunasrNanoRuntimeEnv(),
        this.deps.buildFunasrFallbackModelEnv({ packaged: !!this.deps.packagedRuntimeRoot }),
      )
    }

    return env
  }

  private async exportBrowserVideoCookies(): Promise<string | null> {
    if (!session?.fromPartition) return null
    try {
      const browserSession = session.fromPartition('persist:browser')
      const cookies = await browserSession.cookies.get({})
      if (cookies.length === 0) return null
      const cookiePath = join(this.deps.runtimeRoot, `.ready-video-cookies-${randomUUID()}.txt`)
      const lines = [
        '# Netscape HTTP Cookie File',
        ...cookies.map((cookie) => {
          const domain = String(cookie.domain || '')
          const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
          const path = cookie.path || '/'
          const secure = cookie.secure ? 'TRUE' : 'FALSE'
          const expires = typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)
            ? Math.floor(cookie.expirationDate)
            : 0
          return [
            domain,
            includeSubdomains,
            path,
            secure,
            String(expires),
            cookie.name,
            cookie.value,
          ].join('\t')
        }),
      ]
      writeFileSync(cookiePath, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
      return cookiePath
    } catch (error) {
      logAgentMetric('runtime.video_cookie_export_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  cleanupExportedVideoCookieFile(cookiePath: string | undefined): void {
    if (
      !cookiePath
      || !cookiePath.startsWith(this.deps.runtimeRoot)
      || (!cookiePath.includes('.ready-video-cookies-') && !cookiePath.includes('.ready-youtube-cookies-'))
    ) return
    try {
      rmSync(cookiePath, { force: true })
    } catch {
      // silent-catch: best-effort cleanup for a per-run temporary cookie export.
    }
  }
}
