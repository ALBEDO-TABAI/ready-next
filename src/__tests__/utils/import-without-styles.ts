import { registerHooks } from 'node:module'

/** Node has no stylesheet loader; keep every JavaScript dependency real. */
export async function importWithoutStyles<T>(load: () => Promise<T>): Promise<T> {
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return next(url, context)
  } })
  try { return await load() } finally { hooks.deregister() }
}

/** Like importWithoutStyles; an imported image (a bundler URL) becomes its file URL. */
export async function importWithoutAssets<T>(load: () => Promise<T>): Promise<T> {
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    if (/\.(svg|png|jpe?g|webp)$/i.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    return next(url, context)
  } })
  try { return await load() } finally { hooks.deregister() }
}
