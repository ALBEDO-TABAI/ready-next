import { relativeFileReference } from '../../utils/platform'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { expandTemplate } from '../../../shared/document-anchors/template'
import { rewriteTemplateAttachments } from './attachments'
import { TemplateCommandSchema, type TemplateCommand, type TemplateResult } from '../../../shared/document-comments'
import { checkedPath, ensureDirectory, filename, hashBytes, publishNewFile, stageFile } from '../document-drafts/files'
import type { DocumentPageService } from '../document-pages/service'
import { AnnotationStorage } from '../document-annotations/storage'
import { resolveWikiPage } from '../document-annotations/references'
const IntentSchema = z.object({
  request: TemplateCommandSchema, content: z.string(),
  files: z.array(z.object({ path: z.string(), stage: z.string(), hash: z.string() }).strict()),
}).strict()


export class DocumentTemplateService {
  constructor(readonly storage: AnnotationStorage, private readonly pages: DocumentPageService, private readonly afterPage?: () => void) {}
  async recover(): Promise<void> {
    const directory = checkedPath(this.storage.root, join(this.storage.root, '.ready', 'template-operations'))
    if (!existsSync(directory)) return
    for (const name of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
      const intent = this.storage.read(checkedPath(this.storage.root, join(directory, name)), IntentSchema)
      if (!intent || intent.request.type === 'list') throw new Error('模板恢复记录不完整')
      if (name !== intent.request.operationId + '.json') throw new Error('模板恢复编号不一致')
      // An insertion belongs to an editor buffer; recovery must never replay it into a different buffer.
      if (intent.request.type === 'create') await this.execute(intent.request)
    }
  }
  execute(input: TemplateCommand): Promise<TemplateResult> {
    const request = TemplateCommandSchema.parse(input)
    return this.storage.serial(async () => {
      const root = this.storage.root, directory = checkedPath(root, join(root, '模板'))
      if (request.type === 'list') return { kind: 'list', templates: existsSync(directory) ? readdirSync(directory).filter(name => /\.md$/i.test(name)).sort() : [] }
      const sourcePath = checkedPath(root, join(directory, request.template))
      if (dirname(sourcePath) !== directory || !/\.md$/i.test(sourcePath)) throw new Error('模板必须位于资料库模板目录')
      const manifest = this.storage.path('template-operations', request.operationId)
      let intent = this.storage.read(manifest, IntentSchema)
      if (intent && JSON.stringify(intent.request) !== JSON.stringify(request)) throw new Error('操作编号已用于另一份模板请求')
      if (!intent) {
        const target = request.type === 'expand' ? checkedPath(root, request.targetPath) : join(checkedPath(root, request.parentPath), filename(request.title) + '.md')
        if (!/\.md$/i.test(target) || target.split(/[\\/]/).includes('.ready')) throw new Error('模板目标必须是资料库中的 Markdown 页面')
        if (request.type === 'expand' && !existsSync(target)) throw new Error('插入目标页面不存在')
        const parent = dirname(target), name = basename(target, '.md')
        if (request.type === 'create' && existsSync(target)) throw new Error('目标页面已存在')
        let content = expandTemplate(readFileSync(sourcePath, 'utf8'), request.title, new Date(), randomUUID, basename(sourcePath, '.md'))
        const assets = new Map<string, { path: string; stage: string; hash: string; data: Buffer }>()
        content = rewriteTemplateAttachments(content, localPath => {
          const from = checkedPath(root, resolve(directory, localPath))
          if (/\.(md|canvas)$/i.test(from)) return encodeURI(relativeFileReference(parent, from))
          let asset = assets.get(from)
          if (!asset) {
            const data = readFileSync(from), assetName = `${request.operationId}-${assets.size}-${basename(from)}`
            asset = { path: checkedPath(root, join(parent, name + '.assets', assetName)), stage: checkedPath(root, join(root, '.ready', 'template-staging', request.operationId, assetName)), hash: hashBytes(data), data }
            if (existsSync(asset.path)) throw new Error('目标附件已存在')
            assets.set(from, asset)
          }
          return encodeURI(relativeFileReference(parent, asset.path)).replace(/[()]/g, char => '%' + char.charCodeAt(0).toString(16))
        }, page => relativeFileReference(parent, resolveWikiPage(root, sourcePath, page)).replace(/\.md$/i, ''))
        for (const asset of assets.values()) { ensureDirectory(root, dirname(asset.stage)); await stageFile(root, asset.stage, asset.data, asset.hash) }
        intent = { request, content, files: [...assets.values()].map(({ path, stage, hash }) => ({ path, stage, hash })) }
        await this.storage.write(manifest, intent)
      }
      const prior = request.type === 'create' ? this.pages.operation(request.operationId) : null
      for (const file of prior?.state === 'committed' ? [] : intent.files) {
        checkedPath(root, file.path); checkedPath(root, file.stage)
        ensureDirectory(root, dirname(file.path)); await publishNewFile(root, file.stage, file.path, file.hash)
      }
      if (request.type === 'expand') return { kind: 'expanded', content: intent.content }
      const receipt = await this.pages.operate({ type: 'create', root, operationId: request.operationId, title: request.title, parentPath: checkedPath(root, request.parentPath), content: intent.content })
      this.afterPage?.()
      return { kind: 'created', receipt }
    })
  }
}
