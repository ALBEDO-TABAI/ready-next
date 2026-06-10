/**
 * Zod schemas for the 13 browser_content_task domain tools (Phase 2.5 PR 10).
 *
 * Four tools explicitly advertise `additionalProperties: true` in their
 * legacy hand-rolled params (either at field level for open objects, or at
 * array-item level for arrays of open objects). We express that via Zod v4's
 * `.meta({ additionalProperties: true })` so the derivation picks it up
 * without breaking the default behavior for other domains that use plain
 * `z.record(...)` without the flag.
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

const TabIdOptional = z.string().optional().describe('标签页 ID，留空则使用当前活跃标签页')

export const BrowserCollectImagesSchema = z.object({
  keyword: z.string().optional().describe('可选关键词，按图片 URL/alt/title 过滤'),
  limit: z.number().optional().describe('最多返回条数，默认 20，最大 60'),
  min_width: z.number().optional().describe('最小宽度像素过滤，默认 120'),
  include_hidden: z.boolean().optional().describe('是否包含页面中已加载但当前不可见的候选大图，默认 false'),
  tab_id: TabIdOptional,
})

export const BrowserDownloadUrlsSchema = z.object({
  urls: z.array(z.string()).describe('要下载的 URL 数组（http/https）'),
  directory: z.string().optional().describe('目标目录，默认 ~/Documents'),
  filename_prefix: z.string().optional().describe('文件名前缀（可选）'),
  overwrite: z.boolean().optional().describe('同名是否覆盖，默认 false'),
  tab_id: z.string().optional().describe('可选标签页 ID（用于带 Referer 下载）'),
})

export const BrowserDownloadCollectedMediaSchema = z.object({
  source_task_id: z.string().describe('browser_visible_collect(image_gallery) 返回的任务 ID'),
  directory: z.string().describe('目标目录'),
  filename_prefix: z.string().optional().describe('文件名前缀（可选，默认 image）'),
  overwrite: z.boolean().optional().describe('同名是否覆盖，默认 false'),
})

export const BrowserResolveVideoSchema = z.object({
  page_url: z.string().optional().describe('视频所在页面 URL；留空时尝试使用当前标签页 URL'),
  video_url: z.string().optional().describe('页面已暴露的直接视频 URL（可选）'),
  poster_url: z.string().optional().describe('视频封面 URL（可选）'),
  title: z.string().optional().describe('视频或笔记标题（可选）'),
  sources: z.array(z.string()).optional().describe('候选 source URL 数组（可选）'),
  tab_id: z.string().optional().describe('可选标签页 ID，用于补充当前页面 URL/标题'),
})

export const BrowserExtractStructuredSchema = z.object({
  template: z
    .enum(['article_list', 'image_gallery', 'link_list', 'card_list', 'custom'])
    .describe('提取模板：article_list/image_gallery/link_list/card_list/custom'),
  url: z.string().optional().describe('可选：先打开或复用该 URL 再提取'),
  tab_id: z.string().optional().describe('当前标签页 ID，留空则使用当前活跃页'),
  item_selector: z.string().optional().describe('可选：限定提取项选择器'),
  fields: z
    .array(z.record(z.string(), z.unknown()).meta({ additionalProperties: true }))
    .optional()
    .describe('template=custom 时的字段映射'),
  limit: z.number().optional().describe('最多提取条数'),
  min_width: z.number().optional().describe('图片提取最小宽度'),
  custom_script: z.string().optional().describe('可选：直接执行自定义提取脚本'),
})

export const BrowserScrollCollectSchema = z.object({
  template: z
    .enum(['article_list', 'image_gallery', 'link_list', 'card_list', 'custom'])
    .describe('提取模板：article_list/image_gallery/link_list/card_list/custom'),
  url: z.string().optional().describe('可选：先打开或复用该 URL 再滚动采集'),
  tab_id: z.string().optional().describe('标签页 ID，留空则使用当前活跃页'),
  item_selector: z.string().optional().describe('可选：限定采集项选择器'),
  limit: z.number().optional().describe('最多采集条数'),
  max_scrolls: z.number().optional().describe('最大滚动次数'),
  scroll_delay_ms: z.number().optional().describe('每次滚动后的等待时间'),
  custom_script: z.string().optional().describe('可选：直接执行自定义提取脚本'),
})

export const BrowserStartTaskSchema = z.object({
  kind: z
    .enum(['download_urls', 'scroll_collect', 'research', 'visible_collect'])
    .describe('任务类型：download_urls/scroll_collect/research/visible_collect'),
  payload: z
    .record(z.string(), z.unknown())
    .describe('任务参数对象')
    .meta({ additionalProperties: true }),
})

export const BrowserVisibleCollectSchema = z.object({
  url: z.string().optional().describe('可选：先打开或复用该 URL 再采集；留空则采集当前页'),
  tab_id: TabIdOptional,
  template: z
    .enum(['article_list', 'image_gallery', 'link_list', 'card_list', 'custom'])
    .optional()
    .describe('提取模板，默认 card_list'),
  item_selector: z.string().optional().describe('可选：限定采集项选择器'),
  max_items: z.number().optional().describe('最多采集条数（硬上限）'),
  max_rounds: z.number().optional().describe('最大轮数（硬上限）'),
  max_duration_ms: z.number().optional().describe('最长运行毫秒（硬上限）'),
  user_expected_total: z.number().optional().describe('可选：用户明确声明的目标总数；若冻结数不足，发现阶段不得标记为完整'),
  output_root_dir: z.string().optional().describe('可选：最终保存根目录；未传则后续逐篇采集使用 ~/Documents/Ready采集/<账号标识>'),
})

export const BrowserGetTaskSchema = z.object({
  task_id: z.string().describe('任务 ID'),
})

export const BrowserResumeTaskSchema = z.object({
  task_id: z.string().describe('任务 ID'),
})

export const BrowserCancelTaskSchema = z.object({
  task_id: z.string().describe('任务 ID'),
})

export const BrowserAggregateResultsSchema = z.object({
  items: z
    .array(z.record(z.string(), z.unknown()).meta({ additionalProperties: true }))
    .describe('结构化结果数组'),
  merge_strategy: z
    .enum(['concat', 'dedupe'])
    .optional()
    .describe('concat 或 dedupe，默认 dedupe'),
  sort_by: z
    .enum(['title', 'link', 'source'])
    .optional()
    .describe('title/link/source'),
})

export const BrowserDownloadGallerySchema = z.object({
  url: z.string().describe('图集或画板链接'),
  directory: z.string().optional().describe('下载目录'),
  limit: z.number().optional().describe('最多采集图片数量'),
  max_scrolls: z.number().optional().describe('最大滚动次数'),
  retry_failed: z.boolean().optional().describe('下载失败是否重试'),
})

export const BrowserResearchTopicSchema = z.object({
  query: z.string().describe('研究主题或问题'),
  urls: z.array(z.string()).optional().describe('可选：直接指定来源页列表'),
  max_pages: z.number().optional().describe('最多访问页面数'),
  limit_per_page: z.number().optional().describe('每页最多提取条数'),
  template: z
    .enum(['article_list', 'link_list', 'card_list', 'custom'])
    .optional()
    .describe('提取模板，默认 article_list'),
})

export const BrowserRunWorkflowSchema = z.object({
  steps: z
    .array(z.record(z.string(), z.unknown()).meta({ additionalProperties: true }))
    .describe('步骤数组，每项形如 { action, ... }'),
  tab_id: TabIdOptional,
  continue_on_error: z
    .boolean()
    .optional()
    .describe('遇错是否继续执行后续步骤，默认 false'),
})

export const BrowserExecuteJsSchema = z.object({
  code: z.string().describe('要执行的 JavaScript 代码'),
  tab_id: TabIdOptional,
})

export const BrowserCollectNotesSchema = z.object({
  target_profile_url: z.string().describe('博主主页 URL（用于建根目录与展示）'),
  source_task_id: z.string().optional().describe('可选：从 browser_visible_collect 返回的任务 ID 接力，优先使用该任务冻结的候选清单'),
  expected_count: z.number().optional().describe('可选：上一步确认的目标数量；若实际清单不一致则拒绝启动'),
  strategy: z.enum(['card_loop', 'url_batch']).optional().describe('逐篇采集策略：card_loop=在列表页逐个点开；url_batch=逐个打开详情 URL'),
  allow_partial: z.boolean().optional().describe('可选提示位：用户明确只要采集部分目标时可传 true，但不能放行；真正放行必须已有持久用户确认记录'),
  notes: z
    .array(
      z.object({
        url: z.string().describe('笔记详情页 URL'),
        canonicalUrl: z.string().optional().describe('稳定来源 URL，用于去重与清单追踪'),
        openUrl: z.string().optional().describe('实际打开 URL，优先用于详情页访问'),
        title: z.string().optional().describe('笔记标题（用于建文件夹/进度展示）'),
        sourceId: z.string().optional().describe('来源稳定标识（可选，用于文件夹防重名）'),
        titleConfidence: z.enum(['none', 'low', 'medium', 'high']).optional().describe('标题可信度；低可信标题可被详情页标题兜底'),
        order: z.number().optional().describe('冻结清单中的顺序'),
      }),
    )
    .optional()
    .describe('要逐篇后台采集的笔记列表（由主 agent 先浏览主页后规划得出）'),
  output_root_dir: z.string().optional().describe('采集输出根目录，默认 ~/Documents 下的采集目录'),
  max_notes: z.number().optional().describe('最多采集篇数（高控平台默认更保守）'),
  max_duration_ms: z.number().optional().describe('最长运行时长（毫秒）'),
  max_consecutive_failures: z.number().optional().describe('连续失败上限，超过即停'),
})

export const BrowserConfirmCollectionConsentSchema = z.object({
  request_id: z.string().describe('browser_collect_notes 返回的 pendingConsentRequest.requestId'),
  confirmed_via: z.enum(['ask_user_questions', 'ui_action']).describe('确认来源：ask_user_questions 或 ui_action'),
})

export type BrowserContentToolName =
  | 'browser_collect_images'
  | 'browser_download_urls'
  | 'browser_download_collected_media'
  | 'browser_resolve_video'
  | 'browser_extract_structured'
  | 'browser_scroll_collect'
  | 'browser_start_task'
  | 'browser_get_task'
  | 'browser_resume_task'
  | 'browser_cancel_task'
  | 'browser_aggregate_results'
  | 'browser_download_gallery'
  | 'browser_research_topic'
  | 'browser_run_workflow'
  | 'browser_execute_js'
  | 'browser_visible_collect'
  | 'browser_collect_notes'
  | 'browser_confirm_collection_consent'

export const BROWSER_CONTENT_SCHEMAS: Record<
  BrowserContentToolName,
  z.ZodObject<z.ZodRawShape>
> = {
  browser_collect_images: BrowserCollectImagesSchema,
  browser_download_urls: BrowserDownloadUrlsSchema,
  browser_download_collected_media: BrowserDownloadCollectedMediaSchema,
  browser_resolve_video: BrowserResolveVideoSchema,
  browser_extract_structured: BrowserExtractStructuredSchema,
  browser_scroll_collect: BrowserScrollCollectSchema,
  browser_start_task: BrowserStartTaskSchema,
  browser_get_task: BrowserGetTaskSchema,
  browser_resume_task: BrowserResumeTaskSchema,
  browser_cancel_task: BrowserCancelTaskSchema,
  browser_aggregate_results: BrowserAggregateResultsSchema,
  browser_download_gallery: BrowserDownloadGallerySchema,
  browser_research_topic: BrowserResearchTopicSchema,
  browser_run_workflow: BrowserRunWorkflowSchema,
  browser_execute_js: BrowserExecuteJsSchema,
  browser_visible_collect: BrowserVisibleCollectSchema,
  browser_collect_notes: BrowserCollectNotesSchema,
  browser_confirm_collection_consent: BrowserConfirmCollectionConsentSchema,
}
