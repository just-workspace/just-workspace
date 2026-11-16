/**
 * AI 답변 본문 — markdown-it(html 비활성·linkify·breaks) + DOMPurify.
 * 코드펜스는 머리(언어 + 복사) + shiki 하이라이트(로드 완료 시, 다크/라이트 테마 연동).
 * 스트리밍 중에는 60ms 간격으로 재렌더링한다. 스타일은 AiMessage.css(전역).
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
  /** 수신 중(재렌더링을 60ms 단위로 병합) */
  streaming?: boolean
  /** 이 답변의 출처 번호(본문 [n] 중 해당 번호만 버튼으로 변환) */
  citations?: number[]
  /** 본문 [n] 클릭 */
  onCite?: (n: number, el: HTMLElement) => void
}

export function AiMessage({ content, streaming, citations, onCite }: AiMessageProps) {
  const { t } = useI18n()
  const colorMode = useColorMode()
  const isDark = colorMode.value === 'dark'

  // 렌더러가 참조하는 현재 값
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
    // 수식 $…$ · $$…$$ (KaTeX, 최초 필요 시 로드) — 코드에는 미적용
    aiMathPlugin(m, aiKatexLoaded)
    // 출처 표식 [n] → 버튼
    aiCitePlugin(m, () => live.current.nums, n => live.current.t('ai.cite.marker', { n }))
    return m
  })

  const [rendered, setRendered] = useState('')
  const doRender = useRef(() => {
    const src = live.current.content || ''
    setRendered(DOMPurify.sanitize(md.render(src)))
    // 수식이 있으면 KaTeX 로드 후 1회 재렌더링
    if (!aiKatexLoaded() && aiHasMath(src)) void getAiKatex().then(() => doRender()).catch(() => { /* 원문 유지 */ })
  }).current
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // onMounted: 렌더링 → 하이라이터 로드 후 재렌더링
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

  // 내용 변경 시 재렌더링 예약 — 최초 실행 제외
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
    // 내용 변경 시에만 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])
  // watch(() => props.streaming, s => { if (!s) doRender() })
  useEffect(() => {
    if (!seen.current.streaming) { seen.current.streaming = true; return }
    if (!streaming) doRender()
  }, [streaming, doRender])
  // 출처 번호 변경 시(스트림 중 citation 도착) 재렌더링
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
    void writeClipboard(code).catch(() => { /* 복사 실패 — 버튼 문구만 변경 */ })
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
