/**
 * 모바일 하단 탭바(Vue components/layout/MobileTabBar.vue): 홈 · 채팅 · 활동 · 메일 · 전체.
 * 64 + safe-area, 활성 = primary 글자 + 32 타일 primary/16.
 * 배지: 채팅 = 나를 부른 것(멘션+DM), 활동 = 안 읽은 알림. 메일 = 7px 점(안 읽은 메일이 있을 때 — useMailUnread:
 *   기존 /api/mail/mailboxes 받은편지함 unread_count. 데이터가 오기 전·계정 없음이면 점 없음).
 * 4번째 칸(기본 메일)은 "전체" 시트의 "탭 편집"으로 다른 모듈로 바꿀 수 있다(useUserPrefs.pinnedTab, 서버 동기화).
 *   교체 대상은 4번째(메일) 칸만. 홈·채팅·활동은 고정, 전체는 항상 마지막.
 * '전체' 시트: rounded-sheet, 핸들 36×4, 소통·문서·기타 3묶음 4열 그리드(타일 48 + 배지). 탭에 있는 모듈은 빼고,
 * 탭 편집 중에는 탭 모듈까지 다 보여 고르게 한다. 시트는 화면 아래 끝까지 덮는다 — 바깥·Esc 로 닫는다.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { navigateTo, useRoute } from '~/lib/router'
import { usePlatform } from '~/composables/usePlatform'
import { useNav, type NavItem } from '~/composables/useNav'
import { useAuth } from '~/composables/useAuth'
import { useChat } from '~/composables/useChat'
import { useNotifications } from '~/composables/useNotifications'
import { useUserPrefs } from '~/composables/useUserPrefs'
import { useMailUnread } from '~/composables/useMailUnread'
import { UiIcon } from '~/components/ui/Icon'
import { UiTabbar, type UiTabbarTab } from '~/components/ui/Tabbar'
import { LayoutNavIcon } from './NavIcon'

/** 탭바 마지막 "전체" 칸 id(모듈 id 와 겹치지 않게) */
const ALL_TAB = '__all'

interface Tab { id: string; route: string; label: string; icon: string; alsoMatch?: string[] }
interface SheetItem { id: string; name: string; route: string; icon: string; fixed?: boolean }

// 묶음: 소통 = 파일·캘린더·회의·연락처, 문서 = 위키·게시판·작업·Git, 기타 = AI·(플러그인)·프로필·관리.
// 메일은 4번째 탭을 다른 모듈로 바꿨을 때만 시트에 나온다(소통 맨 앞).
const SHEET_GROUPS: { key: string; label: string; ids: string[] }[] = [
  { key: 'talk', label: 'shell.tab.groupTalk', ids: ['mail', 'files', 'calendar', 'meetings', 'contacts'] },
  { key: 'docs', label: 'shell.tab.groupDocs', ids: ['wiki', 'board', 'tasks', 'git'] },
  { key: 'other', label: 'shell.tab.other', ids: ['ai'] },
]

export function LayoutMobileTabBar() {
  const route = useRoute()
  const { isModuleEnabled } = usePlatform()
  const { flat } = useNav()
  const { user } = useAuth()
  const { totalMentions } = useChat()
  const { unreadCount } = useNotifications()
  const { pinnedTab, setPinnedTab } = useUserPrefs()
  const mailUnread = useMailUnread(isModuleEnabled('mail'))
  const { t } = useI18n()

  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState(false)

  const pinnedMod = flat.find(m => m.id === pinnedTab && m.id !== 'chat' && m.id !== 'dashboard' && m.id !== 'admin')
  const tabs: Tab[] = (() => {
    const list: Tab[] = [{ id: 'home', route: '/', label: t('shell.tab.home'), icon: 'home' }]
    if (isModuleEnabled('chat')) list.push({ id: 'chat', route: '/chat', label: t('nav.chat'), icon: 'chat' })
    list.push({ id: 'activity', route: '/activity', label: t('shell.activity.title'), icon: 'bell' })
    if (pinnedMod) list.push({ id: pinnedMod.id, route: pinnedMod.route, label: pinnedMod.name, icon: pinnedMod.icon || 'puzzle', alsoMatch: pinnedMod.alsoMatch })
    return list
  })()

  const isActive = (r: string) => (r === '/' ? route.path === '/' : route.path === r || route.path.startsWith(r + '/'))
  // 탭 활성: 하위 경로(alsoMatch — 연락처 → 메일)까지 본다. 전체 시트가 열려 있으면 "전체" 하나만 활성.
  const routeMatches = (tb: Tab) => isActive(tb.route) || !!tb.alsoMatch?.some(isActive)
  const tabActive = (tb: Tab) => !showAll && routeMatches(tb)
  const badgeFor = (id: string) => (id === 'chat' ? totalMentions : id === 'activity' ? unreadCount : 0)
  function go(r: string) { setShowAll(false); setEditing(false); void navigateTo(r) }
  function onTile(item: { id: string; route: string }) {
    if (editing) { setPinnedTab(item.id); setEditing(false); return }
    go(item.route)
  }
  const inTabs = (id: string) => tabs.some(tb => tb.id === id)

  const sheetGroups = useMemo(() => {
    const mods = flat.filter(i => i.id !== 'dashboard' && i.id !== 'admin' && i.id !== 'chat')
    const known = new Set(SHEET_GROUPS.flatMap(g => g.ids))
    const visible = (id: string) => editing || !inTabs(id)
    const toItem = (i: NavItem): SheetItem => ({ id: i.id, name: i.name, route: i.route, icon: i.icon || 'puzzle' })
    return SHEET_GROUPS.map((g) => {
      const items: SheetItem[] = g.ids
        .map(id => mods.find(m => m.id === id))
        .filter((m): m is NavItem => !!m && visible(m.id))
        .map(toItem)
      if (g.key === 'other') {
        // 그 밖의 모듈(메모·플러그인)은 AI 뒤에, 프로필·관리는 맨 끝(탭 편집 대상 아님)
        items.push(...mods.filter(m => !known.has(m.id) && visible(m.id)).map(toItem))
        items.push({ id: 'settings', name: t('shell.tab.profile'), route: '/settings', icon: 'user', fixed: true })
        if (user?.is_admin) items.push({ id: 'admin', name: t('nav.admin'), route: '/admin', icon: 'settings', fixed: true })
      }
      return { key: g.key, label: t(g.label), items }
    }).filter(g => g.items.length)
    // inTabs 는 tabs(= flat·pinnedTab·모듈 켜짐)에서 나온다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, editing, t, user?.is_admin, pinnedTab, isModuleEnabled])

  // 탭 밖 모듈(파일·연락처 등)에 있으면 "전체"가 활성(시안)
  const allActive = showAll || !tabs.some(routeMatches)
  function closeSheet() { setShowAll(false); setEditing(false) }
  // 시트가 탭바를 덮으므로 열리면 시트로 포커스를 옮긴다(Esc 닫기가 바로 먹게)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (showAll) sheetRef.current?.focus() }, [showAll])

  return (
    <>
      {/* md:hidden 은 부모가 아니라 여기 둔다(루트가 nav + 포털 두 개). 겉모습은 키트 UiTabbar. */}
      <UiTabbar
        className="md:hidden"
        tabs={[
          ...tabs.map((tb): UiTabbarTab => ({
            id: tb.id,
            label: tb.label,
            icon: tb.icon,
            active: tabActive(tb),
            badge: badgeFor(tb.id),
            dot: tb.id === 'mail' && (mailUnread ?? 0) > 0,
            dotLabel: tb.id === 'mail' && mailUnread ? t('shell.tab.mailUnread', { n: mailUnread }) : undefined,
            ariaLabel: badgeFor(tb.id) ? `${tb.label} — ${badgeFor(tb.id)}` : tb.label,
          })),
          {
            id: ALL_TAB,
            label: t('common.all'),
            icon: 'grid',
            active: allActive,
            current: !showAll && allActive,
            buttonProps: { 'aria-haspopup': 'dialog', 'aria-expanded': showAll },
          },
        ]}
        onSelect={(id) => {
          if (id === ALL_TAB) { if (showAll) closeSheet(); else setShowAll(true); return }
          const tb = tabs.find(x => x.id === id)
          if (tb) go(tb.route)
        }}
      />

      {/* '전체' 바텀시트 — 화면 아래 끝까지(탭바를 덮음). 바깥(스크림)·Esc 로 닫힘 */}
      {showAll && createPortal(
        <div
          className="fixed inset-0 z-modal flex flex-col justify-end bg-scrim md:hidden"
          onClick={closeSheet}
        >
          <div
            role="dialog"
            aria-label={t('shell.tab.allMenu')}
            ref={sheetRef}
            tabIndex={-1}
            className="max-h-full overflow-y-auto overscroll-contain rounded-t-sheet border-t border-border bg-card px-4 pt-2.5 outline-hidden animate-slide-up"
            style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}
            onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') closeSheet() }}
          >
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted" aria-hidden="true" />
            <div className="mb-2.5 flex items-center">
              <span className="flex-1 text-[17px] font-semibold text-foreground">{t('common.all')}</span>
              <button type="button" className="text-sm font-semibold text-primary" onClick={() => setEditing(!editing)}>{editing ? t('common.done') : t('shell.tab.editTabs')}</button>
            </div>
            {editing && <p className="mb-2 text-xs text-muted-foreground">{t('shell.tab.editHint')}</p>}

            {sheetGroups.map(g => (
              <Fragment key={g.key}>
                <div className="pb-1 pt-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{g.label}</div>
                <div className="grid grid-cols-4 gap-1">
                  {g.items.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className={cn('flex min-w-0 flex-col items-center gap-1.5 py-2 text-xs text-foreground', editing && item.fixed ? 'opacity-40' : '')}
                      disabled={editing && item.fixed}
                      onClick={() => (item.fixed ? go(item.route) : onTile(item))}
                    >
                      <span
                        className={cn('relative grid h-12 w-12 place-items-center rounded-lg', isActive(item.route) ? 'bg-primary/[0.16] text-primary' : 'bg-muted', editing && pinnedTab === item.id ? 'ring-2 ring-primary' : '')}
                      >
                        <LayoutNavIcon name={item.icon} className="h-[22px] w-[22px]" />
                        {!editing && badgeFor(item.id) > 0 && (
                          <span
                            className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-card bg-primary px-1 font-mono text-[11px] font-bold text-primary-foreground"
                          >{badgeFor(item.id)}</span>
                        )}
                        {editing && inTabs(item.id) && (
                          <span className="absolute -right-1 -top-1 grid h-[18px] w-[18px] place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground">
                            <UiIcon name="check" className="h-2.5 w-2.5" strokeWidth={3.5} />
                          </span>
                        )}
                      </span>
                      <span className="max-w-full truncate">{item.name}</span>
                    </button>
                  ))}
                </div>
              </Fragment>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

export default LayoutMobileTabBar
