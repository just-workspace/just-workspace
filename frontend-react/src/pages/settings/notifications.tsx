// 설정 › 알림: 브라우저 알림 권한 행(상태 점 + 시험 알림) + 종류 × 데스크톱·모바일·이메일 체크 표.
// 백엔드 /api/notifications/prefs (type 별 in_app·push·email) 그대로 연결 — 서버 9종(시안 7종 + 일정 초대·시스템).
// 방해 금지 일정: GET/PUT /api/notifications/dnd-schedule. 스위치 = 즉시 저장 + "저장됨 ✓", 요일·시간은 [바꾸기] 모달(시안에 편집 화면이 없어
//   기존 폼 규격으로 구성). 서버는 일정 하나(요일 묶음 + 시작·끝)만 저장한다.
// 시험 알림: POST /api/notifications/test(내 푸시 구독 기기 전부). 구독이 없으면 이 브라우저의 로컬 알림으로 대체 표시한다.
// 주의 — 채널 모델 차이: 시안 열은 데스크톱·모바일·이메일, 서버는 앱 안(in_app)·푸시(push)·이메일 → 서버 의미대로 표기.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { requestBrowserPermission } from '~/composables/useNotifications'
import { addToast } from '~/composables/useToast'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsCard } from '~/components/settings/SettingsCard'
import {
  SettingsBrowserPermissionRow, SettingsDndEditModal, SettingsDndRow, SettingsNotifyMatrix,
  type BrowserPermission, type NotifyChannel, type NotifyPref,
} from '~/components/settings/SettingsNotifyParts'

// 디자인 순서(멘션·스레드·작업·회의·공유·새 메일·게시판 필독) + 서버에만 있는 일정 초대·시스템
const notifTypes = ['mention', 'thread_reply', 'task_assigned', 'meeting_invite', 'calendar_invite', 'file_shared', 'new_mail', 'board_must_read', 'system'] as const
const TYPE_KEY: Record<typeof notifTypes[number], string> = {
  mention: 'mention', thread_reply: 'threadReply', task_assigned: 'taskAssigned', meeting_invite: 'meetingInvite', calendar_invite: 'calendarInvite',
  file_shared: 'fileShared', new_mail: 'newMail', board_must_read: 'boardMustRead', system: 'system',
}
const DEFAULT_PREF: NotifyPref = { in_app: true, push: true, email: true }
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

interface DndSchedule { enabled: boolean; days: number[]; start: string; end: string; timezone: string | null }
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export default function SettingsNotificationsPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('profile.navNotifications')} | ${appName}` })

  const rows = notifTypes.map(ty => ({ type: ty, name: t(`settings.notifications.types.${TYPE_KEY[ty]}`), desc: t(`settings.notifications.types.${TYPE_KEY[ty]}Desc`) }))
  const [prefs, setPrefs] = useState<Record<string, NotifyPref>>({})
  const [original, setOriginal] = useState<Record<string, NotifyPref>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const CHANNEL: Record<NotifyChannel, string> = { in_app: t('profile.notifInApp'), push: t('profile.notifPush'), email: t('profile.notifEmail') }
  const val = (ty: string): NotifyPref => prefs[ty] || DEFAULT_PREF
  function setVal(ty: string, k: NotifyChannel, v: boolean) { setPrefs(p => ({ ...p, [ty]: { ...(p[ty] || DEFAULT_PREF), [k]: v } })) }

  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const d = await $fetch<{ prefs: { type: string; in_app: boolean; push: boolean; email: boolean }[] }>('/api/notifications/prefs', { credentials: 'include' })
      const m: Record<string, NotifyPref> = {}
      for (const p of d.prefs || []) m[p.type] = { in_app: p.in_app, push: p.push, email: p.email }
      setPrefs(m)
      setOriginal(clone(m))
    } catch { setLoadError(true) } finally { setLoading(false) }
  }

  const changes = notifTypes.filter(ty => JSON.stringify(val(ty)) !== JSON.stringify(original[ty] || DEFAULT_PREF)).length
  function reset() { setPrefs(clone(original)) }
  async function save() {
    setSaving(true)
    try {
      await $fetch('/api/notifications/prefs', { method: 'PUT', credentials: 'include', body: { prefs: notifTypes.map(ty => ({ type: ty, ...val(ty) })) } })
      setOriginal(clone(prefs))
      setSaved(true); setTimeout(() => { setSaved(false) }, 2000)
    } catch (e) {
      addToast('error', (e as { data?: { detail?: string } })?.data?.detail || t('error.genericError'))
    } finally { setSaving(false) }
  }

  // 브라우저 알림 권한
  const [perm, setPerm] = useState<BrowserPermission>('unsupported')
  const permLabel = ({ granted: t('settings.notifications.permGranted'), denied: t('settings.notifications.permDenied'), default: t('settings.notifications.permDefault'), unsupported: t('settings.notifications.permUnsupported') } as Record<string, string>)[perm]
  const ua = navigator.userAgent
  const browserName = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : t('settings.account.browserFallback')
  async function allow() { setPerm(await requestBrowserPermission()) }
  const [testing, setTesting] = useState(false)
  function localTest() {
    try { new Notification(appName, { body: t('settings.notifications.testBody') }) } catch { /* 무시 */ }
  }
  async function test() {
    if (perm !== 'granted' || testing) return
    setTesting(true)
    try {
      const r = await $fetch<{ ok: boolean; subscriptions: number; sent: number; dnd_scheduled_now: boolean }>('/api/notifications/test', { method: 'POST' })
      if (r.sent > 0) addToast('success', r.dnd_scheduled_now ? t('settings.notifications.testSentDnd', { n: r.sent }) : t('settings.notifications.testSent', { n: r.sent }))
      else {
        // 서버에 푸시 구독이 없음(이 브라우저 구독 실패 등) — 이 브라우저의 로컬 알림으로 형태를 표시한다
        localTest()
        addToast('warning', r.subscriptions ? t('settings.notifications.testNotDelivered') : t('settings.notifications.testNoSubscription'))
      }
    } catch (e) {
      localTest()
      addToast('error', (e as { data?: { detail?: string } })?.data?.detail || t('settings.notifications.testFailed'))
    } finally { setTesting(false) }
  }

  // ── 방해 금지 일정 ──
  const [dnd, setDnd] = useState<DndSchedule | null>(null)
  const [dndActive, setDndActive] = useState(false)
  const [dndSaved, setDndSaved] = useState(false)
  const [dndBusy, setDndBusy] = useState(false)
  async function loadDnd() {
    try {
      const r = await $fetch<{ schedule: DndSchedule; active: boolean }>('/api/notifications/dnd-schedule')
      setDnd(r.schedule); setDndActive(r.active)
    } catch { setDnd(null) }
  }
  async function saveDnd(next: DndSchedule) {
    setDndBusy(true)
    try {
      const r = await $fetch<{ schedule: DndSchedule; active: boolean }>('/api/notifications/dnd-schedule', { method: 'PUT', body: next })
      setDnd(r.schedule); setDndActive(r.active)
      setDndSaved(true); setTimeout(() => { setDndSaved(false) }, 2000)
      return true
    } catch (e) {
      addToast('error', (e as { data?: { detail?: string } })?.data?.detail || t('error.genericError'))
      return false
    } finally { setDndBusy(false) }
  }
  function toggleDnd(v: boolean) { if (dnd) void saveDnd({ ...dnd, enabled: v }) }

  const dayName = (d: number) => t(`settings.notifications.days.${DAY_KEYS[d]}`)
  function dndSummary(s: DndSchedule) {
    const days = [...s.days].sort((a, b) => a - b).join(',')
    const when = days === '0,1,2,3,4,5,6' ? t('settings.notifications.dndEveryday')
      : days === '0,1,2,3,4' ? t('settings.notifications.dndWeekdays')
        : days === '5,6' ? t('settings.notifications.dndWeekend')
          : s.days.map(dayName).join('·')
    const time = s.start === s.end ? t('settings.notifications.dndAllDay') : `${s.start}–${s.end}`
    return { when, time }
  }

  // 바꾸기 모달
  const [dndEdit, setDndEdit] = useState<{ open: boolean; days: number[]; start: string; end: string; error: string }>({ open: false, days: [], start: '22:00', end: '08:00', error: '' })
  function openDndEdit() {
    const s = dnd
    setDndEdit({ open: true, days: s ? [...s.days] : [0, 1, 2, 3, 4, 5, 6], start: s?.start || '22:00', end: s?.end || '08:00', error: '' })
  }
  function toggleDay(d: number) {
    setDndEdit((e) => {
      const set = new Set(e.days)
      if (set.has(d)) set.delete(d)
      else set.add(d)
      return { ...e, days: [...set].sort((a, b) => a - b) }
    })
  }
  async function submitDndEdit() {
    const e = dndEdit
    if (!e.days.length) { setDndEdit({ ...e, error: t('settings.notifications.dndNoDays') }); return }
    if (!HHMM.test(e.start) || !HHMM.test(e.end)) { setDndEdit({ ...e, error: t('settings.notifications.dndBadTime') }); return }
    // 편집을 저장하면 활성화한다(비활성화는 스위치로 수행)
    if (await saveDnd({ enabled: true, days: e.days, start: e.start, end: e.end, timezone: dnd?.timezone ?? null })) setDndEdit(x => ({ ...x, open: false }))
  }

  // onMounted(load) · onMounted(권한) · onMounted(loadDnd)
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void load()
    setPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    void loadDnd()
  }, [])

  return (
    <>
      <SettingsHeader title={t('profile.navNotifications')} subtitle={t('settings.notifications.subtitle')} />

      {/* 브라우저 권한 행 */}
      <SettingsBrowserPermissionRow perm={perm} permLabel={permLabel} browserName={browserName} testing={testing} onAllow={() => void allow()} onTest={() => void test()} />

      <SettingsCard mobileBar="save" changes={changes} saving={saving} saved={saved} flush onSave={() => void save()} onReset={reset}>
        {/* 방해 금지 일정 — GET/PUT /api/notifications/dnd-schedule. 스위치 즉시 저장 + "저장됨 ✓", 요일·시간은 [바꾸기] */}
        <SettingsDndRow
          summary={dnd ? dndSummary(dnd) : null}
          enabled={!!dnd?.enabled}
          activeNow={dndActive}
          saved={dndSaved}
          disabled={!dnd || dndBusy}
          onToggle={toggleDnd}
          onEdit={openDndEdit}
        />
        {loading
          ? <UiSkeleton preset="table" rows={5} />
          : loadError
            ? <UiErrorTile placement="panel" title={t('settings.notifications.loadError')} onRetry={() => void load()} />
            : <SettingsNotifyMatrix rows={rows} value={val} channelLabel={CHANNEL} onChange={setVal} />}
        <p className="px-5 py-3 text-xs text-muted-foreground">{t('settings.notifications.footnote')}</p>
      </SettingsCard>

      {/* 방해 금지 일정 바꾸기(시안에 화면 없음 — 기존 폼 규격) */}
      {dndEdit.open && (
        <SettingsDndEditModal
          days={dndEdit.days}
          start={dndEdit.start}
          end={dndEdit.end}
          error={dndEdit.error}
          busy={dndBusy}
          dayName={dayName}
          onToggleDay={toggleDay}
          onStart={v => setDndEdit(e => ({ ...e, start: v }))}
          onEnd={v => setDndEdit(e => ({ ...e, end: v }))}
          onSubmit={() => void submitDndEdit()}
          onClose={() => setDndEdit(e => ({ ...e, open: false }))}
        />
      )}
    </>
  )
}
