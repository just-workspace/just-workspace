/**
 * 메일 목록 보조 — 검색 구문·빠른 칩·스와이프 판정. 순수 함수만 두어 단위 테스트 대상으로 한다.
 *
 * 검색 구문(커맨드 바 힌트 "from: is:unread"):
 *  - `from:이름|주소`   보낸 사람
 *  - `is:unread` · `is:starred`(`is:star`) · `has:attachment`(`has:file`) → 빠른 칩과 동일한 필터
 *  - 나머지 문자는 서버 검색어(제목 OR 보낸 사람, 현재 폴더 범위)
 * 서버는 현재 평문 q 하나만 수신한다(백엔드 갭) — from: 은 검색어가 없을 때 서버로 전달하고, 있으면 수신한 결과에서 다시 필터링한다.
 */

export interface MailQuickFlags {
  unread: boolean
  starred: boolean
  attachment: boolean
}

export interface ParsedMailQuery extends MailQuickFlags {
  /** 서버로 전송할 평문 */
  text: string
  /** from: 값(소문자 비교용 원문) */
  from: string
}

const TOKEN_RE = /(\S+?):("[^"]*"|\S+)/g

export function parseMailQuery(raw: string): ParsedMailQuery {
  const out: ParsedMailQuery = { text: '', from: '', unread: false, starred: false, attachment: false }
  const rest = (raw || '').replace(TOKEN_RE, (whole, key: string, val: string) => {
    const k = key.toLowerCase()
    const v = val.replace(/^"|"$/g, '').trim()
    const lv = v.toLowerCase()
    if (k === 'from' && v) { out.from = v; return ' ' }
    if (k === 'is' && lv === 'unread') { out.unread = true; return ' ' }
    if (k === 'is' && (lv === 'starred' || lv === 'star' || lv === 'flagged')) { out.starred = true; return ' ' }
    if (k === 'has' && (lv === 'attachment' || lv === 'file' || lv === 'attachments')) { out.attachment = true; return ' ' }
    return whole
  })
  out.text = rest.replace(/\s+/g, ' ').trim()
  return out
}

/** 서버 q 값 — 평문이 있으면 평문, 없으면 from: 값(서버가 FROM 도 함께 검색한다). */
export function serverQuery(p: ParsedMailQuery): string {
  return p.text || p.from
}

interface RowLike {
  is_unread: boolean
  is_flagged: boolean
  has_attachment: boolean
  from_?: readonly { name: string | null; email: string }[]
}

/** 수신한 페이지 내에서 칩·from: 필터링. */
export function filterMailRows<T extends RowLike>(rows: readonly T[], flags: MailQuickFlags, from = ''): T[] {
  const f = from.trim().toLowerCase()
  return rows.filter((r) => {
    if (flags.unread && !r.is_unread) return false
    if (flags.starred && !r.is_flagged) return false
    if (flags.attachment && !r.has_attachment) return false
    if (f) {
      const hay = (r.from_ || []).map(a => `${a.name || ''} ${a.email}`).join(' ').toLowerCase()
      if (!hay.includes(f)) return false
    }
    return true
  })
}

export type SwipeAction = 'archive' | 'toggle-read' | null

/** 스와이프 폭 — 노출되는 동작 칸 96. */
export const SWIPE_REVEAL = 96

/**
 * 손가락을 뗀 시점의 동작. 왼쪽으로 칸 폭 이상 = 보관, 오른쪽 = 읽음 전환.
 * 세로 이동이 가로보다 크면 스크롤로 간주하고 동작하지 않는다.
 */
export function swipeAction(dx: number, dy = 0, threshold = SWIPE_REVEAL): SwipeAction {
  if (Math.abs(dy) > Math.abs(dx)) return null
  if (dx <= -threshold) return 'archive'
  if (dx >= threshold) return 'toggle-read'
  return null
}

/** 바이트 → "2.4 MB" (mono 메타 줄). */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 첨부 미리보기 종류 — 이미지 썸네일 / PDF 모달 / 없음. */
export function previewKind(type: string | null | undefined, name?: string | null): 'image' | 'pdf' | null {
  const t = (type || '').split(';')[0].trim().toLowerCase()
  // 서버(http_utils.INLINE_SAFE_TYPES)가 inline 을 허용하는 형식만 — octet-stream 으로 수신된 PDF 는 다운로드로 처리.
  void name
  if (/^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(t)) return 'image'
  if (t === 'application/pdf') return 'pdf'
  return null
}

/** 역할 폴더의 i18n 키(mail.folder.*). 사용자 폴더는 null — 서버 이름을 그대로 사용한다. */
export const MAILBOX_ROLE_KEYS: Record<string, string> = {
  inbox: 'mail.folder.inbox',
  sent: 'mail.folder.sent',
  drafts: 'mail.folder.drafts',
  trash: 'mail.folder.trash',
  junk: 'mail.folder.junk',
  archive: 'mail.folder.archive',
}

/** 목록·본문 시각(mono): 오늘 = 09:55, 올해 = 10/15, 그 전 = 2025/10/15. withTime 이면 날짜 뒤에 시각도 표시. */
export function formatMailDate(iso: string | null | undefined, withTime = false, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const md = d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  return withTime ? `${md} ${hm}` : md
}

/** summarizeRecipients 화면 문구 — 호출부가 i18n 으로 전달한다. 기본값은 테스트 호환용 한국어. */
export interface RecipientSummaryLabels {
  me: string
  more: (names: string, n: number) => string
}
const DEFAULT_RECIPIENT_LABELS: RecipientSummaryLabels = {
  me: '나',
  more: (names, n) => `${names} 외 ${n}명`,
}

/** "나, 김서연 외 4명" — 받는 사람 요약. */
export function summarizeRecipients(list: readonly { name: string | null; email: string }[], myEmail = '', shown = 2, labels: RecipientSummaryLabels = DEFAULT_RECIPIENT_LABELS): string {
  const me = myEmail.toLowerCase()
  const names = list.map(a => (a.email.toLowerCase() === me ? labels.me : (a.name || a.email.split('@')[0])))
  // 본인을 맨 앞으로 정렬
  names.sort((x, y) => (x === labels.me ? -1 : y === labels.me ? 1 : 0))
  if (names.length <= shown + 1) return names.join(', ')
  return labels.more(names.slice(0, shown).join(', '), names.length - shown)
}

/** 라벨 추가·제거 결과(순서 유지, 중복 없음). */
export function applyLabelChange(current: readonly string[] | undefined, add: readonly string[], remove: readonly string[]): string[] {
  const out = (current || []).filter(l => !remove.includes(l))
  for (const l of add) if (!out.includes(l) && !remove.includes(l)) out.push(l)
  return out
}

/**
 * 라벨 색점 — 서버 라벨에는 색이 없어 이름 기준으로 고정 배정한다(동일 이름 = 항상 동일 색).
 * 범주 색 --cat-1…8 중 하나. 인접 라벨은 색뿐 아니라 이름 문자로도 구분된다(점 옆에 항상 이름 표시).
 * 반환값은 CSS 변수 이름(hsl(var(--<값>)) 으로 사용).
 */
export function labelTone(name: string): `cat-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}` {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return `cat-${((h % 8) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`
}

/**
 * 본문의 접힌 대화(첫 메일 한 줄 + "이전 메일 n개 더 보기").
 * thread 는 오래된 순. 열린 메일을 제외한 나머지 중 첫 메일은 항상 표시하고, 그 사이 메일은 "n개 더 보기"로 접는다.
 */
export function threadLayout<T extends { id: string; mailbox_ids?: readonly string[] }>(thread: readonly T[], currentId: string, expanded = false, currentMailbox?: string | null): { shown: T[]; hidden: number } {
  // 대화에는 다른 메일함(보낸편지함)의 메일도 포함된다 — UID 는 메일함별로 독립이므로 번호만으로 판단하면 다른 메일을 "열린 메일"로 오인하여 제외한다.
  // currentMailbox 를 지정하면 메일함까지 일치하는 메일만 제외한다.
  const others = thread.filter(m => !(m.id === currentId && (currentMailbox == null || (m.mailbox_ids?.[0] ?? currentMailbox) === currentMailbox)))
  if (others.length <= 1 || expanded) return { shown: others, hidden: 0 }
  return { shown: [others[0]], hidden: others.length - 1 }
}

/** Date → `<input type="datetime-local">` 값(로컬 시각, 분 단위). */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `datetime-local` 값 → ISO(UTC). 형식 불일치 시 null. */
export function fromLocalInput(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v || '')) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** 예약 기본값 — 다음 날 오전 8시(현재 시각이 자정~오전 6시이면 오늘 8시). */
export function defaultScheduleTime(now = new Date()): Date {
  const d = new Date(now)
  if (d.getHours() >= 6) d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d
}
