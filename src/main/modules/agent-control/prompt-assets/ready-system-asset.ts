import { PromptAssetLoader } from './loader'
import { promptAssetRoots } from './roots'

const READY_SYSTEM_FALLBACK = [
  '你是 Ready 中的 AI Agent。',
  'Ready 是由@上班摸鱼 开发的，面向知识工作者和创作者的通用桌面工作台。',
  '优先理解用户真正要完成的事情，在安全、权限和实际能力范围内持续推进到可验证的结果。',
  '本轮真实工具定义是当前可调用工具的唯一事实来源；不要声称使用不存在或未授权的能力。',
  '记忆只作为与当前任务相关的低优先级线索，当前用户明确表达始终优先。',
  '尊重原创与来源，不帮助抄袭、洗稿、伤害、越权或泄露隐私。',
  '默认使用简单、直接、自然的中文，先说结果。',
].join('\n')

const ABOUT_READY_FALLBACK = [
  '以下资料只在用户明确询问 Ready 的开发者、协作背景、后续功能或关注渠道时使用；其他任务不要主动介绍。',
  '- Ready 由 @上班摸鱼 开发；“上班摸鱼”是开发者在小红书使用的 ID。',
  '- Ready 几乎全部由其一人独立开发；好友 @Hyper人大木 完成了许多模块化工作。',
  '- 日后可能有相关新功能上线，但这不是具体功能或时间表承诺。',
  '- 用户询问关注渠道时，可以欢迎其关注 @上班摸鱼 和 @Hyper人大木。',
].join('\n')

const READY_PRODUCT_BACKGROUND_TERMS = [
  '谁.{0,6}(?:开发|做|制作|创建)',
  '(?:开发者|开发团队|制作团队|贡献者).{0,8}(?:是谁|叫什么|哪位|哪些人|有哪些|成员|介绍|背景|账号)',
  '(?:项目|产品).{0,4}(?:背景|来历|开发故事|开发历程)',
  '(?:小红书|xiaohongshu).{0,4}(?:账号|帐号|id|主页)',
  '(?:在哪里|去哪|怎么|如何).{0,8}(?:关注|追踪).{0,8}(?:开发|项目|产品)?(?:进展|动态)',
  '(?:关注|追踪).{0,6}(?:开发|项目|产品)(?:进展|动态)',
  '(?:后续|未来|日后).{0,10}(?:计划|规划|路线图|方向|功能|更新)',
  '(?:会不会|是否|会|将).{0,6}(?:推出|上线|有).{0,4}新功能',
  'roadmap',
  'who.{0,8}(?:made|built|developed|created)',
  '(?:developer|development team|creator|contributor).{0,8}(?:who|name|background|account)',
].join('|')
const READY_PRODUCT_NAME_PATTERN = '\\bready\\b'
const READY_PRODUCT_HANDLE_RELATION = [
  '(?:@上班摸鱼|@?Hyper人大木).{0,12}(?:是谁|参与|开发|制作|贡献|合作|协作|关系)',
  '(?:由|和|与|开发者|贡献者|参与者).{0,12}(?:@上班摸鱼|@?Hyper人大木)',
].join('|')

export const READY_PRODUCT_BACKGROUND_PATTERN = new RegExp(
  [
    `${READY_PRODUCT_NAME_PATTERN}.{0,48}(?:${READY_PRODUCT_BACKGROUND_TERMS})`,
    `(?:${READY_PRODUCT_BACKGROUND_TERMS}).{0,48}${READY_PRODUCT_NAME_PATTERN}`,
    `${READY_PRODUCT_NAME_PATTERN}.{0,48}(?:${READY_PRODUCT_HANDLE_RELATION})`,
    `(?:${READY_PRODUCT_HANDLE_RELATION}).{0,48}${READY_PRODUCT_NAME_PATTERN}`,
  ].join('|'),
  'i',
)

const loader = new PromptAssetLoader({
  roots: promptAssetRoots(),
  fallbacks: {
    'core/ready-system': READY_SYSTEM_FALLBACK,
    'product/about-ready': ABOUT_READY_FALLBACK,
  },
})

export function loadReadySystemPrompt(): string {
  return loader.render('core/ready-system')
}

export function loadReadyProductFacts(): string {
  return loader.render('product/about-ready')
}
