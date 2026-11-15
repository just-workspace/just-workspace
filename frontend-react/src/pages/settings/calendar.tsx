// 설정 › 캘린더 — React 에만 있는 화면(Vue 동결 뒤 신설).
//  ① 보기 카드: 기본 보기 UiSegment(일·주·월·일정) + 주 시작 요일 · 기본 알림 · 시간대 UiSelect(2열).
//     고르면 바로 저장 + "저장됨 ✓"(카드 저장 규칙 — 선택만 있는 카드). 값은 useUserPrefs → /api/me/prefs
//     (calendar.default_view · calendar.default_reminder · week_start · timezone). 주 시작·시간대는 설정 › 표시와 같은 값.
//  ② 외부 캘린더 구독 카드: GET/POST /api/calendar/subscriptions, POST …/{id}/refresh(⋮ "지금 새로 고침", 1분 최소 간격 429), PATCH·DELETE /api/calendar/calendars/{id}.
//     구독은 읽기 전용 캘린더로 붙고 서버가 6시간마다 새로 받는다(SSRF 방지·5MB·20초 — backend app/calendar/subscriptions.py).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useUserPrefs, setPref, type CalendarView, type Prefs } from '~/composables/useUserPrefs'
import { addToast } from '~/composables/useToast'
import { fetchCalendars, openShareModal } from '~/composables/useCalendar'
import { resolveWeekStart } from '~/utils/calendarLayout'
import { tzSelectSearch } from '~/utils/timezoneBand'
import { timeZoneList, tzOffsetMinutes } from '~/utils/calendarAttendees'
import { UiCard } from '~/components/ui/Card'
import { UiCardHeader } from '~/components/ui/CardHeader'
import { UiCardTitle } from '~/components/ui/CardTitle'
import { UiCardContent } from '~/components/ui/CardContent'
import { UiSegment } from '~/components/ui/Segment'
import { UiSelect } from '~/components/ui/Select'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsSavedMark } from '~/components/settings/SettingsSavedMark'
import {
  SettingsSubscriptionRow, refreshSubscriptionNow, subscriptionColorOf, confirmUnsubscribe, type CalendarSubscription,
} from '~/components/settings/SettingsCalendarParts'
import { CalendarSubscribeModal } from '~/components/calendar/CalendarSubscribeModal'
import { CalendarShareModal } from '~/components/calendar/CalendarShareModal'

/** "UTC+9" · "UTC+5:30" · "UTC" */
function utcLabel(tz: string): string {
  const off = tzOffsetMinutes(tz, new Date())
  if (!off) return 'UTC'
  const a = Math.abs(off)
  return `UTC${off > 0 ? '+' : '-'}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`
}

const REMINDERS = ['none', '5', '10', '30', '60'] as const

export default function SettingsCalendarPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('settings.calendarPrefs.title')} | ${appName}` })

  // ── ① 보기 ──
  const { prefs } = useUserPrefs()
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function flash() {
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => { setSaved(false) }, 2000)
  }
  function save<K extends keyof Prefs>(k: K, v: Prefs[K]) { setPref(k, v); flash() }

  const VIEWS = [
    { value: 'day', label: t('calendar.viewMode.day') },
    { value: 'week', label: t('calendar.viewMode.week') },
    { value: 'month', label: t('calendar.viewMode.month') },
    { value: 'agenda', label: t('calendar.viewMode.agenda') },
  ]
  const localeDay = resolveWeekStart('locale', navigator.language) === 1 ? t('settings.calendarPrefs.mon') : t('settings.calendarPrefs.sun')
  const WEEK = [
    { value: 'locale', label: t('settings.calendarPrefs.weekLocale', { day: localeDay }) },
    { value: 'sun', label: t('settings.calendarPrefs.sun') },
    { value: 'mon', label: t('settings.calendarPrefs.mon') },
    { value: 'sat', label: t('settings.calendarPrefs.sat') },
  ]
  const ALERTS = REMINDERS.map(v => ({
    value: v,
    label: v === 'none' ? t('settings.calendarPrefs.reminderNone') : v === '60' ? t('settings.calendarPrefs.reminderHour') : t('settings.calendarPrefs.reminderMinutes', { n: Number(v) }),
  }))
  const reminderValue = prefs.calendarDefaultReminder == null ? 'none' : String(prefs.calendarDefaultReminder)
  const ZONES = useMemo(() => {
    const sys = Intl.DateTimeFormat().resolvedOptions().timeZone
    const top = ['Asia/Seoul', 'Asia/Tokyo', 'UTC']
    const names = Array.from(new Set([...top, ...timeZoneList()]))
    return [{ value: '', label: t('settings.calendarPrefs.tzBrowser', { tz: sys }) }, ...names.map(n => ({ value: n, label: `${n} (${utcLabel(n)})` }))]
  }, [t])

  const tzSearch = useMemo(() => tzSelectSearch(t), [t])

  // ── ② 구독 ──
  const [subs, setSubs] = useState<CalendarSubscription[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function load() {
    setLoadError(false)
    try {
      const r = await $fetch<CalendarSubscription[]>('/api/calendar/subscriptions')
      setSubs(Array.isArray(r) ? r : [])
    } catch { setLoadError(true) }
  }
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void load()
  }, [])

  const replace = (row: CalendarSubscription) => setSubs(list => (list ?? []).map(s => (s.id === row.id ? row : s)))

  async function onAction(sub: CalendarSubscription, key: string) {
    if (key === 'refresh') {
      setBusyId(sub.id)
      try {
        const row = await refreshSubscriptionNow(t, sub)
        if (row) replace(row)
      } finally { setBusyId(null) }
      return
    }
    const color = subscriptionColorOf(key)
    if (color) {
      try {
        await $fetch(`/api/calendar/calendars/${sub.id}`, { method: 'PATCH', body: { color } })
        replace({ ...sub, color })
        void fetchCalendars()
      } catch { addToast('error', t('error.genericError')) }
      return
    }
    if (key === 'share') {
      // 사이드바와 같은 공유 대화 상자(이 화면에도 그려 둔다)
      openShareModal({ id: sub.id, name: sub.name, color: sub.color, is_visible: sub.is_visible ?? true, sort_order: 0, is_subscription: true })
      return
    }
    if (key === 'remove') {
      if (!await confirmUnsubscribe(t, sub.name)) return
      try {
        await $fetch(`/api/calendar/calendars/${sub.id}`, { method: 'DELETE' })
        setSubs(list => (list ?? []).filter(s => s.id !== sub.id))
        void fetchCalendars()
      } catch { addToast('error', t('error.genericError')) }
    }
  }

  return (
    <>
      <SettingsHeader title={t('settings.calendarPrefs.title')} subtitle={t('settings.calendarPrefs.subtitle')} />

      <UiCard>
        <UiCardHeader>
          <div className="flex items-center gap-3">
            <UiCardTitle className="flex-1">{t('settings.calendarPrefs.viewTitle')}</UiCardTitle>
            {saved && <SettingsSavedMark />}
          </div>
          <p className="text-[13px] text-muted-foreground">{t('settings.calendarPrefs.viewDesc')}</p>
        </UiCardHeader>
        <UiCardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">{t('settings.calendarPrefs.defaultView')}</span>
            <UiSegment
              className="self-start"
              ariaLabel={t('settings.calendarPrefs.defaultView')}
              modelValue={prefs.calendarDefaultView}
              items={VIEWS}
              onUpdateModelValue={v => save('calendarDefaultView', v as CalendarView)}
            />
          </div>
          <UiSelect label={t('settings.calendarPrefs.weekStart')} modelValue={prefs.weekStart} options={WEEK} onUpdateModelValue={v => save('weekStart', v as Prefs['weekStart'])} />
          <UiSelect
            label={t('settings.calendarPrefs.reminder')}
            modelValue={reminderValue}
            options={ALERTS}
            hint={t('settings.calendarPrefs.reminderHint')}
            onUpdateModelValue={v => save('calendarDefaultReminder', v === 'none' || v == null ? null : Number(v))}
          />
          <UiSelect
            label={t('settings.calendarPrefs.timezone')}
            modelValue={prefs.timezone || ''}
            options={ZONES}
            search={tzSearch}
            hint={t('settings.calendarPrefs.timezoneHint')}
            onUpdateModelValue={v => save('timezone', String(v ?? ''))}
          />
        </UiCardContent>
      </UiCard>

      <UiCard>
        <UiCardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <UiCardTitle>{t('settings.calendarPrefs.subsTitle')}</UiCardTitle>
            <p className="mt-1 text-[13px] text-muted-foreground">{t('settings.calendarPrefs.subsDesc')}</p>
          </div>
          <UiButton variant="outline" size="sm" className="shrink-0" onClick={() => setAdding(true)}>{t('settings.calendarPrefs.subsAdd')}</UiButton>
        </UiCardHeader>
        <div className="border-t border-border">
          {loadError
            ? <UiErrorTile placement="panel" title={t('settings.calendarPrefs.loadError')} onRetry={() => void load()} />
            : subs === null
              ? <UiSkeleton preset="list" rows={2} />
              : !subs.length
                ? <UiEmptyState variant="inline" inset title={t('settings.calendarPrefs.empty')} />
                : subs.map(s => (
                  <SettingsSubscriptionRow key={s.id} sub={s} busy={busyId === s.id} onAction={k => void onAction(s, k)} />
                ))}
        </div>
      </UiCard>

      {adding && (
        <CalendarSubscribeModal
          existingCount={subs?.length ?? 0}
          onAdded={(row) => { setSubs(list => [...(list ?? []), row]); void fetchCalendars() }}
          onClose={() => setAdding(false)}
        />
      )}
      <CalendarShareModal />
    </>
  )
}
