/**
 * 메일 OAuth2(Gmail/Microsoft 365) 앱 자격 증명 — Vue components/admin/AdminMailOAuth.vue. 관리 › 메일 발송.
 * 제공자마다 카드 하나(카드별 저장). 상태는 StatusDot + 글자(설정됨/미설정).
 * redirect URI 는 읽기 전용 입력(점선 + 복사).
 *
 * @example <AdminMailOAuth />
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'

interface PCfg { client_id: string; has_secret: boolean; tenant: string; redirect_uri: string }
const PROVIDERS = ['google', 'microsoft'] as const
type P = typeof PROVIDERS[number]
const LABEL: Record<P, string> = { google: 'Google (Gmail · Workspace)', microsoft: 'Microsoft 365 · Outlook' }
type Form = Record<P, { client_id: string; client_secret: string; tenant: string }>
const EMPTY_FORM: Form = {
  google: { client_id: '', client_secret: '', tenant: '' },
  microsoft: { client_id: '', client_secret: '', tenant: '' },
}

export function AdminMailOAuth() {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<Partial<Record<P, PCfg>>>({})
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [saving, setSaving] = useState<Record<P, boolean>>({ google: false, microsoft: false })
  const [saved, setSaved] = useState<Record<P, boolean>>({ google: false, microsoft: false })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  function formFrom(c: Partial<Record<P, PCfg>>): Form {
    const f = { ...EMPTY_FORM }
    for (const p of PROVIDERS) f[p] = { client_id: c[p]?.client_id || '', tenant: c[p]?.tenant || 'common', client_secret: '' }
    return f
  }

  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const c = await $fetch<Record<P, PCfg>>('/api/mail/oauth/config', { credentials: 'include' })
      setCfg(c)
      setForm(formFrom(c))
    } catch { setLoadError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function setField(p: P, k: keyof Form[P], v: string) {
    setForm(f => ({ ...f, [p]: { ...f[p], [k]: v } }))
  }
  function changes(p: P) {
    return Number(form[p].client_id !== (cfg[p]?.client_id || ''))
      + Number(!!form[p].client_secret.trim())
      + Number(p === 'microsoft' && form[p].tenant !== (cfg[p]?.tenant || 'common'))
  }
  function reset(p: P) {
    setForm(f => ({ ...f, [p]: { client_id: cfg[p]?.client_id || '', tenant: cfg[p]?.tenant || 'common', client_secret: '' } }))
  }
  async function save(p: P) {
    setSaving(s => ({ ...s, [p]: true }))
    try {
      const body: Record<string, string> = { provider: p, client_id: form[p].client_id, tenant: form[p].tenant }
      if (form[p].client_secret.trim()) body.client_secret = form[p].client_secret
      await $fetch('/api/mail/oauth/config', { method: 'PUT', credentials: 'include', body })
      await load()
      setSaved(s => ({ ...s, [p]: true })); setTimeout(() => { setSaved(s => ({ ...s, [p]: false })) }, 2000)
    } catch (e: any) { addToast('error', e?.data?.detail || t('adminParts.mailOAuth.saveError')) }
    finally { setSaving(s => ({ ...s, [p]: false })) }
  }
  function configured(p: P) { return !!(cfg[p]?.client_id && cfg[p]?.has_secret) }

  if (loadError) return <UiErrorTile placement="panel" title={t('adminParts.mailOAuth.loadError')} onRetry={load} />

  return (
    <>
      {PROVIDERS.map(p => (
        <SettingsCard
          key={p}
          title={`OAuth2 · ${LABEL[p]}`}
          description={t('adminParts.mailOAuth.desc')}
          changes={changes(p)}
          saving={saving[p]}
          saved={saved[p]}
          onSave={() => save(p)}
          onReset={() => reset(p)}
          header={
            <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${configured(p) ? 'text-foreground' : 'text-muted-foreground'}`}>
              <UiStatusDot status={configured(p) ? 'ok' : 'off'} label={configured(p) ? t('adminParts.mailOAuth.configured') : t('adminParts.mailOAuth.notConfigured')} />{configured(p) ? t('adminParts.mailOAuth.configured') : t('adminParts.mailOAuth.notConfigured')}
            </span>
          }
        >
          {loading ? (
            <UiSkeleton preset="text" rows={3} />
          ) : (
            <form className="grid gap-x-4 gap-y-3.5" onSubmit={e => { e.preventDefault(); void save(p) }}>
              <UiInput modelValue={cfg[p]?.redirect_uri || ''} label={t('adminParts.mailOAuth.redirectUri')} readonly mono />
              <UiInput modelValue={form[p].client_id} onUpdateModelValue={v => setField(p, 'client_id', v)} label="Client ID" mono />
              <UiPasswordInput modelValue={form[p].client_secret} onUpdateModelValue={v => setField(p, 'client_secret', v)} label="Client Secret" placeholder={cfg[p]?.has_secret ? t('adminParts.secretKeepPlaceholder') : ''} autocomplete="new-password" />
              {p === 'microsoft' && (
                <UiInput modelValue={form[p].tenant} onUpdateModelValue={v => setField(p, 'tenant', v)} label={t('adminParts.mailOAuth.tenant')} hint={t('adminParts.mailOAuth.tenantHint')} mono />
              )}
              <button type="submit" className="hidden" />
            </form>
          )}
        </SettingsCard>
      ))}
    </>
  )
}

export default AdminMailOAuth
