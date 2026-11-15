/**
 * 채팅 설정 — 채팅 안 전체 화면. useChatUi.settings 가 있으면 pages/chat 이 띄운다.
 * 데스크톱: 왼쪽 메뉴 300(안쪽 200, 오른쪽 정렬, card) + 본문(px 40 · py 40, 최대 860) — 닫기 ✕(ESC).
 *   메뉴: "<채팅 이름> · 채팅" 개요 · 역할 · 카테고리·채널 권한 · 커스텀 이모지 · 알림 기본값 · (전역 관리자) 서버 전역 정책 |
 *   "내 설정" 프로필 · 음성 · 메시지 표시 · 알림.
 * 섹션: 'overview' | 'roles' | 'channel-perm'(targetId=채널) | 'category-perm'(targetId=카테고리) | 'emoji' | 'notify-default' |
 *   'policy' | 'profile' | 'voice' | 'display' | 'notify'.
 * 저장 안 된 변경(역할 편집)이 있으면 다른 섹션으로 가려 할 때 띠를 흔들고, 닫기(✕·Esc)는 확인 대화 상자.
 * 모바일: 한 화면씩 — 섹션 목록 → 섹션(→ 편집). 열 때 섹션을 주면 바로 그 섹션.
 */
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { getSharedState, setSharedState } from '~/lib/state'
import { useIsMobile } from '~/composables/useIsMobile'
import { useChatServerName } from './serverSettingsStore'
import { authStore } from '~/composables/useAuth'
import { chatUiStore, closeChatSettings, openChatSettings } from '~/composables/useChatUi'
import { chatStore, fetchAllUsers } from '~/composables/useChat'
import { chatLayoutStore, loadCategories } from '~/composables/useChatLayout'
import { loadCatalog, loadMyWorkspacePerms, loadRoles, loadUserRoles } from '~/composables/useChatRoles'
import { confirmBox } from '~/composables/useDialog'
import { UiIcon } from '~/components/ui/Icon'
import { navigateTo } from '~/lib/router'
import { normalizeSection, type SettingsSection } from './settingsLogic'
import { SettingsCtx, MobileHeader } from './parts'
import { requestLeave, settingsUiStore, setSettingsDirty } from './settingsStore'
import { RolesSection } from './RolesSection'
import { ChannelOverwrites } from './ChannelOverwrites'
import { CustomEmojiSection } from './CustomEmojiSection'
import { VoiceSection } from './VoiceSection'
import { PolicySection } from './PolicySection'
import { NotifyDefaultSection, OverviewSection } from './ServerSections'
import { DisplaySection, NotifySection, ProfileSection } from './MySections'

type NavKey = SettingsSection
interface NavItem { key: NavKey; label: string }

/** 저장 안 된 변경이 있으면 묻고 닫는다 */
export async function closeSettingsGuarded(t: (k: string) => string, onClose: () => void = closeChatSettings): Promise<boolean> {
  if (settingsUiStore.getState().dirty) {
    const ok = await confirmBox(t('chat.settings.dirty.closeConfirm'), { confirmLabel: t('chat.settings.dirty.closeDiscard'), danger: true })
    if (!ok) return false
    setSettingsDirty(false)
  }
  onClose()
  return true
}

export function ChatSettingsScreen({ onClose }: { onClose?: () => void } = {}) {
  const { t } = useI18n()
  const settings = useStore(chatUiStore, s => s.settings)
  const isMobile = useIsMobile()
  const appName = useChatServerName()
  const isAdmin = useStore(authStore, s => !!s.user?.is_admin)
  const section = normalizeSection(settings?.section)
  const targetId = settings?.targetId ?? null
  // 모바일: 섹션 목록(null) ↔ 섹션 — 열 때 섹션을 줬으면 그 섹션부터
  const [mobileMenu, setMobileMenu] = useState(false)

  // 데이터 — 열 때 한 번
  useEffect(() => {
    if (!settings) return
    void loadRoles(true)
    void loadCatalog()
    void loadMyWorkspacePerms()
    const me = authStore.getState().user?.id
    if (me) void loadUserRoles(me)
    if (!chatLayoutStore.getState().loaded) void loadCategories()
    if (!chatStore.getState().allUsers.length) void fetchAllUsers()
  }, [!!settings]) // eslint-disable-line react-hooks/exhaustive-deps

  // 모바일 탭바 숨기기
  useEffect(() => {
    if (!settings || !isMobile) return
    const prev = getSharedState<boolean>('mobile-detail-open', () => false)
    setSharedState('mobile-detail-open', true)
    return () => { setSharedState('mobile-detail-open', prev) }
  }, [!!settings, isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { void closeSettingsGuarded(t, onClose ?? closeChatSettings) }

  // Esc = 닫기(다른 대화 상자·키 기록 중이면 그쪽이 먼저)
  useEffect(() => {
    if (!settings) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelectorAll('[role="dialog"]').length > 1 || document.querySelector('[data-ptt-recording]')) return
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [!!settings]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings) return null

  const ws: NavItem[] = [
    { key: 'overview', label: t('chat.settings.nav.overview') },
    { key: 'roles', label: t('chat.settings.nav.roles') },
    { key: 'channel-perm', label: t('chat.settings.nav.channelPerm') },
    { key: 'emoji', label: t('chat.settings.nav.emoji') },
    { key: 'notify-default', label: t('chat.settings.nav.notifyDefault') },
    ...(isAdmin ? [{ key: 'policy' as const, label: t('chat.settings.nav.policy') }] : []),
  ]
  const mine: NavItem[] = [
    { key: 'profile', label: t('chat.settings.nav.profile') },
    { key: 'voice', label: t('chat.settings.nav.voice') },
    { key: 'display', label: t('chat.settings.nav.display') },
    { key: 'notify', label: t('chat.settings.nav.notify') },
  ]
  const selNav: NavKey = section === 'category-perm' ? 'channel-perm' : section
  /** 계정·보안·연결 등 워크스페이스 전체 사용자 설정 — 채팅 밖 /settings */
  function openWorkspaceSettings() {
    if (!requestLeave()) return
    closeChatSettings()
    void navigateTo('/settings')
  }
  function go(it: NavItem) {
    if (!requestLeave()) return
    openChatSettings(it.key, null)
    setMobileMenu(false)
  }

  const content = (() => {
    switch (section) {
      case 'roles': return <RolesSection />
      case 'channel-perm': return <ChannelOverwrites kind="channel" targetId={targetId} />
      case 'category-perm': return <ChannelOverwrites kind="category" targetId={targetId} />
      case 'emoji': return <CustomEmojiSection />
      case 'voice': return <VoiceSection />
      case 'policy': return isAdmin ? <PolicySection /> : <RolesSection />
      case 'overview': return <OverviewSection />
      case 'notify-default': return <NotifyDefaultSection />
      case 'profile': return <ProfileSection />
      case 'display': return <DisplaySection />
      case 'notify': return <NotifySection />
    }
  })()

  const ctx = { mobile: isMobile, close, backToMenu: () => { if (requestLeave()) setMobileMenu(true) } }

  if (isMobile) {
    return (
      <SettingsCtx.Provider value={ctx}>
        <div role="dialog" aria-modal="true" aria-label={t('chat.settings.title')} className="absolute inset-0 z-drawer flex h-full flex-col bg-background text-foreground">
          {mobileMenu
            ? (
              <div className="flex h-full flex-col">
                <MobileHeader title={t('chat.settings.title')} onBack={close} />
                <nav aria-label={t('chat.settings.navAria')} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                  {[{ h: t('chat.settings.navWorkspace', { app: appName }), items: ws }, { h: t('chat.settings.navMine'), items: mine }].map(g => (
                    <div key={g.h}>
                      <p className="px-1 pb-1 pt-4 text-[13px] font-semibold text-muted-foreground">{g.h}</p>
                      {g.items.map(it => (
                        <button key={it.key} type="button" className="flex min-h-14 w-full items-center gap-3 border-b border-border px-1 text-left text-[16px] hover:bg-overlay-hover" onClick={() => go(it)}>
                          <span className="flex-1">{it.label}</span>
                          <UiIcon name="chevron-right" className="h-5 w-5 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  ))}
                  <button type="button" className="mt-4 flex min-h-14 w-full items-center gap-3 border-b border-border px-1 text-left text-[16px] text-muted-foreground hover:bg-overlay-hover" onClick={openWorkspaceSettings}>
                    <span className="flex-1">{t('chat.settings.nav.workspaceSettings')}</span>
                    <UiIcon name="external-link" className="h-5 w-5" />
                  </button>
                </nav>
              </div>
            )
            : <div className="min-h-0 flex-1">{content}</div>}
        </div>
      </SettingsCtx.Provider>
    )
  }

  const navBtn = (it: NavItem) => (
    <button
      key={it.key}
      type="button"
      aria-current={it.key === selNav ? 'page' : undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        it.key === selNav ? 'bg-overlay-selected font-semibold text-foreground' : 'text-muted-foreground hover:bg-overlay-hover hover:text-foreground',
      )}
      onClick={() => go(it)}
    >
      <span className="min-w-0 flex-1 truncate">{it.label}</span>
    </button>
  )

  return (
    <SettingsCtx.Provider value={ctx}>
      <div role="dialog" aria-modal="true" aria-label={t('chat.settings.title')} className="absolute inset-0 z-drawer flex h-full bg-background text-foreground">
        <nav aria-label={t('chat.settings.navAria')} className="flex shrink-0 justify-end overflow-y-auto border-r border-border bg-card py-10 pr-3" style={{ width: 300 }}>
          <div className="flex flex-col gap-0.5" style={{ width: 200 }}>
            <p className="truncate px-2 pb-1 pt-4 text-[12px] font-semibold text-muted-foreground">{t('chat.settings.navWorkspace', { app: appName })}</p>
            {ws.map(navBtn)}
            <p className="px-2 pb-1 pt-4 text-[12px] font-semibold text-muted-foreground">{t('chat.settings.navMine')}</p>
            {mine.map(navBtn)}
            <div className="mx-2 my-2 h-px bg-border" />
            <button type="button" className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[15px] text-muted-foreground hover:bg-overlay-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={openWorkspaceSettings}>
              <span className="min-w-0 flex-1 truncate">{t('chat.settings.nav.workspaceSettings')}</span>
              <UiIcon name="external-link" className="h-4 w-4" />
            </button>
          </div>
        </nav>
        <main className="relative min-w-0 flex-1 overflow-y-auto px-10 py-10">
          <div className="flex min-h-full flex-col" style={{ maxWidth: 860 }}>{content}</div>
        </main>
      </div>
    </SettingsCtx.Provider>
  )
}

export default ChatSettingsScreen
