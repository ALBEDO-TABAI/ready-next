export const api = () => {
  const value = window.electronAPI?.calendar
  if (!value) throw new Error('日历需要 Ready 数据库连接，请重新打开工作台')
  return value
}
export async function unwrap<T>(result: Promise<{success:boolean;data?:T;error?:string}>):Promise<T> {
  const response = await result
  if (!response.success) throw new Error(response.error || '日历操作未保存')
  return response.data as T
}
export const isMac = /Mac/.test(navigator.platform)
export const isElectron = true
