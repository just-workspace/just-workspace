/**
 * 기본 셸 — Vue layouts/default.vue 그대로.
 * 사이드바(데스크톱) · 상단바 · 공지/모듈 오류 배너 · 본문 · 하단 탭바(모바일) · 활동 패널 · 미니 통화 창 · PWA 배너 · Ctrl K 팰릿 · 단축키 도움말.
 *
 * 규약: children 이 있으면 그것을, 없으면 라우터 <Outlet/> 을 본문에 그린다(AuthErrorScreen 의 셸 안 404 가 children 으로 쓴다).
 * 라우터에서 Admin/Settings 레이아웃은 이 레이아웃의 자식(pathless)이다.
 * Vue onErrorCaptured → 본문을 <AppErrorBoundary scope="layout"> 로 감싼다(같은 토스트).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Outlet } from 'react-router'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useRoute, navigateTo } from '~/lib/router'
import { useEventListener } from '~/lib/dom'
import { useSharedState } from '~/lib/state'
import { AppErrorBoundary } from '~/components/AppErrorBoundary'
import { usePlatform, fetchModules, platformStore } from '~/composables/usePlatform'
import { useSiteConfig, fetchAppConfig, isZoneInstalled } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { useAuth, authStore } from '~/composables/useAuth'
import { useIsMobile } from '~/composables/useIsMobile'
import { useSidebar } from '~/composables/useSidebar'
import { useDesktopShell } from '~/composables/useDesktopShell'
import { useAttention } from '~/composables/useAttention'
import { useShell, shellStore, setCommandPaletteOpen, openPalette, openShortcuts, closeActivity } from '~/composables/useShell'
import { useUserPrefs } from '~/composables/useUserPrefs'
import { pushRecent } from '~/composables/useRecents'
import { useNav, isNavActive, navHome } from '~/composables/useNav'
import { clearBreadcrumb } from '~/composables/useBreadcrumb'
import { useMeetingCall } from '~/composables/useMeetingCall'
import { useMeetings } from '~/composables/useMeetings'
import { initChat } from '~/composables/useChat'
import { ensureApprovals } from '~/composables/useApprovals'
import { useOwnMobileHeaderActive } from '~/composables/useOwnMobileHeader'
import { isMeetingRoomPath } from '~/utils/miniCall'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { LayoutSidebar } from '~/components/layout/Sidebar'
import { LayoutTopBar } from '~/components/layout/TopBar'
import { LayoutMobileTabBar } from '~/components/layout/MobileTabBar'
import { LayoutActivityPanel } from '~/components/layout/ActivityPanel'
import { LayoutShortcutsModal } from '~/components/layout/ShortcutsModal'
import { LayoutMiniCall } from '~/components/layout/MiniCall'
import { VoiceConnectedBar } from '~/components/voice/VoiceConnectedBar'
import { VoiceHiresDialog } from '~/components/voice/VoiceHiresDialog'
import { useVoice } from '~/composables/useVoice'
import { PwaInstallBanner } from '~/components/pwa/InstallBanner'
import { LayoutStorageDownBanner } from '~/components/layout/StorageDownBanner'
import { CommandPalette } from '~/components/CommandPalette'
import { connectDesktopBridge } from '~/lib/desktopBridge'
import { ensureAiArtifacts } from '~/composables/useAiArtifacts'
import { AiArtifactToasts } from '~/components/ai/AiArtifactToasts'

function readDismissed(): string | null {
  try { return localStorage.getItem('announcement-dismissed') } catch { return null }
}

export function DefaultLayout({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  const { modules: platformModules } = usePlatform()
  const { announcement, announcementType } = useSiteConfig()
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const route = useRoute()
  const { wide, pushes, onEnter, onLeave, pinned, togglePin, init: initSidebar } = useSidebar()
  // 데스크톱 셸(Electron) 0.5.0+ 는 창 테두리만 그리고 껍데기는 전부 웹이 그린다.
  // 자체 레일·상단바가 있던 옛 셸(0.5.0 미만)에서만 웹 껍데기를 숨긴다 — 두 벌이 되지 않게.
  const { isDesktopShell, shellHidesWebChrome: hideChrome } = useDesktopShell()
  // 나를 부른 것 수 → 탭 제목·파비콘
  useAttention()
  // 셸 전역 열림 상태(활동 패널·단축키·팰릿) + 밀도 적용 + 최근 방문 기록
  const { commandPaletteOpen } = useShell()
  useUserPrefs()
  const { flat } = useNav()
  // 하단 탭바는 '목록'에선 유지, detail(대화/본문)·통화에서만 숨긴다.
  // 각 페이지가 detail 열림을 useSharedState('mobile-detail-open')로 셸에 알린다.
  const [detailOpen] = useSharedState<boolean>('mobile-detail-open', () => false)
  // 하단을 컨트롤이 쓰는 화면 — 탭바를 숨긴다.
  // 플러그인은 manifest 에 "fullscreen": true 를 두면 같은 대우를 받는다. 코어는 어떤
  // 플러그인이 그런지 몰라도 된다 — 플러그인 이름을 여기 하드코딩하지 않는다.
  // (플러그인 라우트는 manifest 의 route 그대로다. 폴더명과 다를 수 있다.)
  const inCall = route.path.startsWith('/meetings/room/') ||
    platformModules.some(m => m.type === 'plugin' && m.fullscreen && route.path.startsWith(m.route))
  const hideBottomNav = detailOpen || inCall
  // 미니 통화 창: 회의 화면을 떠나도 통화가 이어지면 데스크톱은 떠 있는 창, 모바일은 상단 36 초록 띠.
  const { visible: miniCallVisible, returnPath: callReturnPath, setReturnPath: setCallReturnPath, inCall: callActive } = useMeetingCall()
  const callBand = miniCallVisible && isMobile && !!user
  // 음성 채널 접속 바(사이드바 하단): 세션(useVoice)이 앱 수준이라 화면을 옮겨도 이어진다.
  // 데스크톱: 채팅 목록 사이드바가 그리는 동안(barHosts>0)은 그쪽, 아니면 셸 사이드바 하단(레일이면 세로 compact).
  // 모바일: 하단 탭 바 바로 위. 데스크톱 셸(Electron, 웹 사이드바 없음)은 채팅 계정 패널이 그리는 동안(barHosts>0)은 그쪽,
  // 아니면(다른 화면·목록 접힘·옛 셸) 본문 아래 한 줄로 남긴다.
  const { inVoice, barHosts } = useVoice()
  const voiceInShellSidebar = inVoice && !isMobile && !hideChrome && barHosts === 0
  // 미니 창 상태에서 통화가 저쪽에서 끝나면(방 종료·내보내짐) 창이 사라지는 이유를 알린다.
  // 미니 창의 "나가기"는 돌아갈 경로를 먼저 지우므로 여기 걸리지 않는다.
  const wasInCall = useRef(callActive)
  useEffect(() => {
    const was = wasInCall.current
    wasInCall.current = callActive
    if (was && !callActive && callReturnPath) {
      if (!isMeetingRoomPath(route.path)) addToast('info', t('meetings.mini.ended'))
      setCallReturnPath(null)
    }
    // 통화 상태가 바뀔 때만(Vue watch(callActive))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callActive])
  // 로그아웃은 새로 고침 없이 /login 으로 간다 — 미니 창으로 내려 둔 통화가 화면 없이 남지 않게 끊는다
  const { leaveRoom: leaveCall } = useMeetings()
  const firstUser = useRef(true)
  useEffect(() => {
    if (firstUser.current) { firstUser.current = false; return }
    if (!user && callActive) { setCallReturnPath(null); void leaveCall() }
    // Vue watch(user)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])
  // 페이지가 모바일 자체 머리를 선언하면(useOwnMobileHeader · routes.ts ownMobileHeader · LayoutMobileDetailBar)
  // 모바일 공용 상단바를 숨긴다 — 제목이 두 번 보이지 않게.
  const ownMobileHeader = useOwnMobileHeaderActive()
  // 데스크톱에서 페이지 머리가 상단바 자리를 맡는 화면(채팅 — 위쪽 크롬 = 채널 머리 48 하나)
  const noDesktopTopbar = !isMobile && !!route.meta.noDesktopTopbar
  const showTopBar = !!user && !hideChrome && !(isMobile && ownMobileHeader) && !noDesktopTopbar

  const [moduleError, setModuleError] = useState(false)
  // 공지 닫음 기억(키에 공지 문구를 담아 문구가 바뀌면 다시 보인다) — Vue watchEffect(localStorage) 대응
  const [dismissedText, setDismissedText] = useState<string | null>(readDismissed)
  const announcementDismissed = dismissedText === announcement

  // Ctrl+K 전환기 · Ctrl+\ 사이드바 고정 · Ctrl+/ 단축키 도움말
  useEventListener(typeof document !== 'undefined' ? document : null, 'keydown', (e: KeyboardEvent) => {
    if (!authStore.getState().user) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'k') { e.preventDefault(); if (shellStore.getState().commandPaletteOpen) setCommandPaletteOpen(false); else openPalette() }
    else if (mod && e.key === '\\') { e.preventDefault(); if (!isMobile) togglePin() }
    else if (mod && e.key === '/') { e.preventDefault(); openShortcuts() }
  })

  // 라우트가 바뀌면: 3단 경로의 "위치" 비움 · 활동 패널 닫기(모바일) · 최근 방문에 모듈 기록
  // (layout effect — 새 화면의 useBreadcrumb(일반 effect)가 그 뒤에 위치를 올린다. Vue 는 부모 watch 가 먼저 돈다)
  const firstPath = useRef(true)
  const navRef = useRef({ flat, isMobile, t })
  navRef.current = { flat, isMobile, t }
  useLayoutEffect(() => {
    if (firstPath.current) { firstPath.current = false; return }
    const path = route.path
    const { flat: items, isMobile: mobile, t: tt } = navRef.current
    clearBreadcrumb()
    if (mobile) closeActivity()
    // 최근 방문은 실제 모듈로(연락처를 메일로 묶지 않음)
    const hit = items.find(i => isNavActive(i, path, false)) ?? (isNavActive(navHome, path) ? navHome : null)
    if (hit && hit.id !== 'dashboard') pushRecent({ key: hit.route, name: hit.name, kind: tt('shell.kind.module'), icon: hit.icon || 'dot', to: hit.route })
  }, [route.path])

  function dismissAnnouncement() {
    setDismissedText(announcement)
    try { localStorage.setItem('announcement-dismissed', announcement) } catch { /* ignore */ }
  }

  const announcementClasses = announcementType === 'warning'
    ? 'bg-warning/10 border-warning/30 text-warning'
    : announcementType === 'error'
      ? 'bg-danger/10 border-danger/30 text-danger'
      : 'bg-primary/10 border-primary/30 text-primary'

  // 데스크톱 앱(0.5.0+)의 이동 명령(트레이·알림 클릭) — 새로 불러오지 않고 라우터로 옮긴다(통화가 끊기지 않게)
  useEffect(() => connectDesktopBridge(p => { void navigateTo(p) }) ?? undefined, [])

  useEffect(() => {
    initSidebar()
    void (async () => {
      if (!platformStore.getState().loaded) {
        try {
          await fetchModules()
        } catch (e: any) {
          console.error('[Layout] fetchModules failed:', e)
          setModuleError(true)
          addToast('warning', t('error.moduleLoadFailed'))
        }
      }
      // 실시간 채널(/ws/chat)은 채팅 화면이 아니라 앱이 연다. 알림·멘션·DM·통화 상태가 어느 화면에서든
      // 바로 오고, 알림 폴링은 소켓이 끊겼을 때의 보정으로만 남는다(useNotifications).
      // 채팅 모듈이 꺼져 있거나 설치되지 않았어도 연다 — 채팅 쪽 불러오기만 initChat 이 건너뛴다.
      if (authStore.getState().user) {
        Promise.resolve(initChat()).catch((e: any) => console.error('[Layout] chat init failed:', e))
      }
      // 아래 둘은 AI 구역 것 — 설치되지 않았으면 부르지 않는다(구역 목록을 모르면 예전처럼 부른다)
      await fetchAppConfig()
      if (isZoneInstalled('ai')) {
        // AI 쓰기 승인 대기 건수(레일 배지·토스트) — 처음 값 + 같은 소켓의 approvals.count 이벤트
        ensureApprovals()
        // AI 결과물 묶음 진행·완료 토스트 — 같은 소켓의 ai.artifact_job 이벤트
        ensureAiArtifacts()
      }
    })()
    // 마운트 한 번(Vue onMounted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    // 높이는 100dvh. 100vh(h-screen)는 모바일 브라우저에서 **툴바가 숨었을 때의
    // 최대 높이**라서, 툴바가 보이는 동안 화면 맨 아래 — 하단 탭바 자리 — 가 브라우저
    // 툴바 밑에 깔린다. 스크롤해서 툴바가 접혀야 탭바가 드러나 "가려진다/늦게 나온다/
    // 사라진다"로 보였다. dvh 를 모르는 구형 브라우저는 h-screen 으로 남는다.
    <div className="flex h-screen supports-[height:100dvh]:h-dvh overflow-hidden bg-background">
      {/* 데스크탑 사이드바: 자리(spacer)와 패널을 분리 — hover 는 덮고(overlay), pin 은 밀어낸다(push).
          pinned=false → 자리는 64 고정, 패널만 236 으로 커지므로 본문이 안 움직인다.
          pinned=true  → 둘 다 236 이라 그림자 없이 평평하게 붙는다.
          hidden md:block: 표시 여부를 CSS 미디어쿼리에도 걸어 둔다(md=768px 이 matchMedia 의
          767px 과 맞물린다) — 폰에 사이드바가 그려지지 않게 하는 이중 안전장치다. */}
      {!isMobile && user && !hideChrome && (
        <div
          className={cn('relative hidden shrink-0 transition-[width] duration-150 ease-out motion-reduce:transition-none md:block', pushes ? 'w-sidebar' : 'w-sidebar-rail')}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          <LayoutSidebar
            className={cn(
              'absolute inset-y-0 left-0 z-sidebar overflow-hidden border-r border-border bg-card transition-[width,box-shadow] duration-150 ease-out motion-reduce:transition-none',
              wide ? 'w-sidebar' : 'w-sidebar-rail',
              wide && !pinned ? 'shadow-lg' : '',
            )}
            wide={wide}
            footerSlot={voiceInShellSidebar ? <VoiceConnectedBar compact={!wide} /> : undefined}
          />
        </div>
      )}

      {/* 우측: 상단바 + 배너 + 본문 + (모바일)하단탭바. relative — 활동 패널(400)이 이 안 오른쪽에 붙는다 */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 모바일 통화 띠: 상태 표시줄(safe-area) 바로 아래 → 그 아래 상단바. 띠가 있으면 노치 여백은 띠 위에서 한 번만. */}
        {callBand && !hideChrome && <div className="shrink-0 bg-background" style={{ height: 'env(safe-area-inset-top)' }} aria-hidden="true" />}
        {/* 미니 통화 창: 모바일은 이 자리에 띠로 끼고, 데스크톱은 fixed 라 흐름을 차지하지 않는다 */}
        {user && miniCallVisible && <LayoutMiniCall mobile={isMobile} />}
        {showTopBar
          ? <LayoutTopBar noSafeTop={callBand} />
          // 공용 상단바 대신 페이지 자체 머리를 쓰는 모바일 화면: 노치(safe-area) 여백은 셸이 한 번만 준다
          : user && !hideChrome && isMobile && !callBand
            ? <div className="shrink-0 bg-background" style={{ height: 'env(safe-area-inset-top)' }} aria-hidden="true" />
            : null}

        {/* Announcement banner */}
        {announcement && !announcementDismissed && (
          // 낮은 창(실효 높이 < 760)에선 띠를 36 으로
          <div className={cn('border-b px-4 py-2 text-sm flex items-center gap-2 low:h-9 low:py-0', announcementClasses)}>
            <UiIcon name="info" className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1">{announcement}</span>
            <UiIconButton label={t('shell.announcementClose')} icon="close" className="-my-1 h-7 w-7 text-current hover:bg-transparent hover:opacity-70" onClick={dismissAnnouncement} />
          </div>
        )}

        {/* Module loading error banner */}
        {moduleError && (
          <div className="bg-warning/10 border-b border-warning/30 px-4 py-2 text-sm text-warning flex items-center gap-2 low:h-9 low:py-0">
            <UiIcon name="alert-triangle" className="h-4 w-4 flex-shrink-0" />
            <span>{t('error.moduleLoadFailed')}</span>
            <span className="ml-auto"><UiIconButton label={t('common.close')} icon="close" className="-my-1 h-7 w-7 text-current hover:bg-transparent hover:opacity-70" onClick={() => setModuleError(false)} /></span>
          </div>
        )}

        {/* 파일 저장소 끊김 — 관리자에게만 */}
        {user && <LayoutStorageDownBanner />}

        <main className="min-h-0 flex-1 overflow-hidden">
          <AppErrorBoundary scope="layout">
            {children ?? <Outlet />}
          </AppErrorBoundary>
        </main>

        {/* 음성 채널 접속 바 — 모바일(탭 바 위)·데스크톱 셸(웹 사이드바 없음, 채팅 계정 패널이 접속 줄을 그리면 생략). 회의 화면(전체)에서는 숨긴다(그 화면이 통화를 맡는다) */}
        {user && inVoice && !inCall && (isMobile || (hideChrome && barHosts === 0)) && <VoiceConnectedBar mobile={isMobile} />}

        {/* 적응형 모바일 하단 탭바 (≤767px, 풀스크린 채팅/회의 제외)
            표시 여부는 컴포넌트 안의 md:hidden(CSS)이 정한다 — 화면폭 판단을 한 곳에 둔다. */}
        {user && !hideBottomNav && !hideChrome && <LayoutMobileTabBar />}

        {/* 활동 패널(벨 → 우측 400). 모바일은 /activity 탭이라 데스크톱만. */}
        {user && !isMobile && !hideChrome && <LayoutActivityPanel />}
      </div>

      {/* 이미 설치형 앱 안이다. PWA 설치를 권할 이유가 없다. */}
      {!isDesktopShell && <PwaInstallBanner />}

      {commandPaletteOpen && <CommandPalette onClose={() => setCommandPaletteOpen(false)} />}
      <AiArtifactToasts />
      {user && <LayoutShortcutsModal />}
      {/* 하이레조 장치 독점 확인 — 데스크톱 앱이 confirmHiresExclusive 로 연다 */}
      {user && <VoiceHiresDialog />}
    </div>
  )
}

export default DefaultLayout
