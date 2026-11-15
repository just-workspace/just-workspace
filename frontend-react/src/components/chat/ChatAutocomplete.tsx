/**
 * 컴포저 자동완성 `:` `@`.
 * 컴포저 위 목록(키트 UiMentionList — 행 36 · 앞 24 · 이름 · 설명 muted · 꼬리표 · 비활성 60% + 이유), 최대 8개,
 * 아래 aria-live 결과 수 + 키 안내. Tab/Enter 고르기 · ↑↓ · Esc(입력의 onKeyDown 에서 useUiMentionList 가 처리).
 *
 * 순수 함수(테스트 대상):
 * - findTrigger(text, cursor) → { kind: 'emoji' | 'mention', start, end, query } | null
 *     `:` 는 2글자부터(공백·줄 처음 뒤), `@` 는 바로부터. 이미 닫힌 `:fire:` 는 아님.
 * - mentionCandidates(query, ctx) → AcItem[] — 역할(멘션할 수 없는 역할은 MENTION_EVERYONE 없으면 비활성 + 이유)
 *     → 사람(채널 멤버 먼저, 그다음 워크스페이스 사람) → @here · @everyone. 최대 8.
 * - emojiCandidates(query, skin) → AcItem[] — 유니코드 + 커스텀(꼬리표 "커스텀"), 최대 8.
 */
import type { ReactNode } from 'react'
import { useI18n } from '~/i18n'
import type { ChannelMember, WorkspaceUser } from '~/composables/useChat'
import { roleTextClass, type ChatRole } from '~/composables/useChatRoles'
import { applySkin, searchEmoji } from '~/composables/useChatEmoji'
import { UiMentionList, type UiMentionOption } from '~/components/ui/MentionList'
import { UiAvatar } from '~/components/ui/Avatar'

export const AC_MAX = 8

export interface AcTrigger { kind: 'emoji' | 'mention'; start: number; end: number; query: string }

export function findTrigger(text: string, cursor: number): AcTrigger | null {
  const before = text.slice(0, cursor)
  const m = /(^|\s)([@:])([^\s@:]*)$/.exec(before)
  if (!m) return null
  const start = before.length - m[3].length - 1
  if (m[2] === '@') return { kind: 'mention', start, end: cursor, query: m[3] }
  if (m[3].length < 2) return null
  return { kind: 'emoji', start, end: cursor, query: m[3] }
}

export type AcLeading =
  | { type: 'avatar'; url: string | null; initial: string }
  | { type: 'glyph'; glyph: string }
  | { type: 'image'; url: string }
  | { type: 'at' }

export interface AcItem {
  id: string
  /** 입력에 넣을 글(뒤에 공백 하나는 넣는 쪽이 붙인다) */
  insert: string
  label: string
  secondary?: string
  /** 꼬리표(역할 · 커스텀) */
  tag?: string
  leading: AcLeading
  disabled?: boolean
  disabledReason?: string
  /** 이름 글자 색(역할 색 text-role-N) */
  nameClass?: string
  /** 이모지 고른 것 — 최근에 올린다(유니코드 기본 글리프 또는 ':name:') */
  recentKey?: string
}

export interface MentionContext {
  members: ChannelMember[]
  users: WorkspaceUser[]
  roles: ChatRole[]
  /** 이 채널에서 MENTION_EVERYONE */
  canEveryone: boolean
  memberCount: number
  onlineCount: number
  myId?: string | null
  /** 사람 → 대표 역할 이름(설명 줄) */
  roleNameOf?: (userId: string) => string | null
  /** 사람 → 이름 색 토큰 키(색이 있는 최고 역할) */
  roleColorOf?: (userId: string) => string | null
  /** 문구(i18n t) */
  t: (k: string, p?: Record<string, unknown>) => string
}

export function mentionCandidates(query: string, ctx: MentionContext): AcItem[] {
  const q = query.toLowerCase()
  const hit = (...xs: Array<string | null | undefined>) => !q || xs.some(x => (x || '').toLowerCase().includes(q))
  const rank = (...xs: Array<string | null | undefined>) => (q && xs.some(x => (x || '').toLowerCase().startsWith(q)) ? 0 : 1)
  const { t } = ctx

  const roles: AcItem[] = (Array.isArray(ctx.roles) ? ctx.roles : [])
    .filter(r => !r.is_default && r.mention && hit(r.name, r.mention))
    .sort((a, b) => rank(a.name, a.mention) - rank(b.name, b.mention) || b.position - a.position)
    .map((r) => {
      const off = !r.mentionable && !ctx.canEveryone
      return {
        id: `role:${r.id}`,
        insert: `@${r.mention}`,
        label: r.name,
        secondary: off ? undefined : (r.member_count != null ? t('chat.compose.ac.roleCount', { n: r.member_count }) : t('chat.compose.ac.role')),
        tag: t('chat.compose.ac.role'),
        leading: { type: 'at' },
        nameClass: off ? 'text-muted-foreground' : roleTextClass(r.color),
        disabled: off,
        disabledReason: off ? t('chat.compose.ac.roleNotMentionable') : undefined,
      }
    })

  const seen = new Set<string>()
  const people: Array<AcItem & { r: number; m: number }> = []
  for (const m of ctx.members || []) {
    if (seen.has(m.user_id) || !hit(m.display_name, m.username)) continue
    seen.add(m.user_id)
    const rn = ctx.roleNameOf?.(m.user_id)
    people.push({
      id: `user:${m.user_id}`, insert: `@${m.username}`, label: m.display_name || m.username,
      secondary: rn ? `${m.username} · ${rn}` : m.username,
      leading: { type: 'avatar', url: m.avatar_url, initial: (m.display_name || m.username || '?').charAt(0).toUpperCase() },
      nameClass: roleTextClass(ctx.roleColorOf?.(m.user_id)),
      r: rank(m.display_name, m.username), m: 0,
    })
  }
  for (const u of ctx.users || []) {
    if (seen.has(u.id) || !hit(u.display_name, u.username)) continue
    seen.add(u.id)
    people.push({
      id: `user:${u.id}`, insert: `@${u.username}`, label: u.display_name || u.username, secondary: u.username,
      leading: { type: 'avatar', url: u.avatar_url, initial: (u.display_name || u.username || '?').charAt(0).toUpperCase() },
      r: rank(u.display_name, u.username), m: 1,
    })
  }
  people.sort((a, b) => a.m - b.m || a.r - b.r)

  const special: AcItem[] = (['here', 'everyone'] as const)
    .filter(k => !q || k.startsWith(q))
    .map(k => ({
      id: `special:${k}`, insert: `@${k}`, label: `@${k}`,
      secondary: ctx.canEveryone
        ? t(k === 'here' ? 'chat.compose.ac.hereDesc' : 'chat.compose.ac.everyoneDesc', { n: (k === 'here' ? ctx.onlineCount : ctx.memberCount).toLocaleString() })
        : undefined,
      leading: { type: 'at' } as AcLeading,
      disabled: !ctx.canEveryone,
      disabledReason: ctx.canEveryone ? undefined : t('chat.compose.ac.everyoneNo'),
    }))

  // 아무것도 안 쳤으면 사람이 먼저 보이게 역할은 둘만
  const roleList = q ? roles : roles.slice(0, 2)
  return [...roleList, ...people.map(({ r: _r, m: _m, ...it }) => it), ...special].slice(0, AC_MAX)
}

export function emojiCandidates(query: string, skin: number, t: MentionContext['t']): AcItem[] {
  return searchEmoji(query, { limit: AC_MAX }).map((h): AcItem => (h.kind === 'custom'
    ? {
      id: `c:${h.custom.id}`, insert: h.key, label: h.key, secondary: t('chat.compose.ac.workspace'), tag: t('chat.compose.ac.custom'),
      leading: { type: 'image', url: h.custom.url }, recentKey: h.key,
    }
    : {
      id: `u:${h.entry.glyph}`, insert: applySkin(h.entry.glyph, skin), label: `:${h.entry.name}:`, secondary: h.entry.label,
      leading: { type: 'glyph', glyph: applySkin(h.entry.glyph, skin) }, recentKey: h.entry.glyph,
    }))
}

function Lead({ l, label }: { l: AcLeading; label: string }): ReactNode {
  if (l.type === 'avatar') return <UiAvatar src={l.url} alt={label} fallback={l.initial} textSize={11} className="h-6 w-6" />
  if (l.type === 'image') return <img src={l.url} alt="" className="h-6 w-6 object-contain" />
  return <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center text-[18px] leading-none">{l.type === 'glyph' ? l.glyph : '@'}</span>
}

export interface ChatAutocompleteProps {
  id: string
  trigger: AcTrigger
  items: AcItem[]
  activeIndex: number
  onActiveChange: (i: number) => void
  onPick: (i: number) => void
}

export function ChatAutocomplete({ id, trigger, items, activeIndex, onActiveChange, onPick }: ChatAutocompleteProps) {
  const { t } = useI18n()
  const emoji = trigger.kind === 'emoji'
  const typed = (emoji ? ':' : '@') + trigger.query
  const options: UiMentionOption[] = items.map(it => ({
    id: it.id,
    label: it.label,
    labelClassName: it.nameClass,
    secondary: it.secondary,
    leading: <Lead l={it.leading} label={it.label} />,
    trailing: it.tag ? <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{it.tag}</span> : undefined,
    disabled: it.disabled,
    disabledReason: it.disabledReason,
  }))
  return (
    <UiMentionList
      id={id}
      ariaLabel={emoji ? t('chat.compose.ac.emojiLabel') : t('chat.compose.ac.mentionLabel')}
      heading={t(emoji ? 'chat.compose.ac.emojiHead' : 'chat.compose.ac.mentionHead', { q: typed })}
      footer={<span aria-live="polite">{t(emoji ? 'chat.compose.ac.emojiFoot' : 'chat.compose.ac.mentionFoot', { n: items.length })}</span>}
      options={options}
      activeIndex={activeIndex}
      onActiveChange={onActiveChange}
      onPick={onPick}
      size="chat"
      maxHeight={AC_MAX * 36 + 8}
      className="z-30"
    />
  )
}

export default ChatAutocomplete
