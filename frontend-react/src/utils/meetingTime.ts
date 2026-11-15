/**
 * 회의 목록 묶기: 진행 중(Live n명) · 예정(날짜별) · 지난.
 * 서버 방 목록 = LiveKit 에 살아 있는 방 + DB 에 저장된 내 회의(예정·최근 30일 지난). 행마다 status(live/scheduled/ended/cancelled).
 *  진행 중 = 참가자 1명 이상(status=live 라도 빈 방은 예약 시각으로 판단 — 예약 직후 LiveKit 이 빈 방을 잠시 유지한다)
 *  예정    = 참가자 0 이고 끝나지 않음(예약 없이 만든 방은 만든 시각을 시작으로 본다)
 *  지난    = status ended/cancelled, 또는 예약 끝 시각이 지났고 참가자 0
 * "참여"는 진행 중이거나 시작 10분 전부터 끝날 때까지("시작 10분 전부터 입장").
 */
import { i18n } from '~/i18n'

export interface MeetingLike {
  name: string
  num_participants: number
  creation_time: number
  scheduled_at?: string | null
  duration_minutes?: number | null
  /** live | scheduled | ended | cancelled (예전 Redis 전용 방은 없을 수 있다) */
  status?: string | null
}

export interface MeetingView<T> {
  room: T
  live: boolean
  /** 끝났거나 취소된 회의(status) — 지난 묶음, 참여 불가 */
  ended: boolean
  start: Date
  end: Date | null
  joinable: boolean
  /** 시각 칸 첫 줄(mono 600): 15:00 · 10/20 15:00 · 어제 14:00 */
  timeText: string
  /** 시각 칸 둘째 줄: 60분 · 시작 12분(데스크톱) */
  durText: string
  /** 모바일 둘째 줄: 60분 · 12분째 */
  durShort: string
}

export interface MeetingGroup<T> { key: string; label: string; items: MeetingView<T>[] }

const JOIN_EARLY_MS = 10 * 60 * 1000

/** 번역 함수 — 기본은 Nuxt i18n(앱 안), Nuxt 밖(단위 테스트)에서는 한국어 원문으로 떨어진다. */
type Tr = (key: string, params?: Record<string, unknown>) => string
const KO_FALLBACK: Record<string, string> = {
  'meetings.time.dow.sun': '일',
  'meetings.time.dow.mon': '월',
  'meetings.time.dow.tue': '화',
  'meetings.time.dow.wed': '수',
  'meetings.time.dow.thu': '목',
  'meetings.time.dow.fri': '금',
  'meetings.time.dow.sat': '토',
  'meetings.time.date': '{m}월 {d}일 ({dow})',
  'meetings.time.hours': '{h}시간',
  'meetings.time.hoursMinutes': '{h}시간 {m}분',
  'meetings.time.minutes': '{m}분',
  'meetings.time.yesterdayAt': '어제 {time}',
  'meetings.time.tomorrowAt': '내일 {time}',
  'meetings.time.startedMin': '시작 {n}분',
  'meetings.time.elapsedMin': '{n}분째',
  'meetings.time.groupLive': '진행 중',
  'meetings.time.groupToday': '예정 · 오늘',
  'meetings.time.groupTomorrow': '예정 · 내일',
  'meetings.time.groupDate': '예정 · {m}월 {d}일',
  'meetings.time.groupPast': '지난 회의',
  'meetings.time.today': '오늘',
  'meetings.time.tomorrow': '내일',
}
const koFallback: Tr = (key, params) => {
  const raw = KO_FALLBACK[key] ?? key
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''))
}
// React 판: Vue 의 useNuxtApp().$i18n 대신 전역 i18n. 메시지가 아직 안 실렸으면(키가 그대로 돌아오면) 한국어 원문으로.
const defaultT: Tr = (key, params) => {
  try {
    const out = String(i18n.t(key, (params ?? {}) as Record<string, unknown>))
    return out === key ? koFallback(key, params) : out
  } catch {
    return koFallback(key, params)
  }
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function dayOffset(d: Date, now: Date) {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((a - b) / 86400000)
}
export function hhmm(d: Date) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
/** 10월 16일 (금) */
export function koDate(d: Date, t: Tr = defaultT) {
  return t('meetings.time.date', { m: d.getMonth() + 1, d: d.getDate(), dow: t(`meetings.time.dow.${DOW[d.getDay()]}`) })
}
export function durationLabel(min: number | null | undefined, t: Tr = defaultT) {
  if (!min) return ''
  if (min % 60 === 0) return t('meetings.time.hours', { h: min / 60 })
  return min > 60 ? t('meetings.time.hoursMinutes', { h: Math.floor(min / 60), m: min % 60 }) : t('meetings.time.minutes', { m: min })
}

export function viewOf<T extends MeetingLike>(room: T, now: Date = new Date(), t: Tr = defaultT): MeetingView<T> {
  const sched = room.scheduled_at ? new Date(room.scheduled_at) : null
  const start = sched && !isNaN(sched.getTime()) ? sched : new Date((room.creation_time || 0) * 1000)
  const dur = room.duration_minutes || null
  const end = sched && dur ? new Date(start.getTime() + dur * 60000) : null
  const live = room.num_participants > 0
  const ended = !live && (room.status === 'ended' || room.status === 'cancelled')
  const joinable = !ended && (live || !sched || (now.getTime() >= start.getTime() - JOIN_EARLY_MS && (!end || now <= end)))

  const off = dayOffset(start, now)
  const time = hhmm(start)
  const timeText = off === 0 ? time : off === -1 ? t('meetings.time.yesterdayAt', { time }) : off === 1 ? t('meetings.time.tomorrowAt', { time }) : `${start.getMonth() + 1}/${start.getDate()} ${time}`

  const elapsed = Math.max(0, Math.round((now.getTime() - start.getTime()) / 60000))
  const durText = live ? t('meetings.time.startedMin', { n: elapsed }) : dur ? t('meetings.time.minutes', { m: dur }) : ''
  const durShort = live ? t('meetings.time.elapsedMin', { n: elapsed }) : dur ? t('meetings.time.minutes', { m: dur }) : ''
  return { room, live, ended, start, end, joinable, timeText, durText, durShort }
}

export function groupMeetings<T extends MeetingLike>(rooms: readonly T[], now: Date = new Date(), t: Tr = defaultT): MeetingGroup<T>[] {
  const views = rooms.map(r => viewOf(r, now, t))
  const live = views.filter(v => v.live).sort((a, b) => a.start.getTime() - b.start.getTime())
  const isPast = (v: MeetingView<T>) => !v.live && (v.ended || !!(v.end && v.end < now))
  const past = views.filter(isPast).sort((a, b) => b.start.getTime() - a.start.getTime())
  const upcoming = views.filter(v => !v.live && !isPast(v)).sort((a, b) => a.start.getTime() - b.start.getTime())

  const out: MeetingGroup<T>[] = []
  if (live.length) out.push({ key: 'live', label: t('meetings.time.groupLive'), items: live })
  const byDay = new Map<string, MeetingView<T>[]>()
  for (const v of upcoming) {
    // 이미 시작 시각이 지났는데 아무도 없는 방(예약 없이 만든 방 포함)은 "오늘"로
    const d = v.start < now ? now : v.start
    const off = dayOffset(d, now)
    const label = off === 0 ? t('meetings.time.groupToday') : off === 1 ? t('meetings.time.groupTomorrow') : t('meetings.time.groupDate', { m: d.getMonth() + 1, d: d.getDate() })
    if (!byDay.has(label)) byDay.set(label, [])
    byDay.get(label)!.push(v)
  }
  for (const [label, items] of byDay) out.push({ key: label, label, items })
  if (past.length) out.push({ key: 'past', label: t('meetings.time.groupPast'), items: past })
  return out
}

/** 머리 집계 "진행 중 1 · 오늘 예정 2" */
export function meetingCounts(rooms: readonly MeetingLike[], now: Date = new Date()) {
  let live = 0, today = 0
  for (const r of rooms) {
    const v = viewOf(r, now)
    if (v.live) live++
    else if (!v.ended && !(v.end && v.end < now) && sameDay(v.start < now ? now : v.start, now)) today++
  }
  return { live, today }
}

/** "오늘 15:00–16:00" · "10월 16일 (금) 14:00–15:00" (입장 화면·예약됨 시트) */
export function scheduleText(scheduledAt: string | null | undefined, durationMin: number | null | undefined, now: Date = new Date(), t: Tr = defaultT): string {
  if (!scheduledAt) return ''
  const s = new Date(scheduledAt)
  if (isNaN(s.getTime())) return ''
  const e = durationMin ? new Date(s.getTime() + durationMin * 60000) : null
  const off = dayOffset(s, now)
  const day = off === 0 ? t('meetings.time.today') : off === 1 ? t('meetings.time.tomorrow') : koDate(s, t)
  return `${day} ${hhmm(s)}${e ? `–${hhmm(e)}` : ''}`
}
