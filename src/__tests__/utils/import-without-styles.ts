import { registerHooks } from 'node:module'

/** Node has no stylesheet loader; keep every JavaScript dependency real. */
export async function importWithoutStyles<T>(load: () => Promise<T>): Promise<T> {
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return next(url, context)
  } })
  try { return await load() } finally { hooks.deregister() }
}
