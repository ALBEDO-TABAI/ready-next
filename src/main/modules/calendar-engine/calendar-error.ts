export function calendarErrorMessage(error:unknown):string {
  if(error&&typeof error==='object'&&'code'in error&&String(error.code).startsWith('SQLITE')){
    console.error('[calendar] database operation failed',error)
    return '日历暂时无法完成这次操作，请重试。'
  }
  return error instanceof Error?error.message:String(error)
}
