/**
 * 관리 › 설정 › 저장소·백업. 폼 720.
 *  ⓪ 저장소 상태 = AdminStorageStatus(종류·위치·연결·여유 공간, 연결 단절 시 경고).
 *  ① 저장소 — 행(min 52): 전체 사용량 "사용 / 전체 · n%" + 상태 배지, 사용자 기본 할당 [바꾸기], 휴지통 보관 [바꾸기](소형 모달).
 *  ② 자동 백업 = AdminBackup(#backup).
 *  ③ 외부 저장소(파일 시스템 / S3·MinIO) — 백업 카드 아래 별도 카드.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { AdminBackup } from '~/components/admin/AdminBackup'
import { AdminStorageStatus } from '~/components/admin/AdminStorageStatus'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiTrans } from '~/components/ui/Trans'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiIcon } from '~/components/ui/Icon'
import { UiModal } from '~/components/ui/Modal'

function fmtBytes(n: number) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

interface Summary { disk_total: number; disk_used: number; disk_free: number; user_quota_gb: number; trash_retention_days: number }
interface S3 { endpoint: string; region: string; bucket: string; access_key: string; prefix: string; secret_set?: boolean }
interface Storage { backend: 'filesystem' | 's3'; s3: S3 }
const EMPTY: Storage = { backend: 'filesystem', s3: { endpoint: '', region: '', bucket: '', access_key: '', prefix: '', secret_set: false } }
const clone = (s: Storage): Storage => JSON.parse(JSON.stringify(s))
const S3_KEYS = ['endpoint', 'region', 'bucket', 'access_key', 'prefix'] as const

export default function AdminStoragePage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.storage.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  // ── ① 저장소 요약 ──
  const [sum, setSum] = useState<Summary | null>(null)
  const [sumError, setSumError] = useState(false)
  const [sumSaved, setSumSaved] = useState(false)
  async function loadSummary() {
    setSumError(false)
    try { setSum(await $fetch<Summary>('/api/admin/storage/summary')) } catch { setSumError(true) }
  }
  const pct = sum && sum.disk_total ? Math.round((sum.disk_used / sum.disk_total) * 100) : 0
  const usageTone = pct >= 95 ? 'danger' : pct >= 80 ? 'warning' : 'success'

  const [edit, setEdit] = useState({ open: false, kind: 'quota' as 'quota' | 'trash', value: '', error: '', saving: false })
  function openEdit(kind: 'quota' | 'trash') {
    if (!sum) return
    setEdit({ open: true, kind, value: String(kind === 'quota' ? sum.user_quota_gb : sum.trash_retention_days), error: '', saving: false })
  }
  async function saveEdit() {
    const n = Number(edit.value)
    if (!Number.isInteger(n) || n < 0) { setEdit(e => ({ ...e, error: t('admin.storageSummary.numberError') })); return }
    setEdit(e => ({ ...e, saving: true }))
    try {
      if (edit.kind === 'quota') await $fetch('/api/admin/storage/quota', { method: 'PUT', body: { user_quota_gb: n } })
      else await $fetch('/api/admin/settings/general', { method: 'PATCH', body: { trash_retention_days: n } })
      setEdit(e => ({ ...e, open: false }))
      await loadSummary()
      setSumSaved(true); setTimeout(() => { setSumSaved(false) }, 2000)
    } catch (err: any) { setEdit(e => ({ ...e, error: err?.data?.detail || t('admin.storage.saveFailed') })) }
    finally { setEdit(e => ({ ...e, saving: false })) }
  }

  // ── ③ 파일 저장소 종류(기존) ──
  const [st, setSt] = useState<Storage>(clone(EMPTY))
  const [orig, setOrig] = useState<Storage>(clone(EMPTY))
  const [secret, setSecret] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const setS3 = (k: typeof S3_KEYS[number], v: string) => setSt(s => ({ ...s, s3: { ...s.s3, [k]: v } }))

  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const r = await $fetch<Storage>('/api/setup/storage')
      const next: Storage = { backend: r.backend, s3: { ...EMPTY.s3, ...(r.s3 || {}) } }
      setSt(next)
      setOrig(clone(next))
    } catch { setLoadError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void loadSummary(); void load() }, [])

  const changes = Number(st.backend !== orig.backend) + S3_KEYS.filter(k => st.s3[k] !== orig.s3[k]).length + Number(!!secret)
  function reset() { setSt(clone(orig)); setSecret(''); setTestResult(null) }
  function body() {
    const s3: Record<string, unknown> = { ...st.s3 }
    delete s3.secret_set
    if (secret) s3.secret_key = secret
    return { backend: st.backend, s3 }
  }
  async function save() {
    setSaving(true)
    try {
      await $fetch('/api/setup/storage', { method: 'PATCH', body: body() })
      setSecret('')
      await load()
      setSaved(true); setTimeout(() => { setSaved(false) }, 2000)
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.storage.saveFailed')) }
    finally { setSaving(false) }
  }
  async function test() {
    setTesting(true); setTestResult(null)
    try {
      const r = await $fetch<{ ok: boolean; message: string }>('/api/setup/storage/test', { method: 'POST', body: body() })
      setTestResult(r)
    } catch (e: any) { setTestResult({ ok: false, message: e?.data?.detail || t('admin.storage.testFailed') }) }
    finally { setTesting(false) }
  }

  if (!user?.is_admin) return null
  return (
    <AdminPageShell title={t('admin.storage.pageTitle')} subtitle={t('admin.storage.subtitle')} width="form">
      {/* ⓪ 저장소 상태 */}
      <AdminStorageStatus />

      {/* ① 저장소 */}
      <SettingsCard title={t('admin.storageSummary.title')} description={t('admin.storageSummary.desc')} saved={sumSaved} flush>
        {sumError ? (
          <UiErrorTile placement="card" title={t('admin.storageSummary.loadError')} className="mx-5 mb-4" onRetry={loadSummary} />
        ) : !sum ? (
          <UiSkeleton preset="list" rows={3} />
        ) : (
          <>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('admin.storageSummary.usage')}</b>
                <span className="block text-xs text-muted-foreground"><span className="font-mono">{fmtBytes(sum.disk_used)} / {fmtBytes(sum.disk_total)}</span> · {pct}%</span>
              </span>
              <UiBadge tone={usageTone} tint>{usageTone === 'success' ? t('admin.storageSummary.plenty') : t('admin.storageSummary.low')}</UiBadge>
            </div>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('admin.storageSummary.quota')}</b>
                <span className="block text-xs text-muted-foreground">{sum.user_quota_gb ? t('admin.storageSummary.quotaValue', { n: sum.user_quota_gb }) : t('admin.storageSummary.quotaNone')}</span>
              </span>
              <UiButton variant="outline" size="xs" className="font-semibold" onClick={() => openEdit('quota')}>{t('admin.branding.replace')}</UiButton>
            </div>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('admin.storageSummary.trash')}</b>
                <span className="block text-xs text-muted-foreground">{sum.trash_retention_days ? t('admin.storageSummary.trashValue', { n: sum.trash_retention_days }) : t('admin.storageSummary.trashNever')}</span>
              </span>
              <UiButton variant="outline" size="xs" className="font-semibold" onClick={() => openEdit('trash')}>{t('admin.branding.replace')}</UiButton>
            </div>
          </>
        )}
      </SettingsCard>

      {/* ② 자동 백업 */}
      <AdminBackup id="backup" className="scroll-mt-4" />

      {/* ③ 외부 저장소(백업 카드 아래 별도 카드) */}
      <SettingsCard title={t('admin.storage.externalTitle')} description={t('admin.storage.cardDesc')} changes={changes} saving={saving} saved={saved} onSave={save} onReset={reset}>
        {loading ? (
          <UiSkeleton preset="text" rows={3} />
        ) : loadError ? (
          <UiErrorTile placement="card" title={t('admin.storage.loadError')} onRetry={load} />
        ) : (
          <div className="flex flex-col gap-4">
            <div role="radiogroup" aria-label={t('admin.storage.typeAria')} className="grid gap-3 sm:grid-cols-2">
              <UiRadioCard modelValue={st.backend} onUpdateModelValue={v => setSt(s => ({ ...s, backend: v as Storage['backend'] }))} value="filesystem" title={t('admin.storage.fsTitle')} description={t('admin.storage.fsDesc')} />
              <UiRadioCard modelValue={st.backend} onUpdateModelValue={v => setSt(s => ({ ...s, backend: v as Storage['backend'] }))} value="s3" title="S3 · MinIO" description={t('admin.storage.s3Desc')} />
            </div>
            {st.backend === 's3' ? (
              <form className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void save() }}>
                <UiInput modelValue={st.s3.endpoint} onUpdateModelValue={v => setS3('endpoint', v)} label={t('admin.storage.endpoint')} hint={t('admin.storage.endpointHint')} mono className="sm:col-span-2" />
                <UiInput modelValue={st.s3.bucket} onUpdateModelValue={v => setS3('bucket', v)} label={t('admin.storage.bucket')} mono />
                <UiInput modelValue={st.s3.region} onUpdateModelValue={v => setS3('region', v)} label={t('admin.storage.region')} placeholder="us-east-1" mono />
                <UiInput modelValue={st.s3.access_key} onUpdateModelValue={v => setS3('access_key', v)} label="Access Key" mono />
                <UiPasswordInput modelValue={secret} onUpdateModelValue={setSecret} label="Secret Key" placeholder={st.s3.secret_set ? t('admin.storage.secretSaved') : ''} autocomplete="new-password" />
                <UiInput modelValue={st.s3.prefix} onUpdateModelValue={v => setS3('prefix', v)} label={t('admin.storage.prefix')} placeholder="workspace/" mono className="sm:col-span-2" />
                <button type="submit" className="hidden" />
              </form>
            ) : (
              <UiTrans
                k="admin.storage.fsNote"
                as="p"
                className="text-[13px] text-muted-foreground"
                slots={{ path: <code className="font-mono text-xs">/storage</code> }}
              />
            )}
            <p className="text-xs text-muted-foreground">{t('admin.storage.s3Note')}</p>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <UiButton variant="outline" size="sm" disabled={testing} onClick={test}>{testing ? t('admin.storage.testing') : t('admin.storage.test')}</UiButton>
              {testResult && (
                <p role="status" className={cn('flex min-w-0 items-center gap-1.5 text-xs', testResult.ok ? 'text-success' : 'text-danger')}>
                  <UiIcon name={testResult.ok ? 'check-circle' : 'alert-circle'} className="h-3.5 w-3.5 shrink-0" /><span className="break-all">{testResult.message}</span>
                </p>
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      {edit.open && (
        <UiModal
          title={edit.kind === 'quota' ? t('admin.storageSummary.quota') : t('admin.storageSummary.trash')}
          size="440"
          onClose={() => setEdit(e => ({ ...e, open: false }))}
          footer={
            <>
              <UiButton variant="outline" size="sm" onClick={() => setEdit(e => ({ ...e, open: false }))}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={edit.saving} onClick={saveEdit}>{t('common.save')}</UiButton>
            </>
          }
        >
          <form onSubmit={e => { e.preventDefault(); void saveEdit() }}>
            <UiInput
              modelValue={edit.value}
              onUpdateModelValue={v => setEdit(e => ({ ...e, value: v }))}
              type="number"
              min="0"
              label={edit.kind === 'quota' ? t('admin.storageSummary.quotaLabel') : t('admin.storageSummary.trashLabel')}
              hint={edit.kind === 'quota' ? t('admin.storageSummary.quotaHint') : t('admin.storageSummary.trashHint')}
              error={edit.error}
              mono
              onInput={() => setEdit(e => ({ ...e, error: '' }))}
            />
            <button type="submit" className="hidden" />
          </form>
        </UiModal>
      )}
    </AdminPageShell>
  )
}
