/**
 * 멤버 열 묶음(디스코드 규칙) — 순수 함수.
 * 순서 = hoist 역할(계층순, 높은 역할 먼저) → 온라인 → 오프라인.
 *  · hoist 역할 묶음에는 해당 역할을 최고 hoist 역할로 가진 **온라인** 사용자만 포함된다(디스코드와 동일 — 오프라인은 모두 "오프라인").
 *  · 서버 by-role(useChatRoles.loadMemberGroups)이 없거나 실패하면 온라인/오프라인 두 묶음만 사용.
 *  · 묶음 내부는 이름순(로캘 비교).
 *  · 1,000명을 초과하는 묶음은 처음 3명만 표시하고 "N명 더 보기" + 제목 접기 화살표(BIG_GROUP).
 */
import type { ChatRole, RoleMemberGroup } from '~/composables/useChatRoles'

export const BIG_GROUP = 1000
export const BIG_GROUP_PREVIEW = 3

export interface MemberLike {
  user_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface GroupedMember<M extends MemberLike = MemberLike> {
  member: M
  online: boolean
  /** 이름 색(역할 색 토큰 키) — 없으면 null */
  color: string | null
}

export interface MemberGroup<M extends MemberLike = MemberLike> {
  /** 'role:<id>' · 'online' · 'offline' */
  key: string
  role: ChatRole | null
  kind: 'role' | 'online' | 'offline'
  members: GroupedMember<M>[]
  /** 1,000명 초과 — 미리보기·접기 */
  big: boolean
}

const nameOf = (m: MemberLike) => m.display_name || m.username

export function groupMembers<M extends MemberLike>(
  members: M[],
  isOnline: (userId: string) => boolean,
  byRole?: RoleMemberGroup[] | null,
): MemberGroup<M>[] {
  const roleOf = new Map<string, ChatRole>()
  const colorOf = new Map<string, string | null>()
  if (byRole) {
    for (const g of byRole) {
      for (const m of g.members) {
        if (g.role && !roleOf.has(m.user_id)) roleOf.set(m.user_id, g.role)
        colorOf.set(m.user_id, m.color ?? null)
      }
    }
  }
  const cmp = (a: GroupedMember<M>, b: GroupedMember<M>) => nameOf(a.member).localeCompare(nameOf(b.member), 'ko')
  const roleGroups = new Map<string, MemberGroup<M>>()
  const online: GroupedMember<M>[] = []
  const offline: GroupedMember<M>[] = []
  for (const m of members) {
    const on = isOnline(m.user_id)
    const gm: GroupedMember<M> = { member: m, online: on, color: colorOf.get(m.user_id) ?? null }
    if (!on) { offline.push(gm); continue }
    const r = roleOf.get(m.user_id)
    if (r) {
      const key = `role:${r.id}`
      if (!roleGroups.has(key)) roleGroups.set(key, { key, role: r, kind: 'role', members: [], big: false })
      roleGroups.get(key)!.members.push(gm)
    } else online.push(gm)
  }
  const out: MemberGroup<M>[] = [...roleGroups.values()].sort((a, b) => (b.role!.position - a.role!.position))
  if (online.length) out.push({ key: 'online', role: null, kind: 'online', members: online, big: false })
  if (offline.length) out.push({ key: 'offline', role: null, kind: 'offline', members: offline, big: false })
  for (const g of out) { g.members.sort(cmp); g.big = g.members.length > BIG_GROUP }
  return out
}

/** 표시할 줄 — 접힌 상태이면 0, 큰 묶음을 전부 펼치지 않았으면 처음 3명 */
export function visibleMembers<M extends MemberLike>(g: MemberGroup<M>, collapsed: boolean, expanded: boolean): GroupedMember<M>[] {
  if (collapsed) return []
  if (g.big && !expanded) return g.members.slice(0, BIG_GROUP_PREVIEW)
  return g.members
}
