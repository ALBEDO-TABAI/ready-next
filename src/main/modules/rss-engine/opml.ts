import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { z } from 'zod'
interface RSSSourceLike {
  id: string
  name: string
  url: string
  group_name?: string
  platform?: string
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function generateSubscriptionsOpml(sources: RSSSourceLike[]): string {
  const outlines = sources
    .map((source) => {
      const title = source.name?.trim() || source.url
      return `<outline text="${escapeXml(title)}" title="${escapeXml(title)}" type="rss" xmlUrl="${escapeXml(source.url)}" category="${escapeXml(source.group_name || source.platform || 'default')}" />`
    })
    .join('\n      ')

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head>
    <title>Ready RSS Subscriptions</title>
    <dateCreated>${escapeXml(new Date().toUTCString())}</dateCreated>
  </head>
  <body>
      ${outlines}
  </body>
</opml>`
}

export interface ImportedRSSSource { name:string;url:string;group:string }
export function parseSubscriptionsOpml(xml:string):ImportedRSSSource[] {
  if(/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml)!==true) throw new Error('OPML 格式错误，请选择有效的订阅文件')
  const parsed:unknown=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',isArray:name=>name==='outline',parseAttributeValue:false}).parse(xml)
  const document=OpmlSchema.safeParse(parsed)
  if(!document.success) throw new Error('OPML 格式错误：缺少 opml/body 或订阅地址无效')
  const sources:ImportedRSSSource[]=[]
  const visit=(nodes:Outline[],groups:string[])=>{
    for(const node of nodes) {
      const name=node.title?.trim() || node.text?.trim() || ''
      if(node.xmlUrl) {
        let url:URL
        try { url=new URL(node.xmlUrl) } catch { throw new Error(`OPML 订阅地址无效：${node.xmlUrl}`) }
        if(!['http:','https:'].includes(url.protocol)) throw new Error('OPML 订阅地址必须是 HTTP 或 HTTPS')
        sources.push({name:name||url.href,url:url.href,group:node.category || groups.join(' / ') || 'default'})
      }
      if(node.outline) visit(node.outline,name?[...groups,name]:groups)
    }
  }
  visit(document.data.opml.body.outline??[],[])
  return sources
}
interface Outline {text?:string;title?:string;xmlUrl?:string;category?:string;outline?:Outline[]}
const OutlineSchema:z.ZodType<Outline>=z.lazy(()=>z.object({text:z.string().optional(),title:z.string().optional(),xmlUrl:z.string().min(1).optional(),category:z.string().optional(),outline:z.array(OutlineSchema).optional()}))
const OpmlSchema=z.object({opml:z.object({body:z.preprocess(value=>value===''?{}:value,z.object({outline:z.array(OutlineSchema).optional()}))})})
