const FOLDER_TAG_ALIAS = /(?:给.{0,16}文件夹.{0,12}打标|文件夹.{0,12}(?:打标|标一下)|(?:批量)?打标(?:这个|该)?文件夹|tag[\s-]?forge)/i
const GENERIC_TAG_STUDY = /标签体系|标签方案|标签设计|研究标签/

export function isCodexFolderTagForgeAlias(input: {
  userText: string
  hasTypedFolder: boolean
}): boolean {
  if (!input.hasTypedFolder) return false
  const text = String(input.userText || '').trim()
  if (!text) return false
  if (GENERIC_TAG_STUDY.test(text) && !FOLDER_TAG_ALIAS.test(text)) return false
  return FOLDER_TAG_ALIAS.test(text)
}
