/**
 * 상단바(56px).
 * 데스크톱: [사이드바 고정(aria-pressed, Ctrl \)] 워크스페이스 / 모듈 / 위치(3단, 위치는 페이지가 useBreadcrumb 로 올림 · 플러그인은 __WS_SHELL__.setTitle)
 *           … [이동하거나 검색 240 + Ctrl K 키캡] [벨 36 테두리 → 활동 패널 400, 숫자 배지 primary] [아바타 32 + 상태점 → 사용자 메뉴 288]
 * 모바일: 제목 한 줄 + 검색 아이콘 + 아바타(활동은 탭바 "활동" 탭이 맡는다). 테마 토글은 사용자 메뉴로 옮겼다.
 * 겉모습은 키트 UiTopbar — 이 파일은 경로·알림 수·사용자·플러그인 확장 액션·사용자 메뉴를 잇기만 한다.
 */
import { useEffect, useRef } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { useClickOutside } from '~/lib/dom'
import { useAuth } from '~/composables/useAuth'
import { useIsMobile } from '~/composables/useIsMobile'
import { useSidebar } from '~/composables/useSidebar'
import { useNav, isNavActive } from '~/composables/useNav'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useShell } from '~/composables/useShell'
import { useNotifications } from '~/composables/useNotifications'
import { useMyStatus } from '~/composables/useMyStatus'
import { useShellHeaderActions } from '~/composables/useShellHeaderActions'
import { useShellTitle } from '~/composables/useShellTitle'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiChip } from '~/components/ui/Chip'
import { UiTopbar } from '~/components/ui/Topbar'
import { ShellTransition } from './shellTransition'
import { LayoutUserMenu } from './UserMenu'

export interface LayoutTopBarProps {
  /** 모바일 통화 띠가 위에 끼면 노치 여백은 띠 위에서 이미 줬다 */
  noSafeTop?: boolean
}

/** UI 키트가 React 합성 이벤트를 주든 DOM 이벤트를 주든 플러그인에는 DOM MouseEvent 로(기존 API) */
const toNative = (e: unknown) => ((e as { nativeEvent?: MouseEvent })?.nativeEvent ?? e) as MouseEvent

const TONE_TEXT: Record<string, string> = { primary: 'text-primary', warning: 'text-warning', danger: 'text-danger', success: 'text-success' }

// 현재 모듈 라벨 — 네비 항목 우선, 그 외 경로는 보조 맵(값 = i18n 키)
const EXTRA_LABELS: Record<string, string> = {
  '/settings': 'nav.settings',
  '/profile': 'nav.settings',
  '/admin': 'nav.admin',
  '/activity': 'shell.activity.title',
  '/approvals': 'approvals.title',
}

export function LayoutTopBar({ noSafeTop }: LayoutTopBarProps) {
  const route = useRoute()
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const { pinned, togglePin } = useSidebar()
  const { home, flat } = useNav()
  const { location: pageLocation } = useBreadcrumb()
  // 플러그인이 건 제목(window.__WS_SHELL__.setTitle)이 페이지 위치보다 우선 — 데스크톱 경로 마지막 칸 · 모바일 제목
  const shellTitle = useShellTitle()
  const location = shellTitle || pageLocation
  const { activityOpen, toggleActivity, userMenuOpen, setUserMenuOpen, openPalette } = useShell()
  const { unreadCount, startPolling, stopPolling } = useNotifications()
  // 아바타 상태점 — 서버 상태 기준(오프라인으로 표시 중이면 offline)
  const { dot: presence } = useMyStatus()
  const { t } = useI18n()
  // 플러그인 확장 자리(composables/useShellHeaderActions — window.__WS_SHELL__.setHeaderActions)
  const { actions: extActions } = useShellHeaderActions()
  const extHasSearch = extActions.some(a => a.icon === 'search')

  const moduleLabel = (() => {
    const path = route.path
    const hit = flat.find(i => isNavActive(i, path) && i.id !== 'dashboard')
    if (hit) return hit.name
    if (isNavActive(home, path)) return home.name
    const extra = Object.keys(EXTRA_LABELS).find(p => path === p || path.startsWith(p + '/'))
    return extra ? t(EXTRA_LABELS[extra]) : home.name
  })()
  // 모바일 제목: 위치가 있으면 위치, 없으면 모듈
  const mobileTitle = location || moduleLabel

  const userLabel = user?.display_name ?? user?.username ?? ''
  const bellLabel = unreadCount > 0 ? t('shell.topbar.bellUnread', { n: unreadCount }) : t('shell.activity.title')
  const menuRef = useRef<HTMLDivElement | null>(null)
  useClickOutside(menuRef, () => setUserMenuOpen(false))

  useEffect(() => {
    startPolling()
    return () => stopPolling()
  }, [startPolling, stopPolling])

  // 확장 액션(플러그인): 아이콘 버튼(데스크톱 32 · 모바일 44) 또는 칩(모바일 히트 44).
  // 칩은 글자가 곧 이름(label 은 아이콘 버튼의 aria-label·툴팁), 톤은 선택 색(primary·warning·success)만.
  const actionsNode = user && extActions.length > 0 ? (
    <div className={cn('flex items-center gap-1', isMobile ? '-mr-1.5' : '')}>
      {extActions.map(a => (a.text ? (
        <span key={a.id} className={cn('inline-flex items-center', isMobile ? 'min-h-11' : '')}>
          <UiChip
            label={a.text}
            icon={a.icon}
            size={isMobile ? 'lg' : 'md'}
            variant={a.pressed === undefined ? 'static' : 'toggle'}
            modelValue={!!a.pressed}
            tone={a.tone === 'warning' || a.tone === 'success' ? a.tone : 'primary'}
            disabled={a.disabled}
            onClick={(e: unknown) => a.onClick?.(toNative(e))}
          />
        </span>
      ) : (
        <UiIconButton
          key={a.id}
          label={a.label}
          icon={a.icon}
          size={isMobile ? 'lg' : 'sm'}
          pressed={a.pressed}
          disabled={a.disabled}
          className={cn(a.tone && a.tone !== 'default' ? TONE_TEXT[a.tone] : '', a.pressed ? 'bg-accent' : '')}
          onClick={(e: unknown) => a.onClick?.(toNative(e))}
        />
      )))}
    </div>
  ) : null

  // 표시는 키트(UiTopbar) — 여기서는 경로·알림·사용자·메뉴 상태를 잇기만 한다
  return (
    <UiTopbar
      mobile={isMobile}
      crumbs={location ? [t('shell.topbar.workspace'), moduleLabel, location] : [t('shell.topbar.workspace'), moduleLabel]}
      title={mobileTitle}
      pinned={pinned}
      onTogglePin={togglePin}
      onSearch={user ? openPalette : undefined}
      hideMobileSearch={extHasSearch}
      onBell={user ? toggleActivity : undefined}
      bellCount={unreadCount}
      bellPressed={activityOpen}
      bellLabel={bellLabel}
      actions={actionsNode}
      user={user ? { name: userLabel, avatarUrl: user.avatar_url, status: presence } : undefined}
      onAvatarClick={() => setUserMenuOpen(!userMenuOpen)}
      avatarExpanded={userMenuOpen}
      avatarRef={menuRef}
      avatarMenu={(
        <ShellTransition
          show={userMenuOpen}
          enterActive="transition ease-out duration-100"
          enterFrom="opacity-0 scale-95"
          leaveActive="transition ease-in duration-75"
          leaveTo="opacity-0 scale-95"
          enterMs={100}
          leaveMs={75}
        >
          {cls => (
            <div className={cn('absolute right-0 top-full z-dropdown mt-2 origin-top-right', cls)}>
              <LayoutUserMenu onClose={() => setUserMenuOpen(false)} />
            </div>
          )}
        </ShellTransition>
      )}
      noSafeTop={noSafeTop}
    />
  )
}

export default LayoutTopBar
