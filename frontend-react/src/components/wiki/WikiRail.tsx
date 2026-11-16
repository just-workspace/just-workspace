/**
 * 위키 오른쪽 레일 240("목차와 정보").
 *  "이 페이지" 목차(왼쪽 1px 선 + 현재 항목 2px primary) · "최근 기록"(v12 정하늘 · 10:44) + 전체 기록 보기.
 *  "이 페이지를 가리키는 곳"(백링크, GET /api/wiki/pages/{id}/backlinks): 12 muted 한 줄에 "제목 · 제목"(시안 그대로),
 *  각 제목은 해당 페이지로 이동하는 링크(타 스페이스이면 "스페이스 › 제목"). 백링크가 없으면 영역을 숨긴다.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import type { TocItem } from '~/utils/htmlToc'
import type { WikiPageVersion } from '~/composables/useWiki'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'

export interface WikiRailProps {
  toc: TocItem[]
  activeIndex: number
  versions: WikiPageVersion[]
  /** 현재 페이지 — 백링크 조회 대상 */
  pageId?: string | null
  /** 현재 스페이스 이름 — 동일 스페이스 백링크는 스페이스 이름 생략 */
  spaceName?: string | null
  className?: string
  onJump?: (item: TocItem) => void
  onHistory?: () => void
}

interface Backlink { id: string; title: string; space_name: string; url: string; link_type: string; snippet: string }

/** 목차·최근 기록·백링크 레일 */
export function WikiRail({ toc, activeIndex, versions, pageId, spaceName, className, onJump, onHistory }: WikiRailProps) {
  const { t } = useI18n()

  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const blSeq = useRef(0)
  // watch(pageId, …, { immediate: true })
  useEffect(() => {
    const my = ++blSeq.current
    setBacklinks([])
    if (!pageId) return
    ;(async () => {
      try {
        const data = await $fetch<{ items: Backlink[] }>(`/api/wiki/pages/${encodeURIComponent(pageId)}/backlinks`)
        if (my === blSeq.current) setBacklinks(data.items || [])
      } catch { /* 해당 영역만 숨김 */ }
    })()
  }, [pageId])

  function shortTime(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`
    const y = new Date(now); y.setDate(now.getDate() - 1)
    if (d.toDateString() === y.toDateString()) return t('common.yesterday')
    return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
  }

  return (
    <aside aria-label={t('wiki.rail.label')} className={cn('w-60 shrink-0 overflow-y-auto pb-6 pl-2 pr-5 pt-9 text-[13px]', className)}>
      {toc.length > 0 && (
        <>
          <div className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('wiki.rail.thisPage')}</div>
          <nav aria-label={t('wiki.rail.tocLabel')} className="flex flex-col gap-0.5 border-l border-border">
            {toc.map(h => (
              <a
                key={h.id}
                href={`#${h.id}`}
                className={cn(
                  '-ml-px border-l-2 py-1 pr-3 transition-colors hover:text-foreground',
                  h.index === activeIndex ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground',
                  h.level === 3 ? 'pl-6' : 'pl-3',
                )}
                aria-current={h.index === activeIndex ? 'location' : undefined}
                onClick={(e) => { e.preventDefault(); onJump?.(h) }}
              >{h.text}</a>
            ))}
          </nav>
        </>
      )}

      <div className={cn('mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground', toc.length ? 'mt-6' : '')}>{t('wiki.rail.recent')}</div>
      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        {versions.slice(0, 2).map(v => (
          <span key={v.id} className="truncate">
            <b className="font-mono font-bold text-foreground">v{v.version_number}</b>
            {' '}{v.author.display_name || v.author.username} · <span className="font-mono">{shortTime(v.created_at)}</span>
          </span>
        ))}
        {!versions.length && <span>{t('wiki.versions.empty')}</span>}
        {versions.length > 0 && (
          <button
            type="button"
            className="self-start font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onHistory?.()}
          >{t('wiki.rail.allHistory')}</button>
        )}
      </div>

      {backlinks.length > 0 && (
        <>
          <div className="mb-2 mt-6 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('wiki.rail.backlinks')}</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {backlinks.map((b, i) => (
              <Fragment key={b.id}>
                {i > 0 && ' · '}
                <NuxtLink
                  to={b.url}
                  className="hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  title={b.snippet || undefined}
                >{b.space_name && b.space_name !== spaceName && <>{b.space_name}<UiIcon name="chevron-right" className="mx-0.5 inline h-3 w-3 align-[-2px]" /></>}{b.title}</NuxtLink>
              </Fragment>
            ))}
          </p>
        </>
      )}
    </aside>
  )
}

export default WikiRail
