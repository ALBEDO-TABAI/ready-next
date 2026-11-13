import { useEffect, useRef, useState } from 'react'
import { createUniver, defaultTheme, LocaleType, merge } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
// @ts-expect-error — Vite resolves this fine; TS moduleResolution can't see subpath exports
import sheetsCoreCSSEn from '@univerjs/preset-sheets-core/locales/en-US'
import '@univerjs/presets/lib/styles/preset-sheets-core.css'
import type { DocTab } from '../../stores/useDocTabs'
import type { IWorkbookData } from '@univerjs/core'
import { Loader2 } from 'lucide-react'

/**
 * Convert the IPC sheetData (Record<sheetName, rows[][]>) to Univer IWorkbookData.
 */
function xlsxToWorkbookData(sheetData: Record<string, unknown[][]>): IWorkbookData {
  const sheetEntries = Object.entries(sheetData)
  const sheets: IWorkbookData['sheets'] = {}

  sheetEntries.forEach(([name, rows], index) => {
    const sheetId = `sheet_${index}`
    const cellData: Record<number, Record<number, { v: string | number | boolean }>> = {}
    let maxCol = 0

    rows.forEach((row, rowIdx) => {
      if (!Array.isArray(row)) return
      const rowData: Record<number, { v: string | number | boolean }> = {}
      row.forEach((cell, colIdx) => {
        if (cell != null && cell !== '') {
          rowData[colIdx] = { v: cell as string | number | boolean }
        }
        if (colIdx >= maxCol) maxCol = colIdx + 1
      })
      if (Object.keys(rowData).length > 0) {
        cellData[rowIdx] = rowData
      }
    })

    sheets[sheetId] = {
      id: sheetId,
      name,
      cellData,
      rowCount: Math.max(rows.length, 100),
      columnCount: Math.max(maxCol, 26),
    }
  })

  return {
    id: 'workbook_1',
    locale: LocaleType.EN_US,
    name: 'Workbook',
    appVersion: '',
    styles: {},
    sheetOrder: Object.keys(sheets),
    sheets,
  }
}

export default function UniverSheet({ tab }: { tab: DocTab }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<ReturnType<typeof createUniver> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false

    const init = async () => {
      if (!containerRef.current) return

      // Load data
      let workbookData: IWorkbookData | undefined
      if (tab.path) {
        try {
          const result = await window.electronAPI.document.parseXlsx(tab.path)
          if (!result.success) throw new Error(result.error || 'XLSX 解析失败')
          const rawData = (result.sheetData ?? result.data ?? {}) as Record<string, unknown[][]>
          workbookData = xlsxToWorkbookData(rawData)
        } catch (err) {
          if (!disposed) setError(err instanceof Error ? err.message : String(err))
          return
        }
      }

      if (disposed) return

      // Create Univer instance
      const { univerAPI } = createUniver({
        locale: LocaleType.EN_US,
        locales: { [LocaleType.EN_US]: merge({}, sheetsCoreCSSEn) },
        theme: defaultTheme,
        presets: [
          UniverSheetsCorePreset({ container: containerRef.current }),
        ],
      })

      if (workbookData) {
        univerAPI.createWorkbook(workbookData)
      } else {
        univerAPI.createWorkbook({})
      }

      univerRef.current = { univerAPI } as ReturnType<typeof createUniver>
      if (!disposed) setLoading(false)
    }

    init()

    return () => {
      disposed = true
      univerRef.current?.univerAPI?.dispose()
      univerRef.current = null
    }
  }, [tab.path])

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--rn-ink-2)]">
        <p className="text-[13px]">表格加载失败: {error}</p>
      </div>
    )
  }

  return (
    <div className="flex-1 relative" style={{ overflow: 'hidden' }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: 'var(--rn-solid)' }}>
          <Loader2 className="w-6 h-6 animate-spin text-[var(--rn-ink-2)]" />
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
