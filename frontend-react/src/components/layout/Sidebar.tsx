/**
 * 셸 사이드바(Vue components/layout/Sidebar.vue) — wide 하나로 rail(64) ↔ 확장(236) 두 모습을 만든다.
 * 폭·덮기/밀기 판단은 layouts/default(spacer+panel)와 useSidebar 가 한다.
 * 겉모습은 키트 UiAppRail — 이 파일은 스토어(네비·채팅 멘션·통화·내 상태·고정)를 항목 데이터로 잇기만 한다.
 */
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { NuxtLink } from '~/components/NuxtLink'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { useNav, isNavActive, type NavItem } from '~/composables/useNav'
import { useSidebar } from '~/composables/useSidebar'
import { useRailTools } from '~/composables/useRailTools'
import { useChat } from '~/composables/useChat'
import { useMyStatus } from '~/composables/useMyStatus'
import { useMeetingCall } from '~/composables/useMeetingCall'
import { useApprovalsCount } from '~/composables/useApprovals'
import { useAiGenerating } from '~/composables/useAiStreams'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiAppRail, type UiAppRailGroup, type UiAppRailItem } from '~/components/ui/AppRail'
import { useStore } from 'zustand'
import { chatUiStore, toggleListCollapsed } from '~/composables/useChatUi'

export interface LayoutSidebarProps {
  /** 넓게(236) 그릴지 — false 면 레일(64) */
  wide?: boolean
  /** 항목을 눌러 이동할 때 */
  onNavigate?: () => void
  className?: string
  /** 아바타 줄 위 끼움(음성채널 접속 바 — layouts/default 가 준다) */
  footerSlot?: ReactNode
}

export function LayoutSidebar({ wide, onNavigate, className, footerSlot }: LayoutSidebarProps) {
  const { t } = useI18n()
  const route = useRoute()
  const { appName, brandLogo, config } = useSiteConfig()
  const { user } = useAuth()
  // 레일은 rail:false(연락처 등 하위 모듈)를 뺀 묶음
  const { home, railGroups: groups } = useNav()
  const { pinned, togglePin } = useSidebar()
  // '도구' 묶음(격리 브라우저·네트워크 랩 — 바깥 출처 새 탭). 없으면 null
  const tools = useRailTools()
  // 채팅 항목 배지 = 나를 부른 것(멘션 + DM) — 채팅 시안 레일 규칙. 회의 항목 = 통화 중이면 초록 점.
  const { totalMentions: chatMentions, callStates } = useChat()
  // 아바타 상태점 — 서버 상태 기준(오프라인으로 표시 중이면 offline)
  const { dot: presence } = useMyStatus()
  // 내가 통화 중이어도(미니 통화 창으로 내려 둔 통화 포함) 켠다
  const { inCall: meInCall } = useMeetingCall()
  const liveCall = meInCall || Object.values(callStates).some(c => c.count > 0)
  // 승인 대기함 — 대기 건이 있을 때만 배지와 함께(사용자 결정)
  const approvalsPending = useApprovalsCount() ?? 0
  // 내장 AI 가 답변을 만드는 중(다른 화면에 있어도 — 서버가 끝까지 만든다, useAiStreams)
  const aiGenerating = useAiGenerating()

  const displayName = user?.display_name ?? user?.username ?? ''
  const initial = (displayName || 'U').charAt(0).toUpperCase()
  // 태그라인은 로그인 화면과 같은 설정값(brand.tagline) — 하드코딩 제거(8-1-6)
  const tagline = (config?.['brand.tagline'] ?? '').trim() || 'self-hosted workspace'
  const emit = () => onNavigate?.()
  // 사이드바 하단에 내 계정 패널이 있는 화면(채팅)은 레일 아바타를 뺀다. 채널 목록을 접으면 다시 레일에.
  const chatListCollapsed = useStore(chatUiStore, s => s.listCollapsed)
  const pageHasAccount = !!route.meta.sidebarAccount && !(route.path === '/chat' && chatListCollapsed)
  // 채팅 화면에서 레일의 채팅 아이콘을 다시 누르면 채널 목록을 접고 편다
  function onRailNavigate(item: UiAppRailItem | null, e: { preventDefault: () => void }) {
    if (item?.to === '/chat' && route.path === '/chat') { e.preventDefault(); toggleListCollapsed() }
    emit()
  }

  // 표시는 키트(UiAppRail) — 여기서는 현재 경로·배지·통화 상태만 항목으로 바꾼다
  const toItem = (it: NavItem): UiAppRailItem => {
    const isChat = it.route === '/chat'
    return {
      id: it.id,
      label: it.name,
      icon: it.icon,
      to: it.route,
      active: isNavActive(it, route.path),
      badge: isChat && chatMentions > 0 ? chatMentions : undefined,
      ariaLabel: isChat && chatMentions > 0 ? t('shell.sidebar.chatMentions', { name: it.name, n: chatMentions }) : it.name,
      live: (it.id === 'meetings' && liveCall) || (it.id === 'ai' && aiGenerating),
      ...(it.id === 'ai' && aiGenerating ? { liveLabel: t('ai.run.generating') } : {}),
    }
  }
  const navGroups: UiAppRailGroup[] = groups.map(g => ({ key: g.key, label: g.label, items: g.items.map(toItem) }))
  // 도구 묶음은 관리(system) 묶음 바로 앞 — 관리가 없으면 맨 끝
  if (tools) {
    const at = navGroups.findIndex(g => g.key === 'system')
    navGroups.splice(at < 0 ? navGroups.length : at, 0, tools)
  }
  if (approvalsPending > 0) {
    const approvals: UiAppRailItem = {
      id: 'approvals',
      label: t('approvals.rail'),
      icon: 'shield',
      to: '/approvals',
      active: route.path === '/approvals' || route.path.startsWith('/approvals/'),
      badge: approvalsPending,
      ariaLabel: t('approvals.railAria', { n: approvalsPending }),
    }
    // AI 바로 뒤 — AI 가 없으면 '작업' 묶음 끝, 그것도 없으면 관리 앞 단독 묶음
    const gi = navGroups.findIndex(g => g.items.some(i => i.id === 'ai'))
    if (gi >= 0) {
      const items = [...navGroups[gi].items]
      items.splice(items.findIndex(i => i.id === 'ai') + 1, 0, approvals)
      navGroups[gi] = { ...navGroups[gi], items }
    } else {
      const wi = navGroups.findIndex(g => g.key === 'work')
      if (wi >= 0) navGroups[wi] = { ...navGroups[wi], items: [...navGroups[wi].items, approvals] }
      else {
        const at = navGroups.findIndex(g => g.key === 'system')
        navGroups.splice(at < 0 ? navGroups.length : at, 0, { key: 'approvals', items: [approvals] })
      }
    }
  }
  const railGroups: UiAppRailGroup[] = [
    { key: '__home', items: [toItem(home)] },
    ...navGroups,
  ]

  return (
    <UiAppRail
      wide={wide}
      className={className}
      brand={{ name: appName, tagline, logo: brandLogo || undefined }}
      groups={railGroups}
      onNavigate={onRailNavigate}
      userName={displayName}
      footerSlot={footerSlot}
      avatar={user && !pageHasAccount ? (
        <NuxtLink to="/settings/account" title={displayName} aria-label={t('shell.sidebar.userSettings', { name: displayName })} className="relative inline-flex shrink-0" onClick={emit}>
          <UiAvatar src={user.avatar_url} alt={displayName} fallback={initial} className="h-[26px] w-[26px]" textSize={11} />
          <UiStatusDot status={presence} size={10} ring="card" className="absolute -bottom-0.5 -right-0.5" />
        </NuxtLink>
      ) : undefined}
      footerAction={(
        <UiIconButton
          label={pinned ? t('nav.unpin') : t('nav.pin')}
          icon="panel-left"
          keys={['Ctrl', '\\']}
          pressed={pinned}
          className={cn('h-6 w-6 rounded-sm border [&>svg]:h-3 [&>svg]:w-3', pinned ? 'border-primary bg-primary/[0.13] text-primary hover:text-primary' : 'border-border')}
          onClick={togglePin}
        />
      )}
    />
  )
}

export default LayoutSidebar
