import { createContext } from 'react'

/** The editing slot registers its flush/acknowledgement boundary with the
 * surface that owns the close button, including through composition wrappers. */
export const CanvasEditorLifecycle = createContext<((finish: () => Promise<void>) => () => void) | null>(null)
