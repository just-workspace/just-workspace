/**
 * 메일 본문 렌더. 3경로 + 종이.
 *  A 텍스트        : 종이 위에 그대로 + 인용문 접기
 *  B 단순 HTML     : 서식 태그만 → prose
 *  C 서식 HTML     : 표·이미지·색 → 샌드박스 iframe(발신자 레이아웃 보존)
 * 종이 색은 전역 토큰 --paper / --paper-foreground(두 테마 같은 흰 종이). MailBody.css 의 --mail-paper* 가 그 토큰을 받는다.
 * "어둡게 보기"(dark) 는 A·B 는 앱 색으로, C 는 iframe 을 색 반전(이미지는 되돌림)한다.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { useI18n } from '~/i18n'
// class 를 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지운다)
import { clsx as cx } from 'clsx'
import { UiIcon } from '~/components/ui/Icon'
import './MailBody.css'

// 흰 종이가 필요한 신호 — 하나라도 있으면 iframe(C)
const RICH_RE = /<(table|img|style|font)\b|bgcolor=|style\s*=\s*["'][^"']*(background|color|width|font-)/i
// A — 텍스트에서 인용문을 분리해 접는다(한국 업무 메일은 회신이 겹쳐 원문이 묻힌다)
const QUOTE_RE = /^(&gt;|>|-{2,}\s*(Original|원본)|보낸 사람:|From:|20\d{2}년.*(작성|씀))/

// 바깥 서버에서 받아 오는 것(추적 픽셀·배경 이미지) — 있으면 "이미지 표시" 버튼을 보인다
const REMOTE_RE = /<(img|source|video|audio|input)\b[^>]*\b(src|srcset|poster)\s*=\s*["']?\s*(https?:)?\/\/|\bbackground\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\//i

/**
 * 본문 iframe 의 CSP. 기본은 바깥 리소스 전부 차단(이미지는 data: 만 — 서버가 cid: 인라인 이미지를 data: 로 바꿔 준다).
 * 메일을 여는 것만으로 발신자에게 열람 사실·IP 가 넘어가지 않게 한다. images=true("이미지 표시")면 http(s) 이미지만 푼다.
 * 스크립트는 높이 알림용 인라인 한 개뿐(본문은 DOMPurify 가 script 를 지운다).
 */
export function mailFrameCsp(images: boolean): string {
  return `default-src 'none'; img-src data:${images ? ' https: http:' : ''}; style-src 'unsafe-inline'; script-src 'unsafe-inline'`
}

/** 단순 HTML 본문의 링크는 새 탭으로 — 같은 탭에서 열리면 앱이 통째로 떠나 쓰던 작성 창이 사라진다 */
export function linksToNewTab(html: string): string {
  if (!html) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
  return tpl.innerHTML
}

type BodyMode = 'text' | 'plain-html' | 'rich-html'

export interface MailBodyProps {
  /** 메일 상세(MessageDetail — id·subject·text_body·html_body 를 쓴다) */
  message: any
  /** 어둡게 보기 */
  dark?: boolean
  /** 루트에 덧붙일 클래스 */
  className?: string
}

/** 메일 본문 종이(텍스트·단순 HTML·서식 HTML 3경로) */
export function MailBody({ message, dark = false, className }: MailBodyProps) {
  const { t } = useI18n()
  const [forcePlain, setForcePlain] = useState(false) // "텍스트로 보기"
  const [quoteOpen, setQuoteOpen] = useState(false)
  // "이미지 표시" — 이 메일만(다른 메일을 열면 다시 막는다)
  const [showImages, setShowImages] = useState(false)
  // watch(message.id) — 다른 메일이면 되돌린다
  const [seenId, setSeenId] = useState(message?.id)
  if (message?.id !== seenId) {
    setSeenId(message?.id)
    setForcePlain(false)
    setQuoteOpen(false)
    setShowImages(false)
  }

  const bodyMode: BodyMode = (() => {
    const m = message
    if (!m) return 'text'
    const html = m.html_body || ''
    if (!html) return 'text'
    if (forcePlain) return 'plain-html'
    if (RICH_RE.test(html)) return 'rich-html'
    if ((html.match(/<blockquote/gi) || []).length >= 3) return 'rich-html'
    return 'plain-html'
  })()

  // B — 서식 없는 HTML. 레이아웃 태그(style/color/width)는 전부 버린다.
  const plainHtml = useMemo(() => {
    if (bodyMode !== 'plain-html') return ''
    return linksToNewTab(DOMPurify.sanitize(message.html_body, {
      ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'b', 'i', 'u', 'em', 'strong',
        'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'code', 'pre'],
      ALLOWED_ATTR: ['href', 'title'],
    }))
  }, [bodyMode, message?.html_body])

  const textParts = useMemo(() => {
    const raw: string = message?.text_body || ''
    const lines = raw.split(/\r?\n/)
    const cut = lines.findIndex((l: string) => QUOTE_RE.test(l.trim()))
    if (cut < 0) return { body: raw, quote: '' }
    return {
      body: lines.slice(0, cut).join('\n').trimEnd(),
      quote: lines.slice(cut).join('\n').trim(),
    }
  }, [message?.text_body])

  // C — sanitize 는 표/이미지/색을 허용(레이아웃 보존).
  const sanitizedHtml = useMemo(() => {
    if (bodyMode !== 'rich-html') return ''
    return DOMPurify.sanitize(message.html_body, {
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['script', 'meta', 'head', 'link', 'object', 'embed', 'form', 'input'],
    })
  }, [bodyMode, message?.html_body])
  const hasRemote = !!sanitizedHtml && REMOTE_RE.test(sanitizedHtml)

  // iframe(origin null)은 부모 CSS 변수를 못 읽는다 → 마운트 때 계산값을 읽어 srcdoc 에 넣는다(값의 출처는 여전히 MailBody.css 한 곳).
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [paper, setPaper] = useState({ bg: 'hsl(0 0% 100%)', fg: 'hsl(216 28% 14%)', link: 'hsl(218 78% 48%)', rule: 'hsl(215 18% 87%)', muted: 'hsl(215 12% 42%)' })

  // 폰트 주입 안 함 — 샌드박스 srcdoc iframe(origin null)은 앱 번들의 *.woff2 를 CORS 로 못 불러온다.
  const iframeSrcdoc = useMemo(() => {
    if (!sanitizedHtml) return ''
    const p = paper
    return `<!DOCTYPE html><html${dark ? ' class="dark-view"' : ''}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${mailFrameCsp(showImages)}"><style>
    html, body { background: ${p.bg}; }
    body {
      margin: 0; padding: 18px 20px;
      font-family: "IBM Plex Sans KR", -apple-system, "Segoe UI", sans-serif;
      font-size: 14px; line-height: 1.7; color: ${p.fg};
      word-break: break-word; overflow-wrap: break-word;
    }
    @media (max-width: 480px) { body { padding: 16px 12px; } }
    table, img { max-width: 100%; height: auto; }
    p { margin: 0 0 12px; }
    a { color: ${p.link}; }
    blockquote { margin: 12px 0; padding-left: 14px; border-left: 3px solid ${p.rule}; color: ${p.muted}; }
    pre { white-space: pre-wrap; }
    html.dark-view { filter: invert(1) hue-rotate(180deg); }
    html.dark-view img, html.dark-view video, html.dark-view picture { filter: invert(1) hue-rotate(180deg); }
  </style></head><body>${sanitizedHtml}<script>
    function sendHeight() { parent.postMessage({ type: "mail-iframe-height", height: document.documentElement.scrollHeight }, ${JSON.stringify(window.location.origin)}); }
    sendHeight();
    new MutationObserver(sendHeight).observe(document.body, { childList: true, subtree: true, attributes: true });
    document.querySelectorAll("img").forEach(function(img) { img.addEventListener("load", sendHeight); });
    window.addEventListener("load", sendHeight);
    document.querySelectorAll("a").forEach(function(a) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); });
  </script></body></html>`
  }, [sanitizedHtml, paper, dark, showImages])

  useEffect(() => {
    // readPaperVars
    if (rootRef.current) {
      const cs = getComputedStyle(rootRef.current)
      setPaper((prev) => {
        const v = (n: string, fb: string) => { const x = cs.getPropertyValue(n).trim(); return x ? `hsl(${x})` : fb }
        return {
          bg: v('--mail-paper', prev.bg),
          fg: v('--mail-paper-foreground', prev.fg),
          link: v('--mail-paper-link', prev.link),
          rule: v('--mail-paper-rule', prev.rule),
          muted: v('--mail-paper-muted', prev.muted),
        }
      })
    }
    // iframe 높이 수신
    function onMessage(e: MessageEvent) {
      if (e.origin !== 'null' && e.origin !== window.location.origin) return
      if (e.data?.type === 'mail-iframe-height' && e.data.height) {
        document.querySelectorAll<HTMLIFrameElement>('iframe[data-mail-frame]').forEach((f) => {
          if (f.contentWindow === e.source) f.style.height = e.data.height + 'px'
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <div ref={rootRef} className={cx('mail-paper-scope', className ?? '')}>
      {bodyMode === 'rich-html'
        ? (
          // C · 서식 HTML → 종이 iframe
          <>
            {hasRemote && !showImages && (
              <div role="status" className="mb-1.5 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">{t('mail.view.imagesBlocked', '개인정보 보호를 위해 외부 이미지를 막았습니다.')}</span>
                <button type="button" className="shrink-0 font-semibold text-primary hover:underline" onClick={() => setShowImages(true)}>
                  {t('mail.view.showImages', '이미지 표시')}
                </button>
              </div>
            )}
            <iframe
              srcDoc={iframeSrcdoc}
              data-mail-frame=""
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              title={message.subject || t('mail.body.frameTitle')}
              className="mail-paper block w-full overflow-hidden rounded-md"
              style={{ height: '200px' }}
            />
            <button type="button" className="mt-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setForcePlain(true)}>
              {t('mail.view.viewAsText')}
            </button>
          </>
        )
        : bodyMode === 'plain-html'
          ? (
            // B · 단순 HTML
            <div className={cx('mail-paper rounded-md px-5 py-[18px]', dark ? 'mail-paper--dark' : '')}>
              <div
                className="mail-paper-prose prose prose-sm max-w-none text-[14px] leading-[1.7] [word-break:keep-all]
               prose-p:my-3 prose-a:no-underline prose-blockquote:border-l-[3px] prose-blockquote:pl-3.5 prose-blockquote:not-italic"
                dangerouslySetInnerHTML={{ __html: plainHtml }}
              />
            </div>
          )
          : message.text_body
            ? (
              // A · 텍스트 → 본문 + 접힌 인용문
              <div className={cx('mail-paper rounded-md px-5 py-[18px]', dark ? 'mail-paper--dark' : '')}>
                <pre className="whitespace-pre-wrap font-sans text-[14px] leading-[1.7] [word-break:keep-all]">{textParts.body}</pre>
                {textParts.quote && (
                  <div className="mt-3">
                    <button
                      type="button"
                      aria-expanded={quoteOpen}
                      className="mail-paper-quote-toggle flex min-h-8 items-center gap-2 border-l-[3px] pl-3.5 text-[11px] font-semibold tracking-[0.08em]"
                      onClick={() => setQuoteOpen(!quoteOpen)}
                    >
                      {t('mail.view.quotedLines', { n: textParts.quote.split('\n').length })}
                      <UiIcon name={quoteOpen ? 'chevron-up' : 'chevron-down'} className="h-3 w-3" />
                    </button>
                    {quoteOpen && <pre className="mail-paper-quote mt-2 whitespace-pre-wrap border-l-[3px] pl-3.5 font-sans text-[13px] leading-[1.7]">{textParts.quote}</pre>}
                  </div>
                )}
              </div>
            )
            : <p className="text-sm italic text-muted-foreground">{t('mail.view.noBody')}</p>}
    </div>
  )
}

export default MailBody
