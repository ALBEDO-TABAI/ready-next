import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// A text card at rest reads as rendered Markdown (W4 MS2); double-click opens the block editor on the same source.
// Links are inert here: a click selects the card, opening goes through the card's own open action.
const components: Components = {
  a: ({ children }) => <span className="canvas-md-link">{children}</span>,
  img: ({ alt }) => <span className="canvas-md-image">{alt || '图片'}</span>,
}

export function CardMarkdown({ text }: { text: string }) {
  if (!text.trim()) return <div className="canvas-markdown is-empty">空白卡片</div>
  return <div className="canvas-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</ReactMarkdown></div>
}
