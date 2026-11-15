/**
 * 프로필 팝아웃 "현지 시각과 차이" 한 줄 — 순수 함수.
 * 예) 오전 8:12 · Berlin (UTC+2) · 나보다 7시간 늦음 / 내 것이면 · 내 시간
 */

/** 그 시간대의 UTC 차(분). 모르는 시간대면 null */
export function tzOffsetMinutes(tz: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at)
    const g = (k: string) => Number(parts.find(p => p.type === k)?.value)
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'))
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000)
  } catch { return null }
}

/** UTC+9 · UTC−3:30 · UTC */
export function utcLabel(min: number): string {
  if (min === 0) return 'UTC'
  const sign = min > 0 ? '+' : '−'
  const a = Math.abs(min)
  const h = Math.floor(a / 60), m = a % 60
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`
}

/** Asia/Seoul → Seoul, America/Argentina/Buenos_Aires → Buenos Aires */
export function tzCity(tz: string): string {
  return (tz.split('/').pop() || tz).replace(/_/g, ' ')
}

export interface ProfileClock {
  time: string
  city: string
  utc: string
  /** 상대 − 나(시간, 소수 가능). 양수 = 상대가 빠르다 */
  diffHours: number
}

export function profileClock(tz: string, myTz: string, lang = 'ko-KR', at: Date = new Date()): ProfileClock | null {
  const off = tzOffsetMinutes(tz, at)
  const mine = tzOffsetMinutes(myTz, at)
  if (off == null || mine == null) return null
  let time: string
  try { time = at.toLocaleTimeString(lang, { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return null }
  return { time, city: tzCity(tz), utc: utcLabel(off), diffHours: (off - mine) / 60 }
}

/** 내 시간대 — 설정값이 있으면 그것, 아니면 브라우저 */
export function myTimeZone(pref?: string | null): string {
  if (pref && pref !== 'auto') return pref
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
