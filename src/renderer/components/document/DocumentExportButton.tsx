import { useCallback, useRef, useState } from 'react'
import { Check, FileDown, Loader2 } from 'lucide-react'
import type { DocTab } from '../../stores/useDocTabs'
import { captureDocumentPreviewHtml } from './document-export-capture'
import { isMarkdownExportableTab, stripTitleExtension } from './document-export-target'
import './documentExportButton.css'

type ExportPhase = 'idle' | 'busy' | 'done' | 'error'

const PHASE_RESET_MS: Partial<Record<ExportPhase, number>> = {
  done: 1600,
  error: 3200,
}

export default function DocumentExportButton({ tab }: { tab: DocTab | null }) {
  const [phase, setPhase] = useState<ExportPhase>('idle')
  const [errorText, setErrorText] = useState<string | null>(null)
  const busyRef = useRef(false)
  const resetTimerRef = useRef<number | null>(null)

  const settlePhase = useCallback((next: ExportPhase, error?: string | null) => {
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
    setPhase(next)
    setErrorText(error ?? null)
    const resetAfter = PHASE_RESET_MS[next]
    if (resetAfter) {
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null
        setPhase('idle')
        setErrorText(null)
      }, resetAfter)
    }
  }, [])

  const runExport = useCallback(async (kind: 'pdf' | 'md-bundle', target: DocTab) => {
    const documentApi = window.electronAPI?.document
    if (!documentApi?.exportPdf || !documentApi.exportMarkdownBundle) {
      settlePhase('error', '导出接口不可用')
      return
    }
    const suggestedName = stripTitleExtension(target.title)
    const sourcePath = target.path || null

    const result = kind === 'pdf'
      ? await documentApi.exportPdf({
          html: await captureDocumentPreviewHtml({
            content: target.content,
            notePath: sourcePath,
            title: suggestedName,
          }),
          suggestedName,
          sourcePath,
        })
      : await documentApi.exportMarkdownBundle({
          content: target.content,
          sourcePath,
          suggestedName,
        })

    if (result.success) {
      settlePhase('done')
      return
    }
    if (result.canceled) {
      settlePhase('idle')
      return
    }
    settlePhase('error', result.error || '导出失败')
  }, [settlePhase])

  const handleClick = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (busyRef.current || !tab) return
    const menuApi = window.electronAPI?.ui
    if (!menuApi?.showNativeContextMenu) return

    const rect = event.currentTarget.getBoundingClientRect()
    const menuResult = await menuApi.showNativeContextMenu({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom + 4),
      items: [
        { id: 'export-pdf', label: '导出为 PDF' },
        { id: 'export-md-bundle', label: '导出 Markdown 压缩包（含资源）' },
      ],
    }).catch(() => null)

    const selected = menuResult?.success ? menuResult.selectedId : null
    if (selected !== 'export-pdf' && selected !== 'export-md-bundle') return

    busyRef.current = true
    settlePhase('busy')
    try {
      await runExport(selected === 'export-pdf' ? 'pdf' : 'md-bundle', tab)
    } catch (error) {
      settlePhase('error', error instanceof Error ? error.message : String(error))
    } finally {
      busyRef.current = false
    }
  }, [runExport, settlePhase, tab])

  const exportable = isMarkdownExportableTab(tab)
  const title = !exportable
    ? '当前文档类型暂不支持导出'
    : phase === 'busy'
      ? '正在导出…'
      : phase === 'done'
        ? '导出完成'
        : phase === 'error'
          ? `导出失败：${errorText || '未知错误'}`
          : `导出「${tab?.title || '文档'}」`

  return (
    <div className="document-floating-toggles document-floating-toggles--rail" aria-label="文档导出">
      <button
        type="button"
        className={`document-floating-toggle document-export-button${phase === 'done' ? ' is-success' : ''}${phase === 'error' ? ' is-error' : ''}`}
        onClick={(event) => { void handleClick(event) }}
        disabled={!exportable || phase === 'busy'}
        title={title}
        aria-label="导出文档"
      >
        {phase === 'busy' ? (
          <Loader2 className="h-[14px] w-[14px] animate-spin" strokeWidth={2} />
        ) : phase === 'done' ? (
          <Check className="h-[14px] w-[14px]" strokeWidth={2} />
        ) : (
          <FileDown className="h-[14px] w-[14px]" strokeWidth={2} />
        )}
      </button>
    </div>
  )
}
