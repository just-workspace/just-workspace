/**
 * 기본 셸.
 * 사이드바(데스크톱) · 상단바 · 공지/모듈 오류 배너 · 본문 · 하단 탭바(모바일) · 활동 패널 · 미니 통화 창 · PWA 배너 · Ctrl K 팰릿 · 단축키 도움말.
 *
 * 규약: children 이 있으면 children 을, 없으면 라우터 <Outlet/> 을 본문에 렌더링한다(AuthErrorScreen 의 셸 내부 404 가 children 을 사용한다).
 * 라우터에서 Admin/Settings 레이아웃은 본 레이아웃의 자식(pathless)이다.
 * 본문은 <AppErrorBoundary scope="layout"> 로 감싼다(렌더 오류 → 토스트).
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
import { LayoutUpdateCountdownBanner } from '~/components/layout/UpdateCountdownBanner'
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
  // 데스크톱 셸(Electron) 0.5.0+ 는 창 테두리만 렌더링하며 그 외 외곽 UI 는 전부 웹이 렌더링한다.
  // 자체 레일·상단바를 보유한 구버전 셸(0.5.0 미만)에서만 웹 외곽 UI 를 숨긴다(이중 표시 방지).
  const { isDesktopShell, shellHidesWebChrome: hideChrome } = useDesktopShell()
  // 본인 호출 건수 → 탭 제목·파비콘에 반영
  useAttention()
  // 셸 전역 열림 상태(활동 패널·단축키·팰릿) + 밀도 적용 + 최근 방문 기록
  const { commandPaletteOpen } = useShell()
  useUserPrefs()
  const { flat } = useNav()
  // 하단 탭바는 '목록'에서는 유지하고 detail(대화/본문)·통화에서만 숨긴다.
  // 각 페이지는 detail 열림 여부를 useSharedState('mobile-detail-open')로 셸에 전달한다.
  const [detailOpen] = useSharedState<boolean>('mobile-detail-open', () => false)
  // 컨트롤이 하단을 점유하는 화면 — 탭바를 숨긴다.
  // 플러그인은 manifest 에 "fullscreen": true 를 지정하면 동일하게 처리된다. 코어는 해당
  // 플러그인을 식별할 필요가 없다 — 플러그인 이름을 여기에 하드코딩하지 않는다.
  // (플러그인 라우트는 manifest 의 route 와 동일하다. 폴더명과 상이할 수 있다.)
  const inCall = route.path.startsWith('/meetings/room/') ||
    platformModules.some(m => m.type === 'plugin' && m.fullscreen && route.path.startsWith(m.route))
  const hideBottomNav = detailOpen || inCall
  // 미니 통화 창: 회의 화면 이탈 후에도 통화가 유지되면 데스크톱은 플로팅 창, 모바일은 상단 36 초록 띠로 표시한다.
  const { visible: miniCallVisible, returnPath: callReturnPath, setReturnPath: setCallReturnPath, inCall: callActive } = useMeetingCall()
  const callBand = miniCallVisible && isMobile && !!user
  // 음성 채널 접속 바(사이드바 하단): 세션(useVoice)이 앱 수준이므로 화면 이동 후에도 유지된다.
  // 데스크톱: 채팅 목록 사이드바가 렌더링하는 동안(barHosts>0)은 해당 사이드바, 그 외에는 셸 사이드바 하단(레일이면 세로 compact).
  // 모바일: 하단 탭 바 바로 위. 데스크톱 셸(Electron, 웹 사이드바 없음)은 채팅 계정 패널이 렌더링하는 동안(barHosts>0)은 해당 패널,
  // 그 외(다른 화면·목록 접힘·구버전 셸)에는 본문 아래 한 줄로 유지한다.
  const { inVoice, barHosts } = useVoice()
  const voiceInShellSidebar = inVoice && !isMobile && !hideChrome && barHosts === 0
  // 미니 창 상태에서 통화가 상대 측에서 종료되면(방 종료·내보내짐) 창이 사라지는 사유를 안내한다.
  // 미니 창의 "나가기"는 복귀 경로를 먼저 삭제하므로 이 분기에 해당하지 않는다.
  const wasInCall = useRef(callActive)
  useEffect(() => {
    const was = wasInCall.current
    wasInCall.current = callActive
    if (was && !callActive && callReturnPath) {
      if (!isMeetingRoomPath(route.path)) addToast('info', t('meetings.mini.ended'))
      setCallReturnPath(null)
    }
    // 통화 상태 변경 시에만 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callActive])
  // 로그아웃은 새로 고침 없이 /login 으로 이동한다 — 미니 창으로 전환된 통화가 화면 없이 잔존하지 않도록 종료한다
  const { leaveRoom: leaveCall } = useMeetings()
  const firstUser = useRef(true)
  useEffect(() => {
    if (firstUser.current) { firstUser.current = false; return }
    if (!user && callActive) { setCallReturnPath(null); void leaveCall() }
    // user 변경 시 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])
  // 페이지가 모바일 자체 헤더를 선언하면(useOwnMobileHeader · routes.ts ownMobileHeader · LayoutMobileDetailBar)
  // 모바일 공용 상단바를 숨긴다(제목 중복 표시 방지).
  const ownMobileHeader = useOwnMobileHeaderActive()
  // 데스크톱에서 페이지 헤더가 상단바 위치를 대체하는 화면(채팅 — 상단 크롬 = 채널 헤더 48 하나)
  const noDesktopTopbar = !isMobile && !!route.meta.noDesktopTopbar
  const showTopBar = !!user && !hideChrome && !(isMobile && ownMobileHeader) && !noDesktopTopbar

  const [moduleError, setModuleError] = useState(false)
  // 공지 닫음 상태 저장(키에 공지 문구를 포함하므로 문구 변경 시 재표시)
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

  // 라우트 변경 시: 3단 경로의 "위치" 초기화 · 활동 패널 닫기(모바일) · 최근 방문에 모듈 기록
  // (layout effect — 새 화면의 useBreadcrumb(일반 effect)가 그 이후에 위치를 설정한다)
  const firstPath = useRef(true)
  const navRef = useRef({ flat, isMobile, t })
  navRef.current = { flat, isMobile, t }
  useLayoutEffect(() => {
    if (firstPath.current) { firstPath.current = false; return }
    const path = route.path
    const { flat: items, isMobile: mobile, t: tt } = navRef.current
    clearBreadcrumb()
    if (mobile) closeActivity()
    // 최근 방문은 실제 모듈 기준으로 기록(연락처를 메일로 병합하지 않음)
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

  // 데스크톱 앱(0.5.0+)의 이동 명령(트레이·알림 클릭) — 재로드 없이 라우터로 이동한다(통화 단절 방지)
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
      // 실시간 채널(/ws/chat)은 채팅 화면이 아닌 앱이 연결한다. 알림·멘션·DM·통화 상태를 모든 화면에서
      // 즉시 수신하며, 알림 폴링은 소켓 단절 시의 보정 용도로만 유지한다(useNotifications).
      // 채팅 모듈이 비활성화되었거나 미설치 상태여도 연결한다 — 채팅 측 로드만 initChat 이 생략한다.
      if (authStore.getState().user) {
        Promise.resolve(initChat()).catch((e: any) => console.error('[Layout] chat init failed:', e))
      }
      // 아래 두 항목은 AI 구역 소속 — 미설치 시 호출하지 않는다(구역 목록을 알 수 없으면 기존과 같이 호출한다)
      await fetchAppConfig()
      if (isZoneInstalled('ai')) {
        // AI 쓰기 승인 대기 건수(레일 배지·토스트) — 초기값 + 동일 소켓의 approvals.count 이벤트
        ensureApprovals()
        // AI 결과물 묶음 진행·완료 토스트 — 동일 소켓의 ai.artifact_job 이벤트
        ensureAiArtifacts()
      }
    })()
    // 마운트 시 1회 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    // 높이는 100dvh. 100vh(h-screen)는 모바일 브라우저에서 **툴바가 숨겨졌을 때의
    // 최대 높이**이므로, 툴바가 표시되는 동안 화면 최하단(하단 탭바 위치)이 브라우저
    // 툴바 아래에 가려진다. 스크롤로 툴바가 접혀야 탭바가 노출되어 "가려진다/늦게 나온다/
    // 사라진다"로 보고되었다. dvh 미지원 구형 브라우저는 h-screen 으로 유지된다.
    <div className="flex h-screen supports-[height:100dvh]:h-dvh overflow-hidden bg-background">
      {/* 데스크탑 사이드바: 자리(spacer)와 패널을 분리 — hover 는 overlay, pin 은 push 방식이다.
          pinned=false → 자리는 64 고정, 패널만 236 으로 확장되므로 본문은 이동하지 않는다.
          pinned=true  → 둘 다 236 이므로 그림자 없이 평면으로 접한다.
          hidden md:block: 표시 여부를 CSS 미디어쿼리에도 적용한다(md=768px 이 matchMedia 의
          767px 과 대응한다) — 모바일에 사이드바가 렌더링되지 않도록 하는 이중 안전장치이다. */}
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

      {/* 우측: 상단바 + 배너 + 본문 + (모바일)하단탭바. relative — 활동 패널(400)이 이 영역 내부 우측에 배치된다 */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 모바일 통화 띠: 상태 표시줄(safe-area) 바로 아래 → 그 아래 상단바. 띠가 있으면 노치 여백은 띠 위에 1회만 적용. */}
        {callBand && !hideChrome && <div className="shrink-0 bg-background" style={{ height: 'env(safe-area-inset-top)' }} aria-hidden="true" />}
        {/* 미니 통화 창: 모바일은 이 위치에 띠로 삽입되고, 데스크톱은 fixed 이므로 흐름을 차지하지 않는다 */}
        {user && miniCallVisible && <LayoutMiniCall mobile={isMobile} />}
        {showTopBar
          ? <LayoutTopBar noSafeTop={callBand} />
          // 공용 상단바 대신 페이지 자체 헤더를 사용하는 모바일 화면: 노치(safe-area) 여백은 셸이 1회만 적용한다
          : user && !hideChrome && isMobile && !callBand
            ? <div className="shrink-0 bg-background" style={{ height: 'env(safe-area-inset-top)' }} aria-hidden="true" />
            : null}

        {/* Announcement banner */}
        {announcement && !announcementDismissed && (
          // 낮은 창(실효 높이 < 760)에서는 띠 높이를 36 으로 적용
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

        {/* 파일 저장소 연결 끊김 — 관리자에게만 표시 */}
        {user && <LayoutStorageDownBanner />}

        {/* 업데이트 5분 전 사전 공지 — 모든 사용자에게 표시 */}
        {user && <LayoutUpdateCountdownBanner />}

        <main className="min-h-0 flex-1 overflow-hidden">
          <AppErrorBoundary scope="layout">
            {children ?? <Outlet />}
          </AppErrorBoundary>
        </main>

        {/* 음성 채널 접속 바 — 모바일(탭 바 위)·데스크톱 셸(웹 사이드바 없음, 채팅 계정 패널이 접속 줄을 렌더링하면 생략). 회의 화면(전체)에서는 숨긴다(해당 화면이 통화를 담당한다) */}
        {user && inVoice && !inCall && (isMobile || (hideChrome && barHosts === 0)) && <VoiceConnectedBar mobile={isMobile} />}

        {/* 적응형 모바일 하단 탭바 (≤767px, 풀스크린 채팅/회의 제외)
            표시 여부는 컴포넌트 내부의 md:hidden(CSS)이 결정한다 — 화면 폭 판단을 한 곳으로 일원화한다. */}
        {user && !hideBottomNav && !hideChrome && <LayoutMobileTabBar />}

        {/* 활동 패널(벨 → 우측 400). 모바일은 /activity 탭을 사용하므로 데스크톱 전용. */}
        {user && !isMobile && !hideChrome && <LayoutActivityPanel />}
      </div>

      {/* 이미 설치형 앱 내부이므로 PWA 설치 권유 불필요. */}
      {!isDesktopShell && <PwaInstallBanner />}

      {commandPaletteOpen && <CommandPalette onClose={() => setCommandPaletteOpen(false)} />}
      <AiArtifactToasts />
      {user && <LayoutShortcutsModal />}
      {/* 하이레조 장치 독점 확인 — 데스크톱 앱이 confirmHiresExclusive 로 표시한다 */}
      {user && <VoiceHiresDialog />}
    </div>
  )
}

export default DefaultLayout
