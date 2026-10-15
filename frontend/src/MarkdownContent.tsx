// ==============================================================================
// Markdown & KaTeX 数式レンダリングコンポーネント (MarkdownContent)
// 用途: 問題文や解説中のMarkdownテキストおよびLaTeX数式を安全にパースして描画
// ==============================================================================
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// XSS防止のため外部リンク・画像タグを安全なプレーンテキストに無力化
const safeComponents: Components = {
  a: ({children}) => <span>{children}</span>,
  img: ({alt}) => <span>{alt ?? ''}</span>,
};

const inlineComponents: Components = {
  ...safeComponents,
  p: ({children}) => <span>{children}</span>,
};

/**
 * 数式（KaTeX）およびMarkdownの安全なレンダラーコンポーネント
 */
export default function MarkdownContent({children, className = '', inline = false}: {
  children: string;
  className?: string;
  inline?: boolean;
}) {

  const markdown = <ReactMarkdown
    remarkPlugins={[remarkMath]}
    rehypePlugins={[[rehypeKatex, {strict: false, trust: false}]]}
    components={inline ? inlineComponents : safeComponents}
    skipHtml
  >{children}</ReactMarkdown>;
  return inline
    ? <span className={`markdown-content markdown-inline ${className}`}>{markdown}</span>
    : <div className={`markdown-content ${className}`}>{markdown}</div>;
}
