import { createContext, useContext } from 'react'
import type { DocumentBlock, DocumentBuffer } from '../../../../shared/document-blocks'
import type { MenuItem } from '../block-editor/CommandMenu'
export interface AnnotationMenus {
  blockItems(block: DocumentBlock, snapshot: DocumentBuffer): MenuItem[]
  slashItems(insert: (markdown: string) => void): MenuItem[]
}
export const AnnotationMenuContext = createContext<AnnotationMenus>({ blockItems: () => [], slashItems: () => [] })
export const useAnnotationMenus = () => useContext(AnnotationMenuContext)
