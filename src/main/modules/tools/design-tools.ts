import { appendFileSync } from 'fs'
import { isDesignRatio } from '../../../shared/design-agent'

interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
  schema?: Record<string, unknown>
}

interface DesignToolDef {
  name: string
  description: string
  action: string
  intent: string
  executionKind: 'deterministic' | 'interactive'
  params: ToolParam[]
}

interface DesignToolContext {
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const POSITIONAL_PARAMS: ToolParam[] = [
  { name: 'x', type: 'number', description: '可选，x 坐标', required: false },
  { name: 'y', type: 'number', description: '可选，y 坐标', required: false },
  { name: 'w', type: 'number', description: '可选，宽度覆盖', required: false },
  { name: 'h', type: 'number', description: '可选，高度覆盖', required: false },
]

const META_PARAM: ToolParam = {
  name: 'meta',
  type: 'object',
  description: '可选，样式元数据对象，支持 readyFillColor, readyCornerRadius, readyFontSize, readyTextColor, readyFontWeight, readyPaddingH, readyPaddingV, readyTextAlign 等属性',
  required: false,
  schema: {
    properties: {
      readyFillColor: { type: 'string', description: '填充颜色（hex）' },
      readyCornerRadius: { type: 'number', description: '圆角半径（px）' },
      readyFontSize: { type: 'number', description: '字号（px）' },
      readyTextColor: { type: 'string', description: '文本颜色（hex）' },
      readyFontWeight: { type: 'string', description: 'light/regular/medium/bold/black' },
      readyPaddingH: { type: 'number', description: '水平内边距（px）' },
      readyPaddingV: { type: 'number', description: '垂直内边距（px）' },
      readyTextAlign: { type: 'string', description: 'start/middle/end' },
      readyLineHeight: { type: 'number', description: '行高（倍数）' },
    }
  }
}


const DESIGN_TOOLS: DesignToolDef[] = [
  {
    name: 'design_open_file',
    description: '打开一个现有 .tldr 设计文件并切换到设计模式。',
    action: 'design.openFile',
    intent: 'open_design_file',
    executionKind: 'deterministic',
    params: [{ name: 'path', type: 'string', description: '设计文件绝对路径', required: true }],
  },
  {
    name: 'design_get_editor_state',
    description: '读取当前设计编辑器状态，包括文件、视口、选区与画布摘要。',
    action: 'design.getEditorState',
    intent: 'get_design_editor_state',
    executionKind: 'deterministic',
    params: [],
  },
  {
    name: 'design_snapshot_layout',
    description: '读取当前画布的布局摘要与主要区域，用于设计决策。',
    action: 'design.snapshotLayout',
    intent: 'snapshot_design_layout',
    executionKind: 'deterministic',
    params: [
      { name: 'maxDepth', type: 'number', description: '可选，返回的摘要深度，默认 1', required: false },
    ],
  },
  {
    name: 'design_get_style_guide',
    description: '根据平台、任务类型和关键词生成结构化设计 token，用于规划排版和视觉语言。',
    action: 'design.getStyleGuide',
    intent: 'get_design_style_guide',
    executionKind: 'deterministic',
    params: [
      { name: 'platform', type: 'string', description: 'xiaohongshu / youtube / generic', required: false },
      { name: 'taskType', type: 'string', description: 'social-cover / content-layout', required: false },
      {
        name: 'themeKeywords',
        type: 'array',
        description: '可选，主题关键词数组。',
        required: false,
        schema: { items: { type: 'string' } },
      },
      { name: 'currentTheme', type: 'string', description: '可选，当前项目主题说明', required: false },
    ],
  },
  {
    name: 'design_measure_text',
    description: '估算指定文本在给定宽度、字号、行高下的换行数和高度，用于排版预算。',
    action: 'design.measureText',
    intent: 'measure_design_text',
    executionKind: 'deterministic',
    params: [
      { name: 'text', type: 'string', description: '要测量的文本内容', required: true },
      { name: 'width', type: 'number', description: '可用宽度', required: true },
      { name: 'fontSize', type: 'number', description: '字号', required: true },
      { name: 'lineHeight', type: 'number', description: '行高', required: false },
      { name: 'paddingH', type: 'number', description: '左右内边距', required: false },
      { name: 'paddingV', type: 'number', description: '上下内边距', required: false },
      { name: 'maxLines', type: 'number', description: '最大行数', required: false },
    ],
  },
  {
    name: 'design_find_empty_space_on_canvas',
    description: '在当前设计画布中寻找可用空白区域，便于后续自动落位。',
    action: 'design.findEmptySpaceOnCanvas',
    intent: 'find_design_empty_space',
    executionKind: 'deterministic',
    params: [
      { name: 'width', type: 'number', description: '目标区域宽度', required: true },
      { name: 'height', type: 'number', description: '目标区域高度', required: true },
      { name: 'direction', type: 'string', description: 'right / below', required: false },
      { name: 'padding', type: 'number', description: '可选，区域间距', required: false },
    ],
  },
  {
    name: 'design_get_guides',
    description: '返回当前画板或选区附近的边距线、分栏线和可用区，供布局编译使用。',
    action: 'design.getGuides',
    intent: 'get_design_guides',
    executionKind: 'deterministic',
    params: [
      { name: 'boardId', type: 'string', description: '可选，目标画板 id', required: false },
      { name: 'columns', type: 'number', description: '可选，期望列数', required: false },
      { name: 'gutter', type: 'number', description: '可选，列间距', required: false },
    ],
  },
  {
    name: 'design_capture_canvas_screenshot',
    description: '导出当前画布截图，用于视觉复核和交付物检查。',
    action: 'design.captureCanvasScreenshot',
    intent: 'capture_design_canvas_screenshot',
    executionKind: 'deterministic',
    params: [
      { name: 'path', type: 'string', description: '可选，导出路径', required: false },
      { name: 'defaultName', type: 'string', description: '可选，默认文件名', required: false },
    ],
  },
  {
    name: 'design_compare_screenshot',
    description: '对比本轮前后截图或当前版面摘要，返回视觉节奏与模板母题风险。',
    action: 'design.compareScreenshot',
    intent: 'compare_design_screenshot',
    executionKind: 'deterministic',
    params: [
      { name: 'baselinePath', type: 'string', description: '可选，基线截图路径', required: false },
      { name: 'candidatePath', type: 'string', description: '可选，候选截图路径', required: false },
      { name: 'runId', type: 'string', description: '可选，agent run id', required: false },
      { name: 'notes', type: 'string', description: '可选，额外比对说明', required: false },
    ],
  },
  {
    name: 'design_verify_layout',
    description: '对当前设计结果做几何与节奏校验，返回越界、重复、重叠和比例检查结果。',
    action: 'design.verifyLayout',
    intent: 'verify_design_layout',
    executionKind: 'deterministic',
    params: [
      { name: 'boardId', type: 'string', description: '可选，目标画板节点 id', required: false },
      {
        name: 'layoutBudget',
        type: 'object',
        description: '可选，布局预算，例如标题行数和区块预算。',
        required: false,
      },
      {
        name: 'nodeIds',
        type: 'array',
        description: '可选，需校验的节点 id 数组。',
        required: false,
        schema: { items: { type: 'string' } },
      },
      {
        name: 'screenshotPath',
        type: 'string',
        description: '可选，若提供则启用更严格的截图启发式验收。',
        required: false,
      },
      {
        name: 'expectedBannedMotifs',
        type: 'array',
        description: '可选，禁止出现的模板母题或视觉元素。',
        required: false,
        schema: { items: { type: 'string' } },
      },
      { name: 'runId', type: 'string', description: '可选，agent run id', required: false },
      { name: 'repairScope', type: 'string', description: 'run-owned / selected', required: false },
    ],
  },
  {
    name: 'design_list_owned_nodes',
    description: '列出本轮 run 创建的设计节点及其角色元数据，供反思修正使用。',
    action: 'design.listOwnedNodes',
    intent: 'list_design_owned_nodes',
    executionKind: 'deterministic',
    params: [
      { name: 'runId', type: 'string', description: 'agent run id', required: true },
    ],
  },
  {
    name: 'design_create_frame',
    description: '在当前画布创建原生 frame 容器，用于承载一个完整版面或逻辑区域。',
    action: 'design.createFrame',
    intent: 'create_design_frame',
    executionKind: 'interactive',
    params: [
      { name: 'name', type: 'string', description: '可选，frame 名称', required: false },
      ...POSITIONAL_PARAMS,
    ],
  },
  {
    name: 'design_create_text',
    description: '在当前设计画布上创建一个原生文本元素。',
    action: 'design.createText',
    intent: 'create_design_element',
    executionKind: 'interactive',
    params: [
      { name: 'text', type: 'string', description: '文本内容', required: true },
      ...POSITIONAL_PARAMS,
    ],
  },
  {
    name: 'design_create_geo_shape',
    description: '在当前画布创建基础几何元素，支持 rectangle / ellipse / circle / pill。',
    action: 'design.createGeoShape',
    intent: 'create_design_geometry',
    executionKind: 'interactive',
    params: [
      { name: 'shape', type: 'string', description: 'rectangle / ellipse / circle / pill', required: true },
      { name: 'label', type: 'string', description: '可选，图形内标签', required: false },
      { name: 'fillColor', type: 'string', description: '可选，填充色', required: false },
      { name: 'textColor', type: 'string', description: '可选，文本色', required: false },
      ...POSITIONAL_PARAMS,
    ],
  },
  {
    name: 'design_create_button',
    description: '在当前画布创建按钮组件。',
    action: 'design.createButton',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'label', type: 'string', description: '按钮文案', required: false },
      { name: 'variant', type: 'string', description: 'primary / secondary / ghost', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_input',
    description: '在当前画布创建输入框组件。',
    action: 'design.createInput',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'label', type: 'string', description: '字段标签', required: false },
      { name: 'placeholder', type: 'string', description: '占位文本', required: false },
      { name: 'variant', type: 'string', description: 'default / filled', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_card',
    description: '在当前画布创建内容卡片组件。',
    action: 'design.createCard',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'title', type: 'string', description: '卡片标题', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_text_block',
    description: '在当前画布创建文本块组件。',
    action: 'design.createTextBlock',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'content', type: 'string', description: '文本块内容', required: true },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_image_placeholder',
    description: '在当前画布创建图片占位组件。',
    action: 'design.createImagePlaceholder',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'label', type: 'string', description: '图片标签', required: false },
      { name: 'aspectRatio', type: 'string', description: '16:9 / 4:3 / 1:1', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_page_header',
    description: '创建页面头部组件，用于承载大标题、说明和主操作。',
    action: 'design.createPageHeader',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'title', type: 'string', description: '页面标题', required: true },
      { name: 'eyebrow', type: 'string', description: '标题上方标签', required: false },
      { name: 'metaText', type: 'string', description: '副信息行', required: false },
      { name: 'actionLabel', type: 'string', description: '右侧主按钮文案', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_section_block',
    description: '创建内容分区组件，用于多列内容组织。',
    action: 'design.createSectionBlock',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'title', type: 'string', description: '分区标题', required: true },
      { name: 'description', type: 'string', description: '分区描述', required: false },
      { name: 'columns', type: 'number', description: '列数 1-3', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_stat_card',
    description: '创建数据指标卡组件。',
    action: 'design.createStatCard',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'label', type: 'string', description: '指标标签', required: false },
      { name: 'value', type: 'string', description: '指标数值', required: true },
      { name: 'delta', type: 'string', description: '变化趋势', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_create_list_item',
    description: '创建信息列表项组件，用于摘要、目录、任务清单。',
    action: 'design.createListItem',
    intent: 'create_design_component',
    executionKind: 'interactive',
    params: [
      { name: 'title', type: 'string', description: '列表标题', required: true },
      { name: 'metaText', type: 'string', description: '右侧副信息', required: false },
      { name: 'description', type: 'string', description: '描述文本', required: false },
      ...POSITIONAL_PARAMS,
      META_PARAM,
    ],
  },
  {
    name: 'design_arrange_selection',
    description: '对当前选中的设计元素做基础排版，可用于对齐、分布、垂直或水平堆叠。',
    action: 'design.arrangeSelection',
    intent: 'arrange_design_selection',
    executionKind: 'interactive',
    params: [
      { name: 'mode', type: 'string', description: 'stack-vertical / stack-horizontal / align-left / align-center / align-right / distribute-horizontal / distribute-vertical', required: true },
      { name: 'gap', type: 'number', description: '堆叠或分布时使用的间距', required: false },
    ],
  },
  {
    name: 'design_batch_design',
    description: '批量执行设计编辑动作，可用于低层创建、更新、删除和选择元素。',
    action: 'design.batchDesign',
    intent: 'batch_design_mutation',
    executionKind: 'interactive',
    params: [
      {
        name: 'ops',
        type: 'array',
        description: '批量操作数组，支持 create / update / delete / select。',
        required: true,
        schema: {
          items: {
            type: 'object',
          },
        },
      },
    ],
  },
  {
    name: 'design_update_nodes',
    description: '批量更新节点的位置、尺寸、文字、样式和元数据。',
    action: 'design.updateNodes',
    intent: 'update_design_nodes',
    executionKind: 'interactive',
    params: [
      {
        name: 'patches',
        type: 'array',
        description: '节点补丁数组，每项需包含 id，可附带 x/y/props/meta。',
        required: true,
        schema: { items: { type: 'object' } },
      },
    ],
  },
  {
    name: 'design_update_selected',
    description: '更新当前选中元素的属性。这是一个便捷工具，自动获取选中元素并应用更新，无需手动指定 ID。适用于"把选中的画板改为黑色"等场景。',
    action: 'design.updateSelected',
    intent: 'update_selected_nodes',
    executionKind: 'interactive',
    params: [
      {
        name: 'props',
        type: 'object',
        description: '可选，要更新的 props 属性。对于 geo 形状，使用 color 属性修改颜色；对于文本，使用 text 属性修改内容。',
        required: false,
        schema: {
          properties: {
            color: { type: 'string', description: '颜色（如 "black", "red", "#FF5733"）' },
            text: { type: 'string', description: '文本内容' },
            w: { type: 'number', description: '宽度' },
            h: { type: 'number', description: '高度' },
          }
        }
      },
      {
        name: 'meta',
        type: 'object',
        description: '可选，要更新的 meta 属性。对于自定义组件，使用 readyFillColor 等属性。',
        required: false,
        schema: {
          properties: {
            readyFillColor: { type: 'string', description: '填充颜色（hex）' },
            readyCornerRadius: { type: 'number', description: '圆角半径（px）' },
            readyFontSize: { type: 'number', description: '字号（px）' },
            readyTextColor: { type: 'string', description: '文本颜色（hex）' },
          }
        }
      },
      {
        name: 'x',
        type: 'number',
        description: '可选，新的 x 坐标',
        required: false,
      },
      {
        name: 'y',
        type: 'number',
        description: '可选，新的 y 坐标',
        required: false,
      },
    ],
  },
  {
    name: 'design_set_z_order',
    description: '调整节点前后层级，支持前置、后置、前移、后移。',
    action: 'design.setZOrder',
    intent: 'set_design_z_order',
    executionKind: 'interactive',
    params: [
      {
        name: 'ids',
        type: 'array',
        description: '目标节点 id 数组。',
        required: true,
        schema: { items: { type: 'string' } },
      },
      { name: 'mode', type: 'string', description: 'front / back / forward / backward', required: true },
    ],
  },
  {
    name: 'design_group_nodes',
    description: '把多个节点编组成一个逻辑 group，便于整体移动和修正。',
    action: 'design.groupNodes',
    intent: 'group_design_nodes',
    executionKind: 'interactive',
    params: [
      {
        name: 'ids',
        type: 'array',
        description: '需要编组的节点 id 数组。',
        required: true,
        schema: { items: { type: 'string' } },
      },
      { name: 'name', type: 'string', description: '可选，group 名称', required: false },
    ],
  },
  {
    name: 'design_run_task_controller',
    description: '执行设计控制器闭环：观察画布、生成计划、定位落区、批次执行、复查修正并截图验收。',
    action: 'design.runTaskController',
    intent: 'run_design_task_controller',
    executionKind: 'interactive',
    params: [
      { name: 'taskType', type: 'string', description: 'social-cover / content-layout', required: false },
      { name: 'platform', type: 'string', description: 'xiaohongshu / generic', required: false },
      { name: 'ratio', type: 'string', description: '9:16 / 16:9 / 3:4 / 4:3 / 1:1', required: false },
      { name: 'title', type: 'string', description: '可选，主标题占位文案', required: false },
      { name: 'audience', type: 'string', description: '可选，目标受众', required: false },
      { name: 'tone', type: 'string', description: '可选，风格语气', required: false },
      { name: 'compositionFamily', type: 'string', description: 'editorial-stack / numbered-list / split-feature', required: false },
      { name: 'sectionCount', type: 'number', description: '可选，信息区数量', required: false },
      { name: 'placementStrategy', type: 'string', description: 'auto-right / auto-below / viewport-origin / explicit', required: false },
      {
        name: 'themeKeywords',
        type: 'array',
        description: '可选，主题关键词数组。',
        required: false,
        schema: { items: { type: 'string' } },
      },
      { name: 'styleGuide', type: 'object', description: '可选，结构化设计 token。', required: false },
      { name: 'brief', type: 'object', description: '可选，结构化设计 brief。', required: false },
      { name: 'styleSystem', type: 'object', description: '可选，结构化设计系统 token。', required: false },
      { name: 'palette', type: 'object', description: '可选，结构化配色方案。', required: false },
      { name: 'board', type: 'object', description: '可选，画板尺寸与内边距规划。', required: false },
      { name: 'typography', type: 'object', description: '可选，字体层级规划。', required: false },
      { name: 'layoutStrategy', type: 'object', description: '可选，结构化布局策略。', required: false },
      { name: 'scenePlan', type: 'object', description: '可选，结构化场景蓝图。', required: false },
      { name: 'executionProgram', type: 'object', description: '可选，结构化执行程序。', required: false },
      { name: 'layoutBudget', type: 'object', description: '可选，标题区、信息区、底部预算。', required: false },
      {
        name: 'contentSections',
        type: 'array',
        description: '可选，结构化信息区规划数组。',
        required: false,
        schema: { items: { type: 'object' } },
      },
      { name: 'repairScope', type: 'string', description: 'run-owned / selected', required: false },
      { name: 'reasoningSummary', type: 'string', description: '可选，简短设计决策摘要', required: false },
      { name: 'x', type: 'number', description: '可选，布局起始 x 坐标', required: false },
      { name: 'y', type: 'number', description: '可选，布局起始 y 坐标', required: false },
    ],
  },
  {
    name: 'design_compose_content_layout',
    description: '在当前画布生成一组多层级内容排版骨架。',
    action: 'design.composeContentLayout',
    intent: 'compose_content_layout',
    executionKind: 'interactive',
    params: [
      { name: 'template', type: 'string', description: 'editorial / dashboard / landing', required: false },
      { name: 'title', type: 'string', description: '页面主标题', required: false },
      { name: 'x', type: 'number', description: '可选，布局起始 x 坐标', required: false },
      { name: 'y', type: 'number', description: '可选，布局起始 y 坐标', required: false },
    ],
  },
  {
    name: 'design_compose_social_cover',
    description: '在当前画板生成社媒封面骨架，内部走设计控制器闭环；支持 9:16 / 16:9 / 3:4 / 4:3 / 1:1，支持由上层 planner 传入构图、配色、信息区和落位策略。',
    action: 'design.composeSocialCover',
    intent: 'compose_social_cover',
    executionKind: 'interactive',
    params: [
      { name: 'platform', type: 'string', description: 'xiaohongshu / youtube / generic', required: false },
      { name: 'ratio', type: 'string', description: '9:16 / 16:9 / 3:4 / 4:3 / 1:1', required: false },
      { name: 'title', type: 'string', description: '可选，主标题占位文案', required: false },
      { name: 'audience', type: 'string', description: '可选，目标受众', required: false },
      { name: 'tone', type: 'string', description: '可选，风格语气', required: false },
      { name: 'compositionFamily', type: 'string', description: 'editorial-stack / numbered-list / split-feature', required: false },
      { name: 'sectionCount', type: 'number', description: '可选，信息区数量', required: false },
      { name: 'placementStrategy', type: 'string', description: 'auto-right / auto-below / viewport-origin / explicit', required: false },
      {
        name: 'themeKeywords',
        type: 'array',
        description: '可选，主题关键词数组。',
        required: false,
        schema: { items: { type: 'string' } },
      },
      {
        name: 'palette',
        type: 'object',
        description: '可选，结构化配色方案。',
        required: false,
      },
      {
        name: 'board',
        type: 'object',
        description: '可选，版心尺寸与内边距规划，例如 paddingX / paddingTop / paddingBottom / cornerRadius。',
        required: false,
      },
      {
        name: 'typography',
        type: 'object',
        description: '可选，标题、副标题、正文等字号与行高规划。',
        required: false,
      },
      {
        name: 'layoutStrategy',
        type: 'object',
        description: '可选，结构化布局策略，例如 heroWeight / sectionGap / footerMode。',
        required: false,
      },
      {
        name: 'contentSections',
        type: 'array',
        description: '可选，结构化信息区规划数组。',
        required: false,
        schema: { items: { type: 'object' } },
      },
      {
        name: 'reviewChecklist',
        type: 'array',
        description: '可选，执行后用于自检的布局检查项。',
        required: false,
        schema: { items: { type: 'string' } },
      },
      { name: 'brief', type: 'object', description: '可选，结构化设计 brief。', required: false },
      { name: 'styleSystem', type: 'object', description: '可选，结构化设计系统 token。', required: false },
      { name: 'scenePlan', type: 'object', description: '可选，结构化场景蓝图。', required: false },
      { name: 'reasoningSummary', type: 'string', description: '可选，简短设计决策摘要', required: false },
      { name: 'x', type: 'number', description: '可选，布局起始 x 坐标', required: false },
      { name: 'y', type: 'number', description: '可选，布局起始 y 坐标', required: false },
    ],
  },
  {
    name: 'design_save_project',
    description: '保存当前设计项目；如未绑定文件可指定 path。',
    action: 'design.saveProject',
    intent: 'save_design_project',
    executionKind: 'deterministic',
    params: [{ name: 'path', type: 'string', description: '可选，目标设计文件路径', required: false }],
  },
  {
    name: 'design_export_artifact',
    description: '将当前设计导出为 PNG 或 SVG。',
    action: 'design.exportArtifact',
    intent: 'export_design_artifact',
    executionKind: 'deterministic',
    params: [
      { name: 'format', type: 'string', description: 'png 或 svg', required: true },
      { name: 'path', type: 'string', description: '可选，导出路径', required: false },
      { name: 'defaultName', type: 'string', description: '可选，默认文件名', required: false },
    ],
  },
  {
    name: 'design_capture_session',
    description: '读取当前设计会话快照，包括文件、选区和导出状态。',
    action: 'design.captureSession',
    intent: 'capture_design_session',
    executionKind: 'deterministic',
    params: [],
  },
]

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  return {
    type: param.type,
    description: param.description,
    ...(param.schema || {}),
  }
}

function toStructuredResult(tool: DesignToolDef, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    module: 'design',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
    ...(extra || {}),
  })
}

function getDesignTool(toolName: string): DesignToolDef | undefined {
  return DESIGN_TOOLS.find((item) => item.name === toolName)
}

function requireStringArg(args: Record<string, unknown>, key: string, message: string): string {
  const value = String(args[key] || '').trim()
  if (!value) throw new Error(message)
  return value
}

export function getDesignAnthropicTools(): Array<Record<string, unknown>> {
  return DESIGN_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getDesignOpenAITools(): Array<Record<string, unknown>> {
  return DESIGN_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }))
}

export async function executeDesignTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: DesignToolContext,
): Promise<string> {
  const tool = getDesignTool(toolName)
  if (!tool) return `Unknown design tool: ${toolName}`

  // 强制检查 requestToolAction 可用性（针对 interactive 工具）
  if (tool.executionKind === 'interactive' && !context?.requestToolAction) {
    return toStructuredResult(tool, 'Error: Design tools require active editor session', {
      status: 'failed',
      summary: 'No active design editor session available',
      review: {
        passed: false,
        geometryPassed: false,
        screenshotPassed: false,
        summary: 'Cannot execute design tool without active editor',
        issues: [{ code: 'no-editor-session', message: 'No active design editor session' }],
      },
      ownedNodeIds: [],
      mutationStats: {
        boardCreates: 0,
        boardDeletes: 0,
        boardRebuilds: 0,
        sectionRebuilds: 0,
        executionBatches: 0,
        repairRounds: 0,
        touchedSelection: false,
      },
    })
  }

  try {
    if (toolName === 'design_open_file') {
      requireStringArg(args, 'path', 'Error: path is required')
    }

    if (toolName === 'design_create_text') {
      requireStringArg(args, 'text', 'Error: text is required')
    }

    if (toolName === 'design_find_empty_space_on_canvas') {
      if (!Number.isFinite(Number(args.width)) || Number(args.width) <= 0) return 'Error: width must be a positive number'
      if (!Number.isFinite(Number(args.height)) || Number(args.height) <= 0) return 'Error: height must be a positive number'
    }

    if (toolName === 'design_measure_text') {
      requireStringArg(args, 'text', 'Error: text is required')
      if (!Number.isFinite(Number(args.width)) || Number(args.width) <= 0) return 'Error: width must be a positive number'
      if (!Number.isFinite(Number(args.fontSize)) || Number(args.fontSize) <= 0) return 'Error: fontSize must be a positive number'
    }

    if (toolName === 'design_batch_design') {
      if (!Array.isArray(args.ops) || args.ops.length === 0) return 'Error: ops must be a non-empty array'
      if (args.ops.length > 15) return 'Error: ops must contain at most 15 atomic operations'
    }

    if (toolName === 'design_update_selected') {
      // At least one of props, meta, x, or y must be provided
      if (!args.props && !args.meta && !Number.isFinite(Number(args.x)) && !Number.isFinite(Number(args.y))) {
        return 'Error: At least one of props, meta, x, or y must be provided'
      }
    }

    if (toolName === 'design_update_nodes') {
      if (!Array.isArray(args.patches) || args.patches.length === 0) return 'Error: patches must be a non-empty array'
      if (args.patches.some((item) => !item || typeof item !== 'object' || !String((item as Record<string, unknown>).id || '').trim())) {
        return 'Error: each patch must include a non-empty id'
      }
    }

    if (toolName === 'design_set_z_order') {
      if (!Array.isArray(args.ids) || args.ids.length === 0) return 'Error: ids must be a non-empty array'
      if (!['front', 'back', 'forward', 'backward'].includes(String(args.mode || '').trim())) {
        return 'Error: mode must be front, back, forward, or backward'
      }
    }

    if (toolName === 'design_group_nodes') {
      if (!Array.isArray(args.ids) || args.ids.length < 2) return 'Error: ids must contain at least two nodes'
    }

    if (toolName === 'design_create_geo_shape') {
      const shape = String(args.shape || '').trim()
      if (!['rectangle', 'ellipse', 'circle', 'pill'].includes(shape)) {
        return 'Error: shape must be rectangle, ellipse, circle, or pill'
      }
    }

    if (toolName === 'design_create_frame') {
      if (!Number.isFinite(Number(args.w)) || Number(args.w) <= 0) return 'Error: w must be a positive number'
      if (!Number.isFinite(Number(args.h)) || Number(args.h) <= 0) return 'Error: h must be a positive number'
    }

    if (toolName === 'design_create_text_block') {
      requireStringArg(args, 'content', 'Error: content is required')
    }

    if (toolName === 'design_create_page_header') {
      requireStringArg(args, 'title', 'Error: title is required')
    }

    if (toolName === 'design_create_section_block') {
      requireStringArg(args, 'title', 'Error: title is required')
    }

    if (toolName === 'design_create_stat_card') {
      requireStringArg(args, 'value', 'Error: value is required')
    }

    if (toolName === 'design_create_list_item') {
      requireStringArg(args, 'title', 'Error: title is required')
    }

    if (toolName === 'design_export_artifact') {
      const format = String(args.format || '').trim().toLowerCase()
      if (format !== 'png' && format !== 'svg') return 'Error: format must be png or svg'
    }

    if (toolName === 'design_arrange_selection') {
      const mode = String(args.mode || '').trim()
      const validModes = new Set([
        'stack-vertical',
        'stack-horizontal',
        'align-left',
        'align-center',
        'align-right',
        'distribute-horizontal',
        'distribute-vertical',
      ])
      if (!validModes.has(mode)) {
        return 'Error: mode must be one of stack-vertical, stack-horizontal, align-left, align-center, align-right, distribute-horizontal, distribute-vertical'
      }
    }

    if (toolName === 'design_compose_content_layout') {
      const template = String(args.template || 'editorial').trim().toLowerCase()
      if (!['editorial', 'dashboard', 'landing'].includes(template)) {
        return 'Error: template must be editorial, dashboard, or landing'
      }
    }

    if (toolName === 'design_compose_social_cover') {
      const platform = String(args.platform || 'xiaohongshu').trim().toLowerCase()
      const ratio = String(args.ratio || '9:16').trim()
      if (!['xiaohongshu', 'youtube', 'generic'].includes(platform)) {
        return 'Error: platform must be xiaohongshu, youtube, or generic'
      }
      if (!isDesignRatio(ratio)) {
        return 'Error: ratio must be 9:16, 16:9, 3:4, 4:3, or 1:1'
      }
      if (args.compositionFamily && !['editorial-stack', 'numbered-list', 'split-feature'].includes(String(args.compositionFamily))) {
        return 'Error: compositionFamily must be editorial-stack, numbered-list, or split-feature'
      }
    }

    if (toolName === 'design_run_task_controller') {
      const taskType = String(args.taskType || 'social-cover').trim()
      if (!['social-cover', 'content-layout'].includes(taskType)) {
        return 'Error: taskType must be social-cover or content-layout'
      }
      if (args.ratio && !isDesignRatio(String(args.ratio))) {
        return 'Error: ratio must be 9:16, 16:9, 3:4, 4:3, or 1:1'
      }
      if (args.compositionFamily && !['editorial-stack', 'numbered-list', 'split-feature'].includes(String(args.compositionFamily))) {
        return 'Error: compositionFamily must be editorial-stack, numbered-list, or split-feature'
      }
      if (args.repairScope && !['run-owned', 'selected'].includes(String(args.repairScope))) {
        return 'Error: repairScope must be run-owned or selected'
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  // 统一使用真实 RPC，添加超时机制
  const DESIGN_TOOL_TIMEOUT = 30000 // 30 秒

  if (!context?.requestToolAction) {
    // 这种情况在前面已经被拦截（针对 interactive 工具）
    // 对于 deterministic 工具，如果没有 requestToolAction，则使用 emitToolAction
    context?.emitToolAction?.(tool.action, args)
    return toStructuredResult(tool, `${tool.action} 已排队执行。`, {
      ownerResourceId: typeof args.path === 'string' ? args.path : null,
    })
  }

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Design tool execution timeout after 30s')), DESIGN_TOOL_TIMEOUT)
    )

    const payload = await Promise.race([
      context.requestToolAction(tool.action, args),
      timeoutPromise
    ])

    const normalizedPayload = payload && typeof payload === 'object' ? payload : {}

    // 记录诊断信息
    try {
      const capture = (normalizedPayload as { runCapture?: unknown }).runCapture
      if (capture && typeof capture === 'object') {
        appendFileSync('/tmp/ready-design-run-captures.ndjson', `${JSON.stringify(capture)}\n`)
      }
    } catch {
      // ignore diagnostic persistence failures
    }

    const message = typeof normalizedPayload.summary === 'string' && normalizedPayload.summary.trim()
      ? normalizedPayload.summary.trim()
      : typeof normalizedPayload.message === 'string' && normalizedPayload.message.trim()
        ? normalizedPayload.message.trim()
        : `${tool.description}执行完成。`

    return toStructuredResult(tool, message, normalizedPayload)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return toStructuredResult(tool, `Error: ${errorMessage}`, {
      status: 'failed',
      summary: errorMessage,
      review: {
        passed: false,
        geometryPassed: false,
        screenshotPassed: false,
        summary: errorMessage,
        issues: [{ code: 'execution-error', message: errorMessage }],
      },
      ownedNodeIds: [],
      mutationStats: {
        boardCreates: 0,
        boardDeletes: 0,
        boardRebuilds: 0,
        sectionRebuilds: 0,
        executionBatches: 0,
        repairRounds: 0,
        touchedSelection: false,
      },
    })
  }
}
