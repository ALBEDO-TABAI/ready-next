import { readdir, readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { sha256 } from './fixtures.mjs'

export async function collectOutcome({ server, roots, finalText = '', metrics = {} }) {
  const files = []
  async function walk(root, base, relative = '') {
    let entries
    try {
      entries = await readdir(join(base, relative), { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(root, base, path)
      else if (entry.isFile()) {
        const bytes = await readFile(join(base, path))
        files.push({
          root,
          path,
          size: bytes.length,
          sha256: sha256(bytes),
          text:
            /\.(md|markdown|txt|csv|json|html|htm|tsv)$/.test(extname(path).toLowerCase()) &&
            bytes.length <= 512 * 1024
              ? bytes.toString('utf8')
              : null,
        })
      }
    }
  }
  await walk('workspace', roots.workspace)
  if (roots.downloads) await walk('downloads', roots.downloads)
  return {
    origins: { ...server.origins },
    records: server.records(),
    files,
    finalText,
    metrics: {
      interventions: metrics.interventions ?? 0,
      steps: metrics.steps ?? null,
      tokens: metrics.tokens ?? null,
      durationMs: metrics.durationMs ?? null,
    },
    fixtures: server.fixtures,
  }
}
