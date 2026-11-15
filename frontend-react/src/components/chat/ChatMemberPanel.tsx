/**
 * 멤버 열. Vue 원본: frontend/components/chat/ChatMemberPanel.vue
 *  묶음 = hoist 역할(계층순) → 온라인 → 오프라인(utils/chatMemberGroups — by-role 이 없으면 온라인/오프라인만).
 *  묶음 제목: 위 20 · 아래 4, 12/600 muted "역할 — 인원"(button, aria-expanded — 1,000명 넘는 묶음만 접기 화살표).
 *  행 42 · 아바타 32 + 상태 점 10 · 이름 16(역할 색 text-role-N, 500) · 상태 한 줄 12 muted. 호버 bg-overlay-hover.
 *  오프라인: 아바타 50% + 이름 muted (디스코드 30% 투명 대신 — 접근성 결정, 글자는 흐리지 않는다).
 *  1,000명 넘는 묶음: 처음 3명 + "N명 더 보기"(32, 테두리).
 *  행 누르면 프로필 팝아웃(useChatUi.setProfilePopout). 머리글 없음(디스코드) — 덮개(1180 미만)는 헤더 토글·Esc 로 닫는다.
 * 모바일(전체 화면): 머리 56(‹ 대화로 · "멤버 N" · 초대) · 제목 13/600 pt-16 · 행 56(아바타 40, 점 12, 상태 13).
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { chatStore, presenceOf, setShowMemberPanel } from '~/composables/useChat'
import { anchorOf, initialOf, setInviteOpen, setProfilePopout } from '~/composables/useChatUi'
import { chatRolesStore, loadMemberGroups, loadRoles, roleTextClass } from '~/composables/useChatRoles'
import { useIsMobile } from '~/composables/useIsMobile'
import { groupMembers, visibleMembers, type MemberGroup } from '~/utils/chatMemberGroups'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiIcon } from '~/components/ui/Icon'
import type { ChannelMember } from '~/composables/useChat'

const nf = new Intl.NumberFormat('ko-KR')

/** 채널 멤버 열 */
export function ChatMemberPanel({ className }: { className?: string }) {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const members = useStore(chatStore, s => s.members)
  const channel = useStore(chatStore, s => s.channels.find(c => c.id === s.selectedChannelId) ?? null)
  const presences = useStore(chatStore, s => s.presences)
  const onlineUsers = useStore(chatStore, s => s.onlineUsers)
  const byRole = useStore(chatRolesStore, s => (channel ? s.memberGroups[channel.id] : undefined))
  const channelId = channel?.id

  const byRoleMissing = byRole === undefined
  useEffect(() => {
    if (!channelId) return
    void loadRoles()
    void loadMemberGroups(channelId)
    // 역할이 바뀌어 묶음이 비워지면(handleRolesEvent) 다시 읽는다
  }, [channelId, members.length, byRoleMissing])

  const groups = useMemo(() => {
    const s = chatStore.getState()
    return groupMembers<ChannelMember>(members, id => presenceOf(id, s).state !== 'offline', byRole)
    // presences·onlineUsers 가 바뀌면 다시 묶는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, byRole, presences, onlineUsers])

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const total = channel?.member_count || members.length

  const title = (g: MemberGroup<ChannelMember>) => {
    const label = g.kind === 'role' ? g.role!.name : g.kind === 'online' ? t('chat.shell.members.online') : t('chat.shell.members.offline')
    return `${label} — ${nf.format(g.members.length)}`
  }

  return (
    <aside
      aria-label={t('chat.shell.members.title')}
      className={cn('flex h-full w-full shrink-0 flex-col bg-background', className)}
      data-testid="chat-member-panel"
    >
      {mobile && (
        <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-1">
          <UiIconButton label={t('chat.shell.members.back')} icon="chevron-left" size="lg" noTooltip className="text-foreground" onClick={() => setShowMemberPanel(false)} />
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-foreground">
            {t('chat.shell.members.title')} <span className="font-mono text-[14px] font-normal text-muted-foreground">{nf.format(total)}</span>
          </h2>
          {channel && channel.type !== 'dm' && (
            <UiIconButton label={t('chat.shell.members.invite')} icon="user-plus" size="lg" noTooltip onClick={() => setInviteOpen(true)} />
          )}
        </header>
      )}

      <div className={cn('min-h-0 flex-1 overflow-y-auto px-2 pb-4')}>
        {groups.length === 0 && (
          <p className="px-2 pt-5 text-[13px] text-muted-foreground">{t('chat.shell.members.empty')}</p>
        )}
        {groups.map((g) => {
          const isCollapsed = !!collapsed[g.key]
          const rows = visibleMembers(g, isCollapsed, !!expanded[g.key])
          const more = g.members.length - rows.length
          return (
            <section key={g.key} className="flex flex-col gap-px" aria-label={title(g)}>
              <h3>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  disabled={!g.big}
                  className={cn(
                    'flex w-full items-center gap-1 rounded px-2 text-left font-semibold text-muted-foreground disabled:cursor-default focus-visible:outline-2 focus-visible:outline-ring',
                    mobile ? 'min-h-11 pb-1 pt-4 text-[13px]' : 'pb-1 pt-5 text-[12px]',
                  )}
                  onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))}
                >
                  {g.big && <UiIcon name="chevron-down" className={cn('h-3 w-3 shrink-0 transition-transform duration-100 motion-reduce:transition-none', isCollapsed ? '-rotate-90' : '')} strokeWidth={2.4} />}
                  <span className="truncate">{title(g)}</span>
                </button>
              </h3>
              {rows.map(({ member: m, online, color }) => {
                const p = presenceOf(m.user_id, chatStore.getState())
                const name = m.display_name || m.username
                const line = p.text ? `${p.emoji ? p.emoji + ' ' : ''}${p.text}` : p.state === 'away' || p.state === 'dnd' ? t(`ui.status.${p.state}`) : ''
                return (
                  <button
                    key={m.user_id}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-overlay-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    )}
                    style={{ height: mobile ? 56 : 42 }}
                    aria-label={[name, online ? t(`ui.status.${p.state}`) : t('ui.status.offline'), line].filter(Boolean).join(', ')}
                    onClick={(e) => setProfilePopout({ userId: m.user_id, anchor: anchorOf(e.currentTarget) })}
                  >
                    <span className={cn('relative shrink-0', online ? '' : 'opacity-50')}>
                      <UiAvatar src={m.avatar_url} alt="" fallback={initialOf(name)} className={mobile ? 'h-10 w-10' : 'h-8 w-8'} textSize={mobile ? 14 : 12} />
                      {online && <UiStatusDot status={p.state} size={mobile ? 12 : 10} ring="background" className="absolute -bottom-0.5 -right-0.5" />}
                    </span>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className={cn('block truncate text-[16px]', online ? cn('font-medium', roleTextClass(color) || 'text-foreground') : 'text-muted-foreground')}>{name}</span>
                      {line && <span className={cn('block truncate text-muted-foreground', mobile ? 'text-[13px]' : 'text-[12px]')}>{line}</span>}
                    </span>
                  </button>
                )
              })}
              {more > 0 && !isCollapsed && (
                <button
                  type="button"
                  className={cn('mx-2 mt-1 rounded-lg border border-border text-[13px] text-muted-foreground hover:bg-overlay-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring', mobile ? 'h-11' : 'h-8')}
                  onClick={() => setExpanded(x => ({ ...x, [g.key]: true }))}
                >{t('chat.shell.members.more', { n: nf.format(more) })}</button>
              )}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

export default ChatMemberPanel
