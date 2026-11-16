/**
 * 채팅 설정 순수 로직 — 화면 없이 테스트한다(tests/chat/chat22-settings.test.tsx).
 * - 권한 행렬: 카탈로그 그룹 → 행, 본인이 부여할 수 없는 비트(서버 _check_grant 와 동일 규칙)
 * - 역할: 계층 잠금, 초안 ↔ 원본 비교(미저장 변경 바), 순서 변경 결과
 * - 덮어쓰기: 동기화 판정(본 프로젝트 엔진은 카테고리 → 채널 순서로 중첩 계산하므로 "채널 덮어쓰기 없음" 도 동기화),
 *   대상의 결과 요약("○○ 님이 할 수 있는 것")
 * - 커스텀 이모지: 파일 이름 → 기본 이름, 파일 검사, 오류 문구 키
 * - PTT 키 표시
 */
import {
  PERM, hasBit, overwritesInSync, type ChatRole, type PermName, type PermOverwrite, type PermissionCatalog,
} from '~/composables/useChatRoles'
import { EMOJI_MAX_BYTES, EMOJI_NAME_RE, type EmojiErrorCode } from '~/composables/chatApi22'

export type SettingsSection = 'overview' | 'roles' | 'channel-perm' | 'category-perm' | 'emoji' | 'notify-default' | 'policy'
  | 'profile' | 'voice' | 'display' | 'notify'
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'overview', 'roles', 'channel-perm', 'category-perm', 'emoji', 'notify-default', 'policy', 'profile', 'voice', 'display', 'notify',
]

/** useChatUi.settings.section → 화면 섹션(이전 값 'role-perm' 등도 역할로 매핑) */
export function normalizeSection(s: string | null | undefined): SettingsSection {
  if (!s) return 'roles'
  if ((SETTINGS_SECTIONS as readonly string[]).includes(s)) return s as SettingsSection
  if (s.startsWith('role')) return 'roles'
  if (s === 'perm' || s === 'perm-cat') return s === 'perm' ? 'channel-perm' : 'category-perm'
  if (s.startsWith('emoji')) return 'emoji'
  if (s.startsWith('voice')) return 'voice'
  return 'roles'
}

// ─── 권한 행렬 ───

export type PermGroupKey = 'general' | 'members' | 'text' | 'voice'
export const PERM_GROUP_ORDER: readonly PermGroupKey[] = ['general', 'members', 'text', 'voice']

/** 서버 permissions.DANGEROUS 와 동일(카탈로그 조회 실패 시 사용) */
const DANGEROUS_FALLBACK: PermName[] = [
  'ADMINISTRATOR', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_WEBHOOKS', 'MENTION_EVERYONE',
]
/** 서버 permissions.GROUPS 와 동일(카탈로그 조회 실패 시 사용) */
const GROUPS_FALLBACK: Record<PermGroupKey, PermName[]> = {
  general: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_EXPRESSIONS', 'MANAGE_WEBHOOKS', 'VIEW_AUDIT_LOG', 'ADMINISTRATOR'],
  members: ['CREATE_INVITE', 'KICK_MEMBERS', 'MODERATE_MEMBERS'],
  text: ['SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS', 'READ_HISTORY', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS',
    'USE_EXTERNAL_EMOJI', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'PIN_MESSAGES', 'MANAGE_THREADS', 'BYPASS_SLOWMODE', 'SEND_POLLS', 'USE_COMMANDS'],
  voice: ['CONNECT', 'SPEAK', 'STREAM', 'USE_VAD', 'PRIORITY_SPEAKER', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'USE_SOUNDBOARD', 'REQUEST_TO_SPEAK'],
}
/** 채널·카테고리 덮어쓰기에서 제외할 비트 — 워크스페이스 범위에서만 유효하다(디스코드도 채널 화면에 미표시) */
export const SERVER_ONLY_BITS: PermName[] = ['ADMINISTRATOR', 'VIEW_AUDIT_LOG', 'MODERATE_MEMBERS', 'MANAGE_EXPRESSIONS']

export interface PermRow { name: PermName; bit: number; dangerous: boolean }
export interface PermGroup { key: PermGroupKey; rows: PermRow[] }

/** 카탈로그 → 그룹별 행. scope='channel' 이면 워크스페이스 전용 비트를 제외 */
export function permGroups(catalog: PermissionCatalog | null | undefined, scope: 'role' | 'channel' = 'role'): PermGroup[] {
  const groups = (catalog?.groups as Record<PermGroupKey, string[]> | undefined) ?? GROUPS_FALLBACK
  const dangerous = new Set<string>(catalog ? catalog.permissions.filter(p => p.dangerous).map(p => p.name) : DANGEROUS_FALLBACK)
  const valueOf = (n: string) => catalog?.permissions.find(p => p.name === n)?.value ?? PERM[n as PermName]
  return PERM_GROUP_ORDER.map(key => ({
    key,
    rows: (groups[key] || [])
      .filter(n => valueOf(n) != null && !(scope === 'channel' && (SERVER_ONLY_BITS as string[]).includes(n)))
      .map(n => ({ name: n as PermName, bit: valueOf(n) as number, dangerous: dangerous.has(n) })),
  })).filter(g => g.rows.length > 0)
}

/** 본인이 타 사용자에게 부여 가능한 비트인지 여부(서버 _check_grant: 전역 관리자·ADMINISTRATOR 는 전부, 그 외 본인 보유 비트만) */
export function canGrantBit(myBits: number, bit: number, isGlobalAdmin: boolean): boolean {
  if (isGlobalAdmin || hasBit(myBits, PERM.ADMINISTRATOR)) return true
  return hasBit(myBits, bit)
}

/** 검색어로 행 필터링(이름·설명 문구 — 번역 함수를 전달받아 사용) */
export function filterPermGroups(groups: PermGroup[], q: string, text: (n: PermName) => string): PermGroup[] {
  const s = q.trim().toLowerCase()
  if (!s) return groups
  return groups.map(g => ({ ...g, rows: g.rows.filter(r => text(r.name).toLowerCase().includes(s) || r.name.toLowerCase().includes(s)) }))
    .filter(g => g.rows.length > 0)
}

// ─── 역할 ───

/** 계층 잠금: 본인 최고 역할 위치 이상이면 변경 불가(서버 _below_me). @everyone 은 MANAGE_ROLES 권한으로 충분 */
export function isRoleLocked(role: Pick<ChatRole, 'position' | 'is_default'>, myTop: number, canManage: boolean): boolean {
  if (!canManage) return true
  if (role.is_default) return false
  return role.position >= myTop
}

export interface RoleDraft {
  name: string
  color: string | null
  hoist: boolean
  mentionable: boolean
  group_id: string | null
  permissions: number
}
export function draftOf(r: ChatRole): RoleDraft {
  return { name: r.name, color: r.color ?? null, hoist: !!r.hoist, mentionable: !!r.mentionable, group_id: r.group_id ?? null, permissions: r.permissions || 0 }
}
/** 초안과 원본이 상이한 필드만 반환(저장 PATCH 본문). 동일하면 빈 객체 */
export function draftPatch(base: RoleDraft, draft: RoleDraft, isDefault: boolean): Partial<RoleDraft> {
  const out: Partial<RoleDraft> = {}
  const keys: (keyof RoleDraft)[] = isDefault ? ['permissions'] : ['name', 'color', 'hoist', 'mentionable', 'group_id', 'permissions']
  for (const k of keys) if (base[k] !== draft[k]) (out as Record<string, unknown>)[k] = draft[k]
  if (out.name != null) out.name = out.name.trim()
  return out
}
export function isDirty(base: RoleDraft | null, draft: RoleDraft | null, isDefault = false): boolean {
  if (!base || !draft) return false
  return Object.keys(draftPatch(base, draft, isDefault)).length > 0
}

/** 순서 변경: @everyone 을 제외한 위→아래 id 목록에서 from 을 to 위치로 이동. 변경이 없으면 null */
export function moveRoleIds(ids: string[], fromId: string, toIndex: number): string[] | null {
  const from = ids.indexOf(fromId)
  if (from < 0) return null
  const next = ids.slice()
  next.splice(from, 1)
  const to = Math.max(0, Math.min(next.length, toIndex > from ? toIndex - 1 : toIndex))
  next.splice(to, 0, fromId)
  return next.every((id, i) => id === ids[i]) ? null : next
}
/** 새 순서의 계층 준수 여부 — 위치가 바뀌는 역할은 이전·신규 위치 모두 본인 최고 역할보다 아래여야 함(서버 reorder_roles) */
export function reorderAllowed(roles: Pick<ChatRole, 'id' | 'position'>[], nextIds: string[], myTop: number): boolean {
  if (myTop === Infinity) return true
  const n = nextIds.length
  return nextIds.every((id, i) => {
    const r = roles.find(x => x.id === id)
    const np = n - i
    return !r || r.position === np || (r.position < myTop && np < myTop)
  })
}

// ─── 덮어쓰기 ───

const hasAny = (o: PermOverwrite) => !!(o.allow || o.deny)
/** 채널과 카테고리의 동기화 여부 — 채널 덮어쓰기가 없거나(카테고리 덮어쓰기만 적용) 카테고리 덮어쓰기와 동일 */
export function channelSynced(channelOws: PermOverwrite[], categoryOws: PermOverwrite[]): boolean {
  if (!channelOws.some(hasAny)) return true
  return overwritesInSync(channelOws, categoryOws)
}

/** 한 계층의 덮어쓰기 적용: @everyone → 역할 합(deny 전부 제거 후 allow 전부 추가) → 사용자 — 서버 permissions 계산 3·4단계 */
function applyLayer(bits: number, ows: PermOverwrite[], everyoneId: string | null, roleIds: string[], userId: string | null): number {
  const sub = (b: number, m: number) => { let r = b; for (const v of bitsList(m)) if (hasBit(r, v)) r -= v; return r }
  const add = (b: number, m: number) => { let r = b; for (const v of bitsList(m)) if (!hasBit(r, v)) r += v; return r }
  const ev = ows.find(o => o.subject_kind === 'role' && (o.subject_id === everyoneId || o.subject_id === 'everyone'))
  let r = bits
  if (ev) { r = sub(r, ev.deny); r = add(r, ev.allow) }
  const roleOws = ows.filter(o => o.subject_kind === 'role' && roleIds.includes(o.subject_id) && o !== ev)
  let deny = 0, allow = 0
  for (const o of roleOws) { deny = add(deny, o.deny); allow = add(allow, o.allow) }
  r = sub(r, deny); r = add(r, allow)
  const u = userId ? ows.find(o => o.subject_kind === 'user' && o.subject_id === userId) : undefined
  if (u) { r = sub(r, u.deny); r = add(r, u.allow) }
  return r
}
/** 비트 마스크 → 설정된 비트 값 목록(2^0…2^40) */
export function bitsList(mask: number): number[] {
  const out: number[] = []
  for (let i = 0, b = 1; i <= 40 && b <= mask; i++, b *= 2) if (hasBit(mask, b)) out.push(b)
  return out
}

export interface SummarySubject { kind: 'role' | 'user'; id: string; roleIds?: string[] }
/**
 * 대상(역할·사용자)이 해당 채널/카테고리에서 갖는 결과 비트. 채널 멤버로 가정한다(멤버십 검사는 제외).
 * base = @everyone ∪ (역할 대상이면 해당 역할 · 사용자이면 해당 사용자의 역할들). ADMINISTRATOR 이면 전부.
 */
export function effectiveFor(
  subject: SummarySubject, roles: ChatRole[], channelOws: PermOverwrite[], categoryOws: PermOverwrite[] = [],
): number {
  const everyone = roles.find(r => r.is_default)
  const roleIds = subject.kind === 'role' ? (subject.id === everyone?.id ? [] : [subject.id]) : (subject.roleIds || [])
  let base = everyone?.permissions || 0
  for (const r of roles) if (roleIds.includes(r.id)) for (const v of bitsList(r.permissions)) if (!hasBit(base, v)) base += v
  if (hasBit(base, PERM.ADMINISTRATOR)) return allBits()
  const userId = subject.kind === 'user' ? subject.id : null
  let bits = applyLayer(base, categoryOws, everyone?.id ?? null, roleIds, userId)
  bits = applyLayer(bits, channelOws, everyone?.id ?? null, roleIds, userId)
  if (!hasBit(bits, PERM.VIEW_CHANNEL)) return 0
  return bits
}
function allBits(): number { return Object.values(PERM).reduce((a, b) => a + b, 0) }

/** 요약 행에 표시할 비트(시안: 보기 · 보내기 · 파일 · 고정 · 메시지 관리) */
export const SUMMARY_BITS: { key: string; bit: number }[] = [
  { key: 'view', bit: PERM.VIEW_CHANNEL },
  { key: 'send', bit: PERM.SEND_MESSAGES },
  { key: 'files', bit: PERM.ATTACH_FILES },
  { key: 'pin', bit: PERM.PIN_MESSAGES },
  { key: 'manage', bit: PERM.MANAGE_MESSAGES },
]

// ─── 커스텀 이모지 ───

/** 파일 이름 → 기본 이모지 이름(소문자 · a-z0-9_ 만 · 32자) */
export function emojiNameFromFile(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').toLowerCase()
  return base.replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
}
export const EMOJI_TYPES = ['image/png', 'image/gif', 'image/webp', 'image/jpeg'] as const
/** 업로드 전 파일 검사 — 서버와 동일 기준(형식 · 256KB) */
export function checkEmojiFile(f: Pick<File, 'type' | 'size'>): EmojiErrorCode | null {
  if (!(EMOJI_TYPES as readonly string[]).includes(f.type)) return 'bad_type'
  if (f.size > EMOJI_MAX_BYTES) return 'too_large'
  return null
}
/** 이름 검사(형식 · 기존 이름 중복 · 대화 상자 내 중복) */
export function checkEmojiName(name: string, taken: Iterable<string>): EmojiErrorCode | null {
  if (!EMOJI_NAME_RE.test(name)) return 'name_invalid'
  for (const n of taken) if (n === name) return 'name_taken'
  return null
}
/** 오류 코드 → i18n 키(chat.settings.emoji.err.*). 미확인 오류 = failed */
export function emojiErrorKey(code: EmojiErrorCode | null | undefined): string {
  const known: EmojiErrorCode[] = ['name_invalid', 'name_taken', 'too_large', 'bad_type', 'limit_reached', 'forbidden']
  return `chat.settings.emoji.err.${code && known.includes(code) ? code : 'failed'}`
}
/** 이름 입력란 아래에 표시하는 오류인지 여부(나머지는 파일 목록 행) */
export const isNameError = (c: EmojiErrorCode | null | undefined) => c === 'name_invalid' || c === 'name_taken'

// ─── PTT ───

/** KeyboardEvent.code → 키캡 문자 */
export function pttKeyLabel(code: string): string {
  if (!code) return '?'
  const named: Record<string, string> = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Space: 'Space', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Shift',
    AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta', CapsLock: 'Caps', Tab: 'Tab', Enter: 'Enter',
  }
  if (named[code]) return named[code]
  const m = /^(?:Key|Digit)(.)$/.exec(code)
  if (m) return m[1]
  const np = /^Numpad(.+)$/.exec(code)
  if (np) return `Num ${np[1]}`
  if (/^Mouse/.test(code)) return code
  return code
}
