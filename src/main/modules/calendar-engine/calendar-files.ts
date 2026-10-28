import { dialog } from 'electron'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

export async function readCalendarFile(path?:string):Promise<{name:string;text:string;sourceId:string}|null>{
  if(!path){const result=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'日历文件',extensions:['ics','vcs']}]});if(result.canceled)return null;path=result.filePaths[0]}
  if(!path)return null
  return {name:basename(path),text:await readFile(path,'utf8'),sourceId:`ics-file-${createHash('sha256').update(await realpath(path)).digest('hex').slice(0,24)}`}
}
export async function saveCalendarFile(name:string,text:string):Promise<boolean>{
  const result=await dialog.showSaveDialog({defaultPath:basename(name),filters:[{name:'日历文件',extensions:['ics']}]})
  if(result.canceled||!result.filePath)return false
  await writeFile(result.filePath,text,'utf8');return true
}
