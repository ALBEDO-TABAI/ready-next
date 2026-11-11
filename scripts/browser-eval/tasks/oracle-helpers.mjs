import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeDocument(ctx, title, text) {
  await mkdir(ctx.workspaceDir, { recursive: true })
  await writeFile(join(ctx.workspaceDir, `${title}.md`), `# ${title}\n\n${text}\n`)
}
export async function login(ctx) {
  const response = await ctx.http.postForm(ctx.url('/login/submit'), {
    ...ctx.server.fixtures.credentials,
    next: '/admin/',
  })
  if (response.status !== 200 || !response.text.includes('欢迎，'))
    throw new Error('oracle 登录失败')
}
export async function download(ctx, name, path = `/downloads/files/${name}`) {
  const response = await ctx.http.get(ctx.url(path))
  if (response.status !== 200 || !response.headers['content-disposition'])
    throw new Error(`下载失败：${name}`)
  const dir = join(ctx.workspaceDir, '下载')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), response.buffer)
  return response
}
export function tokenFrom(response) {
  const token = /name="token" value="([^"]+)"/.exec(response.text)?.[1]
  if (!token) throw new Error('表单缺少 token')
  return token
}
export const task = ({ id, start, session = 'logged_out', ...definition }) => ({
  id,
  category: id[0],
  start: { origin: 'main', ...start },
  session,
  ...definition,
})
export const credentials = '登录这个后台（用户名 eval-user，密码 ready-eval-2026），'
