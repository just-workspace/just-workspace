/**
 * 오늘의 포커스 — AI 브리핑 카드(옵트인 · 주 줄 4·5·6열, 3열 이하는 보조 영역 맨 앞).
 *
 * 활성: 3줄(번호 mono + 문장 + 출처 링크 xs primary) → "회의 준비" 접이식(회의 10분 전부터 자동 펼침:
 *       지난 회의 한 줄 + 관련 채팅 #채널 n · 메일 n) → 푸터 "09:00 생성 · 내가 볼 수 있는 것만" · 다시 만들기 · [도움됨][아님].
 * 비활성(미동의): 설명 2줄 + [켜기][숨기기]. 생성 중: 줄 스켈레톤 3 + "읽는 중…". 실패: danger 한 줄 + [↻ 다시 시도]
 * (전일 내용은 표시하지 않는다). AI 공급자가 없거나 차단된 경우 안내를 표시한다.
 * 서버: /api/dashboard/briefing(GET · enable · generate · feedback) — 일 단위 캐시, 다시 만들기는 하루 3회.
 */
import { useCallback, useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { cn } from '~/lib/utils'
import { addToast } from '~/composables/useToast'
import { useAuth } from '~/composables/useAuth'
import { todayRange } from '~/composables/useDashSummary'
import { NuxtLink } from '~/components/NuxtLink'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { DashCard, useCardStatus, useDash } from './DashCard'
import { openMeetingLink } from './DashboardToday'

export interface BriefingSource { label: string; to: string }
export interface BriefingState {
  available: boolean
  reason: 'module_off' | 'not_configured' | 'external_blocked' | null
  external: boolean
  enabled: boolean
  status: 'off' | 'none' | 'generating' | 'ready' | 'failed'
  items: { text: string; sources: BriefingSource[] }[]
  generated_at: string | null
  regen_left: number
  regen_max: number
  feedback: 'helpful' | 'not' | null
  error: string | null
  prep: {
    event: { id: string; title: string; start: string; end: string; join_url: string | null }
    last_line: string | null
    chat: { count: number; channel_id: string | null; channel_name: string | null }
    mail: { count: number }
  } | null
}

const hhmm = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function errMessage(e: any, fallback: string): string {
  const d = e?.data?.detail ?? e?.response?._data?.detail
  return typeof d === 'string' && d && !/^[a-z_]+$/.test(d) ? d : fallback
}

export function DashboardFocus() {
  const { t } = useI18n()
  const d = useDash()
  const { user } = useAuth()
  const [st, setSt] = useState<BriefingState | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prepOpen, setPrepOpen] = useState<boolean | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const generate = useCallback(async (regenerate: boolean) => {
    setBusy(true)
    setSt(s => (s ? { ...s, status: 'generating' } : s))
    try {
      setSt(await $fetch<BriefingState>('/api/dashboard/briefing/generate', { method: 'POST', params: todayRange(), body: { regenerate } }))
    } catch (e) {
      addToast('error', errMessage(e, t('dashboard.d17.ai.failed')))
      try { setSt(await $fetch<BriefingState>('/api/dashboard/briefing', { params: todayRange() })) } catch { /* 현 상태 유지 */ }
    } finally { setBusy(false) }
  }, [t])

  const load = useCallback(async () => {
    setLoadError(false)
    try {
      const s = await $fetch<BriefingState>('/api/dashboard/briefing', { params: todayRange() })
      setSt(s)
      // 당일 첫 브리핑은 카드를 열 때 생성한다(다시 만들기 횟수에 미포함)
      if (s.enabled && s.available && s.status === 'none') void generate(false)
    } catch { setLoadError(true) }
  }, [generate])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id) }, [])
  // 비활성·사용 불가는 'empty' — 주 줄 동일 높이 맞춤 대상에서 제외한다(제자리 안내는 유지, 빈 카드 그룹으로도 이동하지 않음)
  useCardStatus('ai', loadError ? 'error' : !st ? 'loading' : !st.available || !st.enabled ? 'empty' : 'ready')

  async function enable(on: boolean) {
    setBusy(true)
    try {
      const s = await $fetch<BriefingState>('/api/dashboard/briefing/enable', { method: 'POST', params: todayRange(), body: { enabled: on } })
      setSt(s)
      if (on && s.status === 'none') void generate(false)
    } catch (e) { addToast('error', errMessage(e, t('dashboard.d17.ai.enableFailed'))) } finally { setBusy(false) }
  }
  async function feedback(v: 'helpful' | 'not') {
    if (!st) return
    const next = st.feedback === v ? null : v
    setSt({ ...st, feedback: next })
    try { await $fetch('/api/dashboard/briefing/feedback', { method: 'POST', params: todayRange(), body: { value: next } }) }
    catch { setSt(s => (s ? { ...s, feedback: st.feedback } : s)) }
  }

  const prep = st?.prep ?? null
  const prepStart = prep ? Date.parse(prep.event.start) : 0
  const prepSoon = !!prep && prepStart - now <= 10 * 60_000 && Date.parse(prep.event.end) >= now
  const prepShown = prepOpen ?? prepSoon

  let body: React.ReactNode
  let footer: React.ReactNode = undefined
  const pad = 'flex flex-col gap-3 border-t border-border px-4'
  if (!st) {
    body = loadError
      ? <div className={cn(pad, 'py-3.5 text-[13.5px]')}><p className="text-danger">{t('dashboard.d17.ai.loadFailed')}</p><div><UiButton variant="outline" size="xs" icon="refresh" onClick={() => { void load() }}>{t('dashboard.d17.ai.retry')}</UiButton></div></div>
      : <Skel />
  } else if (!st.available) {
    const key = st.reason === 'module_off' ? 'moduleOff' : st.reason === 'external_blocked' ? 'externalBlocked' : 'notConfigured'
    body = (
      <div className={cn(pad, 'py-4 text-[13.5px]')}>
        <p className="leading-relaxed">{t(`dashboard.d17.ai.${key}`)}</p>
        <p className="text-xs text-muted-foreground">{t(user?.is_admin ? 'dashboard.d17.ai.adminHint' : 'dashboard.d17.ai.userHint')}</p>
        <div className="flex gap-2">
          {user?.is_admin && <UiButton size="sm" onClick={() => { void navigateTo('/admin/ai') }}>{t('dashboard.d17.ai.openAdmin')}</UiButton>}
          <UiButton variant="ghost" size="sm" onClick={() => d.hide('ai')}>{t('dashboard.d17.ai.hide')}</UiButton>
        </div>
      </div>
    )
  } else if (!st.enabled) {
    body = (
      <div className={cn(pad, 'py-4 text-[13.5px]')}>
        <p className="leading-relaxed">{t('dashboard.d17.ai.offDesc')}</p>
        <p className="text-xs text-muted-foreground">{t(st.external ? 'dashboard.d17.ai.offNoteExternal' : 'dashboard.d17.ai.offNote')}</p>
        <div className="flex gap-2">
          <UiButton size="sm" disabled={busy} onClick={() => { void enable(true) }}>{t('dashboard.d17.ai.enable')}</UiButton>
          <UiButton variant="ghost" size="sm" onClick={() => d.hide('ai')}>{t('dashboard.d17.ai.hide')}</UiButton>
        </div>
      </div>
    )
  } else if (st.status === 'generating' || st.status === 'none') {
    body = <Skel reading />
  } else if (st.status === 'failed') {
    body = (
      <div className={cn(pad, 'py-3.5 text-[13.5px]')}>
        <p className="flex items-center gap-2 text-danger"><UiIcon name="alert-circle" className="h-4 w-4 shrink-0" />{st.error || t('dashboard.d17.ai.failed')}</p>
        <div><UiButton variant="outline" size="xs" icon="refresh" disabled={busy || st.regen_left <= 0} onClick={() => { void generate(true) }}>{t('dashboard.d17.ai.retry')}</UiButton></div>
      </div>
    )
  } else {
    body = (
      <div className={cn(pad, 'py-3.5')}>
        {st.items.length ? st.items.map((f, i) => (
          <div key={i} className="flex gap-2.5 text-[13.5px] leading-snug">
            <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
            <p className="min-w-0 flex-1">
              {f.text}{' '}
              {f.sources.map((s, j) => (
                <span key={j}>{j > 0 && <span className="text-xs text-muted-foreground"> · </span>}<NuxtLink to={s.to} className="whitespace-nowrap text-xs text-primary hover:underline">{s.label}</NuxtLink></span>
              ))}
            </p>
          </div>
        )) : <p className="text-[13.5px] text-muted-foreground">{t('dashboard.d17.ai.nothing')}</p>}
        {prep && (
          <div className="rounded-md border border-border bg-background/60 px-3 py-2.5 text-[13px]">
            <button
              type="button"
              aria-expanded={prepShown}
              className="flex w-full items-center gap-2 text-left font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setPrepOpen(!prepShown)}
            >
              <UiIcon name="clock" className="h-4 w-4 text-primary" />
              <span className="min-w-0 flex-1 truncate">{t('dashboard.d17.ai.prep', { title: prep.event.title, time: hhmm(prep.event.start) })}</span>
              <UiIcon name={prepShown ? 'chevron-up' : 'chevron-down'} className="h-4 w-4 text-muted-foreground" />
            </button>
            {prepShown && (
              <ul className="mt-1.5 flex flex-col gap-1 pl-6 text-muted-foreground">
                {/* 근거(관련 채팅)가 없으면 요약 행은 제외하고 "관련 채팅 n · 메일 n" 만 표시 */}
                {prep.last_line && prep.chat.count > 0 && <li>{t('dashboard.d17.ai.prepLast', { text: prep.last_line })}</li>}
                <li>
                  {t('dashboard.d17.ai.prepChat')}{' '}
                  {prep.chat.channel_id
                    ? <NuxtLink to={`/chat?channel=${encodeURIComponent(prep.chat.channel_id)}`} className="text-primary hover:underline">#{prep.chat.channel_name} {prep.chat.count}</NuxtLink>
                    : <span className="font-mono">{prep.chat.count}</span>}
                  {' · '}{t('dashboard.d17.ai.prepMail')}{' '}
                  {prep.mail.count ? <NuxtLink to="/mail" className="text-primary hover:underline">{prep.mail.count}</NuxtLink> : <span className="font-mono">0</span>}
                </li>
                {prep.event.join_url && <li><button type="button" className="text-primary hover:underline" onClick={() => openMeetingLink(prep.event.join_url!)}>{t('meetings.list.join')}</button></li>}
              </ul>
            )}
          </div>
        )}
      </div>
    )
    footer = (
      <div className="flex items-center gap-1 px-4 pb-3 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate"><span className="font-mono">{hhmm(st.generated_at)}</span> {t('dashboard.d17.ai.generated')}</span>
        <UiIconButton
          icon="refresh"
          label={st.regen_left > 0 ? t('dashboard.d17.ai.regen', { n: st.regen_left }) : t('dashboard.d17.ai.regenNone')}
          size="sm"
          disabled={busy || st.regen_left <= 0}
          onClick={() => { void generate(true) }}
        />
        <UiButton variant="ghost" size="xs" aria-pressed={st.feedback === 'helpful'} className={st.feedback === 'helpful' ? 'bg-accent text-foreground' : undefined} onClick={() => { void feedback('helpful') }}>{t('dashboard.d17.ai.helpful')}</UiButton>
        <UiButton variant="ghost" size="xs" aria-pressed={st.feedback === 'not'} className={st.feedback === 'not' ? 'bg-accent text-foreground' : undefined} onClick={() => { void feedback('not') }}>{t('dashboard.d17.ai.notHelpful')}</UiButton>
      </div>
    )
  }

  return <DashCard cardKey="ai" ai title={t('dashboard.d17.ai.title')} footer={footer}>{body}</DashCard>
}

function Skel({ reading }: { reading?: boolean }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-3 border-t border-border px-4 py-3.5" aria-busy="true">
      {[0, 1, 2].map(i => (
        <div key={i} className="flex gap-2.5">
          <span className="mt-0.5 h-3 w-2 animate-pulse rounded bg-muted" />
          <span className="flex flex-1 flex-col gap-1.5"><span className="h-3 w-full animate-pulse rounded bg-muted" /><span className="h-3 w-3/5 animate-pulse rounded bg-muted" /></span>
        </div>
      ))}
      {reading && <p className="text-xs text-muted-foreground" role="status">{t('dashboard.d17.ai.reading')}</p>}
    </div>
  )
}

export default DashboardFocus
