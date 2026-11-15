/**
 * AI 답변 본문(Vue components/ai/AiMessage.vue) — markdown-it(html 끔·linkify·breaks) + DOMPurify.
 * 코드펜스는 머리(언어 + 복사) + shiki 하이라이트(로드되면, 다크/라이트 테마 따라).
 * 스트리밍 중에는 60ms 간격으로 다시 그린다. 스타일은 AiMessage.css(Vue 전역 <style> 그대로).
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { useI18n } from '~/i18n'
import { useColorMode } from '~/composables/useColorMode'
import { getAiHighlighter, AI_LANGS } from '~/utils/aiHighlighter'
import { aiHasMath, aiKatexLoaded, aiMathPlugin, getAiKatex } from '~/utils/aiMath'
import { aiCitePlugin } from '~/utils/aiCite'
import './AiMessage.css'
import { writeClipboard } from '~/lib/clipboard'

export interface AiMessageProps {
  /** 마크다운 원문 */
  content: string
  /** 받는 중(다시 그리기를 60ms 로 묶는다) */
  streaming?: boolean
  /** 이 답변의 출처 번호(본문 [n] 중 이 번호만 버튼이 된다) */
  citations?: number[]
  /** 본문 [n] 을 누름 */
  onCite?: (n: number, el: HTMLElement) => void
}

export function AiMessage({ content, streaming, citations, onCite }: AiMessageProps) {
  const { t } = useI18n()
  const colorMode = useColorMode()
  const isDark = colorMode.value === 'dark'

  // 렌더러가 읽는 "지금" 값(Vue 는 클로저가 반응형 값을 읽었다)
  const citeKey = (citations ?? []).join(',')
  const live = useRef({ content, isDark, t, nums: new Set(citations ?? []) as ReadonlySet<number> })
  live.current = { content, isDark, t, nums: new Set(citations ?? []) }
  const hl = useRef<any>(null)

  const [md] = useState(() => {
    const m = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true })
    // 코드펜스: 헤더(언어+복사) + shiki 하이라이트(가능 시)
    m.renderer.rules.fence = (tokens: any, idx: number) => {
      const tok = tokens[idx]
      const lang = ((tok.info || '').trim().split(/\s+/)[0] || 'text').toLowerCase()
      const code = tok.content
      let body = ''
      if (hl.current && AI_LANGS.includes(lang)) {
        try {
          body = hl.current.codeToHtml(code, { lang, theme: live.current.isDark ? 'github-dark' : 'github-light' })
        } catch { body = '' }
      }
      if (!body) body = `<pre class="ai-pre"><code>${m.utils.escapeHtml(code)}</code></pre>`
      const label = m.utils.escapeHtml(lang === 'text' ? '' : lang)
      return `<div class="ai-cb"><div class="ai-cb-h"><span class="ai-cb-lang">${label}</span>`
        + `<button type="button" class="ai-cb-copy">${m.utils.escapeHtml(live.current.t('ai.message.copy'))}</button></div>${body}</div>`
    }
    // 수식 $…$ · $$…$$ (KaTeX, 처음 필요할 때 로드) — 코드에는 닿지 않는다
    aiMathPlugin(m, aiKatexLoaded)
    // 출처 표식 [n] → 버튼
    aiCitePlugin(m, () => live.current.nums, n => live.current.t('ai.cite.marker', { n }))
    return m
  })

  const [rendered, setRendered] = useState('')
  const doRender = useRef(() => {
    const src = live.current.content || ''
    setRendered(DOMPurify.sanitize(md.render(src)))
    // 수식이 있으면 KaTeX 를 불러온 뒤 한 번 더
    if (!aiKatexLoaded() && aiHasMath(src)) void getAiKatex().then(() => doRender()).catch(() => { /* 원문 그대로 */ })
  }).current
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // onMounted: 그리기 → 하이라이터 로드 후 다시
  useEffect(() => {
    let alive = true
    doRender()
    void (async () => {
      try {
        const h = await getAiHighlighter()
        if (!alive) return
        hl.current = h
        doRender()
      } catch { /* 하이라이트 없이 진행 */ }
    })()
    return () => {
      alive = false
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
    }
  }, [doRender])

  // Vue watch(() => props.content, schedule) — 첫 실행 없음
  const seen = useRef({ content: false, streaming: false, dark: false, cites: false })
  useEffect(() => {
    if (!seen.current.content) { seen.current.content = true; return }
    if (streaming) {
      if (timer.current) return
      timer.current = setTimeout(() => { timer.current = null; doRender() }, 60)
    } else {
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      doRender()
    }
    // 내용이 바뀔 때만(Vue watch 소스와 같게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])
  // watch(() => props.streaming, s => { if (!s) doRender() })
  useEffect(() => {
    if (!seen.current.streaming) { seen.current.streaming = true; return }
    if (!streaming) doRender()
  }, [streaming, doRender])
  // 출처 번호가 바뀌면(스트림 중 citation 도착) 다시
  useEffect(() => {
    if (!seen.current.cites) { seen.current.cites = true; return }
    doRender()
  }, [citeKey, doRender])
  // watch(isDark, doRender)
  useEffect(() => {
    if (!seen.current.dark) { seen.current.dark = true; return }
    doRender()
  }, [isDark, doRender])

  function onClick(e: MouseEvent<HTMLDivElement>) {
    const cite = (e.target as HTMLElement).closest('.ai-cite') as HTMLElement | null
    if (cite) {
      e.preventDefault()
      onCite?.(Number(cite.dataset.cite), cite)
      return
    }
    const btn = (e.target as HTMLElement).closest('.ai-cb-copy') as HTMLElement | null
    if (!btn) return
    const pre = btn.closest('.ai-cb')?.querySelector('pre')
    const code = pre?.textContent || ''
    void writeClipboard(code).catch(() => { /* 복사 실패 — 버튼 문구만 바뀐다 */ })
    const prev = btn.textContent
    btn.textContent = t('ai.message.copied')
    setTimeout(() => { btn.textContent = prev || t('ai.message.copy') }, 1200)
  }

  return (
    <div
      className="ai-md prose prose-sm dark:prose-invert max-w-none break-words"
      dangerouslySetInnerHTML={{ __html: rendered }}
      onClick={onClick}
    />
  )
}

export default AiMessage
