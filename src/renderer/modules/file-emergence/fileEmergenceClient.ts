import {
  FILE_EMERGENCE_SETTING_KEY,
  type FileEmergenceRecordActivityPayload,
  type FileEmergenceRecordReadingSessionPayload,
} from '../../../shared/file-emergence'

export async function readFileEmergenceEnabled(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.electronAPI?.settings?.get) return true
  const result = await window.electronAPI.settings.get(FILE_EMERGENCE_SETTING_KEY)
  return result?.success ? result.data !== 'false' : true
}

export async function recordFileEmergenceActivity(payload: FileEmergenceRecordActivityPayload): Promise<void> {
  if (typeof window === 'undefined' || !window.electronAPI?.fileEmergence?.recordActivity) return
  if (!(await readFileEmergenceEnabled())) return
  const result = await window.electronAPI.fileEmergence.recordActivity(payload)
  if (!result.success) {
    console.warn('[file-emergence] recordActivity failed', result.error)
  }
}

export async function recordFileEmergenceReadingSession(payload: FileEmergenceRecordReadingSessionPayload): Promise<void> {
  if (typeof window === 'undefined' || !window.electronAPI?.fileEmergence?.recordReadingSession) return
  if (!(await readFileEmergenceEnabled())) return
  const result = await window.electronAPI.fileEmergence.recordReadingSession(payload)
  if (!result.success) {
    console.warn('[file-emergence] recordReadingSession failed', result.error)
  }
}
