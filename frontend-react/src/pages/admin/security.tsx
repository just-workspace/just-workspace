/**
 * 관리 › 설정 › 보안·SSL. 폼 720.
 *  ⓪ 인증서(AdminCertCard) — 설치 관리자가 인증서를 관리하는 설치: 상태, 재발급, 인증서 올리기, 진행·실패.
 *     이 경우 ①은 렌더링하지 않는다(①의 올리기로는 설치 관리자가 배치한 인증서를 교체할 수 없다).
 *     설치 관리자 없이 구성한 설치에서는 ⓪이 안내 한 줄로 축소되고 ①이 기존과 동일하게 표시된다.
 *  ① SSL 인증서 — 머리 배지(만료 30일 이내 "갱신 필요"), 인증서 행(도메인 600 + "MM/DD 만료 · D-n", 상태 배지).
 *     서버 effective(관리 개요 ops-summary 의 ssl 과 동일 출처) 하나를 표시한다. 재발급 버튼은 두지 않는다.
 *     머리 오른쪽 [인증서 업로드](outline) → AdminSslUploadModal(미리 읽기·짝 검사) + 기존 삭제 줄. 자동 발급 버튼은 없다(재발급 버튼 미제공).
 *  ② 로그인 보호 — 2단계 인증 필수 대상 UiSelect(없음/관리자/전체), 연속 실패 잠금, 새 기기 로그인 메일 알림. 즉시 저장.
 *  ③ 세션 — 세션 유지·유휴 로그아웃 선택 + 카드 푸터 저장.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { useAuth, fetchUser } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { daysUntil, refreshAdminOps } from '~/composables/useAdminOps'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiBadge } from '~/components/ui/Badge'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiSelect } from '~/components/ui/Select'
import { UiSwitch } from '~/components/ui/Switch'
import { UiButton } from '~/components/ui/Button'
import { AdminSslUploadModal } from '~/components/admin/AdminSslUploadModal'
import { AdminCertCard } from '~/components/admin/AdminCertCard'

interface Effective { not_after: string | null; days_left: number | null; source: string | null; name?: string | null; issuer?: string | null }
interface Ssl { installed: boolean; subject?: string; issuer?: string; not_before?: string; not_after?: string; has_key?: boolean; error?: string; effective?: Effective }
interface Policy { require_2fa: 'off' | 'admins' | 'all'; lockout_enabled: boolean; new_device_alert: boolean; idle_timeout_minutes: number; lockout_threshold: number; lockout_minutes: number; idle_choices: number[] }
interface Shown { name: string; issuer: string; notAfter: string; source: string }

const SRC_KEY: Record<string, string> = { file: 'srcFile', local: 'srcLocal', probe: 'srcProbe', remote: 'srcRemote' }

/** 표시할 인증서 = 서버 effective. effective 가 없는 구버전 서버에서는 업로드된 인증서 정보로 대체 */
function shownCert(s: Ssl | null): Shown | null {
  if (!s) return null
  const e = s.effective
  if (e?.source && e.not_after) return { name: e.name || '—', issuer: e.issuer || '', notAfter: e.not_after, source: e.source }
  if (e === undefined && s.installed && s.not_after) {
    const cn = (s.subject || '').match(/CN\s*=\s*([^,/]+)/)?.[1]
    const org = (s.issuer || '').match(/O\s*=\s*([^,/]+)/)?.[1]
    return { name: (cn || s.subject || '—').trim(), issuer: (org || '').trim(), notAfter: s.not_after, source: 'local' }
  }
  return null
}
// 시안 "10/27 만료 · D-12" — 관리 개요와 동일한 MM/DD 형식
function mmdd(iso: string) { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}` }

export default function AdminSecurityPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.security.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  function flash(set: (v: boolean) => void) { set(true); setTimeout(() => { set(false) }, 2000) }

  // ── ⓪ 설치 관리자가 인증서를 관리하는지 여부 — null: 미확인 · true: 관리하지 않음(① 표시) · false: 관리함(⓪ 만 표시) ──
  const [legacyCert, setLegacyCert] = useState<boolean | null>(null)

  // ── ① 인증서 ──
  const [ssl, setSsl] = useState<Ssl | null>(null)
  const [sslError, setSslError] = useState(false)
  async function loadSsl() {
    setSslError(false)
    try { setSsl(await $fetch<Ssl>('/api/admin/settings/ssl')) } catch { setSslError(true) }
  }
  const shown = shownCert(ssl)
  const certDesc = !shown
    ? (ssl?.effective !== undefined ? t('admin.sslPage.certDescUnknown') : t('admin.sslPage.certDescNone'))
    : t('admin.sslPage.certDescSrc', { name: shown.name, issuer: shown.issuer || '—', src: t(`admin.sslPage.${SRC_KEY[shown.source] || 'srcRemote'}`) })
  const days = daysUntil(shown?.notAfter)
  const certBadge = days == null ? null
    : days < 0 ? { tone: 'danger' as const, text: t('admin.common.expired') }
      : days <= 30 ? { tone: 'warning' as const, text: `D-${days}` }
        : { tone: 'success' as const, text: t('admin.sslPage.ok') }
  let expiryText = ''
  const na = shown?.notAfter
  if (na) {
    if (Number.isNaN(Date.parse(na))) expiryText = na
    else {
      const date = mmdd(na)
      expiryText = days != null && days >= 0 ? t('admin.sslPage.expiresShort', { date, n: days }) : t('admin.sslPage.expiredOn', { date })
    }
  }

  // ── ② 로그인 보호 · ③ 세션 ──
  const [pol, setPol] = useState<Policy | null>(null)
  const [polError, setPolError] = useState(false)
  const [polSaved, setPolSaved] = useState(false)
  async function loadPolicy(): Promise<Policy | null> {
    setPolError(false)
    try { const p = await $fetch<Policy>('/api/admin/settings/security-policy'); setPol(p); return p } catch { setPolError(true); return null }
  }
  async function putPolicy(body: Partial<Policy>, setSaved: (v: boolean) => void = setPolSaved) {
    try {
      setPol(await $fetch<Policy>('/api/admin/settings/security-policy', { method: 'PUT', body }))
      flash(setSaved)
      if ('require_2fa' in body) void fetchUser()
      return true
    } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')); return false }
  }
  const scopeOptions = [
    { value: 'off', label: t('admin.sslPage.scopeNone') },
    { value: 'admins', label: t('admin.sslPage.scopeAdmins') },
    { value: 'all', label: t('admin.sslPage.scopeAll') },
  ]

  const [sess, setSess] = useState({ remember: '30', idle: '0' })
  const [sessOrig, setSessOrig] = useState({ remember: '30', idle: '0' })
  const [sessSaving, setSessSaving] = useState(false)
  const [sessSaved, setSessSaved] = useState(false)
  async function loadSession(p: Policy | null) {
    let remember = '30'
    try {
      const g = await $fetch<{ session_remember_days: number }>('/api/admin/settings/general')
      remember = String(g.session_remember_days)
    } catch { /* 일반 설정 조회 실패 시 기본값 사용 */ }
    const next = { remember, idle: String(p?.idle_timeout_minutes ?? 0) }
    setSess(next)
    setSessOrig({ ...next })
  }
  const sessChanges = Number(sess.remember !== sessOrig.remember) + Number(sess.idle !== sessOrig.idle)
  const rememberOptions = [1, 7, 14, 30, 60, 90].map(d => ({ value: String(d), label: t('admin.sslPage.days', { n: d }) }))
  if (!rememberOptions.some(o => o.value === sess.remember)) rememberOptions.push({ value: sess.remember, label: t('admin.sslPage.days', { n: sess.remember }) })
  const idleOptions = (pol?.idle_choices ?? [0, 15, 30, 60, 120, 240, 480]).map(m => ({
    value: String(m),
    label: m === 0 ? t('admin.sslPage.idleOff') : m < 60 ? t('admin.sslPage.minutes', { n: m }) : t('admin.sslPage.hours', { n: m / 60 }),
  }))
  async function saveSession() {
    setSessSaving(true)
    try {
      if (sess.remember !== sessOrig.remember) await $fetch('/api/admin/settings/general', { method: 'PATCH', body: { session_remember_days: Number(sess.remember) } })
      if (sess.idle !== sessOrig.idle && !await putPolicy({ idle_timeout_minutes: Number(sess.idle) }, setSessSaved)) return
      setSessOrig({ ...sess })
      flash(setSessSaved)
    } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
    finally { setSessSaving(false) }
  }

  // ── ④ 인증서 올리기 ──
  const [uploaded, setUploaded] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  async function onUploaded() {
    addToast('success', t('admin.sslUpload.applied'))
    await loadSsl(); void refreshAdminOps()
    flash(setUploaded)
  }
  async function removeCert() {
    if (!await confirmBox(t('admin.security.removeBody'), { title: t('admin.settings.ssl.deleteConfirm'), confirmLabel: t('common.delete'), danger: true })) return
    try { await $fetch('/api/admin/settings/ssl', { method: 'DELETE' }); setUploadOpen(false); await loadSsl(); void refreshAdminOps() }
    catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
  }

  useEffect(() => {
    void loadSsl()
    void (async () => { const p = await loadPolicy(); void loadSession(p) })()
  }, [])

  if (!user?.is_admin) return null
  return (
    <AdminPageShell title={t('admin.sslPage.pageTitle')} subtitle={t('admin.sslPage.subtitle')} width="form">
      {/* ⓪ 인증서(설치 관리자) */}
      <AdminCertCard onLegacy={setLegacyCert} />

      {/* ① SSL 인증서 — 설치 관리자가 인증서를 관리하지 않는 설치에서만 표시 */}
      {legacyCert === true && <SettingsCard
        title={t('admin.sslPage.certTitle')}
        description={ssl ? certDesc : ''}
        flush
        saved={uploaded}
        header={(
          <>
            {certBadge && certBadge.tone !== 'success' && <UiBadge tone={certBadge.tone} tint>{certBadge.tone === 'danger' ? t('admin.common.expired') : t('admin.sslPage.renewNeeded')}</UiBadge>}
            <UiButton variant="outline" size="sm" className="shrink-0" onClick={() => setUploadOpen(true)}>{t('admin.sslPage.uploadCert')}</UiButton>
          </>
        )}
      >
        {sslError ? (
          <UiErrorTile placement="card" title={t('admin.security.loadError')} className="mx-5 mb-4" onRetry={loadSsl} />
        ) : !ssl ? (
          <UiSkeleton preset="list" rows={1} />
        ) : !shown ? (
          <UiEmptyState
            variant="inline"
            inset
            title={ssl.effective !== undefined ? t('admin.sslPage.unknownTitle') : t('admin.settings.ssl.noCert')}
            className="border-t border-border"
          />
        ) : (
          <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
            <span className="min-w-0 flex-1">
              <b className="block truncate font-semibold text-foreground">{shown.name}</b>
              <span className="block truncate text-xs text-muted-foreground">{expiryText}{shown.source === 'local' && ssl.has_key === false && <> · {t('admin.security.noKey')}</>}</span>
            </span>
            {certBadge && <UiBadge tone={certBadge.tone} tint>{certBadge.text}</UiBadge>}
          </div>
        )}
      </SettingsCard>}

      {/* ② 로그인 보호 */}
      <SettingsCard title={t('admin.sslPage.protectTitle')} description={t('admin.sslPage.protectDesc')} saved={polSaved} flush>
        {polError ? (
          <UiErrorTile placement="card" title={t('admin.sslPage.policyLoadError')} className="mx-5 mb-4" onRetry={loadPolicy} />
        ) : !pol ? (
          <UiSkeleton preset="list" rows={3} />
        ) : (
          <>
            <div className="flex min-h-[52px] flex-wrap items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('admin.sslPage.require2fa')}</b>
                <span className="block text-xs text-muted-foreground">{t('admin.sslPage.require2faDesc')}</span>
              </span>
              <UiSelect
                modelValue={pol.require_2fa}
                onUpdateModelValue={v => { void putPolicy({ require_2fa: v as Policy['require_2fa'] }) }}
                options={scopeOptions}
                size="sm"
                aria-label={t('admin.sslPage.scopeAria')}
                className="w-40"
              />
            </div>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('admin.sslPage.lockout', { n: pol.lockout_threshold, m: pol.lockout_minutes })}</b>
                <span className="block text-xs text-muted-foreground">{t('admin.sslPage.lockoutDesc')}</span>
              </span>
              <UiSwitch modelValue={pol.lockout_enabled} ariaLabel={t('admin.sslPage.lockout', { n: pol.lockout_threshold, m: pol.lockout_minutes })} onUpdateModelValue={v => { void putPolicy({ lockout_enabled: v }) }} />
            </div>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('admin.sslPage.newDevice')}</b>
                <span className="block text-xs text-muted-foreground">{t('admin.sslPage.newDeviceDesc')}</span>
              </span>
              <UiSwitch modelValue={pol.new_device_alert} ariaLabel={t('admin.sslPage.newDevice')} onUpdateModelValue={v => { void putPolicy({ new_device_alert: v }) }} />
            </div>
          </>
        )}
      </SettingsCard>

      {/* ③ 세션 */}
      <SettingsCard title={t('admin.sslPage.sessionTitle')} changes={sessChanges} saving={sessSaving} saved={sessSaved} onSave={saveSession} onReset={() => setSess({ ...sessOrig })}>
        <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
          <UiSelect modelValue={sess.remember} onUpdateModelValue={v => setSess(s => ({ ...s, remember: String(v) }))} options={rememberOptions} label={t('admin.sslPage.remember')} hint={t('admin.sslPage.rememberHint')} />
          <UiSelect modelValue={sess.idle} onUpdateModelValue={v => setSess(s => ({ ...s, idle: String(v) }))} options={idleOptions} label={t('admin.sslPage.idle')} hint={t('admin.sslPage.idleHint')} />
        </div>
      </SettingsCard>

      {/* 인증서 올리기(SSL 카드 머리 버튼 → 모달). 삭제 줄은 기존 기능 유지 */}
      {uploadOpen && (
        <AdminSslUploadModal
          onUploaded={() => void onUploaded()}
          onClose={() => setUploadOpen(false)}
          extra={ssl?.installed && (
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>{t('admin.settings.ssl.nginxHint')}</span>
              <button type="button" className="relative shrink-0 font-semibold text-danger hover:underline after:absolute after:-inset-3 after:content-['']" onClick={removeCert}>{t('admin.settings.ssl.deleteCert')}</button>
            </div>
          )}
        />
      )}
    </AdminPageShell>
  )
}
