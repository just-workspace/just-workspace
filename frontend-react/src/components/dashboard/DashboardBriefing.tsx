/**
 * 오늘 브리핑 행 + 관리자 운영 바.
 *
 * 칩(높이 36, rounded-full, 누르면 해당 화면으로 이동): 안 읽은 메일 n · 나를 부른 것 n · 오늘 마감 n · 지남 n(지난 것만 있으면 `지남 n` danger 하나) ·
 * 다음 회의 `제목 14:00 · 10분 후 [참여]`(30분 전부터 primary 테두리 + [참여]) · 관리자 전용 서비스 이상 n(warning).
 * 0 인 칩은 숨김. 전부 없으면 "오늘은 처리할 것이 없습니다." 한 행. 모바일은 한 행 가로 스크롤(줄바꿈 없음).
 *
 * 운영 바(관리자 전용, 높이 40): 운영 · 서비스 n/n 정상 · 이상 내용(warning) · 저장소 used / total · 승인 대기 n · 관리 개요 ›.
 * 모바일은 칩 행과 같이 한 행 가로 스크롤(줄바꿈·페이드 없음, "관리 개요 ›" 맨 끝).
 * 데이터는 모두 /api/dashboard/summary 1회 호출(useDashSummary).
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { cn } from '~/lib/utils'
import { openActivity } from '~/composables/useShell'
import { isMobileNow } from '~/composables/useIsMobile'
import { useDashSummary, type DashSummary, type ServiceIssue } from '~/composables/useDashSummary'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { bytes } from './DashboardMoreCards'
import { openMeetingLink } from './DashboardToday'

export interface BriefChip {
  key: string
  icon: string
  label: string
  value: string
  sub?: string
  join?: string | null
  tone?: 'primary' | 'warning'
  /** 문자·숫자 danger(지난 마감만 있을 때) */
  danger?: boolean
  to?: string
  onClick?: () => void
}

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** 요약 → 칩(0 인 항목은 제외). 순수 함수 — 표 기반 테스트 */
export function briefChips(s: DashSummary | null, now: number, t: (k: string, a?: Record<string, unknown>) => string, isAdmin: boolean): BriefChip[] {
  if (!s) return []
  const out: BriefChip[] = []
  if (s.mail_unread) out.push({ key: 'mail', icon: 'mail', label: t('dashboard.d17.chip.mail'), value: String(s.mail_unread), to: '/mail' })
  if (s.mentions_unread) out.push({ key: 'mention', icon: 'at-sign', label: t('dashboard.d17.chip.mention'), value: String(s.mentions_unread) })
  if (s.tasks_due_today) {
    out.push({
      key: 'due', icon: 'check-square', label: t('dashboard.d17.chip.due'), value: String(s.tasks_due_today),
      sub: s.tasks_overdue ? t('dashboard.d17.chip.overdue', { n: s.tasks_overdue }) : undefined, to: '/tasks',
    })
  } else if (s.tasks_overdue) {
    // 오늘 마감 0 · 지난 것만 존재 — "지남 n" 하나
    out.push({ key: 'due', icon: 'check-square', label: t('dashboard.d17.chip.overdueLabel'), value: String(s.tasks_overdue), danger: true, to: '/tasks' })
  }
  const m = s.next_meeting
  if (m) {
    const st = Date.parse(m.start), en = Date.parse(m.end)
    if (en >= now) {
      const mins = Math.round((st - now) / 60_000)
      const rel = now >= st ? t('dashboard.d17.today.now') : mins <= 60 ? t('dashboard.d17.today.inMin', { n: Math.max(1, mins) }) : ''
      const soon = st - now <= 30 * 60_000
      out.push({
        key: 'meeting', icon: 'video', label: m.title || t('dashboard.d17.chip.meeting'), value: [hm(new Date(st)), rel].filter(Boolean).join(' · '),
        tone: soon ? 'primary' : undefined, join: soon ? m.join_url : null, to: '/calendar',
      })
    }
  }
  const issues = s.admin?.services.issues ?? []
  if (isAdmin && issues.length) out.push({ key: 'service', icon: 'alert-triangle', label: t('dashboard.d17.chip.service'), value: String(issues.length), tone: 'warning', to: '/admin/system' })
  return out
}

const TONE: Record<string, { box: string; icon: string }> = {
  primary: { box: 'border-primary/50 bg-primary/10', icon: 'text-primary' },
  warning: { box: 'border-warning/50 bg-warning/10', icon: 'text-warning' },
}

export function DashboardBriefingChips({ isAdmin, mobile }: { isAdmin: boolean; mobile: boolean }) {
  const { t } = useI18n()
  const { summary } = useDashSummary()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id) }, [])
  const chips = briefChips(summary, now, t, isAdmin)
  // 나를 부른 것 = 활동(데스크톱 패널 · 모바일 화면)
  const openMention = () => { if (isMobileNow()) void navigateTo('/activity'); else openActivity() }

  if (!summary) return <div className="h-9" aria-hidden="true" />
  return (
    <div
      role="list"
      aria-label={t('dashboard.d17.chip.region')}
      className={cn('flex items-center gap-2', mobile ? '-mx-4 overflow-x-auto px-4 [scrollbar-width:none]' : 'flex-wrap')}
    >
      {chips.map((c) => {
        const tone = c.tone ? TONE[c.tone] : { box: 'border-border bg-card', icon: 'text-muted-foreground' }
        const inner = (
          <>
            <UiIcon name={c.icon} className={cn('h-4 w-4 shrink-0', c.danger ? 'text-danger' : tone.icon)} />
            <span className={cn('max-w-[16rem] truncate', c.danger && 'text-danger')}>{c.label}</span>
            <span className={cn('font-mono font-semibold', c.danger && 'text-danger')}>{c.value}</span>
            {c.sub && <><span className="text-muted-foreground" aria-hidden="true">·</span><span className="font-mono text-danger">{c.sub}</span></>}
          </>
        )
        const cls = cn('flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[13px] hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', tone.box)
        return (
          <div role="listitem" key={c.key} className="flex shrink-0 items-center">
            {c.join ? (
              // [참여]는 칩 내부 오른쪽 끝 — 칩 본문(일정)과 별도 클릭 대상
              <span className={cn(cls, 'pr-1')}>
                <NuxtLink to={c.to ?? '/calendar'} className="flex items-center gap-2 focus-visible:outline-hidden">{inner}</NuxtLink>
                <button
                  type="button"
                  className="ml-1 flex h-7 items-center rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => openMeetingLink(meetingPath(c.join!))}
                >{t('meetings.list.join')}</button>
              </span>
            ) : c.key === 'mention'
              ? <button type="button" className={cls} onClick={openMention}>{inner}</button>
              : <NuxtLink to={c.to ?? '/'} className={cls}>{inner}</NuxtLink>}
          </div>
        )
      })}
      {!chips.length && <span className="text-[13px] text-muted-foreground">{t('dashboard.d17.chip.none')}</span>}
    </div>
  )
}

/** 서버가 반환한 회의 주소(동일 출처이면 경로로 변환) */
function meetingPath(u: string): string {
  try { const x = new URL(u, window.location.origin); return x.origin === window.location.origin ? x.pathname : x.href } catch { return u }
}

/** 이상 한 행 — "메일 발송 지연 · 1.8s" / "메일 응답 없음" */
export function issueText(i: ServiceIssue, t: (k: string, a?: Record<string, unknown>) => string): string {
  return i.status === 'slow' && i.response_ms != null
    ? t('dashboard.d17.ops.slow', { name: i.name, s: (i.response_ms / 1000).toFixed(1) })
    : t('dashboard.d17.ops.down', { name: i.name })
}

export function DashboardOpsBand({ mobile = false }: { mobile?: boolean }) {
  const { t } = useI18n()
  const { summary } = useDashSummary()
  const a = summary?.admin
  if (!a) return null
  const first = a.services.issues[0]
  return (
    <div
      role="region"
      aria-label={t('dashboard.d17.ops.title')}
      // 모바일: 칩 행과 동일한 가로 스크롤(줄바꿈 없음 · 페이드 없음) — 항목은 축소되지 않고 "관리 개요 ›" 가 맨 끝에 위치
      className={cn(
        'flex h-10 items-center gap-4 whitespace-nowrap rounded-md border border-border bg-muted/40 px-3.5 text-[13px]',
        mobile ? 'overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0' : 'overflow-hidden',
      )}
    >
      <span className="text-[11px] font-semibold tracking-widest text-muted-foreground">{t('dashboard.d17.ops.title')}</span>
      {a.services.total > 0 && (
        <span className="flex items-center gap-1.5"><UiIcon name="server" className="h-4 w-4 text-muted-foreground" />{t('dashboard.d17.ops.servicesA')} <span className="font-mono">{a.services.ok}/{a.services.total}</span> {t('dashboard.d17.ops.servicesB')}</span>
      )}
      {first && (
        <span className="flex min-w-0 items-center gap-1.5 text-warning"><UiIcon name="alert-triangle" className="h-4 w-4 shrink-0" /><span className="truncate">{issueText(first, t)}{a.services.issues.length > 1 ? ` ${t('dashboard.d17.ops.more', { n: a.services.issues.length - 1 })}` : ''}</span></span>
      )}
      {a.storage && (
        <span className="flex items-center gap-1.5"><UiIcon name="database" className="h-4 w-4 text-muted-foreground" />{t('dashboard.d17.ops.storage')} <span className="font-mono">{bytes(a.storage.used)} / {bytes(a.storage.total)}</span></span>
      )}
      <span className="flex items-center gap-1.5"><UiIcon name="user-plus" className="h-4 w-4 text-muted-foreground" />{t('dashboard.d17.ops.pending')} <span className="font-mono">{a.pending_users}</span></span>
      {!mobile && <span className="flex-1" />}
      <NuxtLink to="/admin/dashboard" className="shrink-0 text-xs text-primary hover:underline">{t('dashboard.d17.ops.overview')} ›</NuxtLink>
    </div>
  )
}
