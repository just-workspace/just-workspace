/**
 * 홈 대시보드 보드 — 홈(/)과 관리 › 설정 › 대시보드가 공용으로 사용한다.
 *
 * 순서: (편집 바) → 헤더(인사·날짜 + 빠른 만들기 · 편집) → (공지 바) → 오늘 브리핑 칩 → (관리자 운영 바) → (시작하기 전폭) → 카드 보드 → 비어 있는 카드.
 * 카드 보드: 열 = lib/fluid dashColumns, 최대 폭 열 × 520 가운데 정렬, grid-auto-rows 4px + dense,
 * 주 줄(내용 있는 카드끼리 동일 높이 — 빈 상태·AI 비활성은 자체 높이) + 보조 영역(카드마다 row span = ceil((본래 높이 + 20) / 4)) — 규칙은 lib/dashLayout.
 * 빈 카드: 주 줄 카드는 제자리 한 행, 나머지는 렌더링하지 않고 맨 아래 점선 상자 "비어 있는 카드 n"에 한 행씩 표시.
 *
 * 편집(mode="user"): 헤더의 layout 버튼 → 편집 바 + 점선 카드(grip 드래그 · 1칸/2칸 · 숨기기) + 오른쪽 320 "카드" 패널.
 *   변경 시마다 /api/me/prefs `dash.layout` 에 즉시 저장(기기 간 동기화). "기본값으로 복원" = 개인 배치를 삭제하여 관리자 기본 배치로 복원.
 * mode="admin"(관리 › 설정 › 대시보드): 항상 편집 상태, 저장 대상은 관리자 기본 배치(appcfg dash.layout), 패널에서 카드 잠금(관리자 고정).
 */
import { useZoneConfirmed } from '~/composables/useSiteConfig'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { errText } from '~/utils/errText'
import { useSiteConfig, refetchAppConfig } from '~/composables/useSiteConfig'
import { usePlatform } from '~/composables/usePlatform'
import { useAuth } from '~/composables/useAuth'
import { useIsMobile } from '~/composables/useIsMobile'
import { useViewport, useElementWidth } from '~/composables/useViewport'
import { refreshDashSummary } from '~/composables/useDashSummary'
import { addToast } from '~/composables/useToast'
import { dashColumns, DASH_COL_MAX } from '~/lib/fluid'
import {
  INLINE_EMPTY, PRIMARY, PRIMARY_NEW, drawOrder, maxRowsFor, moveKey, parseLayout, planTier, resolveLayout, rowSpanFor, stepKey, tierHeights, toSaved,
  type CardKey, type CardSpan, type DashLayout, type ResolvedLayout,
} from '~/lib/dashLayout'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { DashCtx, type CardStatus, type DashCtxValue, type EmptyNote } from './DashCard'
import { DashboardGreeting } from './DashboardGreeting'
import { DashboardBriefingChips, DashboardOpsBand } from './DashboardBriefing'
import { DashboardInbox } from './DashboardInbox'
import { DashboardToday } from './DashboardToday'
import { DashboardFocus } from './DashboardFocus'
import { DashboardContinue } from './DashboardContinue'
import { DashboardTasks } from './DashboardTasks'
import { DashboardRecentMail } from './DashboardRecentMail'
import { DashboardLater } from './DashboardLater'
import { DashboardTeam } from './DashboardTeam'
import { DashboardGitActivity } from './DashboardGitActivity'
import { DashboardStart, loadStart, useStartChecklist } from './DashboardStart'
import { DashboardNetLab } from './DashboardNetLab'
import { useNetLabUrl } from '~/composables/useNetLab'
import {
  DashboardBoard, DashboardNotices, DashboardFrequentChannels, DashboardStorage, DashboardLiveMeetings, DashboardDiscover,
} from './DashboardMoreCards'

const BANNER_CLASS: Record<string, string> = {
  danger: 'border-danger/35 bg-danger/[0.09]',
  accent: 'border-primary/35 bg-primary/[0.08]',
  warning: 'border-warning/35 bg-warning/[0.08]',
}
const BANNER_ICON: Record<string, string> = { danger: 'alert-circle', accent: 'info', warning: 'alert-triangle' }
const BANNER_ICON_CLASS: Record<string, string> = { danger: 'text-danger', accent: 'text-primary', warning: 'text-warning' }

/** 관리자 기본 배치가 없을 때의 고정 카드(시안: 공지 = 관리자 고정) */
const DEFAULT_LOCKED: CardKey[] = ['notice']

interface CardDef {
  title: string
  icon: string
  /** 사용 가능 여부(모듈·권한) */
  on: boolean
  node: () => ReactNode
  /** 빈 카드 그룹 한 행: 사유 · 링크 */
  empty: { text: string; link: string; to: string }
}

/** 저장 상태 표시 없이 즉시 저장 — 실패 시 토스트만 표시 */
async function saveUserLayout(v: DashLayout | null) {
  await $fetch('/api/me/prefs', { method: 'PATCH', body: { 'dash.layout': v } })
}
async function saveAdminLayout(v: DashLayout | null) {
  await $fetch('/api/admin/settings/appconfig', { method: 'PATCH', body: { values: { 'dash.layout': v ? JSON.stringify(v) : '' } } })
  await refetchAppConfig()
}

/** 카드 보드 여백 — 모바일 16 · 데스크톱 24/28 · 편집 중 데스크톱은 오른쪽 320 패널 폭만큼 추가 */
export function dashPadding(isMobile: boolean, editing: boolean): string {
  if (isMobile) return '16px'
  return editing ? `24px ${320 + 28}px 24px 28px` : '24px 28px'
}

export function DashboardHome({ mode = 'user' }: { mode?: 'user' | 'admin' }) {
  const { t } = useI18n()
  const { config } = useSiteConfig()
  const { isModuleEnabled } = usePlatform()
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const { width: vw, height: vh, portrait } = useViewport()
  const admin = mode === 'admin'
  const cfg = (k: string) => (config?.[k] ?? '').trim()

  // ── 크기 ──
  const [measure, mainWidth] = useElementWidth<HTMLDivElement>(vw - 64)
  const cols = isMobile ? 1 : dashColumns(mainWidth, portrait, vw)
  const maxRows = maxRowsFor(vh)

  // ── 신규 사용자(시작하기) ──
  const { active: isNew } = useStartChecklist()
  useEffect(() => { void loadStart(); void refreshDashSummary() }, [])

  // ── 카드 정의 ──
  const has = (m: string) => isModuleEnabled(m)
  // AI 브리핑 카드는 AI 구역 소속(모듈 활성화 전에도 표시되므로 구역으로 판정). 카드가 마운트 즉시 /api/dashboard/briefing 을
  // 호출하므로, 구역 목록을 수신하기 전에는 표시하지 않는다(AI 구역이 없는 서버에서 404 방지)
  const aiZone = useZoneConfirmed('ai')
  // 네트워크 랩 — NETLAB_URL(https)이 있을 때만 사용 가능한 카드(기본 표시, 다른 카드와 같이 이동·숨기기 가능)
  const netlabUrl = useNetLabUrl()
  const defs = useMemo<Record<CardKey, CardDef>>(() => ({
    start: { title: t('dashboard.d17.start.title'), icon: 'check-circle', on: isNew && !admin, node: () => <DashboardStart />, empty: { text: '', link: '', to: '/' } },
    inbox: { title: t('dashboard.inbox.title'), icon: 'inbox', on: true, node: () => <DashboardInbox />, empty: { text: t('dashboard.inbox.empty'), link: t('dashboard.inbox.open'), to: '/activity' } },
    today: { title: t('common.today'), icon: 'calendar', on: has('calendar'), node: () => <DashboardToday />, empty: { text: t('dashboard.today.empty'), link: t('dashboard.today.create'), to: '/calendar?new=1' } },
    ai: { title: t('dashboard.d17.ai.title'), icon: 'sparkles', on: aiZone, node: () => <DashboardFocus />, empty: { text: '', link: '', to: '/' } },
    cont: { title: t('dashboard.d17.cont.title'), icon: 'folder', on: has('files') || has('wiki') || has('chat') || has('board'), node: () => <DashboardContinue />, empty: { text: t('dashboard.d17.empty.cont'), link: t('dashboard.recentFiles.open'), to: '/files' } },
    tasks: { title: t('dashboard.d17.tasks.title'), icon: 'check-square', on: has('tasks'), node: () => <DashboardTasks />, empty: { text: t('dashboard.d17.empty.none'), link: t('dashboard.d17.empty.tasksLink'), to: '/tasks' } },
    mail: { title: t('dashboard.recentMail.title'), icon: 'mail', on: has('mail'), node: () => <DashboardRecentMail />, empty: { text: t('dashboard.recentMail.emptyInbox'), link: t('dashboard.recentMail.open'), to: '/mail' } },
    later: { title: t('dashboard.d17.later.title'), icon: 'bookmark', on: has('chat'), node: () => <DashboardLater />, empty: { text: t('dashboard.d17.empty.later'), link: t('dashboard.d17.empty.laterLink'), to: '/chat?view=saved' } },
    team: { title: t('dashboard.d17.team.title'), icon: 'users', on: has('chat'), node: () => <DashboardTeam />, empty: { text: t('dashboard.d17.empty.team'), link: t('dashboard.frequentChannels.open'), to: '/chat' } },
    git: { title: t('dashboard.gitActivity.title'), icon: 'git-branch', on: has('git'), node: () => <DashboardGitActivity />, empty: { text: t('dashboard.gitActivity.emptyAll'), link: t('dashboard.gitActivity.open'), to: '/code' } },
    board: { title: t('dashboard.recentBoard.title'), icon: 'clipboard-list', on: has('board'), node: () => <DashboardBoard />, empty: { text: t('dashboard.d17.empty.none'), link: t('dashboard.notices.openBoard'), to: '/board' } },
    notice: { title: t('common.notice'), icon: 'bell', on: has('board'), node: () => <DashboardNotices />, empty: { text: t('dashboard.notices.emptyNew'), link: t('dashboard.notices.openBoard'), to: '/board' } },
    chans: { title: t('dashboard.frequentChannels.title'), icon: 'hash', on: has('chat'), node: () => <DashboardFrequentChannels />, empty: { text: t('dashboard.d17.empty.chans'), link: t('dashboard.d17.discover.link'), to: '/chat' } },
    store: { title: t('dashboard.d17.store.title'), icon: 'database', on: has('files'), node: () => <DashboardStorage />, empty: { text: '', link: '', to: '/files' } },
    meet: { title: t('dashboard.liveMeetings.title'), icon: 'video', on: has('meetings'), node: () => <DashboardLiveMeetings />, empty: { text: t('dashboard.liveMeetings.empty'), link: t('dashboard.liveMeetings.open'), to: '/meetings' } },
    discover: { title: t('dashboard.d17.discover.title'), icon: 'hash', on: isNew && !admin && has('chat'), node: () => <DashboardDiscover />, empty: { text: t('dashboard.d17.empty.discover'), link: t('dashboard.d17.discover.link'), to: '/chat' } },
    lab: { title: t('dashboard.d17.lab.title'), icon: 'router', on: !!netlabUrl, node: () => (netlabUrl ? <DashboardNetLab url={netlabUrl} /> : null), empty: { text: '', link: '', to: '/' } },
    // has 는 isModuleEnabled 에 종속
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [t, isNew, admin, isModuleEnabled, netlabUrl, aiZone])
  const available = useMemo(() => (Object.keys(defs) as CardKey[]).filter(k => defs[k].on), [defs])

  // ── 배치(개인 · 관리자 기본) ──
  const adminLayout = useMemo(() => {
    const p = parseLayout(cfg('dash.layout'))
    return p ?? { locked: DEFAULT_LOCKED }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])
  const [userLayout, setUserLayout] = useState<DashLayout | null | undefined>(admin ? null : undefined)
  useEffect(() => {
    if (admin) return
    $fetch<{ prefs: Record<string, unknown> }>('/api/me/prefs')
      .then(r => setUserLayout(parseLayout(r.prefs?.['dash.layout'])))
      .catch(() => setUserLayout(null))
  }, [admin])
  // 관리자 화면은 편집 중인 기본 배치를 직접 보유한다(저장 시 사이트 설정을 재조회)
  const [adminDraft, setAdminDraft] = useState<DashLayout | null>(null)
  const layout: ResolvedLayout = useMemo(() => resolveLayout({
    available, isNew,
    admin: admin ? (adminDraft ?? adminLayout) : adminLayout,
    user: admin ? null : userLayout,
  }), [available, isNew, admin, adminDraft, adminLayout, userLayout])

  const [editing, setEditing] = useState(admin)
  const persist = useCallback((next: ResolvedLayout) => {
    if (admin) {
      const v = toSaved(next, true)
      setAdminDraft(v)
      saveAdminLayout(v).catch(e => addToast('error', errText(e, t('dashboard.d17.edit.saveFailed'))))
    } else {
      const v = toSaved(next)
      setUserLayout(v)
      saveUserLayout(v).catch(e => addToast('error', errText(e, t('dashboard.d17.edit.saveFailed'))))
    }
  }, [admin, t])
  async function resetLayout() {
    try {
      if (admin) { setAdminDraft({ locked: DEFAULT_LOCKED }); await saveAdminLayout(null) } else { setUserLayout(null); await saveUserLayout(null) }
    } catch (e) { addToast('error', errText(e, t('dashboard.d17.edit.saveFailed'))) }
  }

  // ── 카드 상태 · 높이 ──
  const [status, setStatus] = useState<Partial<Record<CardKey, { s: CardStatus; note?: EmptyNote }>>>({})
  const [heights, setHeights] = useState<Partial<Record<CardKey, number>>>({})
  const report = useCallback((key: CardKey, s: CardStatus, note?: EmptyNote) => {
    setStatus(cur => (cur[key]?.s === s && JSON.stringify(cur[key]?.note) === JSON.stringify(note) ? cur : { ...cur, [key]: { s, note } }))
  }, [])
  const reportHeight = useCallback((key: CardKey, px: number) => {
    const h = Math.round(px)
    setHeights(cur => (cur[key] === h ? cur : { ...cur, [key]: h }))
  }, [])

  // ── 배치 계산 ──
  const visible = layout.order.filter(k => !layout.hidden.has(k))
  const spanOf = useCallback((k: CardKey): CardSpan => (Math.min(layout.size[k] ?? 1, cols) as CardSpan), [layout, cols])
  const primary = isNew && !admin ? PRIMARY_NEW : PRIMARY
  const tier = planTier(visible, primary, spanOf, cols)
  const order = drawOrder(visible, tier, primary)
  const isEmpty = (k: CardKey) => status[k]?.s === 'empty' && !tier.includes(k) && !INLINE_EMPTY.includes(k)
  // 관리자 화면에서는 빈 카드도 위치를 표시한다(배치를 정하는 화면이므로)
  // 편집 중에는 빈 카드도 보드에 렌더링한다(관리자 모드와 동일) — 숨기면 카드 내 크기·숨기기 버튼을 사용할 수 없었다
  const empties = admin || editing ? [] : order.filter(isEmpty)
  // 주 줄 동일 높이는 내용 있는 카드끼리만 적용(빈 상태·AI 비활성·로딩·오류는 자체 높이)
  const tierH = tierHeights(tier, heights, k => status[k]?.s === 'ready')
  const rowsOf = (k: CardKey) => rowSpanFor(tier.includes(k) ? (tierH[k] ?? 240) : (heights[k] ?? 200))
  const showStart = visible.includes('start') && defs.start.on

  // ── 편집 동작 ──
  const dragKey = useRef<CardKey | null>(null)
  const ctx: DashCtxValue = useMemo(() => ({
    editing, maxRows, cols, report, reportHeight, spanOf,
    isLocked: k => layout.locked.has(k) && !admin,
    setSpan: (k, sp) => persist({ ...layout, size: { ...layout.size, [k]: sp } }),
    hide: (k) => { if (!layout.locked.has(k) || admin) persist({ ...layout, hidden: new Set([...layout.hidden, k]) }) },
    step: (k, d) => persist({ ...layout, order: stepKey(layout.order, k, d) }),
    dragStart: (k) => { dragKey.current = k },
  }), [editing, maxRows, cols, report, reportHeight, spanOf, layout, persist, admin])
  function drop(target: CardKey) {
    const from = dragKey.current
    dragKey.current = null
    if (from && from !== target) persist({ ...layout, order: moveKey(layout.order, from, target) })
  }
  function toggleHidden(k: CardKey) {
    if (layout.locked.has(k) && !admin) return
    const hidden = new Set(layout.hidden)
    if (hidden.has(k)) hidden.delete(k); else hidden.add(k)
    persist({ ...layout, hidden })
  }
  function toggleLock(k: CardKey) {
    const locked = new Set(layout.locked)
    if (locked.has(k)) locked.delete(k); else { locked.add(k) }
    const hidden = new Set(layout.hidden); hidden.delete(k)
    persist({ ...layout, locked, hidden })
  }

  // 공지(관리 › 일반 "대시보드 문구·공지" — dash.notice_banner). 비우면 렌더링하지 않음.
  const noticeBanner = cfg('dash.notice_banner')
  const noticeLevel = cfg('dash.notice_level') || 'warning'

  const shownCount = layout.order.filter(k => !layout.hidden.has(k)).length
  const hiddenCount = layout.order.length - shownCount
  const emptyCols = Math.min(cols, isNew ? 3 : 2)

  return (
    <DashCtx.Provider value={ctx}>
      <div className="relative h-full">
        <div
          ref={measure}
          className="h-full overflow-auto"
          // 편집 중 데스크톱은 오른쪽 320 패널이 카드·편집 바([완료])를 가리지 않도록 해당 폭만큼 여백을 둔다
          // 축약형 padding 과 paddingRight:undefined 를 혼용하면 React 가 paddingRight 를 '' 로 제거하여 오른쪽 여백이 0 이 된다 — 문자열 하나로 지정
          style={{ padding: dashPadding(isMobile, editing) }}
        >
          <div className="mx-auto flex flex-col gap-4" style={!isMobile ? { maxWidth: cols * DASH_COL_MAX } : undefined}>
            {editing && (
              <div role="toolbar" aria-label={t('dashboard.d17.edit.open')} className="flex min-h-14 flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 text-[13.5px]">
                <UiIcon name="layout" className="h-4 w-4 text-primary" />
                <span className="font-semibold">{t(admin ? 'dashboard.d17.edit.adminTitle' : 'dashboard.d17.edit.open')}</span>
                <span className="min-w-0 text-muted-foreground">{t(admin ? 'dashboard.d17.edit.adminDesc' : 'dashboard.d17.edit.desc')}</span>
                <span className="flex-1" />
                <UiButton variant="ghost" size="sm" onClick={() => { void resetLayout() }}>{t('dashboard.d17.edit.reset')}</UiButton>
                <UiButton size="sm" onClick={() => { if (admin) void navigateTo('/admin/settings'); else setEditing(false) }}>{t('dashboard.d17.edit.done')}</UiButton>
              </div>
            )}

            <DashboardGreeting wide={!isMobile && cols >= 3} editing={editing} onToggleEdit={() => setEditing(e => !e)} noEdit={admin} />

            {noticeBanner && (
              <div role="status" className={cn('flex min-h-11 items-center gap-3 rounded-lg border px-4', BANNER_CLASS[noticeLevel] || BANNER_CLASS.warning)}>
                <UiIcon name={BANNER_ICON[noticeLevel] || 'alert-triangle'} className={cn('h-4 w-4 shrink-0', BANNER_ICON_CLASS[noticeLevel] || 'text-warning')} />
                <span className="min-w-0 flex-1 text-[13px] font-medium text-foreground">{noticeBanner}</span>
              </div>
            )}

            <DashboardBriefingChips isAdmin={!!user?.is_admin} mobile={isMobile} />
            {user?.is_admin && <DashboardOpsBand mobile={isMobile} />}

            {/* 시작하기 — 주 줄 위 전폭 카드(항목은 열 수에 맞춘 격자) */}
            {showStart && <div data-cell="start">{defs.start.node()}</div>}

            <div
              className="grid"
              data-cols={cols}
              style={{ gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gridAutoRows: '4px', gridAutoFlow: 'row dense', columnGap: 20 }}
            >
              {order.map(k => (
                <div
                  key={k}
                  data-cell={k}
                  data-tier={tier.includes(k) || undefined}
                  className="min-w-0"
                  style={{ gridColumn: `span ${spanOf(k)}`, gridRow: `span ${rowsOf(k)}`, paddingBottom: 20, display: empties.includes(k) ? 'none' : undefined }}
                  onDragOver={editing ? (e) => { if (dragKey.current) e.preventDefault() } : undefined}
                  onDrop={editing ? (e) => { e.preventDefault(); drop(k) } : undefined}
                >
                  {defs[k].node()}
                </div>
              ))}
            </div>

            {empties.length > 0 && !editing && (
              <section aria-label={t('dashboard.d17.empty.title')} className="-mt-1 rounded-lg border border-dashed border-border px-4 py-2.5">
                <div className="flex h-8 items-center gap-2 text-[13px]">
                  <span className="font-semibold">{t('dashboard.d17.empty.title')}</span>
                  <span className="font-mono text-xs text-muted-foreground">{empties.length}</span>
                  <span className="flex-1" />
                  {!isMobile && <span className="text-xs text-muted-foreground">{t('dashboard.d17.empty.hint')}</span>}
                </div>
                <ul className="grid gap-x-6" style={{ gridTemplateColumns: `repeat(${emptyCols},minmax(0,1fr))` }}>
                  {empties.map((k) => {
                    const d = defs[k], note = status[k]?.note
                    return (
                      <li key={k} className="flex h-9 min-w-0 items-center gap-2 text-[13px]">
                        <UiIcon name={d.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 font-medium">{d.title}</span>
                        <span className="truncate text-muted-foreground">— {note?.text || d.empty.text} ·</span>
                        <NuxtLink to={note?.to || d.empty.to} className="shrink-0 text-primary hover:underline">{note?.linkLabel || d.empty.link}</NuxtLink>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
          </div>
        </div>

        {editing && (
          <aside
            aria-label={t('dashboard.d17.panel.title')}
            className="absolute bottom-0 right-0 top-0 z-10 flex flex-col border-l border-border bg-card"
            style={{ width: isMobile ? '100%' : 320, boxShadow: '-8px 0 24px rgba(0,0,0,0.25)' }}
          >
            <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
              <span className="flex-1 text-[14px] font-semibold">{t('dashboard.d17.panel.title')}</span>
              <span className="font-mono text-xs text-muted-foreground">{t('dashboard.d17.panel.count', { shown: shownCount, hidden: hiddenCount })}</span>
              {isMobile && <UiButton variant="ghost" size="xs" className="ml-2" onClick={() => setEditing(false)}>{t('dashboard.d17.edit.done')}</UiButton>}
            </div>
            <ul className="flex min-h-0 flex-1 flex-col overflow-auto py-1">
              {layout.order.map((k) => {
                const lk = layout.locked.has(k)
                const hid = layout.hidden.has(k)
                const userLocked = lk && !admin
                return (
                  <li key={k} className={cn('flex h-10 items-center gap-3 px-4 text-[13.5px]', hid && 'text-muted-foreground')}>
                    <button
                      type="button"
                      disabled={userLocked}
                      aria-pressed={!hid}
                      aria-label={t(hid ? 'dashboard.d17.panel.show' : 'dashboard.d17.panel.hide', { title: defs[k].title })}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                      onClick={() => toggleHidden(k)}
                    >
                      <UiIcon name={userLocked ? 'lock' : hid ? 'eye-off' : 'eye'} className={cn('h-4 w-4 shrink-0', hid ? 'text-muted-foreground' : 'text-foreground')} />
                      <span className="flex-1 truncate">{defs[k].title}</span>
                      <span className="text-xs text-muted-foreground">{userLocked ? t('dashboard.d17.panel.locked') : hid ? t('dashboard.d17.panel.hidden') : ''}</span>
                    </button>
                    {admin && (
                      <button
                        type="button"
                        aria-pressed={lk}
                        aria-label={t('dashboard.d17.panel.lock', { title: defs[k].title })}
                        className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-sm hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', lk ? 'text-primary' : 'text-muted-foreground')}
                        onClick={() => toggleLock(k)}
                      ><UiIcon name={lk ? 'lock' : 'unlock'} className="h-4 w-4" /></button>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="mt-auto border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t(admin ? 'dashboard.d17.panel.adminNote' : 'dashboard.d17.panel.note')}</p>
          </aside>
        )}
      </div>
    </DashCtx.Provider>
  )
}

export default DashboardHome
