/**
 * 연락처 목록 — Vue 판 components/contacts/ContactsList.vue.
 * 데스크톱: 커맨드 바 44 bg-card(검색 32 "이름·회사·이메일" + "이름순 ▾"), 초성 헤더 28(sticky, 11/700 muted, bg-background),
 *   행 56(이니셜 36 · 이름 14/600 · 보조 12 muted), 선택 = primary/13.
 * 모바일: 범위 줄(주소록 ▾ · 개수 mono · 검색 · ⋯), 헤더 28 bg-card 12/700, 행 60(이니셜 40 · 15/600 · 13), 오른쪽 초성 색인 바.
 *   색인 글자 시각 24×22 유지, 터치는 바 전체를 끌어 고르는 방식 + 폭 40 히트 영역.
 * 사진(있으면 이미지, 없으면 이니셜) · 즐겨찾기 별(warning 14). 즐겨찾기는 맨 위 "★" 묶음으로 모은다(색인 바 ★ 포함).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { useIsMobile } from '~/composables/useIsMobile'
import { useContacts, type Contact } from '~/composables/useContacts'
import { groupByIndex, initialsOf, HANGUL_KEYS, OTHER_KEY } from '~/utils/contactsIndex'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { getUiZoom } from '~/composables/useViewport'

const FAV_KEY = '★' // 내부 묶음 키(화면에는 UiIcon star 로 그린다)
// ── 모바일 초성 색인 바(★ ㄱ…ㅎ A #) ──
const INDEX = [FAV_KEY, ...HANGUL_KEYS, 'A', OTHER_KEY]

function subline(c: Contact) {
  // 시안 "제품팀 · seoyeon@example.com" — 회사 · 첫 이메일(없으면 전화)
  const contact = c.emails?.[0]?.value || c.phones?.[0]?.value || ''
  return [c.organization, contact].filter(Boolean).join(' · ')
}

/** 연락처 목록 열(데스크톱 340 · 모바일 전체). props 없음 — 상태는 useContacts. */
export function ContactsList() {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const {
    contacts, selectedContact, loadingContacts, contactsError, searchQuery, totalContacts, sortBy, scope, scopeLabel,
    currentPage, totalPages, hasNextPage, hasPrevPage, setMobileMenuOpen, setSortBy,
    setSearchQuery, selectContact, nextPage, prevPage, fetchContacts,
  } = useContacts()

  const [localSearch, setLocalSearch] = useState(searchQuery)
  // watch(localSearch) — 첫 실행은 건너뛴다(Vue watch 는 immediate 아님)
  const firstSearch = useRef(true)
  useEffect(() => {
    if (firstSearch.current) { firstSearch.current = false; return }
    const tm = setTimeout(() => setSearchQuery(localSearch), 300)
    return () => clearTimeout(tm)
  }, [localSearch, setSearchQuery])

  const [mobileSearch, setMobileSearch] = useState(!!searchQuery)
  const searchEl = useRef<HTMLInputElement | null>(null)
  const focusSearch = useRef(false)
  function toggleMobileSearch() {
    const next = !mobileSearch
    setMobileSearch(next)
    if (next) focusSearch.current = true
    else if (localSearch) setLocalSearch('')
  }
  useEffect(() => {
    if (mobileSearch && focusSearch.current) { focusSearch.current = false; searchEl.current?.focus() }
  }, [mobileSearch])

  const scopeName = scopeLabel

  const groups = useMemo(() => {
    const all = contacts
    const nameOf = (c: Contact) => c.name || c.first_name || ''
    const orgOf = (c: Contact) => c.organization || ''
    // 즐겨찾기 범위에서는 따로 묶지 않는다(전부 즐겨찾기)
    if (scope.kind === 'favorite') return groupByIndex(all, nameOf, orgOf, sortBy)
    const favs = all.filter(c => c.is_favorite)
    const rest = all.filter(c => !c.is_favorite)
    const out = groupByIndex(rest, nameOf, orgOf, sortBy)
    if (favs.length) {
      const sorted = [...favs].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ko'))
      out.unshift({ key: FAV_KEY, items: sorted })
    }
    return out
  }, [contacts, scope.kind, sortBy])

  const sortOptions = [
    { value: 'name', label: t('contacts.list.sortName') },
    { value: 'org', label: t('contacts.list.sortOrg') },
  ]

  const listEl = useRef<HTMLDivElement | null>(null)
  const [activeKey, setActiveKey] = useState('')
  const activeRef = useRef('')

  function jumpTo(key: string) {
    activeRef.current = key
    setActiveKey(key)
    // 'A' 는 라틴 전체를 대표
    const order = groups.map(g => g.key)
    const isLatin = (k: string) => /^[A-Z]$/.test(k)
    const want = key === 'A' ? order.find(isLatin) : key
    let target = want && order.includes(want) ? want : undefined
    if (!target) {
      // 그 초성이 없으면 다음 초성으로
      const all = [FAV_KEY, ...HANGUL_KEYS, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), OTHER_KEY]
      const from = all.indexOf(key)
      target = order.find(k => all.indexOf(k) >= from)
    }
    if (!target) return
    const el = listEl.current?.querySelector<HTMLElement>(`[data-index-key="${CSS.escape(target)}"]`)
    if (el && listEl.current) listEl.current.scrollTop += (el.getBoundingClientRect().top - listEl.current.getBoundingClientRect().top) / getUiZoom()
  }

  function keyAtPoint(e: RPointerEvent) {
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    return el?.closest<HTMLElement>('[data-jump]')?.dataset.jump
  }
  const dragging = useRef(false)
  function onIndexDown(e: RPointerEvent<HTMLElement>) {
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const k = keyAtPoint(e); if (k) jumpTo(k)
  }
  function onIndexMove(e: RPointerEvent<HTMLElement>) {
    if (!dragging.current) return
    const k = keyAtPoint(e); if (k && k !== activeRef.current) jumpTo(k)
  }
  function onIndexUp() { dragging.current = false; setTimeout(() => { if (!dragging.current) { activeRef.current = ''; setActiveKey('') } }, 600) }

  return (
    <div className="flex h-full flex-col">
      {/* 데스크톱 커맨드 바 44 */}
      <div className="hidden h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-2.5 md:flex">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35">
          <UiIcon name="search" className="h-[13px] w-[13px] shrink-0" />
          <input
            value={localSearch}
            onChange={e => setLocalSearch(e.target.value)}
            type="search"
            autoComplete="off"
            aria-label={t('contacts.list.searchLabel')}
            placeholder={t('contacts.list.searchPlaceholder')}
            className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-hidden placeholder:text-muted-foreground"
          />
          {localSearch && <UiIconButton label={t('common.clear')} icon="close" className="-mr-1.5 h-6 w-6 [&>svg]:h-3 [&>svg]:w-3" onClick={() => setLocalSearch('')} />}
        </label>
        <label className="relative flex h-8 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground hover:text-foreground focus-within:ring-2 focus-within:ring-ring">
          <span>{sortOptions.find(o => o.value === sortBy)?.label}</span>
          <UiIcon name="chevron-down" className="h-3 w-3" />
          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'name' | 'org')} aria-label={t('contacts.list.sortLabel')} className="absolute inset-0 cursor-pointer opacity-0">
            {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      {/* 1024 미만 범위 줄: 주소록 ▾ · 개수 · 검색(모바일) · ⋯ — 사이드바 대신.
          모바일(<768)에선 이 줄이 화면 머리(56, 제목 "연락처" 18/600 + 아래 범위 줄) — 공용 상단바는 숨긴다. */}
      <div className="flex h-14 shrink-0 items-center gap-0.5 border-b border-border pl-4 pr-1 md:h-12 lg:hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-lg font-semibold leading-6 text-foreground md:hidden">{t('nav.contacts')}</h1>
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 text-left text-xs text-muted-foreground"
            aria-label={t('contacts.mobile.scopeLabel', { name: scopeName })}
            onClick={() => setMobileMenuOpen(true)}
          >
            <span className="truncate">{scopeName}</span>
            <UiIcon name="chevron-down" className="h-3 w-3 shrink-0" />
            <span aria-hidden="true">·</span>
            <span className="font-mono">{totalContacts}</span>
          </button>
        </div>
        <UiIconButton label={t('common.search')} icon="search" size="lg" noTooltip className="md:hidden" pressed={mobileSearch} onClick={toggleMobileSearch} />
        <UiIconButton label={t('contacts.mobile.menu')} icon="more-horizontal" size="lg" noTooltip onClick={() => setMobileMenuOpen(true)} />
      </div>
      {mobileSearch && (
        <div className="shrink-0 border-b border-border px-4 py-2 md:hidden">
          <label className="flex h-11 items-center gap-2 rounded-md border border-input bg-background px-3 text-muted-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35">
            <UiIcon name="search" className="h-4 w-4 shrink-0" />
            <input
              ref={searchEl}
              value={localSearch}
              onChange={e => setLocalSearch(e.target.value)}
              type="search"
              autoComplete="off"
              aria-label={t('contacts.list.searchLabel')}
              placeholder={t('contacts.list.searchPlaceholder')}
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-hidden placeholder:text-muted-foreground"
            />
          </label>
        </div>
      )}

      {/* 목록 */}
      <div className="relative min-h-0 flex-1">
        <div ref={listEl} className="h-full overflow-y-auto">
          {contactsError
            ? (
              <div className="p-3">
                <UiErrorTile placement="panel" title={t('contacts.list.loadError')} onRetry={fetchContacts} />
              </div>
            )
            : loadingContacts && contacts.length === 0
              ? <UiSkeleton preset="list" rows={8} />
              : contacts.length === 0
                ? (
                  <UiEmptyState
                    icon="users"
                    title={searchQuery ? t('contacts.list.noMatch') : t('contacts.list.empty')}
                    description={searchQuery ? undefined : t('contacts.list.emptyDesc')}
                    variant={isMobile ? 'full' : 'panel'}
                  />
                )
                : (
                  <>
                    {groups.map(g => (
                      <section key={g.key} data-index-key={g.key} aria-label={g.key}>
                        <h3
                          className="sticky top-0 z-[1] flex h-7 items-center px-4 font-bold text-muted-foreground md:bg-background md:px-3.5 md:text-[11px] max-md:bg-card max-md:text-xs"
                        >{g.key === FAV_KEY ? <><UiIcon name="star" filled className="mr-1 h-3 w-3 text-warning" />{t('contacts.sidebar.favorites')}</> : g.key}</h3>
                        {g.items.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            className={cx(
                              'flex w-full items-center gap-3 border-b border-border text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring h-[60px] pl-4 pr-9 md:h-14 md:px-3.5',
                              selectedContact?.id === c.id ? 'bg-primary/[0.13]' : 'hover:bg-accent/40',
                            )}
                            aria-current={selectedContact?.id === c.id ? 'true' : undefined}
                            onClick={() => selectContact(c)}
                          >
                            {c.photo
                              ? <img src={c.photo} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-full object-cover md:h-9 md:w-9" />
                              : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-foreground md:h-9 md:w-9 md:text-[13px]" aria-hidden="true">{initialsOf(c.name || c.first_name)}</span>}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[15px] font-semibold text-foreground md:text-sm">{c.name}</span>
                              {subline(c) && <span className="block truncate text-[13px] text-muted-foreground md:text-xs">{subline(c)}</span>}
                            </span>
                            {c.is_favorite && <UiIcon name="star" filled className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={t('contacts.detail.favorited')} />}
                          </button>
                        ))}
                      </section>
                    ))}

                    {/* 페이지 넘김(서버 50개 단위) */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between px-2 py-2 text-xs">
                        <UiButton variant="ghost" size="xs" disabled={!hasPrevPage} onClick={prevPage}>{t('common.pagination.prev')}</UiButton>
                        <span className="font-mono text-[11px] text-muted-foreground">{currentPage + 1} / {totalPages}</span>
                        <UiButton variant="ghost" size="xs" disabled={!hasNextPage} onClick={nextPage}>{t('common.pagination.next')}</UiButton>
                      </div>
                    )}
                    <div className="h-24 md:hidden" aria-hidden="true" />
                  </>
                )}
        </div>

        {/* 모바일 초성 색인 바 */}
        {contacts.length > 0 && !contactsError && (
          <nav
            aria-label={t('contacts.list.indexLabel')}
            className="absolute right-0 top-3 flex w-10 touch-none select-none flex-col items-center gap-0.5 text-[10px] font-semibold text-primary md:hidden"
            onPointerDown={onIndexDown}
            onPointerMove={onIndexMove}
            onPointerUp={onIndexUp}
            onPointerCancel={onIndexUp}
          >
            {INDEX.map(k => (
              <button
                key={k}
                type="button"
                data-jump={k}
                className="grid h-[22px] w-10 place-items-center"
                aria-label={t('contacts.list.jumpTo', { key: k === FAV_KEY ? t('contacts.sidebar.favorites') : k })}
                onClick={() => jumpTo(k)}
              >
                <span className={cx('grid h-[22px] w-6 place-items-center rounded-sm', activeKey === k ? 'bg-primary text-primary-foreground' : '')}>
                  {k === FAV_KEY ? <UiIcon name="star" filled className="h-3 w-3" /> : k}
                </span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}

export default ContactsList
