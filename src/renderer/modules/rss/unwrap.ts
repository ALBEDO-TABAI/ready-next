type RSSResponse<T> = { success: boolean; data?: T; error?: string }

/** The 资讯 IPC answers { success, data } or { success: false, error }; a missing payload is a failure too. */
export async function unwrapRSS<T>(request: Promise<RSSResponse<T>>): Promise<T> {
  const result = await request
  if (!result.success || result.data === undefined) throw new Error(result.error || '资讯操作没有完成')
  return result.data
}
