// 관리자 › AI 운영 › 정책 — 화면 구성(개인정보 가리기 · 커넥터 쓰기 · 분당 호출 · 감사 로그 보관 1·2·3년 · 로컬 모델만,
// AI 생성 표시는 끌 수 없음 안내, [되돌리기][저장]). 저장은 PUT /api/ai/governance(바뀐 값만).
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { errText } from '~/utils/errText'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiSwitch } from '~/components/ui/Switch'
import { UiTrans } from '~/components/ui/Trans'
import { aiOpsApi, loadError, type Governance, type LoadError } from '~/utils/aiOps'
import { OpsCard, OpsLoadFailed } from './parts'

interface Form { mask_pii: boolean; mcp_write_enabled: boolean; rate: string; audit_retention_years: number; local_only: boolean }

function toForm(g: Governance): Form {
  return {
    mask_pii: !!g.mask_pii, mcp_write_enabled: !!g.mcp_write_enabled, rate: String(g.mcp_rate_limit_per_min ?? 120),
    audit_retention_years: g.audit_retention_years || 1, local_only: !!g.local_only,
  }
}

/** 0~10000 정수만 */
export function parseRate(v: string): number | null {
  if (!/^\d{1,5}$/.test(v.trim())) return null
  const n = Number(v.trim())
  return n >= 0 && n <= 10000 ? n : null
}

export function PolicyTab() {
  const { t } = useI18n()
  const [orig, setOrig] = useState<Form | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    setError(null)
    try {
      const c = await aiOpsApi.config()
      const f = toForm(c.governance)
      setOrig(f)
      setForm(f)
    } catch (e) {
      setError(loadError('/api/ai/config', e))
    }
  }
  useEffect(() => { void load() }, [])

  if (error) return <OpsLoadFailed error={error} title={t('aiOps.policy.loadFailed')} onRetry={() => void load()} />
  if (!form || !orig) return <div className="max-w-[720px]"><UiSkeleton preset="card" framed delay={false} /></div>

  const rate = parseRate(form.rate)
  const dirty = JSON.stringify(form) !== JSON.stringify(orig)
  const set = (p: Partial<Form>) => setForm(f => (f ? { ...f, ...p } : f))

  async function save() {
    if (!form || !orig || rate == null) return
    const body: Partial<Governance> = {}
    if (form.mask_pii !== orig.mask_pii) body.mask_pii = form.mask_pii
    if (form.mcp_write_enabled !== orig.mcp_write_enabled) body.mcp_write_enabled = form.mcp_write_enabled
    if (form.rate !== orig.rate) body.mcp_rate_limit_per_min = rate
    if (form.audit_retention_years !== orig.audit_retention_years) body.audit_retention_years = form.audit_retention_years
    if (form.local_only !== orig.local_only) body.local_only = form.local_only
    setSaving(true)
    try {
      const r = await aiOpsApi.saveGovernance(body)
      const f = toForm(r.governance)
      setOrig(f)
      setForm(f)
      addToast('success', t('aiOps.policy.saved'))
    } catch (e: any) {
      addToast('error', t('aiOps.policy.saveFailed', { msg: errText(e, e?.message || String(e)) }))
    } finally {
      setSaving(false)
    }
  }

  const keepOpts = [1, 2, 3].map(n => ({ value: n, label: t('aiOps.policy.years', { n }) }))
  return (
    <OpsCard aria-label={t('aiOps.policy.title')} className="flex max-w-[720px] flex-col gap-4 px-[18px] py-4">
      <h2 className="m-0 text-[15px] font-semibold">{t('aiOps.policy.title')}</h2>
      <UiSwitch label={t('aiOps.policy.maskPii')} description={t('aiOps.policy.maskPiiDesc')} modelValue={form.mask_pii} onUpdateModelValue={v => set({ mask_pii: v })} />
      <UiSwitch label={t('aiOps.policy.mcpWrite')} description={t('aiOps.policy.mcpWriteDesc')} modelValue={form.mcp_write_enabled} onUpdateModelValue={v => set({ mcp_write_enabled: v })} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <UiInput
            label={t('aiOps.policy.rate')} modelValue={form.rate} mono type="number" onUpdateModelValue={v => set({ rate: v })}
            error={rate == null ? t('aiOps.policy.rateInvalid') : undefined}
          />
        </div>
        <span className="flex-[1_1_200px] pb-2.5 text-[12.5px] text-muted-foreground">
          <UiTrans k="aiOps.policy.rateHint" slots={{ zero: <span className="font-mono">0</span> }} />
        </span>
      </div>
      <div className="w-60">
        <UiSelect
          label={t('aiOps.policy.retention')} hint={t('aiOps.policy.retentionHint')} options={keepOpts}
          modelValue={form.audit_retention_years} onUpdateModelValue={v => set({ audit_retention_years: Number(v) || 1 })}
        />
      </div>
      <UiSwitch label={t('aiOps.policy.localOnly')} description={t('aiOps.policy.localOnlyDesc')} modelValue={form.local_only} onUpdateModelValue={v => set({ local_only: v })} />
      <div role="note" className="flex gap-2 rounded-lg bg-secondary px-3 py-2.5 text-[12.5px] leading-[19px]">
        <UiIcon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span><UiTrans k="aiOps.policy.aiLabelNote" slots={{ date: <span className="font-mono">2026-01-22</span> }} /></span>
      </div>
      <div className="flex justify-end gap-2">
        <UiButton variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setForm(orig)}>{t('aiOps.policy.revert')}</UiButton>
        <UiButton size="sm" disabled={!dirty || saving || rate == null} onClick={() => void save()}>{t('aiOps.policy.save')}</UiButton>
      </div>
    </OpsCard>
  )
}
