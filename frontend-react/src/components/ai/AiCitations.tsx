/**
 * AI 답변 출처 칩(올렸을 때/눌렀을 때 미리보기, 모바일 가로 스크롤).
 *  칩 32(모바일 36) r8 · card · border — mono 번호 + 종류 아이콘(primary) + "종류 · 제목"(말줄임, 최대 280).
 *  마우스를 올리면 미리보기, 누르면 고정(다시 누르거나 Esc·바깥 누르면 닫힘). 본문 [n] 을 눌러도 그 칩이 열린다.
 *  미리보기: 보낸 사람·시각·종류 / 발췌 / "메일에서 열기" 등(앱 안 링크, 웹은 새 탭). 링크가 없으면 열기 없음.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { NuxtLink } from '~/components/NuxtLink'
import type { AiCitation } from '~/utils/aiAssist'

export interface AiCitationsProps {
  items: AiCitation[]
  /** 칩 id 접두사(본문 [n] 이 찾아 포커스) */
  idPrefix: string
  /** 고정해 연 칩 번호 */
  openN: number | null
  onOpenChange: (n: number | null) => void
  className?: string
}

export const AI_CITE_ICON: Record<string, string> = {
  mail: 'mail', file: 'file-text', wiki: 'book-open', board: 'clipboard-list', chat: 'chat', event: 'calendar', web: 'globe',
}

function fmtDate(v: string | undefined) {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  const hasTime = /T\d|\s\d{1,2}:/.test(v)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}${hasTime ? ` ${p2(d.getHours())}:${p2(d.getMinutes())}` : ''}`
}

export function AiCitations({ items, idPrefix, openN, onOpenChange, className }: AiCitationsProps) {
  const { t } = useI18n()
  const [hoverN, setHoverN] = useState<number | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const shownN = openN ?? hoverN
  const shown = items.find(c => c.n === shownN) || null

  // 고정된 미리보기: Esc·바깥 누름으로 닫기
  useEffect(() => {
    if (openN == null) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      onOpenChange(null)
      document.getElementById(`${idPrefix}-${openN}`)?.focus()
    }
    function onDown(e: PointerEvent) { if (!box.current?.contains(e.target as Node)) onOpenChange(null) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [openN, idPrefix, onOpenChange])
  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current) }, [])

  function hoverIn(n: number) {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
    setHoverN(n)
  }
  function hoverOut() {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHoverN(null), 150)
  }

  if (!items.length) return null
  const previewId = `${idPrefix}-preview`

  return (
    <div ref={box} className={cn('relative', className)}>
      <div className="flex gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0" role="group" aria-label={t('ai.cite.listLabel')}>
        {items.map(c => {
          const active = shownN === c.n
          return (
            <button
              key={c.n}
              id={`${idPrefix}-${c.n}`}
              type="button"
              aria-expanded={openN === c.n}
              aria-controls={active ? previewId : undefined}
              aria-label={t('ai.cite.chipLabel', { n: c.n, kind: t(`ai.cite.kind.${c.kind}`), title: c.title })}
              className={cn(
                'inline-flex h-9 max-w-[280px] shrink-0 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-[12.5px] text-foreground transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:h-8',
                active ? 'border-primary/60 bg-accent' : 'border-border hover:bg-accent/40',
              )}
              onClick={() => onOpenChange(openN === c.n ? null : c.n)}
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverIn(c.n) }}
              onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverOut() }}
            >
              <span aria-hidden="true" className="font-mono text-[11px] text-muted-foreground">{c.n}</span>
              <UiIcon name={AI_CITE_ICON[c.kind] || 'link'} className="h-3.5 w-3.5 text-primary" />
              <span aria-hidden="true" className="truncate">{t(`ai.cite.kind.${c.kind}`)} · {c.title}</span>
            </button>
          )
        })}
      </div>

      {shown && (
        <div
          id={previewId}
          role="region"
          aria-label={t('ai.cite.previewLabel', { n: shown.n })}
          className="absolute left-0 right-0 top-full z-20 mt-1.5 flex flex-col gap-1.5 rounded-[10px] border border-border bg-popover px-3.5 py-3 shadow-lg md:right-auto md:w-[420px] md:max-w-full"
          onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverIn(shown.n) }}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverOut() }}
        >
          <span className="text-xs text-muted-foreground">
            {shown.author && <>{shown.author} · </>}
            {fmtDate(shown.date) && <><span className="font-mono">{fmtDate(shown.date)}</span> · </>}
            {t(`ai.cite.kind.${shown.kind}`)}
          </span>
          <span className="text-[13px] font-semibold leading-5 text-foreground">{shown.title}</span>
          {shown.snippet && <span className="text-[13px] leading-5 text-foreground">“{shown.snippet}”</span>}
          {shown.url && (
            shown.kind === 'web'
              ? <a href={shown.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 self-start text-[12.5px] text-primary hover:underline">{t('ai.cite.open.web')}<UiIcon name="external-link" className="h-3 w-3" /></a>
              : <NuxtLink to={shown.url} className="inline-flex min-h-8 items-center self-start text-[12.5px] text-primary hover:underline">{t(`ai.cite.open.${shown.kind}`)}</NuxtLink>
          )}
        </div>
      )}
    </div>
  )
}

export default AiCitations
