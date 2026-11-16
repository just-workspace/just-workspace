/**
 * 오늘(주 줄 1칸): 오늘 일정 행 56 = 제목 + 메타(끝남 · n분 후 · 장소 · n명) + 시각(mono) +
 * 화상 회의이면 [참여](항상 표시되는 primary). 진행 중·임박 일정 행은 bg-primary/10 + semibold, 종료된 일정은 muted.
 * 헤더 개수 = 오늘 일정 수, "캘린더 ›". 비어 있으면 제자리 한 행 + 그 아래 [일정 만들기](ghost) 하나.
 * 참여는 시작 10분 전부터 종료 시까지 가능("지금 입장" 규칙). "오늘"·시각은 캘린더 시간대(utils/calTz) 기준.
 * 회의 링크는 일정 장소·설명에 포함된 /meetings/ 주소로 탐색한다.
 */
import { useEffect, useRef, useState } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiButton } from '~/components/ui/Button'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, DashInlineEmpty, useCardStatus, useDash } from './DashCard'
import { eventRange, zAddDays, zFmtTime, zNow, zStartOfDay } from '~/utils/calTz'

interface Ev {
  id: string; title: string; start: string; end: string; all_day: boolean
  location?: string | null; description?: string | null; status?: string | null; attendees?: unknown[] | null
}

export interface DashboardTodayProps {
  /** 오늘 일정 수 수신 후 통지 */
  onCount?: (n: number) => void
}

const MEETING_RE = /(https?:\/\/\S+)?\/meetings\/[\w\-/]+/

function hm(iso: string) { return zFmtTime(new Date(iso)) }
export function meetingLink(e: Pick<Ev, 'location' | 'description'>): string | null {
  const text = `${e.location ?? ''} ${e.description ?? ''}`
  const m = text.match(MEETING_RE)
  if (!m) return null
  try { const u = new URL(m[0], window.location.origin); return u.origin === window.location.origin ? u.pathname : u.href } catch { return null }
}
export function openMeetingLink(l: string) {
  if (l.startsWith('/')) void navigateTo(l); else window.open(l, '_blank', 'noopener')
}

/** 대시보드 오늘 일정 카드 */
export function DashboardToday({ onCount }: DashboardTodayProps) {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const [events, setEvents] = useState<Ev[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount

  async function load() {
    setLoading(true); setError(false)
    // 캘린더 시간대의 오늘 [00:00, 다음날 00:00). 종일 일정(UTC 00:00 저장)이 경계에 걸려도 누락되지 않도록 하루씩 넓혀 조회하고 화면 기준으로 필터링한다
    const s = zStartOfDay(zNow())
    const e = zAddDays(s, 1)
    try {
      const d = await $fetch<{ events: Ev[] }>('/api/calendar/events', { params: { start: zAddDays(s, -1).toISOString(), end: zAddDays(e, 1).toISOString() } })
      const list = (d.events || [])
        .filter(x => x.status !== 'cancelled')
        .filter((x) => { const r = eventRange(x); return r.start < e && r.end > s })
        .sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start))
      setEvents(list)
      onCountRef.current?.(list.length)
    } catch { setError(true) } finally { setLoading(false) }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => clearInterval(timer)
  }, [])
  useCardStatus('today', loading && !events.length ? 'loading' : error ? 'error' : events.length ? 'ready' : 'empty')

  function canJoin(e: Ev) {
    if (e.all_day) return false
    return now >= Date.parse(e.start) - 10 * 60_000 && now <= Date.parse(e.end)
  }
  const ended = (e: Ev) => !e.all_day && Date.parse(e.end) < now
  // 현재 진행 중이거나 다음에 도래할 첫 일정(시안: 해당 행만 강조)
  const focusId = events.find(e => !e.all_day && Date.parse(e.end) >= now)?.id

  function meta(e: Ev): string {
    if (ended(e)) return t('dashboard.d17.today.ended')
    const parts: string[] = []
    const st = Date.parse(e.start), en = Date.parse(e.end)
    if (!e.all_day) {
      if (now >= st && now <= en) parts.push(t('dashboard.d17.today.now'))
      else if (st - now <= 60 * 60_000 && st > now) parts.push(t('dashboard.d17.today.inMin', { n: Math.max(1, Math.round((st - now) / 60_000)) }))
    }
    const loc = e.location?.replace(MEETING_RE, t('dashboard.today.videoMeeting')).trim()
    if (loc) parts.push(loc)
    const n = Array.isArray(e.attendees) ? e.attendees.length : 0
    if (n > 1) parts.push(t('dashboard.liveMeetings.people', { n }))
    if (!parts.length && !e.all_day) {
      const min = Math.round((en - st) / 60_000)
      parts.push(min >= 60 && min % 60 === 0 ? t('dashboard.d17.today.hours', { n: min / 60 }) : t('dashboard.d17.today.minutes', { n: min }))
    }
    return parts.join(' · ')
  }

  return (
    <DashCard cardKey="today" title={t('common.today')} count={events.length} link={{ label: t('nav.calendar'), to: '/calendar' }}>
      {loading && !events.length ? <DashRowsSkeleton rows={3} />
        : error ? <UiErrorTile placement="card" title={t('dashboard.today.loadFailed')} className="m-3.5" onRetry={() => { void load() }} />
          : !events.length ? (
            <>
              <DashInlineEmpty icon="calendar" text={t('dashboard.today.empty')} />
              <div className="px-4 pb-3">
                <UiButton variant="ghost" size="xs" className="-ml-3" onClick={() => { void navigateTo('/calendar?new=1') }}>{t('dashboard.today.create')}</UiButton>
              </div>
            </>
          )
            : (
              <DashRows>
                {events.slice(0, maxRows).map((e) => {
                  const link = meetingLink(e)
                  const focus = e.id === focusId
                  return (
                    <DashRow
                      key={`${e.id}:${e.start}`}
                      title={e.title}
                      titleClass={ended(e) ? 'text-muted-foreground' : focus ? 'font-semibold' : undefined}
                      meta={meta(e) || ' '}
                      time={e.all_day ? t('calendar.allDay') : hm(e.start)}
                      className={focus ? 'bg-primary/10' : undefined}
                      to="/calendar"
                      action={link && canJoin(e) ? { label: t('meetings.list.join'), variant: 'default', persistent: true, onClick: () => openMeetingLink(link) } : undefined}
                    />
                  )
                })}
              </DashRows>
            )}
    </DashCard>
  )
}

export default DashboardToday
