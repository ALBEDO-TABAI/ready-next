export interface BrowserTabErrorUpdate {
  loading?: false
  error?: string
}

export function resolveBrowserTabErrorUpdate(
  error: string | null | undefined,
): BrowserTabErrorUpdate {
  if (error === undefined) return {}
  if (!error) return { error: undefined }
  return { loading: false, error }
}
