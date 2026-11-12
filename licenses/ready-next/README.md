# Ready Next 移植资源

来源：本机藏书阁项目。字体随应用由 Vite 打包，仅包含拉丁字体；中文使用系统字体。

| 资源 | 应用内位置 | 许可证 |
| --- | --- | --- |
| Inter Tight | src/renderer/design/next/fonts/InterTight.woff2 | OFL-InterTight.txt |
| Inter | src/renderer/design/next/fonts/Inter.woff2 | OFL-Inter.txt |
| Instrument Serif（含 Italic） | src/renderer/design/next/fonts/InstrumentSerif*.woff2 | OFL-InstrumentSerif.txt |
| Geist Mono | src/renderer/design/next/fonts/GeistMono.woff2 | OFL-GeistMono.txt |
| Paper Flipbook 翻页算法 | src/renderer/modules/library/reader/{flipbook,glturn}.js | paper-flipbook-LICENSE.txt |

手工声明以 `manifest.json` 为准；`npm run licenses:generate` 离线合并生产依赖，生成 `licenses/generated/` 的 JSON 与文本。五个字体按文件分别列出，Instrument Serif 正体与斜体共享 OFL。`lets-go-rss-NOTICE.txt` 仅记录上游 MIT 字样及缺口，不冒充全文；其他缺口见清单的 notes / textMissing。

## 历史

旧 `design/next/glass.ts`（Glass HQ，MIT）于 `5b993c62e` 删除，不再列为现用资源。现用 `LiquidLens.tsx`、`refraction-map.ts` 在 `c26faf3f6`（2026-06-11）已引入，早于旧移植（2026-10-30）；代码路径与算法实现不同，但现用文件仍有外部曲线参考，离线记录不足以排除共同上游关系。因此本批保留 `LICENSE-liquid-glass.txt` 并随包附上，待来源补齐后再判断，不将其认定为现用实现的已确认授权。
