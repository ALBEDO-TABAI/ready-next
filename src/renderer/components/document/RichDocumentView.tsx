import NotePreview from './NotePreview'

interface RichDocumentViewProps {
  content: string
  notePath?: string | null
}

export default function RichDocumentView({ content, notePath }: RichDocumentViewProps) {
  return <NotePreview content={content} notePath={notePath} />
}
