// 내 상태(GET /api/chat/me/status 응답) → 사용자 메뉴 상태 3칸 값. 서버 effective_state 와 같은 규칙.
//  invisible → null(아무 칸도 안 켜짐, 점은 offline) · dnd_until 미래 또는 기한 없는 dnd → dnd · away → away · 그 밖 → online
import type { MyStatus } from '~/lib/chatEvents'

export type MenuPresence = 'online' | 'away' | 'dnd'

export function menuPresence(s: Pick<MyStatus, 'mode' | 'dnd_until'>, now: number): MenuPresence | null {
  if (s.mode === 'invisible') return null
  const until = s.dnd_until ? new Date(s.dnd_until).getTime() : null
  if (until !== null && until > now) return 'dnd'
  if (s.mode === 'dnd' && until === null) return 'dnd'
  if (s.mode === 'away') return 'away'
  return 'online'
}

// ─── 상태 메시지 펼침 패널(시안 R12Status · 답변서 A4) ───

/** 상태 문구 최대 글자 수(시안 "6 / 60") */
export const STATUS_TEXT_MAX = 60

/** 지우기 선택지 — 지우지 않음 · 30분 뒤 · 1시간 뒤 · 오늘 안 · 시각 지정 */
export type StatusClear = 'never' | '30m' | '1h' | 'today' | 'time'

function pad2(n: number) { return String(n).padStart(2, '0') }
export function hhmmOf(d: Date) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

/**
 * 지우기 선택 → 지울 시각. never 면 null.
 * today = 오늘 23:59(현지), time = 오늘 그 시각(이미 지났으면 내일 그 시각). time 값이 틀리면 null.
 */
export function statusClearAt(choice: StatusClear, time: string, now: number): Date | null {
  const d = new Date(now)
  switch (choice) {
    case 'never': return null
    case '30m': return new Date(now + 30 * 60_000)
    case '1h': return new Date(now + 60 * 60_000)
    case 'today': return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0, 0)
    case 'time': {
      const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
      if (!m) return null
      const h = Number(m[1]), mi = Number(m[2])
      if (h > 23 || mi > 59) return null
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, 0, 0)
      if (at.getTime() <= now) at.setDate(at.getDate() + 1)
      return at
    }
  }
}

/** 이미 걸린 만료 시각 → 패널 처음 값(만료 없으면 지우지 않음, 있으면 시각 지정 + 그 시각) */
export function statusClearFrom(expiresAt: Date | null): { choice: StatusClear; time: string } {
  return expiresAt ? { choice: 'time', time: hhmmOf(expiresAt) } : { choice: 'never', time: '' }
}

/** 방해 금지 남은 시간 — 60분 이상이면 시간(올림), 아니면 분(올림). 기한 없으면 null */
export function dndLeft(until: Date | null, now: number): { n: number; unit: 'h' | 'm' } | null {
  if (!until) return null
  const min = Math.max(1, Math.ceil((until.getTime() - now) / 60_000))
  return min >= 60 ? { n: Math.ceil(min / 60), unit: 'h' } : { n: min, unit: 'm' }
}

/** 방해 금지 세그먼트(끄기·30분·1·2·4시간) 값(분). 0 = 끄기 */
export const DND_SEGMENT_MINUTES = [0, 30, 60, 120, 240] as const

/**
 * 지금 방해 금지 상태 → 세그먼트 값. 방해 금지가 아니면 0(끄기),
 * 기한이 있으면 남은 시간을 덮는 가장 짧은 칸, 기한 없는 방해 금지면 null(아무 칸도 안 켜짐).
 */
export function dndSegmentValue(dnd: boolean, until: Date | null, now: number): number | null {
  if (!dnd) return 0
  if (!until) return null
  const left = (until.getTime() - now) / 60_000
  return DND_SEGMENT_MINUTES.find(m => m > 0 && m >= left - 0.5) ?? 240
}

// ─── 상태 메시지 이모지 고르기(R5 A4 · 시안 R13 #emoji, 8×2) ───

/** 이모지 고르기 기본 추천(16 — 최근 쓴 것이 없으면 이것만으로 8×2 를 채운다) */
export const STATUS_EMOJIS = ['💬', '🎧', '🗓', '🚌', '🍱', '☕', '🤒', '🌴', '🏠', '✈️', '🎯', '🔕', '🚀', '✅', '👀', '🙏']
/** 8×2 칸 수 */
export const EMOJI_CELLS = 16

/** 고르기 칸: 최근 쓴 것(최대 8) 먼저, 남은 칸은 기본 추천으로(중복 없이) */
export function statusEmojiCells(recent: string[]): string[] {
  const out: string[] = []
  for (const e of [...recent.slice(0, 8), ...STATUS_EMOJIS]) {
    if (!out.includes(e)) out.push(e)
    if (out.length >= EMOJI_CELLS) break
  }
  return out
}
