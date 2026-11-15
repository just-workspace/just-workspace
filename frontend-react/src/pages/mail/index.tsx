/**
 * 메일.
 * 데스크톱: 사이드바 236 | 목록 clamp(320, 본문 폭 × 24%, 440) | 읽기 판(끝까지, 본문 760 가운데) | 보낸 사람 360(상세 칸 ≥ 1400 일 때만 펼친 채)
 *   자리가 없으면 읽기 머리의 보낸 사람(아바타+이름)을 눌러 같은 패널을 오버레이로 연다 — Esc·바깥 클릭으로 닫힘.
 *   + 오른쪽 아래 떠 있는 작성 창들(앱 루트 MailComposeHost). 세로 화면(실효 높이 > 폭): 목록 위 42% / 본문 아래로 쌓는다.
 * 1024 미만: 사이드바는 드로어(≡ 또는 왼쪽 가장자리 스와이프). 모바일: 목록만, 본문은 /mail/:id 로 푸시.
 * 단축키(데스크톱): C 새 메일 · / 검색 · J/K 다음/이전 · R/A/F 답장/전체/전달 · E 보관 · Del(#) 삭제 · U 안 읽음 · S 별표 · X 선택 · Esc 선택 해제/닫기.
 */
import { useEffect, useRef, useState, type TouchEvent as RTouchEvent } from 'react'
import { useI18n } from '~/i18n'
// class 를 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지운다)
import { clsx as cx } from 'clsx'
import { useHead } from '~/lib/head'
import { useRoute, navigateTo, queryString } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useStore } from 'zustand'
import { useMail, mailStore, mailIsPop3 } from '~/composables/useMail'
import { useViewport, useElementWidth } from '~/composables/useViewport'
import { listColumnWidth, mailSideOpen } from '~/lib/fluid'
import { MailSenderPanel } from '~/components/mail/MailSenderPanel'
import { openComposeFromQuery } from '~/composables/useMailCompose'
import { useDesktopShell } from '~/composables/useDesktopShell'
import { useIsMobile, isMobileNow } from '~/composables/useIsMobile'
import { useOwnMobileHeader } from '~/composables/useOwnMobileHeader'
import { usePageShortcuts } from '~/composables/useShortcuts'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { MailSidebar } from '~/components/mail/MailSidebar'
import { MailList, type MailListHandle } from '~/components/mail/MailList'
import { MailReader, type MailReaderHandle } from '~/components/mail/MailReader'

function typing(el: EventTarget | null) {
  const e = el as HTMLElement | null
  if (!e) return false
  // 체크박스·라디오·버튼형 input 은 글자를 받지 않는다 — 입력 중으로 보면 메일을 체크한 직후(포커스가 체크박스에 남는다)
  // Del·E·U·Esc 가 먹지 않는다.
  if (e.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'submit', 'reset'].includes((e as HTMLInputElement).type)) return false
  return e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)
}

export default function MailPage() {
  const { t } = useI18n()
  const { appName, demoMode } = useSiteConfig()
  useHead({ title: `${t('nav.mail')} | ${appName}` })

  const {
    accounts, accountsError, fetchAccounts, fetchMailboxes, fetchMessages, selectAccountMailbox, fetchMailboxesFor,
    openMessage, openAdjacent, clearSelectedMessage, toggleSelect, deselectAll, openCompose, isPop3,
  } = useMail()

  // 데스크톱 셸(Electron)이 폴더 열을 그리면 여기서는 렌더하지 않는다.
  const { navOwnedByShell } = useDesktopShell()
  const isMobile = useIsMobile()
  // 계정을 다 받기 전엔 온보딩(계정 없음)을 그리지 않는다 — 깜빡임·오인 방지
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  // 모바일 머리: 목록 화면은 MailList 의 폴더 머리가 대신한다. 온보딩·오류 화면은 공용 상단바("메일")
  useOwnMobileHeader(!demoMode && accountsLoaded && !accountsError && accounts.length > 0)

  const [showDrawer, setShowDrawer] = useState(false)
  // 유동 폭: 본문 폭(셸 레일 뒤) → 목록 열, 본문 − 폴더 열 236 − 목록 = 상세 칸 → 보낸 사람 패널.
  // (패널이 상세 칸을 줄여도 다시 접히지 않게 패널을 빼기 전 폭으로 판단한다. 1024 미만은 폴더가 서랍이지만 그땐 1400 이 안 나온다)
  const { width: vw, portrait } = useViewport()
  const [measureMain, mainWidth] = useElementWidth<HTMLDivElement>(vw - 64)
  const listW = listColumnWidth(mainWidth, portrait)
  const selectedMessage = useStore(mailStore, s => s.selectedMessage)
  const paneW = mainWidth - (navOwnedByShell ? 0 : 236) - listW
  const showSide = !isMobile && !!selectedMessage && mailSideOpen(paneW, portrait)
  // 보낸 사람 오버레이(자리가 없을 때만). 펼친 채가 되거나 메일을 닫으면 저절로 내려간다.
  const [senderOverlay, setSenderOverlay] = useState(false)
  const senderOverlayOpen = senderOverlay && !isMobile && !showSide && !!selectedMessage
  const senderOverlayRef = useRef(false)
  senderOverlayRef.current = senderOverlayOpen
  const senderPanelBox = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (!selectedMessage || showSide) setSenderOverlay(false) }, [selectedMessage, showSide])
  // 바깥 클릭으로 닫기 — 보낸 사람 버튼(토글)과 패널 안쪽은 빼고
  useEffect(() => {
    if (!senderOverlayOpen) return
    const h = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (!el || senderPanelBox.current?.contains(el) || el.closest?.('[data-sender-trigger]')) return
      setSenderOverlay(false)
    }
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [senderOverlayOpen])
  const listRef = useRef<MailListHandle | null>(null)
  const readerRef = useRef<MailReaderHandle | null>(null)

  const route = useRoute()
  const routeRef = useRef(route)
  routeRef.current = route

  /** 셸이 고른 폴더(`?account=&mailbox=`)로 맞춘다. 읽지 않으면 어느 폴더를 눌러도 받은편지함만 보인다. */
  async function applyShellScope() {
    const q = routeRef.current.query
    const mailbox = queryString(q.mailbox)
    if (!mailbox) return
    const account = queryString(q.account) ?? mailStore.getState().accounts[0]?.id
    if (!account) return
    await fetchMailboxesFor(account)
    await selectAccountMailbox(account, mailbox)
  }

  /** `?compose=…`(메일 밖·/mail/compose 에서 넘어온 쓰기) · `?open=id`(데스크톱에서 /mail/:id 로 들어온 경우) */
  async function consumeQuery() {
    const q = { ...routeRef.current.query }
    let changed = false
    if (typeof q.compose === 'string') { openComposeFromQuery(q.compose); delete q.compose; changed = true }
    if (typeof q.open === 'string') { await openMessage(q.open); delete q.open; changed = true }
    if (changed) void navigateTo({ query: q }, { replace: true })
  }

  async function loadAll() {
    await fetchAccounts()
    setAccountsLoaded(true)
    // 계정(자체메일 포함)이 하나도 없으면 온보딩만 — mailboxes 호출 안 함(404 방지). 계정 목록 실패는 오류 타일.
    const s = mailStore.getState()
    if (!s.accountsError && s.accounts.length > 0) {
      await fetchMailboxes()
      if (routeRef.current.query.mailbox) await applyShellScope()
      else await fetchMessages()
      await consumeQuery()
    } else if (!s.accountsError && typeof routeRef.current.query.compose === 'string') {
      // 계정이 없어도 ?compose 는 처리한다 — 예전엔 조용히 버려 창이 안 떴다. 작성 창이 "계정 연결" 안내를 그린다.
      await consumeQuery()
    }
  }

  // ─── 단축키 ───
  function onKeydown(e: KeyboardEvent) {
    if (isMobileNow() || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return
    if (document.querySelector('[aria-modal="true"]')) return
    const k = e.key
    const s = mailStore.getState()
    const sel = s.selectedIds.size > 0
    const selectedMessage = s.selectedMessage
    const run = (fn: () => unknown) => { e.preventDefault(); fn() }
    switch (k) {
      case 'c': return run(() => openCompose('new'))
      case '/': return run(() => listRef.current?.focusSearch())
      case 'j': return run(() => openAdjacent(1))
      case 'k': return run(() => openAdjacent(-1))
      case 'r': return selectedMessage ? run(() => readerRef.current?.reply(false)) : undefined
      case 'a': return selectedMessage ? run(() => readerRef.current?.reply(true)) : undefined
      case 'f': return selectedMessage ? run(() => readerRef.current?.forward()) : undefined
      case 's': return selectedMessage ? run(() => readerRef.current?.star()) : undefined
      case 'x': return selectedMessage ? run(() => toggleSelect(selectedMessage.id)) : undefined
      // POP3 는 보관함이 없다 — 키를 먹지 않고 그대로 둔다
      case 'e': return mailIsPop3(s) ? undefined : run(() => (sel ? listRef.current?.bulk('archive') : readerRef.current?.archive()))
      case 'u': return run(() => (sel ? listRef.current?.bulk('unread') : readerRef.current?.markUnread()))
      case 'Delete':
      case '#': return run(() => (sel ? listRef.current?.bulk('delete') : readerRef.current?.remove()))
      case 'Escape':
        if (senderOverlayRef.current) return run(() => setSenderOverlay(false))
        if (sel) return run(deselectAll)
        if (selectedMessage) return run(clearSelectedMessage)
    }
  }
  const keyRef = useRef(onKeydown)
  keyRef.current = onKeydown

  useEffect(() => {
    if (demoMode) return
    // 모바일 목록에서는 본문이 따로(/mail/:id) — 전에 열어 둔 메일을 비운다
    if (isMobileNow()) clearSelectedMessage()
    const h = (e: KeyboardEvent) => keyRef.current(e)
    document.addEventListener('keydown', h)
    void loadAll()
    return () => document.removeEventListener('keydown', h)
    // 마운트 때 한 번(demoMode 는 그 시점 값)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 셸이 같은 페이지 안에서 폴더만 바꿀 수도 있다.
  const qAccount = queryString(route.query.account)
  const qMailbox = queryString(route.query.mailbox)
  const firstScope = useRef(true)
  useEffect(() => {
    if (firstScope.current) { firstScope.current = false; return }
    if (routeRef.current.query.mailbox) void applyShellScope()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qAccount, qMailbox])
  const qCompose = route.query.compose
  const firstCompose = useRef(true)
  useEffect(() => {
    if (firstCompose.current) { firstCompose.current = false; return }
    if (typeof qCompose === 'string') void consumeQuery()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qCompose])

  // 도움말(Ctrl /)에 메일 묶음 등록 — 키 처리는 위 onKeydown(데스크톱만)
  usePageShortcuts(t('nav.mail'), isMobile ? [] : [
    { keys: ['C'], label: t('mail.compose.new') },
    { keys: ['/'], label: t('mail.shortcuts.search') },
    { keys: ['J'], label: t('mail.shortcuts.next') },
    { keys: ['K'], label: t('mail.shortcuts.prev') },
    { keys: ['R'], label: t('mail.compose.reply') },
    { keys: ['A'], label: t('mail.compose.replyAll') },
    { keys: ['F'], label: t('mail.compose.forward') },
    ...(isPop3 ? [] : [{ keys: ['E'], label: t('mail.list.archive') }]),
    { keys: ['Del'], label: t('mail.shortcuts.delete') },
    { keys: ['U'], label: t('mail.shortcuts.unread') },
    { keys: ['S'], label: t('mail.message.star') },
    { keys: ['X'], label: t('mail.shortcuts.select') },
    { keys: ['Esc'], label: t('mail.shortcuts.escape') },
  ])

  // ─── 왼쪽 가장자리 스와이프 = 폴더 드로어("스와이프로도 열림") ───
  const edgeX = useRef<number | null>(null)
  function onEdgeStart(e: RTouchEvent) { const x = e.touches[0].clientX; edgeX.current = x < 24 ? x : null }
  function onEdgeMove(e: RTouchEvent) {
    if (edgeX.current === null) return
    if (e.touches[0].clientX - edgeX.current > 60) { setShowDrawer(true); edgeX.current = null }
  }

  // Demo mode placeholder
  if (demoMode) {
    return (
      <div className="flex h-full flex-col">
        <UiEmptyState title={t('nav.mail')} description={t('demo.mailDescription')} />
      </div>
    )
  }
  // 계정 목록을 못 받음 — 빈 상태(온보딩)로 보이면 안 된다
  if (accountsError) {
    return (
      <div className="flex h-full flex-col">
        <UiErrorTile placement="page" title={t('mail.list.accountsFailed')} detail={accountsError} onRetry={loadAll} />
      </div>
    )
  }
  if (!accountsLoaded) {
    return (
      <div className="flex h-full flex-col">
        <UiSkeleton preset="list" rows={8} />
      </div>
    )
  }
  // 온보딩: 연결된 메일 계정이 없을 때
  if (accounts.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <UiEmptyState
          title={t('mail.onboarding.title')}
          description={t('mail.onboarding.desc')}
          actionLabel={t('mail.onboarding.connect')}
          actionTo="/mail/accounts?add=1"
        />
      </div>
    )
  }

  return (
    <div
      ref={measureMain}
      className="relative flex h-full min-h-0 overflow-hidden bg-background"
      onTouchStart={onEdgeStart}
      onTouchMove={onEdgeMove}
    >
      {/* 1024 미만 드로어 가림막 */}
      {/* 768~1023 은 셸 주메뉴 레일(z-sidebar 250)이 화면 왼쪽 64 에 떠 있다. 서랍·가림막을 fixed 로 화면 왼쪽 끝에 두면
          z-drawer(200)라 그 밑에 깔려 폴더 이름 앞부분이 가려졌다 — md 부터는 이 화면(레일 오른쪽) 안에 absolute 로 둔다.
          모바일(<768)은 레일이 없어 예전처럼 fixed. */}
      {showDrawer && <div className="fixed inset-0 z-drawer bg-scrim md:absolute lg:hidden" aria-hidden="true" onClick={() => setShowDrawer(false)} />}

      {/* 사이드바 236 */}
      {!navOwnedByShell && (
        <div
          className={cx(
            'fixed inset-y-0 left-0 z-drawer w-sidebar shrink-0 shadow-xl transition-transform duration-200 md:absolute lg:static lg:z-auto lg:shadow-none',
            showDrawer ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          )}
          onKeyDown={(e) => { if (e.key === 'Escape') setShowDrawer(false) }}
        >
          <MailSidebar onNavigate={() => setShowDrawer(false)} />
        </div>
      )}

      {/* 목록 + 읽기 판 — 세로 화면이면 위아래로 쌓는다 */}
      <div className={cx('flex min-h-0 min-w-0 flex-1', !isMobile && portrait && 'flex-col')}>
        {/* 목록 */}
        <section
          className={cx(
            'flex min-h-0 w-full min-w-0 flex-col md:shrink-0 md:border-border',
            !isMobile && portrait ? 'md:border-b' : 'md:border-r',
          )}
          style={isMobile ? undefined : portrait ? { height: '42%' } : { width: listW }}
          aria-label={t('mail.list.paneLabel')}
        >
          <MailList ref={listRef} onOpenFolders={() => setShowDrawer(true)} />
        </section>

        {/* 읽기 판 */}
        <section className="hidden min-h-0 min-w-0 flex-1 md:flex" aria-label={t('mail.body.frameTitle')}>
          <MailReader
            ref={readerRef}
            variant="pane"
            onSenderClick={showSide ? undefined : () => setSenderOverlay(v => !v)}
            senderPanelOpen={senderOverlayOpen}
          />
        </section>
      </div>

      {/* 보낸 사람(자리가 날 때만 펼친 채 — 상세 칸 ≥ 1400) */}
      {showSide && selectedMessage && <MailSenderPanel msg={selectedMessage} />}
      {/* 보낸 사람 오버레이 — 채팅 오른쪽 패널 오버레이와 같은 자리·그림자 */}
      {senderOverlayOpen && selectedMessage && (
        <div ref={senderPanelBox} className="absolute inset-y-0 right-0 z-drawer flex h-full shadow-xl">
          <MailSenderPanel msg={selectedMessage} overlay />
        </div>
      )}
    </div>
  )
}
