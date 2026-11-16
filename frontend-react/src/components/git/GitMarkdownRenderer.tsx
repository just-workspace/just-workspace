// README·이슈 본문·댓글 마크다운(markdown-it, html 비활성화 + DOMPurify). 결과가 비어 있으면 렌더링하지 않는다.
import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'

export interface GitMarkdownRendererProps {
  /** 마크다운 원문 */
  content: string
}

/** Git 마크다운 본문 */
export function GitMarkdownRenderer({ content }: GitMarkdownRendererProps) {
  const [rendered, setRendered] = useState('')

  useEffect(() => {
    let alive = true
    async function render() {
      if (!content) {
        setRendered('')
        return
      }
      try {
        const MarkdownIt = (await import('markdown-it')).default
        const md = new MarkdownIt({
          html: false,
          linkify: true,
          breaks: true,
        })
        const html = DOMPurify.sanitize(md.render(content))
        if (alive) setRendered(html)
      } catch {
        if (alive) setRendered(DOMPurify.sanitize(content.replace(/\n/g, '<br>')))
      }
    }
    void render()
    return () => { alive = false }
  }, [content])

  if (!rendered) return null
  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none break-words
      prose-headings:border-b prose-headings:pb-2 prose-headings:mb-3
      prose-a:text-primary prose-a:break-words prose-code:text-sm
      prose-pre:bg-muted/50 prose-pre:border prose-pre:rounded-md prose-pre:overflow-x-auto
      [&_table]:block [&_table]:overflow-x-auto
      prose-img:rounded-md prose-img:max-w-full"
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  )
}

export default GitMarkdownRenderer
