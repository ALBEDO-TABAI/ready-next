import {
  describeApprovedWidgetProps,
  listDocumentWidgetCatalog,
  type DocumentWidgetComponentName,
} from '../../../../shared/document-widget-openui'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'

export const CODEX_DOCUMENT_WIDGET_GUIDANCE_KEY = 'ready-document-widget-guidance'
export const CODEX_DOCUMENT_WIDGET_GUIDANCE_CONTRACT = 'ready_document_widget_guidance_v1'
// Codex 0.149 cuts an additionalContext value above 1000 tokens (counted as bytes / 4) out of the middle; a cut
// catalog would also fail the gateway digest, so the delivered value must stay under this many bytes.
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 3_800

// Field structures sent every turn stay bounded; a rejected component's own fields come back in the tool error.
const CORE_COMPONENTS: readonly DocumentWidgetComponentName[] = [
  'info_card',
  'callout_block',
  'stats_card',
  'bar_chart',
  'line_chart',
  'flow_diagram',
  'relationship_graph',
]

/**
 * The model-visible source of Ready's widget components for a turn that may insert them. Codex threads freeze their
 * tool definitions, so the catalog travels as per-turn context instead of inside the tool schema.
 */
export function codexDocumentWidgetGuidance(
  prepared: Pick<PreparedCodexProductRun, 'readyTurnToolAuthorization' | 'currentDocumentAmbient'>,
): string | null {
  // An ambiently available document gets no catalog every turn; an earlier catalog stays in history and a wrong
  // component name comes back with the approved list.
  if (prepared.currentDocumentAmbient
    || !prepared.readyTurnToolAuthorization.allowedToolNames.includes('document_insert_widget')) return null
  return [
    '## Ready 文档组件',
    '- 信息卡、摘要卡、对比卡、数据卡、关系图、流程图、时间线、图表等卡片内容，用 document_insert_widget 的 componentSpec { component, props } 插入；不要用引用块、Markdown 表格或手写 HTML 冒充卡片。',
    '- 位置：文档开头用 position=prepend_start，某节标题之后用 position=after_section 加 sectionTitle，文末用 append_end。',
    '- 改已有卡片用 document_update_widget，删卡片用 document_remove_widget；被卡片取代的正文用 document_replace_exact 删除或替换。改完用 document_save_tab 写回原文件。',
    '- 只用下列组件名，不要自造：',
    ...listDocumentWidgetCatalog()
      .filter((entry) => entry.group === 'common-display')
      .map((entry) => `  - ${entry.name}: ${entry.description}`),
    '### componentSpec.props 字段（!必填 ?可选）',
    describeApprovedWidgetProps(CORE_COMPONENTS),
  ].join('\n')
}
