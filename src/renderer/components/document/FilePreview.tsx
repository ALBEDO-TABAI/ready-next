import { useMemo, lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { type DocTab } from '../../stores/useDocTabs'
import { toLocalFileUrl } from '../../utils/dragDrop'
import { getFileExtension } from '../../utils/path'

const PdfViewer = lazy(() => import('./PdfViewer'))
const ArtVideoPlayer = lazy(() => import('./ArtVideoPlayer'))
const ImageGallery = lazy(() => import('./ImageGallery'))

const getFileExt = (path: string | null): string => {
  if (!path) return ''
  return getFileExtension(path)
}

const LoadingFallback = ({ bg = 'var(--bg-content)' }: { bg?: string }) => (
  <div className="flex-1 flex items-center justify-center" style={{ background: bg }}>
    <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--text-light)' }} />
  </div>
)

interface FilePreviewProps {
  tab: DocTab
}

export default function FilePreview({ tab }: FilePreviewProps) {
  const currentExt = useMemo(() => getFileExt(tab.path), [tab.path])
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(currentExt)
  const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(currentExt)
  const isPdf = currentExt === 'pdf'

  const fileUrl = tab.path ? toLocalFileUrl(tab.path) : ''

  if (isImage && tab.path) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <ImageGallery tab={tab} fileUrl={fileUrl} currentExt={currentExt} />
      </Suspense>
    )
  }

  if (isVideo && tab.path) {
    return (
      <Suspense fallback={<LoadingFallback bg="var(--bg-canvas)" />}>
        <ArtVideoPlayer tab={tab} fileUrl={fileUrl} currentExt={currentExt} />
      </Suspense>
    )
  }

  if (isPdf && tab.path) {
    return (
      <Suspense fallback={<LoadingFallback bg="var(--bg-editor)" />}>
        <PdfViewer tab={tab} fileUrl={fileUrl} />
      </Suspense>
    )
  }

  // Fallback: unsupported
  return (
    <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
      <p className="text-[13px]">暂不支持预览该格式</p>
    </div>
  )
}
