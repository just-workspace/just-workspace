/**
 * 게시판 표기 도우미.
 */

const p2 = (n: number) => String(n).padStart(2, '0')

/** 목록 날짜 — 오늘은 HH:mm, 그 밖은 MM/DD(시안 "10/15") */
export function boardDay(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (d.toDateString() === now.toDateString()) return `${p2(d.getHours())}:${p2(d.getMinutes())}`
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`
}

/** 글·댓글 시각 — 오늘은 HH:mm, 그 밖은 MM/DD HH:mm(시안 "10/15 09:00") */
export function boardStamp(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return hm
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${hm}`
}

export function fileSize(bytes?: number | null): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 && bytes / Math.pow(1024, i) < 10 ? 1 : 0)} ${units[i]}`
}

export function authorName(a: { display_name?: string | null; username?: string } | null | undefined): string {
  return a ? (a.display_name || a.username || '') : ''
}

/** 아바타 글자(시안: 이름 첫 글자) */
export function initialOf(name: string): string {
  return name.trim().charAt(0) || '?'
}

/**
 * 안 읽음 = 굵게. 서버의 is_read 가 오면 그것을, 없으면 "아직 안 읽은 필독"만 안다(/must-read).
 * 그 밖의 글은 읽음으로 그린다 — 게시판별 읽음 기록이 서버에 없다(백엔드 갭).
 */
export function isUnreadPost(post: { id: string; is_read?: boolean }, unreadMustRead: ReadonlySet<string>): boolean {
  if (post.is_read === false) return true
  if (post.is_read === true) return false
  return unreadMustRead.has(post.id)
}

/** 파일 유형 칩("PDF"): 글자와 색 토큰 */
export function fileKind(name: string): { label: string; tone: 'danger' | 'primary' | 'success' | 'warning' | 'muted' } {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return { label: 'PDF', tone: 'danger' }
  if (['doc', 'docx', 'odt', 'hwp', 'txt', 'md'].includes(ext)) return { label: ext.toUpperCase().slice(0, 4), tone: 'primary' }
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return { label: ext.toUpperCase().slice(0, 4), tone: 'success' }
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { label: ext.toUpperCase().slice(0, 4), tone: 'warning' }
  return { label: (ext || 'FILE').toUpperCase().slice(0, 4), tone: 'muted' }
}

/** 댓글 본문을 텍스트·@언급 조각으로(@김서연 = accent 바탕 칩) */
export function splitMentions(text: string): Array<{ mention: boolean; text: string }> {
  const out: Array<{ mention: boolean; text: string }> = []
  const re = /(^|[\s(])(@[^\s@,.!?;:()]+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    if (start > last) out.push({ mention: false, text: text.slice(last, start) })
    out.push({ mention: true, text: m[2] })
    last = start + m[2].length
  }
  if (last < text.length) out.push({ mention: false, text: text.slice(last) })
  return out
}

/** 칩 조각 — 서버가 해석한 사용자면 user 가 붙는다 */
export interface MentionPart { mention: boolean; text: string; user?: { id: string; username: string; display_name: string | null } }

/**
 * 댓글 본문 조각내기 — 서버가 해석한 mentions[] 가 있으면 그 사람의 @username 만 칩으로(백엔드 정규식과 같은 선:
 * 공백·줄 처음 뒤 @[\w.-]+, 끝의 . - 는 뗀다). mentions 가 비었으면(예전 댓글) 글자 그대로의 @언급을 칩으로(splitMentions).
 */
export function splitResolvedMentions(
  text: string,
  mentions: ReadonlyArray<{ id: string; username: string; display_name: string | null }> | null | undefined,
): MentionPart[] {
  if (!mentions || !mentions.length) return splitMentions(text)
  const by = new Map(mentions.map(m => [m.username, m]))
  const out: MentionPart[] = []
  const re = /(^|\s)@([\w.-]+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[2].replace(/[.-]+$/, '')
    const u = by.get(name)
    if (!u) continue
    const start = m.index + m[1].length
    if (start > last) out.push({ mention: false, text: text.slice(last, start) })
    out.push({ mention: true, text: `@${name}`, user: { id: u.id, username: u.username, display_name: u.display_name } })
    last = start + 1 + name.length
  }
  if (last < text.length) out.push({ mention: false, text: text.slice(last) })
  return out
}

/** 입력 중인 @멘션 — 커서 바로 앞이 "@검색어"(공백·줄 처음·괄호 뒤)면 그 시작 위치와 검색어 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|[\s(])@([^\s@]{0,40})$/.exec(before)
  if (!m) return null
  return { start: m.index + m[1].length, query: m[2] }
}
