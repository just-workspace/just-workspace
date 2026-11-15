/**
 * 검색 결과 — 오른쪽 자리 400.
 * 자리: chatStore.showSearchPanel(기존 "search" 패널 자리 — ChatSearchPanel 이 이것을 그린다).
 *
 * 머리 48+1: (모바일 ‹ 44) search 20 · "검색 결과" 16/600 · 닫기 32(Esc).
 * 모바일: 머리 아래 검색칸(ChatSearchBox mobile — 칩 입력 44 + 필터 칩 줄).
 * 개수 줄: "38개 · from:이도윤 has:링크" 13/600 (aria-live polite) + 정렬 세그먼트 sm(최신 · 오래된).
 * 본문: 채널 묶음 제목 12/600 muted(연속한 같은 채널) → 결과 카드(rounded-lg 1px bg-card p-3, 호버 bg-overlay-hover):
 *   아바타 32 · 이름 14/500(역할 색) · 시각 11 mono · (스레드 답글이면 "스레드" 꼬리표) · "이동" 12/600 primary
 *   → 본문 14 · 일치 부분 bg-warning/30 굵게.
 *   누르면 그 채널을 열고 useChatUi.jumpTo(channelId, messageId) — 스레드 답글이면 스레드를 연다. 모바일은 결과 화면을 닫는다.
 * 아래: 25개씩 쪽 넘김(현재 쪽 bg-overlay-selected 600 · "25개씩" · ‹ ›).
 * 상태: 찾는 중(스켈레톤 4 · aria-busy) · 결과 없음(아이콘 원 48 + 15/600 + 13 설명) · 오류(다시 시도) · 아직 안 찾음(안내).
 */
import { useEffect } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { chatStore, getDMDisplayName, openThread, selectChannel, setShowSearchPanel } from '~/composables/useChat'
import { chatClockAmPm, initialOf, jumpTo } from '~/composables/useChatUi'
import { roleTextClass, userRoleColor, useChatRoles } from '~/composables/useChatRoles'
import { SEARCH_PAGE, type SearchHit } from '~/composables/chatApi22'
import {
  closeSearchResults, describeChips, goSearchPage, groupByChannel, highlightParts, pageWindow, retrySearch, setSearchSort,
  useChatSearch, type SearchSort,
} from '~/composables/useChatSearch'
import { plainLine } from '~/composables/useChatThreadList'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { UiAvatar } from '~/components/ui/Avatar'
import { ChatSearchBox } from './ChatSearchBox'

/** 결과 시각 — 오늘이면 "오늘 오전 10:02", 어제 "어제 오후 4:40", 아니면 "10월 14일" */
export function searchStamp(iso: string, t: (k: string) => string, lang = 'ko-KR', now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return `${t('chat.right.search.today')} ${chatClockAmPm(iso, lang)}`
  if (d.toDateString() === y.toDateString()) return `${t('common.yesterday')} ${chatClockAmPm(iso, lang)}`
  return d.toLocaleDateString(lang, d.getFullYear() === now.getFullYear() ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' })
}

function groupTitle(channelId: string, name: string, type: string): string {
  const ch = chatStore.getState().channels.find(c => c.id === channelId)
  if (ch) return ch.type === 'dm' ? getDMDisplayName(ch) : ch.type === 'private' ? ch.name : `#${ch.name}`
  return type === 'public' ? `#${name}` : name
}

function ResultCard({ hit, q, onGo }: { hit: SearchHit; q?: string; onGo: (h: SearchHit) => void }) {
  const { t, locale } = useI18n()
  const name = hit.sender?.display_name || hit.sender?.username || t('chat.right.search.system')
  const color = useChatRoles(s => (hit.sender ? userRoleColor(hit.sender.id, s) : null))
  const isReply = !!hit.parent_id && !hit.thread_broadcast
  const body = plainLine(hit.content) || (hit.attachments?.[0]?.filename ?? '')
  return (
    <li>
      <button
        type="button"
        aria-label={t('chat.right.search.jumpLabel', { name })}
        className="flex w-full gap-3 rounded-lg border border-border bg-card p-3 text-left outline-none hover:bg-overlay-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onGo(hit)}
      >
        <UiAvatar src={hit.sender?.avatar_url} fallback={initialOf(name)} textSize={11} className="h-8 w-8" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-[14px]">
            <b className={cn('truncate font-medium', roleTextClass(color) || 'text-foreground')}>{name}</b>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{searchStamp(hit.created_at, t, locale === 'en' ? 'en-US' : 'ko-KR')}</span>
            {isReply && <span className="shrink-0 rounded-sm bg-muted px-1 text-[11px] font-medium text-muted-foreground">{t('chat.right.search.inThread')}</span>}
            <span className="flex-1" />
            <span className="shrink-0 text-[12px] font-semibold text-primary">{t('chat.right.search.go')}</span>
          </span>
          <span className="line-clamp-3 block break-words text-[14px] leading-snug text-foreground">
            {highlightParts(body, q).map((p, i) => (p.hit
              ? <mark key={i} className="rounded-sm bg-warning/30 px-0.5 font-semibold text-foreground">{p.t}</mark>
              : <span key={i}>{p.t}</span>))}
          </span>
        </span>
      </button>
    </li>
  )
}

/** 검색 결과(오른쪽 자리 / 모바일 전체 화면) */
export function ChatSearchResults() {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const { query, queryChips, sort, offset, items, total, loading, error } = useChatSearch()

  function close() { closeSearchResults() }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function onGo(h: SearchHit) {
    const inThread = !!h.parent_id && !h.thread_broadcast
    if (chatStore.getState().selectedChannelId !== h.channel_id) await selectChannel(h.channel_id)
    if (inThread) {
      // 스레드 답글 — 스레드를 열고(오른쪽 자리를 바꿔 낀다) 그 답글로
      setShowSearchPanel(false)
      await openThread(h.parent_id!)
      jumpTo(h.channel_id, h.id)
      return
    }
    jumpTo(h.channel_id, h.id)
    if (mobile) setShowSearchPanel(false)
  }

  const groups = groupByChannel(items)
  const conds = describeChips(queryChips)
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE))
  const page = Math.floor(offset / SEARCH_PAGE)
  const countText = loading
    ? t('chat.right.search.searching')
    : conds ? t('chat.right.search.countWith', { n: total.toLocaleString(), conds }) : t('chat.right.search.count', { n: total.toLocaleString() })
  const sorts = [{ value: 'new', label: t('chat.right.search.sortNew') }, { value: 'old', label: t('chat.right.search.sortOld') }]
  const condsForEmpty = [conds, query?.q ? `“${query.q}”` : ''].filter(Boolean).join(' · ')

  return (
    <aside aria-label={t('chat.right.search.resultsTitle')} className="flex h-full w-full shrink-0 flex-col border-border bg-background md:w-[400px] md:border-l">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 max-md:h-14 max-md:px-1">
        {mobile && <UiIconButton label={t('chat.right.back')} icon="chevron-left" size="lg" noTooltip onClick={close} />}
        <UiIcon name="search" className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{t('chat.right.search.resultsTitle')}</h2>
        {!mobile && <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} onClick={close} />}
      </header>

      <div className="flex shrink-0 flex-col gap-2 px-3 py-2.5">
        {mobile && <ChatSearchBox variant="mobile" autoFocus={!query} />}
        {query && (
          <div className="flex items-center gap-2">
            <p aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] font-semibold">{countText}</p>
            <UiSegment
              ariaLabel={t('chat.right.search.sortLabel')}
              size={mobile ? 'lg' : 'sm'}
              items={sorts}
              modelValue={sort}
              onUpdateModelValue={(v) => { void setSearchSort(v as SearchSort) }}
            />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        {!query
          ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><UiIcon name="search" className="h-6 w-6 text-muted-foreground" /></span>
              <p className="text-[15px] font-semibold">{t('chat.right.search.idleTitle')}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{t('chat.right.search.idleDesc')}</p>
            </div>
          )
          : loading && items.length === 0
            ? (
              <div aria-busy="true" className="flex flex-col gap-4 px-2 pt-2">
                {[1, 2, 3, 4].map(k => (
                  <div key={k} className="flex gap-3">
                    <span className="h-8 w-8 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
                    <div className="flex flex-1 flex-col gap-2">
                      <span className="h-3 w-24 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
                      <span className="h-3 w-full animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
                    </div>
                  </div>
                ))}
              </div>
            )
            : error
              ? (
                <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><UiIcon name="alert-circle" className="h-6 w-6 text-muted-foreground" /></span>
                  <p className="text-[15px] font-semibold">{t('chat.right.search.error')}</p>
                  <p className="text-[13px] text-muted-foreground">{error}</p>
                  <button type="button" className="mt-1 h-8 rounded-md px-3 text-[13px] font-semibold text-primary hover:bg-overlay-hover max-md:h-11" onClick={() => { void retrySearch() }}>{t('chat.right.retry')}</button>
                </div>
              )
              : items.length === 0
                ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><UiIcon name="search" className="h-6 w-6 text-muted-foreground" /></span>
                    <p className="text-[15px] font-semibold">{t('chat.right.search.noneTitle')}</p>
                    <p className="text-[13px] leading-relaxed text-muted-foreground">{t('chat.right.search.noneDesc', { conds: condsForEmpty })}</p>
                  </div>
                )
                : (
                  <div className={cn('flex flex-col gap-1', loading && 'opacity-60')} aria-busy={loading || undefined}>
                    {groups.map(g => (
                      <section key={g.key} aria-label={groupTitle(g.channelId, g.channelName, g.channelType)}>
                        <p className="px-2 pb-1 pt-3 text-[12px] font-semibold text-muted-foreground">{groupTitle(g.channelId, g.channelName, g.channelType)}</p>
                        <ul className="flex flex-col gap-1">
                          {g.items.map(h => <ResultCard key={h.id} hit={h} q={query.q} onGo={(x) => { void onGo(x) }} />)}
                        </ul>
                      </section>
                    ))}
                    {pages > 1 && (
                      <nav aria-label={t('chat.right.search.pagerLabel')} className="mt-2 flex items-center justify-center gap-1 text-[13px]">
                        <UiIconButton label={t('chat.right.search.prev')} icon="chevron-left" size={mobile ? 'lg' : 'sm'} disabled={page === 0} onClick={() => { void goSearchPage(page - 1) }} />
                        {pageWindow(page, pages).map(p => (
                          <button
                            key={p}
                            type="button"
                            aria-current={p === page ? 'page' : undefined}
                            aria-label={t('chat.right.search.page', { n: p + 1 })}
                            className={cn('flex items-center justify-center rounded-md font-mono', mobile ? 'h-11 w-11' : 'h-8 w-8', p === page ? 'bg-overlay-selected font-semibold' : 'hover:bg-overlay-hover')}
                            onClick={() => { void goSearchPage(p) }}
                          >
                            {p + 1}
                          </button>
                        ))}
                        <span className="px-1 text-muted-foreground">{t('chat.right.search.perPage', { n: SEARCH_PAGE })}</span>
                        <UiIconButton label={t('chat.right.search.next')} icon="chevron-right" size={mobile ? 'lg' : 'sm'} disabled={page >= pages - 1} onClick={() => { void goSearchPage(page + 1) }} />
                      </nav>
                    )}
                  </div>
                )}
      </div>
    </aside>
  )
}

export default ChatSearchResults
