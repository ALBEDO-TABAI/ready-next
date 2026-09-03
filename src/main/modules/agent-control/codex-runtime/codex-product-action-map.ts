export const CODEX_PRODUCT_ACTION_MAP: Readonly<Record<string, readonly string[]>> = {
  document_read_section: ['document.readSection'],
  document_list_widgets: ['document.listWidgets'],
  document_insert_widget: ['document.insertWidget'],
  document_update_widget: ['document.updateWidget'],
  document_remove_widget: ['document.removeWidget'],
  document_replace_exact: ['document.replaceExact'],
  document_save_tab: ['document.saveTab'],
  rss_add_source: ['rss.addSource'],
  rss_fetch_updates: ['rss.fetchUpdates'],
  rss_select_item: ['rss.selectItem'],
  rss_analyze_item: ['rss.analyzeItem'],
  rss_get_analysis_result: ['rss.getAnalysisResult'],
  rss_capture_session: ['rss.captureSession'],
  pet_show_sticky_note: ['pet.showStickyNote'],
  pet_dismiss_sticky_note: ['pet.dismissStickyNote'],
  pet_clear_sticky_notes: ['pet.clearStickyNotes'],
  calendar_list_window: ['calendar.listWindow'],
  calendar_create_event: ['calendar.createEvent'],
  calendar_update_event: ['calendar.updateEvent'],
  calendar_delete_event: ['calendar.deleteEvent'],
  calendar_capture_session: ['calendar.captureSession'],
  tag_forge_apply_batch: ['tagForge.checkRevision', 'tagForge.applyContent'],
  map_plan_route: ['renderer:present-file'],
  present_file: ['renderer:present-file'],
  web_clip_url: ['renderer:present-file'],
}

export const DOCUMENT_WRITE_PRODUCT_TOOLS = [
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_exact',
  'document_save_tab',
] as const

export const DOCUMENT_WRITE_FLOOR_TOOL_NAMES = [
  'document_list_widgets',
  ...DOCUMENT_WRITE_PRODUCT_TOOLS,
] as const

export const FILE_WRITE_OR_ORGANIZE_TOOL_NAMES = [
  'file_rename',
  'file_move',
  'file_copy',
  'file_classify',
  'file_create_folder',
  'file_organize_preview',
  'file_organize_apply',
  'file_organize_undo',
  'tag_forge_prepare_batch',
  'tag_forge_apply_batch',
  'tag_forge_review_batch',
] as const

export const TAG_FORGE_EXCLUSIVE_TOOL_NAMES = [
  'file_locate',
  'file_read_excerpt',
  'tag_forge_prepare_batch',
  'tag_forge_apply_batch',
  'declare_completion_criteria',
] as const

export function allowedProductActionsForTool(toolName: string): readonly string[] {
  return CODEX_PRODUCT_ACTION_MAP[toolName] || []
}

export function isAllowedProductAction(toolName: string, action: string): boolean {
  return allowedProductActionsForTool(toolName).includes(action)
}
