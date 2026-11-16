/**
 * 프로필 팝아웃.
 *  배너 64(첫 역할 색 /30, 없으면 muted) → 아바타 80 + 상태 점 12(ring-4 popover) [관리 권한이 있으면 ⋯] → 이름 20/700 · 아이디 13 muted
 *  → 커스텀 상태 14 → 카드(bg-card p-3: 직함 · 소개 · 역할 칩 + [+] · 현지 시각과 차이) → DM 입력(Enter 로 전송) / 본인이면 상태 바꾸기 · 프로필 편집
 *  → "전체 프로필 보기".
 *  ⋯ 메뉴(MANAGE_ROLES 또는 KICK_MEMBERS): 역할 관리 · 멘션 복사 · (구분선) 채널에서 내보내기(danger, 확인).
 *  [+]: 부여 가능한 역할 목록 — 본인 최고 역할 이상(계층 상위)·그룹 연결 역할은 잠금(자물쇠 + 사유).
 * 데이터: chatApi22.fetchChatProfile(구버전 서버이면 chatStore 의 사용자·멤버로 대체) · useChatRoles(rolesOfUser · setUserRoles).
 * 열기: useChatUi.setProfilePopout({ userId, anchor }) — 메시지 이름·아바타(MESSAGES), 멤버 행, 음성 접속자 행.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { authStore } from '~/composables/useAuth'
import { chatStore, openDM, presenceOf, sendMessage, fetchMembers } from '~/composables/useChat'
import { chatUiStore, initialOf, openChatSettings, setProfilePopout } from '~/composables/useChatUi'
import { fetchChatProfile, type ChatProfile } from '~/composables/chatApi22'
import {
  PERM, canInChannel, canWorkspace, chatRolesStore, loadRoles, loadUserRoles, myTopPosition, roleColorIndex, rolesOfUser, setUserRoles,
} from '~/composables/useChatRoles'
import { userPrefsStore } from '~/composables/useUserPrefs'
import { useIsMobile } from '~/composables/useIsMobile'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { $fetch } from '~/lib/api'
import { myTimeZone, profileClock } from '~/utils/chatProfileTime'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { ChatFloating } from './ChatFloating'
import { openAccountMenu } from './ChatAccountPanel'

/** pages/chat 에서 1회 렌더링 */
export function ChatProfilePopoutHost() {
  const pop = useStore(chatUiStore, s => s.profilePopout)
  if (!pop) return null
  return <ChatProfilePopout key={pop.userId} userId={pop.userId} anchor={pop.anchor} onClose={() => setProfilePopout(null)} />
}

export interface ChatProfilePopoutProps {
  userId: string
  anchor: { x: number; y: number; w: number; h: number } | null
  onClose: () => void
}

export function ChatProfilePopout({ userId, anchor, onClose }: ChatProfilePopoutProps) {
  const { t, locale } = useI18n()
  const mobile = useIsMobile()
  const me = useStore(authStore, s => s.user)
  const allUsers = useStore(chatStore, s => s.allUsers)
  const members = useStore(chatStore, s => s.members)
  const channelId = useStore(chatStore, s => s.selectedChannelId)
  const channelType = useStore(chatStore, s => s.channels.find(c => c.id === s.selectedChannelId)?.type)
  const presence = useStore(chatStore, useShallow(s => presenceOf(userId, s)))
  const roles = useStore(chatRolesStore, useShallow(s => rolesOfUser(userId, s)))
  const allRoles = useStore(chatRolesStore, s => s.roles)
  const myTz = useStore(userPrefsStore, s => myTimeZone(s.prefs.timezone))
  // 권한(역할 store 변경 시 재계산)
  useStore(chatRolesStore, s => s.myWorkspacePerms)
  useStore(chatRolesStore, s => s.myChannelPerms)

  const [profile, setProfile] = useState<ChatProfile | null>(null)
  const [dm, setDm] = useState('')
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let alive = true
    fetchChatProfile(userId).then((p) => { if (alive) setProfile(p) }, () => { /* 구버전 서버 — 아래 대체값 사용 */ })
    void loadRoles()
    void loadUserRoles(userId)
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [userId])

  const base = allUsers.find(u => u.id === userId) ?? members.find(m => m.user_id === userId)
  const username = profile?.username ?? base?.username ?? ''
  const name = profile?.display_name || base?.display_name || username || '—'
  const avatar = profile?.avatar_url ?? base?.avatar_url ?? null
  const isMe = profile?.is_me ?? userId === me?.id
  const custom = profile?.custom_status ?? (presence.text ? { emoji: presence.emoji, text: presence.text } : null)
  const handle = [username, profile?.department].filter(Boolean).join(' · ')
  const colorRole = roles.find(r => roleColorIndex(r.color) > 0)
  const bannerCls = colorRole ? `bg-role-${roleColorIndex(colorRole.color)}/30` : 'bg-muted'

  const clock = useMemo(() => {
    if (!profile?.timezone) return null
    const c = profileClock(profile.timezone, myTz, locale === 'en' ? 'en-US' : 'ko-KR', now)
    if (!c) return null
    const rel = isMe ? t('chat.shell.profile.myTime')
      : c.diffHours === 0 ? t('chat.shell.profile.sameTime')
        : c.diffHours > 0 ? t('chat.shell.profile.ahead', { n: fmtHours(c.diffHours) })
          : t('chat.shell.profile.behind', { n: fmtHours(-c.diffHours) })
    return `${c.time} · ${c.city} (${c.utc}) · ${rel}`
  }, [profile?.timezone, myTz, locale, now, isMe, t])

  const canRoles = canWorkspace(PERM.MANAGE_ROLES)
  const isMember = members.some(m => m.user_id === userId)
  const canKick = !isMe && isMember && !!channelId && channelType !== 'dm' && canInChannel(channelId, PERM.KICK_MEMBERS)
  const adminMenu = canRoles || canKick
  const top = myTopPosition()
  const assignable = allRoles.filter(r => !r.is_default && !roles.some(x => x.id === r.id))

  async function sendDm() {
    const text = dm.trim()
    if (!text) return
    try {
      await openDM(userId)
      sendMessage(text)
      setDm('')
      onClose()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.shell.profile.dmFail'))
    }
  }
  function onDmKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendDm() }
  }

  async function onAdmin(key: string) {
    if (key === 'roles') { onClose(); openChatSettings('roles') }
    else if (key === 'mention') {
      try { await navigator.clipboard.writeText(`@${username}`); addToast('success', t('chat.shell.profile.mentionCopied')) } catch { /* 클립보드 권한 없음 */ }
    } else if (key === 'kick' && channelId) {
      if (!await confirmBox(t('chat.shell.profile.kickConfirm', { name }), { danger: true, confirmLabel: t('chat.shell.profile.kick') })) return
      try {
        await $fetch(`/api/chat/channels/${channelId}/members/${userId}`, { method: 'DELETE' })
        await fetchMembers()
        addToast('success', t('chat.shell.profile.kicked', { name }))
        onClose()
      } catch (e: any) {
        addToast('error', e?.data?.detail || t('chat.shell.profile.kickFail'))
      }
    }
  }
  async function addRole(roleId: string) {
    try { await setUserRoles(userId, [...roles.map(r => r.id), roleId]) } catch (e: any) {
      addToast('error', e?.data?.detail?.message || e?.data?.detail || t('chat.shell.profile.roleFail'))
    }
  }

  const adminItems: UiMenuItem[] = [
    ...(canRoles ? [{ key: 'roles', label: t('chat.shell.profile.manageRoles') }] : []),
    { key: 'mention', label: t('chat.shell.profile.copyMention') },
    ...(canKick ? [{ key: 'kick', label: t('chat.shell.profile.kick'), danger: true, separated: true }] : []),
  ]
  const roleItems: UiMenuItem[] = assignable.length
    ? assignable.map((r) => {
      const locked = r.position >= top || r.managed
      return {
        key: r.id, label: r.name, disabled: locked, icon: locked ? 'lock' : undefined,
        description: r.managed ? t('chat.shell.profile.roleManaged') : locked ? t('chat.shell.profile.roleAbove') : undefined,
      }
    })
    : [{ key: '__none', label: t('chat.shell.profile.noRoles'), disabled: true }]

  return (
    <ChatFloating anchor={anchor} width={300} mobile={mobile} ariaLabel={t('chat.shell.profile.aria', { name })} onClose={onClose}>
      <div className={cn('relative', mobile ? 'pb-6' : '')}>
        <div className={cn('h-16', bannerCls)} aria-hidden="true" />
        <div className="relative px-4 pb-4">
          <div className="-mt-10 flex items-end justify-between">
            <span className="relative rounded-full ring-4 ring-popover">
              <UiAvatar src={avatar} alt={name} fallback={initialOf(name)} className="h-20 w-20" textSize={28} />
              <UiStatusDot status={presence.state} size={12} ring="background" className="absolute bottom-1 right-1" />
            </span>
            {adminMenu && !isMe && (
              <UiMenu
                items={adminItems}
                label={t('chat.shell.profile.more')}
                width={192}
                onSelect={(k) => { void onAdmin(k) }}
                trigger={({ toggle, open, controls }) => (
                  <button
                    type="button"
                    aria-label={t('chat.shell.profile.more')}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={controls}
                    className={cn('mb-1 flex items-center justify-center rounded-md text-muted-foreground hover:bg-overlay-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring', mobile ? 'h-11 w-11' : 'h-8 w-8', open ? 'bg-overlay-selected text-foreground' : '')}
                    onClick={toggle}
                  ><UiIcon name="more-horizontal" className="h-5 w-5" /></button>
                )}
              />
            )}
          </div>
          <p className="mt-2 break-words text-[20px] font-bold leading-tight text-foreground">{name}</p>
          {handle && <p className="text-[13px] text-muted-foreground">{handle}</p>}
          {custom?.text && <p className="mt-2 text-[14px] text-foreground">{custom.emoji ? custom.emoji + ' ' : ''}{custom.text}</p>}

          <div className="mt-3 flex flex-col gap-3 rounded-lg bg-card p-3">
            {profile?.job_title && (
              <div>
                <p className="text-[12px] font-semibold text-muted-foreground">{t('chat.shell.profile.jobTitle')}</p>
                <p className="text-[14px] text-foreground">{profile.job_title}</p>
              </div>
            )}
            {profile?.bio && (
              <div>
                <p className="text-[12px] font-semibold text-muted-foreground">{t('chat.shell.profile.bio')}</p>
                <p className="whitespace-pre-line text-[14px] leading-snug text-foreground">{profile.bio}</p>
              </div>
            )}
            {(roles.length > 0 || canRoles) && (
              <div>
                <p className="text-[12px] font-semibold text-muted-foreground">{t('chat.shell.profile.roles')}</p>
                <ul className="mt-1 flex flex-wrap gap-1" aria-label={t('chat.shell.profile.roles')}>
                  {roles.map((r) => {
                    const n = roleColorIndex(r.color)
                    return (
                      <li key={r.id} className="flex h-6 items-center gap-1.5 rounded-md border border-border px-1.5 text-[12px] text-foreground">
                        <span className={cn('h-2.5 w-2.5 rounded-full', n ? `bg-role-${n}` : 'border border-muted-foreground')} aria-hidden="true" />{r.name}
                      </li>
                    )
                  })}
                  {canRoles && (
                    <li>
                      <UiMenu
                        items={roleItems}
                        label={t('chat.shell.profile.addRole')}
                        width={224}
                        onSelect={(k) => { if (k !== '__none') void addRole(k) }}
                        trigger={({ toggle, open, controls }) => (
                          <button
                            type="button"
                            aria-label={t('chat.shell.profile.addRole')}
                            aria-haspopup="menu"
                            aria-expanded={open}
                            aria-controls={controls}
                            className={cn('flex items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring', mobile ? 'h-11 w-11' : 'h-6 w-6')}
                            onClick={toggle}
                          ><UiIcon name="plus" className="h-3.5 w-3.5" /></button>
                        )}
                      />
                    </li>
                  )}
                </ul>
              </div>
            )}
            {clock && (
              <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <UiIcon name="clock" className="h-4 w-4 shrink-0" />{clock}
              </p>
            )}
            {!profile?.job_title && !profile?.bio && !roles.length && !canRoles && !clock && (
              <p className="text-[13px] text-muted-foreground">{t('chat.shell.profile.nothing')}</p>
            )}
          </div>

          {isMe
            ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <UiButton variant="outline" size="sm" onClick={() => { onClose(); if (mobile) void navigateTo('/settings/account'); else openAccountMenu() }}>{t('chat.shell.profile.changeStatus')}</UiButton>
                <UiButton size="sm" onClick={() => { onClose(); void navigateTo('/settings/account') }}>{t('chat.shell.profile.editProfile')}</UiButton>
              </div>
            )
            : (
              <input
                type="text"
                value={dm}
                onChange={e => setDm(e.target.value)}
                onKeyDown={onDmKey}
                aria-label={t('chat.shell.profile.dmPlaceholder', { name })}
                placeholder={t('chat.shell.profile.dmPlaceholder', { name })}
                className={cn('mt-3 w-full rounded-md border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring', mobile ? 'h-11' : 'h-10')}
              />
            )}
          <button
            type="button"
            className={cn('mt-3 rounded text-[13px] font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring', mobile ? 'min-h-11' : '')}
            onClick={() => { onClose(); void navigateTo(isMe ? '/settings/account' : `/contacts?user=${encodeURIComponent(userId)}`) }}
          >{t('chat.shell.profile.fullProfile')}</button>
        </div>
      </div>
    </ChatFloating>
  )
}

function fmtHours(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1)
}

export default ChatProfilePopout
