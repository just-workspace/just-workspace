/**
 * 메일 목록 (모바일 목록).
 *  - 거터 체크박스 상시 표시. 1개 이상 선택 시 위 줄(44)이 선택 바로 전환: 개수·보관·읽음·이동·삭제·Esc.
 *  - 위 줄(선택 없음): 전체 선택 체크 · 커맨드 바 검색(현재 폴더, `from: is:unread` 구문) · 새로고침.
 *  - 빠른 칩 줄 44: 안 읽음(개수)·별표·첨부 + 정렬(최근 순/보낸 사람 순, 광고 숨기기).
 *  - 행: 2줄 56(밀도 조밀이면 한 줄 40). 안 읽음 = 두 줄 굵게(6px 점 폐지). 대화 수(thread_count ≥ 2)는 보낸 사람 옆 mono 숫자.
 *  - 빠른 칩·사이드바 라벨은 서버 필터(unread·flagged·has_attachment·label) — 페이지·전체 개수도 필터 적용 결과 기준.
 *  - 사이드바 "예약함" 선택 시 이 위치에 예약 목록(MailScheduledList) 표시.
 *  - 모바일: 상단 56(≡ 폴더 · 폴더 이름/안 읽음 수 · 검색) · 칩 36 · 행 3줄(미리보기) · 스와이프(왼쪽 보관 / 오른쪽 읽음 전환)
 *    · 길게 누르기 = 선택 모드 · FAB "새 메일". 행에 ⋮ 없음(메일 4).
 * 데스크톱 hover 빠른 동작(읽음·별표·삭제)은 기존 기능이므로 유지(시안에 없음).
 *
 * ref: { bulk(action), focusSearch() }
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref, type TouchEvent as RTouchEvent } from 'react'
import { useI18n } from '~/i18n'
// class 를 단순 연결(tailwind-merge 를 사용하는 cn 은 leading-[1.35]+text-xl 같은 조합을 제거함)
import { clsx as cx } from 'clsx'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useStore } from 'zustand'
import { useMail, mailStore, mailIsPop3, type MessageSummary } from '~/composables/useMail'
import { mailDraftsStore } from '~/composables/useMailCompose'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useIsMobile } from '~/composables/useIsMobile'
import { useUserPrefs } from '~/composables/useUserPrefs'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { parseMailQuery, serverQuery, filterMailRows, swipeAction, SWIPE_REVEAL, MAILBOX_ROLE_KEYS, formatMailDate } from '~/utils/mailQuery'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiMenu } from '~/components/ui/Menu'
import { UiChip } from '~/components/ui/Chip'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiFab } from '~/components/ui/Fab'
import { MailScheduledList } from '~/components/mail/MailScheduledList'

export type MailBulkAction = 'archive' | 'read' | 'unread' | 'delete' | 'spam'

export interface MailListHandle {
  /** 선택 항목(또는 지정한 id)에 일괄 동작 수행 */
  bulk: (action: MailBulkAction, ids?: string[]) => Promise<void>
  /** 검색 칸 포커스(단축키 /) */
  focusSearch: () => void
}

export interface MailListProps {
  /** 폴더 드로어 열기(≡ · 1024 미만) */
  onOpenFolders?: () => void
  /** { bulk, focusSearch } */
  ref?: Ref<MailListHandle | null>
}

// ─── 정렬·광고 숨기기(기존 기능 유지) ───
const AD_RE = /^\s*[([]\s*(광고|advertisement|ad)\s*[)\]]\s*/i

type Row = MessageSummary & { isAd: boolean; cleanSubject: string }
interface DraftRow { id: string; subject: string | null; to: { name: string | null; email: string }[]; body_text: string | null; updated_at: string }

/** 메일 목록(또는 예약함) */
export function MailList({ onOpenFolders, ref }: MailListProps) {
  const { t } = useI18n()
  const {
    messages, loadingMessages, listError, selectedMessage, currentPage, totalMessages, hasNextPage, hasPrevPage,
    nextPage, prevPage, limit, openMessage, toggleStar, toggleRead, deleteMessage, fetchMessages, refresh,
    selectedIds, setSelectedIds, toggleSelect, deselectAll, bulkAction, bulkOn, archiveMessages, archiveMailbox,
    mailboxes, selectedMailbox, selectedMailboxId, selectedAccountId, searchQuery, setSearchQuery, quickFilters, setQuickFilters, openCompose,
    applyFilters, labelFilter, setLabelFilter, scheduledView, mailboxesError, fetchMailboxes, isPop3,
  } = useMail()
  const isMobile = useIsMobile()
  const { density } = useUserPrefs()

  // ─── 폴더 이름·안 읽음 ───
  // 메일함을 아직 조회하지 못했거나 조회에 실패한 경우 모듈 이름 사용 — 상단바 3단에서는 위치를 비워 "메일 / 메일" 중복을 방지
  const folderLabel = !selectedMailbox
    ? t('nav.mail')
    : selectedMailbox.role && MAILBOX_ROLE_KEYS[selectedMailbox.role] ? t(MAILBOX_ROLE_KEYS[selectedMailbox.role]) : selectedMailbox.name
  const unreadCount = selectedMailbox?.unread_count ?? 0
  useBreadcrumb(scheduledView ? t('mail.scheduled.title') : selectedMailbox ? folderLabel : '')
  // 메일함 조회 실패 → 재시도(메일함 → 목록)
  async function retryMailboxes() {
    await fetchMailboxes()
    if (!mailStore.getState().mailboxesError) await fetchMessages()
  }

  // 조밀(데스크톱 전용, 터치는 셸이 차단) = 한 줄 40
  const oneLine = density === 'compact' && !isMobile

  // ─── 검색(커맨드 바) ───
  const [localSearch, setLocalSearch] = useState(searchQuery)
  const [fromFilter, setFromFilter] = useState('')
  const fromRef = useRef('')
  fromRef.current = fromFilter
  const [mobileSearch, setMobileSearch] = useState(false)
  // watch(searchQuery) — 값이 비면(폴더 전환 등) 입력도 초기화
  const firstQ = useRef(true)
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return }
    if (!searchQuery && !fromRef.current) setLocalSearch('')
  }, [searchQuery])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const localRef = useRef(localSearch)
  localRef.current = localSearch
  function onSearchInput(v: string) {
    setLocalSearch(v)
    localRef.current = v
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(applySearch, 300)
  }
  function applySearch() {
    const p = parseMailQuery(localRef.current)
    const qf = mailStore.getState().quickFilters
    if (p.unread || p.starred || p.attachment) {
      setQuickFilters({ unread: p.unread || qf.unread, starred: p.starred || qf.starred, attachment: p.attachment || qf.attachment })
    }
    setFromFilter(p.text ? p.from : '')
    const q = serverQuery(p)
    if (q !== mailStore.getState().searchQuery) setSearchQuery(q)
  }
  function clearSearch() {
    setLocalSearch('')
    localRef.current = ''
    setFromFilter('')
    fromRef.current = ''
    setSearchQuery('')
  }

  const [hideAds, setHideAds] = useState(false)
  const [sortBy, setSortBy] = useState<'date' | 'sender'>('date')
  useEffect(() => { try { setHideAds(localStorage.getItem('mail.hideAds') === '1') } catch { /* 비공개 창 */ } }, [])
  const firstAds = useRef(true)
  useEffect(() => {
    if (firstAds.current) { firstAds.current = false; return }
    try { localStorage.setItem('mail.hideAds', hideAds ? '1' : '0') } catch { /* 무시 */ }
  }, [hideAds])
  const sortItems = [
    { key: 'date', label: t('mail.list.sortRecent'), radio: true, checked: sortBy === 'date' },
    { key: 'sender', label: t('mail.list.sortSenderName'), radio: true, checked: sortBy === 'sender' },
    { key: 'ads', label: t('mail.list.hideAds'), checked: hideAds },
  ]
  function onSort(k: string) {
    if (k === 'ads') setHideAds(!hideAds)
    else setSortBy(k as 'date' | 'sender')
  }

  function senderName(m: { from_: readonly { name: string | null; email: string }[] }): string {
    const a = m.from_?.[0]
    return a ? (a.name || a.email) : t('mail.sender.none')
  }

  const rows = useMemo<Row[]>(() => messages.map((m) => {
    const s = m.subject || ''
    const isAd = AD_RE.test(s)
    return { ...m, isAd, cleanSubject: isAd ? s.replace(AD_RE, '') : s }
  }), [messages])
  const filtered = useMemo(() => {
    const base = hideAds ? rows.filter(r => !r.isAd) : rows
    return filterMailRows(base, quickFilters, fromFilter)
  }, [rows, hideAds, quickFilters, fromFilter])
  const sorted = useMemo(() => {
    if (sortBy !== 'sender') return filtered
    return [...filtered].sort((a, b) => {
      const c = senderName(a).localeCompare(senderName(b))
      return c !== 0 ? c : (b.received_at || '').localeCompare(a.received_at || '')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortBy])
  // 보낸 사람 순일 때만 연속된 동일 보낸 사람 3개 이상을 머리 행으로 접음(스레드 아님)
  const displayItems = useMemo<{ head?: string; count?: number; msg?: Row; grouped?: boolean }[]>(() => {
    const list = sorted
    if (sortBy !== 'sender') return list.map(msg => ({ msg }))
    const out: { head?: string; count?: number; msg?: Row; grouped?: boolean }[] = []
    let i = 0
    while (i < list.length) {
      const name = senderName(list[i])
      let run = 1
      while (i + run < list.length && senderName(list[i + run]) === name) run++
      const grouped = run >= 3
      if (grouped) out.push({ head: name, count: run })
      for (let k = 0; k < run; k++) out.push({ msg: list[i + k], grouped })
      i += run
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, sortBy])
  const filtersOn = quickFilters.unread || quickFilters.starred || quickFilters.attachment || !!fromFilter || !!labelFilter
  function clearFilters() {
    setQuickFilters({ unread: false, starred: false, attachment: false })
    setFromFilter('')
    fromRef.current = ''
    if (mailStore.getState().labelFilter) void setLabelFilter(null)
  }
  // 칩 선택 시 서버에서 재조회(동일 조합이면 applyFilters 가 생략)
  const firstQf = useRef(true)
  useEffect(() => {
    if (firstQf.current) { firstQf.current = false; return }
    void applyFilters()
  }, [quickFilters.unread, quickFilters.starred, quickFilters.attachment, applyFilters])
  // 폴더 변경 시 칩 해제(현재 폴더 범위)
  const firstMb = useRef(true)
  useEffect(() => {
    if (firstMb.current) { firstMb.current = false; return }
    clearFilters()
    setMobileSearch(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMailboxId])

  // ─── 선택 ───
  const hasSelection = selectedIds.size > 0
  const visibleIds = sorted.map(m => m.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
  const someSelected = hasSelection && !allSelected
  function setMaster(v: boolean) { setSelectedIds(v ? new Set(visibleIds) : new Set()) }
  const lastToggled = useRef<string | null>(null)
  /** Shift+클릭 범위 선택 — 체크박스는 label 내부 input 이므로 클릭 이벤트가 2회 발생한다. 누르는 시점의 Shift 상태만 기록한다 */
  const shiftHeld = useRef(false)
  function onCheck(id: string) {
    const shift = shiftHeld.current
    shiftHeld.current = false
    if (shift && lastToggled.current && lastToggled.current !== id) {
      const ids = visibleIds
      const a = ids.indexOf(lastToggled.current), b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const s = new Set(mailStore.getState().selectedIds)
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) s.add(x)
        setSelectedIds(s)
        lastToggled.current = id
        return
      }
    }
    toggleSelect(id)
    lastToggled.current = id
  }

  async function bulk(action: MailBulkAction, ids = Array.from(mailStore.getState().selectedIds)) {
    if (!ids.length) return
    // POP3 는 서버 폴더가 없음 — 버튼은 숨김 처리했으며, 단축키(E)·스와이프로 진입해도 no-op
    if ((action === 'archive' || action === 'spam') && mailIsPop3()) return
    if (action === 'archive') {
      if (!mailStore.getState().mailboxes.find(m => m.role === 'archive')) { addToast('warning', t('mail.list.noArchive')); return }
      const ok = await archiveMessages(ids)
      addToast(ok ? 'success' : 'error', ok ? t('mail.list.archived', { n: ids.length }) : t('mail.list.archiveFailed'))
      return
    }
    if (action === 'delete' && ids.length > 1 && !await confirmBox(t('mail.list.deleteConfirm', { n: ids.length }), { title: t('mail.list.deleteTitle'), confirmLabel: t('common.delete'), danger: true })) return
    const ok = await bulkOn(ids, action)
    if (!ok) addToast('error', t('mail.list.actionFailed'))
    else if (action === 'delete') addToast('info', t('mail.list.trashed', { n: ids.length }))
  }
  const moveItems = mailboxes
    .filter(m => m.id !== selectedMailboxId)
    .map(m => ({ key: m.id, label: m.role && MAILBOX_ROLE_KEYS[m.role] ? t(MAILBOX_ROLE_KEYS[m.role]) : m.name, icon: 'folder' }))
  async function moveTo(id: string) {
    const n = mailStore.getState().selectedIds.size
    if (await bulkAction('move', id)) addToast('success', t('mail.list.moved', { n }))
    else addToast('error', t('mail.list.moveFailed'))
  }

  // ─── 열기 ───
  function open(id: string) {
    if (isMobile) {
      if (mailStore.getState().selectedIds.size > 0) { toggleSelect(id); return }
      const q = new URLSearchParams()
      if (selectedMailboxId) q.set('mailbox', selectedMailboxId)
      if (selectedAccountId) q.set('account', selectedAccountId)
      void navigateTo(`/mail/${encodeURIComponent(id)}?${q.toString()}`)
      return
    }
    void openMessage(id)
  }

  // hover 빠른 동작(데스크톱)
  async function quickDelete(id: string) {
    if (await deleteMessage(id)) addToast('info', t('mail.list.trashedOne'))
    else addToast('error', t('mail.list.actionFailed'))
  }
  // 읽음·별표 전환 실패 시 안내(기존에는 무반응)
  async function flip(run: Promise<boolean>) {
    if (!await run) addToast('error', t('mail.list.actionFailed'))
  }

  // ─── 모바일 스와이프 · 길게 누르기 ───
  // 처리기는 swipeRef 로 판정하고, 화면(행 위치·노출된 칸)은 swipe 상태로 렌더링
  const swipeRef = useRef({ id: '', x0: 0, y0: 0, dx: 0, axis: '' as '' | 'x' | 'y' })
  const [swipe, setSwipe] = useState({ id: '', dx: 0 })
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressClick = useRef(false)
  function onTouchStart(e: RTouchEvent, id: string) {
    const p = e.touches[0]
    swipeRef.current = { id, x0: p.clientX, y0: p.clientY, dx: 0, axis: '' }
    setSwipe({ id, dx: 0 })
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      if (swipeRef.current.axis) return
      suppressClick.current = true
      if (!mailStore.getState().selectedIds.has(id)) toggleSelect(id)
      try { navigator.vibrate?.(15) } catch { /* 미지원 */ }
    }, 500)
  }
  function onTouchMove(e: RTouchEvent) {
    const sw = swipeRef.current
    const p = e.touches[0]
    const dx = p.clientX - sw.x0, dy = p.clientY - sw.y0
    if (!sw.axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      sw.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
    }
    // 선택 모드에서는 스와이프 동작 비활성화
    if (sw.axis === 'x' && mailStore.getState().selectedIds.size === 0) {
      // POP3 는 보관(왼쪽으로 밀기) 미지원 — 행이 왼쪽으로 이동하지 않도록 차단
      sw.dx = Math.max(mailIsPop3() ? 0 : -SWIPE_REVEAL * 1.4, Math.min(SWIPE_REVEAL * 1.4, dx))
      setSwipe({ id: sw.id, dx: sw.dx })
    }
  }
  async function onTouchEnd(m: Row) {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
    const sw = swipeRef.current
    const act = sw.axis === 'x' ? swipeAction(sw.dx) : null
    if (sw.axis === 'x') suppressClick.current = true
    sw.dx = 0
    sw.id = ''
    setSwipe({ id: '', dx: 0 })
    if (act === 'archive') await bulk('archive', [m.id])
    else if (act === 'toggle-read') await flip(toggleRead(m.id))
  }
  function onTouchCancel() { swipeRef.current.dx = 0; swipeRef.current.id = ''; setSwipe({ id: '', dx: 0 }) }
  function onRowClick(id: string) {
    if (suppressClick.current) { suppressClick.current = false; return }
    open(id)
  }

  // ─── 임시보관함: 본 앱에서 작성 중 닫은 초안(DB) — 기존에는 목록 UI 가 없어 닫은 후 조회 수단이 없었음 ───
  const [appDrafts, setAppDrafts] = useState<DraftRow[]>([])
  const role = selectedMailbox?.role
  // 작성기가 초안을 저장·삭제·발송하면 재조회
  const draftsRev = useStore(mailDraftsStore, s => s.rev)
  useEffect(() => {
    let alive = true
    void (async () => {
      if (role !== 'drafts') { setAppDrafts([]); return }
      try { const d = await $fetch<DraftRow[]>('/api/mail/drafts'); if (alive) setAppDrafts(d) } catch { if (alive) setAppDrafts([]) }
    })()
    return () => { alive = false }
  }, [role, draftsRev])

  // ─── 페이지 표시 1–50 / 1,284 ───
  const rangeStart = totalMessages === 0 ? 0 : currentPage * limit + 1
  const rangeEnd = Math.min((currentPage + 1) * limit, totalMessages)

  useImperativeHandle(ref, () => ({ bulk, focusSearch: () => document.getElementById('mail-search')?.focus() }))

  if (scheduledView) return <MailScheduledList onOpenFolders={onOpenFolders} />

  const iconSize = isMobile ? 'lg' : 'sm'

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 모바일 상단 56 (선택 모드가 아닐 때) */}
      {!hasSelection && (
        <header className="flex h-14 shrink-0 items-center border-b border-border px-1 md:hidden">
          <UiIconButton label={t('mail.list.foldersSwipe')} icon="menu" size="lg" className="text-foreground" onClick={() => onOpenFolders?.()} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold">{folderLabel}</h1>
            <p className="text-xs text-muted-foreground">{`${t('mail.list.unread')} `}<span className="font-mono">{unreadCount}</span></p>
          </div>
          <UiIconButton label={t('common.search')} icon="search" size="lg" pressed={mobileSearch} onClick={() => setMobileSearch(!mobileSearch)} />
        </header>
      )}

      {/* 위 줄 44: 선택 바 / 검색 */}
      {hasSelection
        ? (
          <div
            role="toolbar"
            aria-label={t('mail.list.selectedToolbar')}
            className="flex h-14 shrink-0 items-center gap-1 border-b border-primary/35 bg-primary/10 pl-2.5 pr-1.5 text-[13px] md:h-11"
          >
            <UiCheckbox modelValue={allSelected} onUpdateModelValue={setMaster} indeterminate={someSelected} ariaLabel={t('mail.list.selectAll')} className="-my-1" />
            <b className="mx-2 font-semibold">{t('mail.list.selectedCount', { n: selectedIds.size })}</b>
            <span className="flex-1" />
            {!isPop3 && <UiIconButton label={archiveMailbox ? t('mail.list.archiveKey') : t('mail.list.archiveKeyNone')} disabled={!archiveMailbox} size={iconSize} onClick={() => bulk('archive')}><UiIcon name="archive" /></UiIconButton>}
            <UiIconButton label={t('mail.list.markRead')} size={iconSize} onClick={() => bulk('read')}><UiIcon name="mail-read" /></UiIconButton>
            {!isPop3 && <UiMenu
              label={t('common.move')}
              items={moveItems}
              width={200}
              onSelect={moveTo}
              trigger={({ toggle, open: o, controls }) => (
                <UiIconButton label={t('common.move')} size={iconSize} aria-haspopup="menu" aria-expanded={o} aria-controls={controls} onClick={toggle}><UiIcon name="folder" /></UiIconButton>
              )}
            />}
            <UiIconButton label={t('mail.list.deleteKey')} size={iconSize} className="text-danger hover:text-danger" onClick={() => bulk('delete')}><UiIcon name="trash" /></UiIconButton>
            <UiIconButton label={t('mail.list.deselectKey')} icon="close" size={iconSize} onClick={deselectAll} />
          </div>
        )
        : (
          <div
            className={cx('h-11 shrink-0 items-center gap-2 border-b border-border bg-card pl-2.5 pr-2', mobileSearch ? 'flex' : 'hidden md:flex')}
          >
            <UiIconButton label={t('mail.list.folders')} icon="menu" className="hidden md:inline-flex lg:hidden" onClick={() => onOpenFolders?.()} />
            <UiCheckbox modelValue={allSelected} onUpdateModelValue={setMaster} ariaLabel={t('mail.list.selectAll')} className="-my-1 hidden md:inline-flex" />
            <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs focus-within:ring-2 focus-within:ring-ring">
              <UiIcon name="search" className="h-[13px] w-[13px] shrink-0 text-muted-foreground" />
              <span className="sr-only">{t('mail.list.searchIn', { folder: folderLabel })}</span>
              <input
                id="mail-search"
                value={localSearch}
                onChange={e => onSearchInput(e.target.value)}
                type="search"
                autoComplete="off"
                placeholder={t('mail.list.searchPlaceholder', { folder: folderLabel })}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-hidden placeholder:text-xs placeholder:text-muted-foreground md:text-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); applySearch() }
                  else if (e.key === 'Escape') { e.stopPropagation(); clearSearch(); e.currentTarget.blur() }
                }}
              />
              {localSearch && (
                <button type="button" aria-label={t('mail.list.clearQuery')} className="relative grid h-5 w-5 place-items-center text-muted-foreground hover:text-foreground before:absolute before:-inset-2.5 before:content-['']" onClick={clearSearch}>
                  <UiIcon name="close" className="h-3 w-3" />
                </button>
              )}
            </label>
            <UiIconButton label={t('common.refresh')} icon="refresh" className="hidden md:inline-flex" onClick={refresh} />
          </div>
        )}

      {/* 빠른 칩 + 정렬 */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap px-4 py-2 md:h-11 md:border-b md:border-border md:px-2.5 md:py-0">
        <UiChip modelValue={quickFilters.unread} onUpdateModelValue={v => setQuickFilters({ ...mailStore.getState().quickFilters, unread: v })} label={t('mail.list.unread')} count={isMobile ? undefined : unreadCount} size={isMobile ? 'lg' : 'sm'} />
        <UiChip modelValue={quickFilters.starred} onUpdateModelValue={v => setQuickFilters({ ...mailStore.getState().quickFilters, starred: v })} label={t('mail.message.star')} size={isMobile ? 'lg' : 'sm'} />
        <UiChip modelValue={quickFilters.attachment} onUpdateModelValue={v => setQuickFilters({ ...mailStore.getState().quickFilters, attachment: v })} label={t('mail.compose.attach')} size={isMobile ? 'lg' : 'sm'} />
        {labelFilter && <UiChip modelValue label={labelFilter} size={isMobile ? 'lg' : 'sm'} onUpdateModelValue={() => setLabelFilter(null)} />}
        <span className="flex-1" />
        <UiMenu
          label={t('mail.list.sort')}
          items={sortItems}
          width={180}
          className="hidden md:inline-flex"
          onSelect={onSort}
          trigger={({ toggle, open: o, controls }) => (
            <button type="button" aria-haspopup="menu" aria-expanded={o} aria-controls={controls} className="inline-flex h-8 items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={toggle}>
              {sortBy === 'sender' ? t('mail.list.sortSenderName') : t('mail.list.sortRecent')}
              <UiIcon name="chevron-down" className="h-3 w-3" />
            </button>
          )}
        />
      </div>

      {/* 본문: 로딩 · 오류 · 빈 상태 · 목록 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="region" aria-label={t('mail.list.regionLabel', { folder: folderLabel })}>
        {/* 본 앱에서 작성 중 닫은 초안 */}
        {appDrafts.length > 0 && (
          <section aria-label={t('mail.list.appDrafts')}>
            <div className="border-b border-border bg-muted/40 px-3 py-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">{`${t('mail.list.appDraftsHead')} `}<span className="font-mono">{appDrafts.length}</span></div>
            {appDrafts.map(d => (
              <button
                key={d.id}
                type="button"
                className="flex w-full min-h-row-2 flex-col justify-center gap-0.5 border-b border-border px-3 py-2 text-left hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-hidden"
                onClick={() => openCompose('draft', null, d.id)}
              >
                <span className="flex items-baseline gap-1.5 text-[13.5px]">
                  <span className="truncate text-danger">{t('mail.list.draftTag')}</span>
                  <span className="truncate text-muted-foreground">{d.to.map(a => a.name || a.email).join(', ') || t('mail.list.noRecipients')}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-[11px] text-muted-foreground">{formatMailDate(d.updated_at)}</span>
                </span>
                <span className="truncate text-[13px] text-foreground/80">{d.subject || t('mail.subject.none')}</span>
              </button>
            ))}
          </section>
        )}

        {mailboxesError && !scheduledView
          ? (
            <div className="p-4">
              <UiErrorTile placement="panel" title={t('mail.list.mailboxesFailed')} detail={mailboxesError} onRetry={retryMailboxes} />
            </div>
          )
          : loadingMessages && !messages.length
            ? <UiSkeleton preset="list" rows={8} />
            : listError
              ? (
                <div className="p-4">
                  <UiErrorTile placement="panel" title={t('mail.list.loadFailed')} detail={listError} onRetry={fetchMessages} />
                </div>
              )
              : !messages.length && !appDrafts.length && !filtersOn
                ? (
                  <UiEmptyState
                    variant="panel"
                    icon="inbox"
                    title={searchQuery ? t('mail.list.noResults') : t('mail.empty')}
                    actionLabel={searchQuery ? t('mail.list.clearSearch') : undefined}
                    className="py-10"
                    onAction={clearSearch}
                  />
                )
                : !sorted.length && (filtersOn || messages.length)
                  ? (
                    <UiEmptyState
                      variant="panel"
                      icon="filter"
                      title={t('mail.list.noMatchTitle')}
                      description={t('mail.list.noMatchDesc')}
                      actionLabel={t('mail.list.clearChips')}
                      className="py-10"
                      onAction={clearFilters}
                    />
                  )
                  : (
                    <div role="list" aria-busy={loadingMessages}>
                      {displayItems.map((item, index) => {
                        // 보낸 사람 묶음 머리(보낸 사람 순 + 연속 3개 이상)
                        if (item.head) {
                          return (
                            <div key={`h${index}`} className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1 text-[11px] font-semibold text-muted-foreground">
                              <span className="min-w-0 truncate">{item.head}</span>
                              <span className="shrink-0 font-mono">{`· ${item.count}`}</span>
                            </div>
                          )
                        }
                        const m = item.msg!
                        const swiping = swipe.id === m.id && swipe.dx !== 0
                        const threadCount = m.thread_count ?? 0
                        return (
                          <div key={m.id} role="listitem" className="relative overflow-hidden border-b border-border">
                            {/* 스와이프로 노출되는 동작 칸(모바일) */}
                            {swiping && (
                              <div className="absolute inset-0 flex md:hidden" aria-hidden="true">
                                {swipe.dx > 0 && (
                                  <span className="flex w-24 flex-col items-center justify-center gap-0.5 bg-primary text-xs font-semibold text-primary-foreground">
                                    <UiIcon name={m.is_unread ? 'mail-read' : 'mail-unread'} strokeWidth="2.2" className="h-[18px] w-[18px]" />{m.is_unread ? t('mail.bulk.read') : t('mail.list.unread')}
                                  </span>
                                )}
                                <span className="flex-1" />
                                {swipe.dx < 0 && (
                                  <span className="flex w-24 flex-col items-center justify-center gap-0.5 bg-success text-xs font-semibold text-background">
                                    <UiIcon name="archive" strokeWidth="2.2" className="h-[18px] w-[18px]" />{t('mail.list.archive')}
                                  </span>
                                )}
                              </div>
                            )}

                            <div
                              className={cx(
                                'group relative isolate flex touch-pan-y gap-2.5 bg-background transition-transform',
                                oneLine ? 'h-row items-center px-3 md:pl-2.5' : 'px-4 py-3 md:min-h-row-2 md:py-[9px] md:pl-2.5 md:pr-3',
                                swiping ? 'duration-0' : 'duration-150',
                                item.grouped ? 'md:pl-6' : '',
                              )}
                              style={swipe.id === m.id && swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined}
                              onTouchStart={e => onTouchStart(e, m.id)}
                              onTouchMove={onTouchMove}
                              onTouchEnd={() => onTouchEnd(m)}
                              onTouchCancel={onTouchCancel}
                            >
                              {/* 선택·열림 바탕 */}
                              {selectedIds.has(m.id)
                                ? <span className="absolute inset-0 -z-10 bg-primary/[0.13]" aria-hidden="true" />
                                : selectedMessage?.id === m.id
                                  ? <span className="absolute inset-0 -z-10 bg-accent/50 shadow-[inset_3px_0_0_hsl(var(--primary))]" aria-hidden="true" />
                                  : <span className="absolute inset-0 -z-10 group-hover:bg-accent/30" aria-hidden="true" />}

                              {/* 거터 체크박스(데스크톱 상시, 모바일은 선택 모드에서만) */}
                              <UiCheckbox
                                modelValue={selectedIds.has(m.id)}
                                ariaLabel={t('mail.list.selectRow', { sender: senderName(m), subject: m.cleanSubject || t('mail.subject.none') })}
                                className={cx('relative z-10 shrink-0 self-start', hasSelection ? 'inline-flex' : 'hidden md:inline-flex', oneLine ? 'self-center' : '-my-[9px] md:-mt-[9px]')}
                                onPointerDown={(e) => { shiftHeld.current = e.shiftKey }}
                                onUpdateModelValue={() => onCheck(m.id)}
                              />

                              {/* 행 본문 = 버튼(행 전체가 클릭 영역) */}
                              <button
                                type="button"
                                className="min-w-0 flex-1 text-left outline-hidden after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                                aria-current={selectedMessage?.id === m.id ? 'true' : undefined}
                                onClick={() => onRowClick(m.id)}
                              >
                                {oneLine
                                  ? (
                                    // 한 줄(조밀 40)
                                    <span className="flex min-w-0 items-baseline gap-2.5 text-[13px]">
                                      <span className={cx('w-36 shrink-0 truncate', m.is_unread ? 'font-bold' : 'text-muted-foreground')}>{senderName(m)}{threadCount > 1 && <span className="ml-1.5 font-mono text-[11px]" aria-label={t('mail.thread.countLabel', { n: m.thread_count })}>{m.thread_count}</span>}</span>
                                      <span className={cx('min-w-0 flex-1 truncate', m.is_unread ? 'font-semibold' : 'text-foreground/80')}>
                                        {m.isAd && <UiBadge tone="neutral" tint size={18} className="mr-1">{t('mail.badge.ad')}</UiBadge>}{m.cleanSubject || t('mail.subject.none')}
                                      </span>
                                      <span className={cx('shrink-0 font-mono text-[11px]', m.is_unread ? 'font-semibold' : 'text-muted-foreground')}>{formatMailDate(m.received_at)}</span>
                                    </span>
                                  )
                                  : (
                                    // 두 줄(기본 56) · 모바일 세 줄
                                    <>
                                      <span className={cx('flex min-w-0 items-baseline gap-1.5 text-[15px] md:text-[13.5px]', m.is_unread ? '' : 'text-muted-foreground')}>
                                        {!item.grouped && <span className={cx('truncate', m.is_unread ? 'font-bold' : '')}>{senderName(m)}</span>}
                                        {threadCount > 1 && <span className={cx('shrink-0 font-mono text-[11px]', m.is_unread ? 'font-semibold' : '')} aria-label={t('mail.thread.countLabel', { n: m.thread_count })}>{m.thread_count}</span>}
                                        <span className="flex-1" />
                                        <span className={cx('shrink-0 font-mono text-xs md:text-[11px]', m.is_unread ? 'font-semibold' : '')}>{formatMailDate(m.received_at)}</span>
                                      </span>
                                      <span className={cx('flex min-w-0 items-center gap-1.5 text-sm md:text-[13px]', m.is_unread ? 'font-semibold' : 'md:text-foreground/80')}>
                                        {m.isAd && <UiBadge tone="neutral" tint size={18} className="shrink-0">{t('mail.badge.ad')}</UiBadge>}
                                        <span className="truncate">{m.cleanSubject || t('mail.subject.none')}</span>
                                      </span>
                                      {m.preview && <span className="block truncate text-[13px] text-muted-foreground md:hidden">{m.preview}</span>}
                                    </>
                                  )}
                              </button>

                              {/* 오른쪽 16: 별표·첨부 */}
                              <span className={cx('flex w-4 shrink-0 flex-col items-center gap-1 text-muted-foreground', oneLine ? 'flex-row self-center' : 'pt-0.5')}>
                                {m.is_flagged && <UiIcon name="star" filled aria-label={t('mail.message.star')} className="h-3.5 w-3.5 text-warning" strokeWidth={1.5} />}
                                {m.has_attachment && <UiIcon name="paperclip" aria-label={t('mail.list.hasAttachment')} className="h-3.5 w-3.5" />}
                              </span>

                              {/* hover 빠른 동작(데스크톱, 기존 기능) */}
                              <div className="absolute right-2 top-1.5 z-10 hidden items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-md md:group-hover:flex md:group-focus-within:flex">
                                <UiIconButton label={m.is_unread ? t('mail.bulk.markRead') : t('mail.bulk.markUnread')} className="h-7 w-7" onClick={(e) => { e.stopPropagation(); void flip(toggleRead(m.id)) }}><UiIcon name={m.is_unread ? 'mail-read' : 'mail-unread'} /></UiIconButton>
                                <UiIconButton label={m.is_flagged ? t('mail.message.unstar') : t('mail.message.star')} pressed={m.is_flagged} className={cx('h-7 w-7', m.is_flagged ? 'text-warning hover:text-warning' : '')} onClick={(e) => { e.stopPropagation(); void flip(toggleStar(m.id)) }}><UiIcon name="star" filled={m.is_flagged} /></UiIconButton>
                                <UiIconButton label={t('common.delete')} className="h-7 w-7 text-danger hover:text-danger" onClick={(e) => { e.stopPropagation(); void quickDelete(m.id) }}><UiIcon name="trash" /></UiIconButton>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
      </div>

      {/* 페이지 36 */}
      {totalMessages > 0 && (
        <div className="hidden h-9 shrink-0 items-center border-t border-border pl-3 pr-1 font-mono text-[11px] text-muted-foreground md:flex">
          {`${rangeStart}–${rangeEnd} / ${totalMessages.toLocaleString()}`}
          <span className="flex-1" />
          <UiIconButton label={t('common.prev')} icon="chevron-left" disabled={!hasPrevPage} className="h-7 w-7" onClick={prevPage} />
          <UiIconButton label={t('common.next')} icon="chevron-right" disabled={!hasNextPage} className="h-7 w-7" onClick={nextPage} />
        </div>
      )}
      {/* 모바일: 더 보기 */}
      {(hasNextPage || hasPrevPage) && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-2 pb-20 pt-1 md:hidden">
          <UiButton variant="ghost" size="sm" disabled={!hasPrevPage} onClick={prevPage}>{t('common.prev')}</UiButton>
          <span className="font-mono text-xs text-muted-foreground">{`${rangeStart}–${rangeEnd} / ${totalMessages.toLocaleString()}`}</span>
          <UiButton variant="ghost" size="sm" disabled={!hasNextPage} onClick={nextPage}>{t('common.next')}</UiButton>
        </div>
      )}

      {/* FAB "새 메일"(56 · 좌우 20 · 16 둥글기 · 펜 아이콘 + 글자). 목록 판 내부 오른쪽 아래.
          1024 미만은 사이드바가 드로어여서 "새 메일" 버튼이 보이지 않으므로 태블릿(768~1023)까지 표시한다. */}
      {!hasSelection && <UiFab label={t('mail.compose.new')} icon="pen" extended contained until="lg" onClick={() => openCompose('new')} />}
    </div>
  )
}

export default MailList
