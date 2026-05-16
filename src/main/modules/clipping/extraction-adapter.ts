/**
 * P1.6 — `ExtractionAdapter` 接口。
 *
 * 这一层在 clip-pipeline 与具体抽取库（@mozilla/readability / defuddle / Jina
 * pre-extracted markdown）之间做隔离。Phase 1 唯一实现是
 * `ReadabilityJsdomAdapter`（移植自 standalone skill 的 clip-page.mjs 抽取
 * 逻辑），Phase 2 会加 `DefuddleLinkedomAdapter` swap-in，签名固定后两次替换不
 * 触动 clip-pipeline / web_clip_url tool / browser:clipCurrentTab IPC 中的任
 * 何一行。
 *
 * 设计约束（Codex iter-2 Q7）：
 * - `metadata` 是 JSON-safe object（含已展开的 author/published/image/site/lang/
 *   wordCount/description），不再裸暴露 `Map<string,string>` 或 raw JSON-LD。
 * - `structuredData` 是 pre-flattened JSON-LD entry 列表（已经过 `@graph` 展开），
 *   仅作 preset 模板引擎的回退查找；上层不应再做 schema 扁平化。
 * - `diagnostics` 记录 extraction source 与置信度，Phase 2 的 second-pass /
 *   defuddle 切换判定都基于它。
 *
 * 该模块 pure — 不依赖 electron / skills-runtime。
 */

export interface ExtractionInput {
  html: string
  url: string
  /** True if the caller already stripped PII / form values (current-tab path). */
  sanitized?: boolean
}

export interface ExtractionMetadata {
  author?: string
  published?: string
  description?: string
  image?: string
  site?: string
  lang?: string
  wordCount?: number
}

export interface ExtractionDiagnostics {
  extractionSource: 'readability' | 'defuddle' | 'jina'
  /** 0..1; below 0.4 the pipeline should consider a second pass. */
  confidence: number
  warnings: string[]
}

export interface ExtractionResult {
  title: string
  contentMarkdown: string
  metadata: ExtractionMetadata
  /** JSON-LD entries with @graph already flattened; JSON-safe. */
  structuredData: Record<string, unknown>[]
  /** Lookup helper for `meta:name:...` / `meta:property:...` preset variables. */
  metaLookup: Record<string, string>
  diagnostics: ExtractionDiagnostics
}

export interface ExtractionAdapter {
  /** Extract structured content + metadata from raw HTML. */
  extract(input: ExtractionInput): Promise<ExtractionResult>
}
