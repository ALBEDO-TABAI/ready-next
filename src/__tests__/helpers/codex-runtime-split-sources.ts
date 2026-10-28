import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const runtimeRoot = 'src/main/modules/agent-control/codex-runtime'

function modulePaths(directory: string): string[] {
  return readdirSync(join(repoRoot, runtimeRoot, directory))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => `${runtimeRoot}/${directory}/${name}`)
}

function readAll(paths: string[]): string {
  return paths.map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n')
}

/** Repository-relative paths of the runtime composition's factories, which its entry file assembles. */
export function codexRuntimeCompositionModulePaths(): string[] {
  return modulePaths('composition')
}

/**
 * The source of every runtime composition factory. A check over `codex-runtime-production-composition.ts` covers the
 * whole live composition only together with these.
 */
export function readCodexRuntimeCompositionModules(): string {
  return readAll(codexRuntimeCompositionModulePaths())
}

/**
 * The source of every binding repository module. A check over `codex-binding-repository.ts` covers the whole
 * repository only together with these.
 */
export function readCodexBindingRepositoryModules(): string {
  return readAll(modulePaths('binding-repository'))
}
