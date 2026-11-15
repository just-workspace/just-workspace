/**
 * 관리 › 설정 › 일반 — Vue pages/admin/settings.vue. 본문 720, 카드별 저장.
 *  ① 로그인 방식(순서·사용 여부) + LDAP 연결 = AdminLoginMethods
 *  ② 대시보드 문구·공지(공지 한 계통 + "보이는 곳": 상단 띠 = general.announcement / 대시보드 = appcfg dash.notice_banner)
 *  ③ 가입·세션·파일 보관
 * 예전 딥링크 /admin/settings#ai 는 /admin/ai 로 보낸다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo, useRoute } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig, refetchAppConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { AdminLoginMethods } from '~/components/admin/AdminLoginMethods'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'

type Level = 'info' | 'warning' | 'danger'
type Where = 'band' | 'dash' | 'both'
interface Copy { notice: string; level: Level; where: Where; greetingMode: string; greetingText: string; primaryLabel: string; primaryHref: string; latency: string }
const COPY_EMPTY: Copy = { notice: '', level: 'warning', where: 'both', greetingMode: 'date', greetingText: '', primaryLabel: '', primaryHref: '', latency: '' }
const BAND_TYPE: Record<Level, string> = { info: 'info', warning: 'warning', danger: 'error' }
const DASH_LEVEL: Record<Level, string> = { info: 'accent', warning: 'warning', danger: 'danger' }

interface General { registration_mode: string; upload_max_size_mb: number | string; session_hours: number | string; session_remember_days: number | string; git_visibility: string; trash_retention_days: number | string; versions_max_age_days: number | string }
const GEN_KEYS: (keyof General)[] = ['registration_mode', 'upload_max_size_mb', 'session_hours', 'session_remember_days', 'git_visibility', 'trash_retention_days', 'versions_max_age_days']
const GEN_DEFAULT: General = { registration_mode: 'approval', upload_max_size_mb: 1024, session_hours: 8, session_remember_days: 30, git_visibility: 'private', trash_retention_days: 30, versions_max_age_days: 0 }

/** 서버 두 계통(상단 띠 · 대시보드) → 화면의 공지 한 계통 */
function copyFrom(g: { announcement?: string; announcement_type?: string }, v: Record<string, string>): Copy {
  const band = (g.announcement || '').trim()
  const dash = (v['dash.notice_banner'] || '').trim()
  const bandLevel: Level = g.announcement_type === 'error' ? 'danger' : g.announcement_type === 'warning' ? 'warning' : 'info'
  const dashLevel: Level = v['dash.notice_level'] === 'danger' ? 'danger' : v['dash.notice_level'] === 'accent' ? 'info' : 'warning'
  return {
    notice: band || dash,
    level: band ? bandLevel : dash ? dashLevel : 'warning',
    where: band && dash ? 'both' : band ? 'band' : dash ? 'dash' : 'both',
    greetingMode: ['custom', 'none'].includes(v['dash.greeting_mode']) ? v['dash.greeting_mode'] : 'date',
    greetingText: v['dash.greeting_text'] || '',
    primaryLabel: v['dash.primary_action'] || '',
    primaryHref: v['dash.primary_href'] || '',
    latency: v['system.latency_warn_ms'] || '',
  }
}

export default function AdminSettingsPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.settings.general.title'), app: appName }) })
  const { user } = useAuth()
  const route = useRoute()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  // 예전 딥링크(/admin/settings#ai — AI 화면의 "설정")는 AI 항목으로 보낸다
  useEffect(() => { if (route.hash === '#ai') void navigateTo('/admin/ai', { replace: true }) }, [route.hash])

  function flash(set: (v: boolean) => void) { set(true); setTimeout(() => { set(false) }, 2000) }

  // ── ② 대시보드 문구 · 공지 ──
  const [copy, setCopy] = useState<Copy>({ ...COPY_EMPTY })
  const [copyOrig, setCopyOrig] = useState<Copy>({ ...COPY_EMPTY })
  const [copyLoading, setCopyLoading] = useState(true)
  const [copyError, setCopyError] = useState(false)
  const [copySaving, setCopySaving] = useState(false)
  const [copySaved, setCopySaved] = useState(false)
  const setC = <K extends keyof Copy>(k: K, v: Copy[K]) => setCopy(c => ({ ...c, [k]: v }))

  const LEVELS = [{ value: 'info', label: t('admin.settings.copy.levelInfo') }, { value: 'warning', label: t('admin.settings.copy.levelWarning') }, { value: 'danger', label: t('admin.settings.copy.levelDanger') }]
  const WHERES = [{ value: 'band', label: t('admin.settings.copy.whereBand') }, { value: 'dash', label: t('admin.settings.copy.whereDash') }, { value: 'both', label: t('admin.settings.copy.whereBoth') }]
  const GREETINGS = [{ value: 'date', label: t('admin.settings.copy.greetAuto') }, { value: 'custom', label: t('admin.settings.copy.greetCustom') }, { value: 'none', label: t('admin.settings.copy.greetHidden') }]

  // ── ③ 가입·세션·파일 ──
  const [general, setGeneral] = useState<General>({ ...GEN_DEFAULT })
  const [generalOrig, setGeneralOrig] = useState<General>({ ...GEN_DEFAULT })
  const [genSaving, setGenSaving] = useState(false)
  const [genSaved, setGenSaved] = useState(false)
  const setG = <K extends keyof General>(k: K, v: General[K]) => setGeneral(g => ({ ...g, [k]: v }))

  async function load() {
    setCopyLoading(true); setCopyError(false)
    try {
      const [g, a] = await Promise.all([
        $fetch<General & { announcement: string; announcement_type: string }>('/api/admin/settings/general'),
        $fetch<{ values: Record<string, string> }>('/api/admin/settings/appconfig'),
      ])
      const gen = { ...GEN_DEFAULT }
      for (const k of GEN_KEYS) (gen as any)[k] = (g as any)[k]
      setGeneral(gen)
      setGeneralOrig({ ...gen })
      const c = copyFrom(g, a.values || {})
      setCopy(c)
      setCopyOrig({ ...c })
    } catch { setCopyError(true) } finally { setCopyLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const copyChanges = (Object.keys(COPY_EMPTY) as (keyof Copy)[]).filter(k => String(copy[k]) !== String(copyOrig[k])).length
  const latencyError = copy.latency && !/^\d{1,6}$/.test(copy.latency.trim()) ? t('admin.settings.copy.latencyError') : ''
  function resetCopy() { setCopy({ ...copyOrig }) }
  async function saveCopy() {
    if (latencyError) return
    setCopySaving(true)
    const text = copy.notice.trim()
    const toBand = copy.where !== 'dash' ? text : ''
    const toDash = copy.where !== 'band' ? text : ''
    try {
      await Promise.all([
        $fetch('/api/admin/settings/general', { method: 'PATCH', body: { announcement: toBand, announcement_type: BAND_TYPE[copy.level] } }),
        $fetch('/api/admin/settings/appconfig', {
          method: 'PATCH',
          body: { values: {
            'dash.notice_banner': toDash,
            'dash.notice_level': DASH_LEVEL[copy.level],
            'dash.greeting_mode': copy.greetingMode,
            'dash.greeting_text': copy.greetingText.trim(),
            'dash.primary_action': copy.primaryLabel.trim(),
            'dash.primary_href': copy.primaryHref.trim(),
            'system.latency_warn_ms': copy.latency.trim(),
          } },
        }),
      ])
      setCopyOrig({ ...copy })
      await refetchAppConfig()
      flash(setCopySaved)
    } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
    finally { setCopySaving(false) }
  }

  const genChanges = GEN_KEYS.filter(k => String(general[k]) !== String(generalOrig[k])).length
  function resetGeneral() { setGeneral({ ...generalOrig }) }
  async function saveGeneral() {
    setGenSaving(true)
    const body: Record<string, unknown> = {}
    for (const k of GEN_KEYS) {
      if (String(general[k]) === String(generalOrig[k])) continue
      body[k] = typeof generalOrig[k] === 'number' ? Number(general[k]) : general[k]
    }
    try {
      await $fetch('/api/admin/settings/general', { method: 'PATCH', body })
      setGeneralOrig({ ...general })
      await refetchAppConfig()
      flash(setGenSaved)
    } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
    finally { setGenSaving(false) }
  }

  const REG_MODES = [
    { value: 'open', label: t('admin.settings.general.regOpen') },
    { value: 'approval', label: t('admin.settings.general.regApproval') },
    { value: 'closed', label: t('admin.settings.general.regClosed') },
  ]
  const GIT_VIS = [
    { value: 'private', label: t('admin.settings.general.gitPrivate') },
    { value: 'public', label: t('admin.settings.general.gitPublic') },
  ]

  if (!user?.is_admin) return null
  return (
    <AdminPageShell title={t('admin.settings.general.title')} subtitle={t('admin.settings.pageSubtitle')} width="form">
      <AdminLoginMethods />

      {/* 대시보드 문구 · 공지 */}
      <SettingsCard
        title={t('admin.settings.copy.title')}
        description={t('admin.settings.copy.description')}
        changes={copyChanges}
        saving={copySaving}
        saved={copySaved}
        onSave={saveCopy}
        onReset={resetCopy}
      >
        {copyLoading ? (
          <UiSkeleton preset="text" rows={4} />
        ) : copyError ? (
          <UiErrorTile placement="card" title={t('admin.settings.copy.loadError')} onRetry={load} />
        ) : (
          <form className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void saveCopy() }}>
            <UiInput modelValue={copy.notice} onUpdateModelValue={v => setC('notice', v)} label={t('admin.settings.copy.notice')} placeholder={t('admin.settings.copy.noticePlaceholder')} maxLength={120} className="sm:col-span-2" />
            <UiSelect modelValue={copy.level} onUpdateModelValue={v => setC('level', v as Level)} options={LEVELS} label={t('admin.settings.copy.level')} />
            <UiSelect modelValue={copy.where} onUpdateModelValue={v => setC('where', v as Where)} options={WHERES} label={t('admin.settings.copy.where')} />
            <UiSelect modelValue={copy.greetingMode} onUpdateModelValue={v => setC('greetingMode', String(v))} options={GREETINGS} label={t('admin.settings.copy.greeting')} />
            <UiInput modelValue={copy.latency} onUpdateModelValue={v => setC('latency', v)} label={t('admin.settings.copy.latency')} placeholder="800" hint={t('admin.settings.copy.latencyHint')} error={latencyError} mono inputMode="numeric" />
            {copy.greetingMode === 'custom' && (
              <UiInput modelValue={copy.greetingText} onUpdateModelValue={v => setC('greetingText', v)} label={t('admin.settings.copy.greetingText')} maxLength={80} className="sm:col-span-2" />
            )}
            <UiInput modelValue={copy.primaryLabel} onUpdateModelValue={v => setC('primaryLabel', v)} label={t('admin.settings.copy.primaryLabel')} placeholder={t('admin.settings.copy.primaryPlaceholder')} hint={t('admin.settings.copy.primaryHint')} maxLength={40} />
            <UiInput modelValue={copy.primaryHref} onUpdateModelValue={v => setC('primaryHref', v)} label={t('admin.settings.copy.primaryHref')} placeholder="/board/…" mono maxLength={200} />
            <button type="submit" className="hidden" />
          </form>
        )}
      </SettingsCard>

      {/* 가입·세션·파일 보관 */}
      <SettingsCard
        id="general"
        title={t('admin.settings.genTitle')}
        changes={genChanges}
        saving={genSaving}
        saved={genSaved}
        className="scroll-mt-4"
        onSave={saveGeneral}
        onReset={resetGeneral}
      >
        {copyLoading ? (
          <UiSkeleton preset="text" rows={4} />
        ) : (
          <form className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void saveGeneral() }}>
            <UiSelect modelValue={general.registration_mode} onUpdateModelValue={v => setG('registration_mode', String(v))} options={REG_MODES} label={t('admin.settings.general.registrationMode')} hint={t('admin.settings.general.registrationModeHint')} />
            <UiInput modelValue={general.upload_max_size_mb} onUpdateModelValue={v => setG('upload_max_size_mb', v)} type="number" min="1" max="10240" label={`${t('admin.settings.general.uploadMaxSize')} (MB)`} mono />
            <UiInput modelValue={general.session_hours} onUpdateModelValue={v => setG('session_hours', v)} type="number" min="1" max="720" label={`${t('admin.settings.general.sessionHours')} (${t('admin.settings.general.hours')})`} mono />
            <UiInput modelValue={general.session_remember_days} onUpdateModelValue={v => setG('session_remember_days', v)} type="number" min="1" max="365" label={`${t('admin.settings.general.sessionRememberDays')} (${t('admin.settings.general.days')})`} mono />
            <UiSelect modelValue={general.git_visibility} onUpdateModelValue={v => setG('git_visibility', String(v))} options={GIT_VIS} label={t('admin.settings.general.gitVisibility')} hint={t('admin.settings.general.gitVisibilityHint')} className="sm:col-span-2" />
            <UiInput modelValue={general.trash_retention_days} onUpdateModelValue={v => setG('trash_retention_days', v)} type="number" min="0" max="3650" label={`${t('admin.settings.general.trashRetentionDays')} (${t('admin.settings.general.days')})`} hint={t('admin.settings.general.trashRetentionHint')} mono />
            <UiInput modelValue={general.versions_max_age_days} onUpdateModelValue={v => setG('versions_max_age_days', v)} type="number" min="0" max="3650" label={`${t('admin.settings.general.versionsMaxAgeDays')} (${t('admin.settings.general.days')})`} hint={t('admin.settings.general.versionsMaxAgeHint')} mono />
            <button type="submit" className="hidden" />
          </form>
        )}
      </SettingsCard>
    </AdminPageShell>
  )
}
