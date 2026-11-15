/**
 * 관리 분석 카드의 표시 형식 도우미 — Vue 판은 각 AdminAnalytics*.vue 안에 같은 함수가 따로 있었다(내용 그대로 모음).
 */
type T = (key: string, params?: Record<string, unknown>) => string

/**
 * 상대 시각. short=true 면 "방금"·"n분 전" 두 단계만(AdminAnalyticsActiveUsers),
 * 아니면 분 → 시간 → 일(RecentLogins·GitActivity). 빈 값은 '-'.
 */
export function analyticsTimeAgo(iso: string, t: T, short = false, now = Date.now()): string {
  if (!iso) return '-'
  const diff = now - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('common.justNow')
  if (short || mins < 60) return t('common.minutesAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('common.hoursAgo', { n: hours })
  return t('common.daysAgo', { n: Math.floor(hours / 24) })
}

/** IPv4 는 앞 두 칸만(a.b.x.x), 그 밖은 10자 넘으면 자르고 '...' */
export function maskIp(ip: string): string {
  const parts = ip.split('.')
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`
  return ip.length > 10 ? ip.slice(0, 10) + '...' : ip
}

/** 날짜 → MM/DD(일별 차트 라벨) */
export function mmddLabel(date: string): string {
  const dt = new Date(date)
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`
}

/** 접근 로그 시각 — MM. DD. HH:mm:ss(ko-KR, 24시간) */
export function fmtLogTime(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}
/** 상태 코드 색: 2xx success · 3xx warning · 그 밖 danger */
export function codeTone(code: number) { return code < 300 ? 'text-success' : code < 400 ? 'text-warning' : 'text-danger' }
