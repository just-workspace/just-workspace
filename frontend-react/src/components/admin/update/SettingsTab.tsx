/**
 * 업데이트 › 설정 — 적용 방식(수동/자동 + 시간대), 채널(안정판/시험판), 점검 화면의 관리자 연락처.
 *
 *  · 자동: 서버 시간 기준 시간대, 나온 지 며칠 지난 릴리스만(서버가 준 값), 실패하면 되돌리고 멈춘다는 안내.
 *  · 안정판 → 시험판: 경고. 시험판 → 안정판: "다음 안정판까지 기다리기" / "시험판 이전 상태로 복원" 중 고른다.
 *    복원은 확인 창을 거쳐 복원 작업을 시작하고 진행 화면으로 간다.
 *  · 안정판으로 돌아와 기다리는 중이면 어느 버전부터 다시 받는지 보여 준다.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import {
  updateApi, errorCode, formatTime, jobPath, HOURS,
  type Channel, type SettingsReply, type UpdateMode, type UpdateSettings, type UpdateStatus,
} from '~/composables/useSystemUpdate'
import { Mono, Unavailable, useLoad } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiRadio } from '~/components/ui/Radio'
import { UiSelect } from '~/components/ui/Select'
import { UiInput } from '~/components/ui/Input'
import { UiModal } from '~/components/ui/Modal'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'

interface Form { mode: UpdateMode; start: string; end: string; channel: Channel; back: 'wait' | 'restore'; contact: string }
const formOf = (s: UpdateSettings, contact: string | null): Form => ({ mode: s.mode, start: s.window.start, end: s.window.end, channel: s.channel, back: 'wait', contact: contact ?? '' })

export function SettingsTab({ status, onSaved }: { status: UpdateStatus | null; onSaved: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const settings = useLoad(() => updateApi.settings())
  const contact = useLoad(() => updateApi.contact())
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [wait, setWait] = useState<SettingsReply['effect']['wait']>(null)

  const saved = settings.data
  const savedContact = contact.data?.contact ?? null
  useEffect(() => {
    if (saved && (contact.data || contact.error) && !form) setForm(formOf(saved, savedContact))
  }, [saved, contact.data, contact.error, form, savedContact])

  if (settings.unavailable) return <Unavailable reason={settings.unavailable} />
  if (!saved || !form) {
    return settings.error
      ? <UiErrorTile placement="card" title={t('admin.update.settings.loadError')} onRetry={() => { void settings.reload() }} />
      : <UiCard><UiSkeleton preset="list" rows={5} /></UiCard>
  }

  const set = (patch: Partial<Form>) => setForm(f => (f ? { ...f, ...patch } : f))
  const base = formOf(saved, savedContact)
  const toBeta = saved.channel === 'stable' && form.channel === 'beta'
  const toStable = saved.channel === 'beta' && form.channel === 'stable'
  const restorePoint = saved.beta?.restore_point ?? null
  const windowError = form.mode === 'auto' && form.start === form.end
  const settingsDirty = form.mode !== base.mode || form.channel !== base.channel || (form.mode === 'auto' && (form.start !== base.start || form.end !== base.end))
  const contactDirty = form.contact.trim() !== base.contact
  const dirty = settingsDirty || contactDirty
  const hours = HOURS.map(h => ({ value: h, label: h }))
  // 안정판으로 돌아와 기다리는 중 — 방금 저장했거나, 전에 바꿔 둔 상태
  const waiting = wait ?? (saved.channel === 'stable' && status?.available.state === 'wait' ? status.available : null)

  async function save(restore: boolean) {
    setBusy(true)
    try {
      if (contactDirty) {
        const r = await updateApi.saveContact(form!.contact.trim() || null)
        contact.set({ contact: r.contact })
      }
      if (settingsDirty) {
        const reply = await updateApi.saveSettings({
          mode: form!.mode, window: { start: form!.start, end: form!.end }, channel: form!.channel,
          ...(toStable ? { stable_return: restore ? 'restore' as const : 'wait' as const } : {}),
        })
        if (reply.effect?.job) { navigate(jobPath(reply.effect.job)); return }
        settings.set(reply.settings)
        setWait(reply.effect?.channel === 'to_stable_wait' ? reply.effect.wait ?? { channel_latest: null, resume_from: null } : null)
        setForm(formOf(reply.settings, form!.contact.trim() || null))
      } else {
        setForm(formOf(saved!, form!.contact.trim() || null))
      }
      addToast('success', t('admin.update.settings.saved'))
      onSaved()
    } catch (e: any) {
      const code = errorCode(e)
      addToast('error', code === 'busy' ? t('admin.update.busy') : code === 'restore_point_missing' ? t('admin.update.settings.noRestorePoint') : e?.data?.detail || t('admin.update.settings.saveFailed'))
    } finally { setBusy(false); setConfirm(false) }
  }
  function onSave() {
    if (toStable && form!.back === 'restore') setConfirm(true)
    else void save(false)
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <h2 id="upd-mode" className="text-sm font-semibold leading-5">{t('admin.update.settings.mode')}</h2>
        <div role="radiogroup" aria-labelledby="upd-mode" className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-2">
          {(['manual', 'auto'] as const).map(m => (
            <UiRadioCard key={m} className="w-full" layout="row" value={m} title={t(`admin.update.mode.${m}.title`)} description={t(`admin.update.mode.${m}.desc`)}
              modelValue={form.mode} onUpdateModelValue={v => { if (v != null) set({ mode: v as UpdateMode }) }} />
          ))}
        </div>
        {form.mode === 'auto' && (
          <UiCard data-testid="update-auto-window">
            <div className="flex flex-col gap-3 p-4">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
                <UiSelect native label={t('admin.update.settings.windowStart')} options={hours} modelValue={form.start} onUpdateModelValue={v => set({ start: String(v) })} />
                <UiSelect native label={t('admin.update.settings.windowEnd')} options={hours} modelValue={form.end} onUpdateModelValue={v => set({ end: String(v) })}
                  error={windowError ? t('admin.update.settings.windowSame') : undefined} />
              </div>
              <p className="text-xs leading-[18px] text-muted-foreground" data-testid="update-auto-note">
                <UiTrans k="admin.update.settings.autoNote" slots={{ days: <Mono>{saved.min_age_days}</Mono> }} />
              </p>
            </div>
          </UiCard>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 id="upd-channel" className="text-sm font-semibold leading-5">{t('admin.update.settings.channel')}</h2>
        <div role="radiogroup" aria-labelledby="upd-channel" className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-2">
          {(['stable', 'beta'] as const).map(c => (
            <UiRadioCard key={c} className="w-full" layout="row" value={c} title={t(`admin.update.channel.${c}.title`)} description={t(`admin.update.channel.${c}.desc`)}
              modelValue={form.channel} onUpdateModelValue={v => { if (v != null) set({ channel: v as Channel }) }} />
          ))}
        </div>
        {toBeta && (
          <UiCallout tone="warning" data-testid="update-to-beta" title={t('admin.update.settings.toBeta.title')}>{t('admin.update.settings.toBeta.body')}</UiCallout>
        )}
        {toStable && (
          <UiCallout tone="neutral" icon="info" data-testid="update-to-stable" title={t('admin.update.settings.toStable.title')}>
            <div role="radiogroup" aria-label={t('admin.update.settings.toStable.aria')} className="flex flex-col gap-2 pt-1">
              <UiRadio name="upd-back" value="wait" label={t('admin.update.settings.toStable.wait')} description={t('admin.update.settings.toStable.waitDesc')}
                modelValue={form.back} onUpdateModelValue={v => { if (v != null) set({ back: 'wait' }) }} />
              <UiRadio name="upd-back" value="restore" label={t('admin.update.settings.toStable.restore')} disabled={!restorePoint}
                description={restorePoint ? t('admin.update.settings.toStable.restoreDesc') : t('admin.update.settings.noRestorePoint')}
                modelValue={form.back} onUpdateModelValue={v => { if (v != null) set({ back: 'restore' }) }} />
            </div>
          </UiCallout>
        )}
        {!toStable && !toBeta && waiting && (
          <UiCallout tone="neutral" icon="clock" role="status" data-testid="update-stable-wait" title={t('admin.update.home.wait.title')}>
            {waiting.resume_from
              ? <UiTrans k="admin.update.home.wait.body" slots={{ version: <Mono>{waiting.resume_from}</Mono>, current: <Mono>{status?.current.version ?? ''}</Mono> }} />
              : t('admin.update.home.wait.bodyUnknown')}
          </UiCallout>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold leading-5">{t('admin.update.settings.maint')}</h2>
        <UiInput label={t('admin.update.settings.contact')} hint={t('admin.update.settings.contactHint')} maxLength={200}
          modelValue={form.contact} onUpdateModelValue={v => set({ contact: v })} />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <span role="status" className="min-w-0 flex-1 basis-[200px] text-[13px] text-muted-foreground">{dirty ? t('admin.update.settings.dirty') : ''}</span>
        <UiButton variant="secondary" disabled={!dirty || busy} onClick={() => setForm(base)}>{t('common.cancel')}</UiButton>
        <UiButton disabled={!dirty || busy || windowError} onClick={onSave}>{t('common.save')}</UiButton>
      </div>

      {confirm && (
        <UiModal confirm danger size="440" title={t('admin.update.settings.betaRestore.title')} onClose={() => { if (!busy) setConfirm(false) }}
          footer={<>
            <UiButton variant="outline" size="sm" disabled={busy} onClick={() => setConfirm(false)}>{t('common.cancel')}</UiButton>
            <UiButton variant="danger" size="sm" disabled={busy} onClick={() => { void save(true) }}>{t('admin.update.restore.start')}</UiButton>
          </>}>
          <div className="flex flex-col gap-2 text-[13.5px] text-muted-foreground" data-testid="update-beta-restore-body">
            <p>{t('admin.update.restore.loss')}</p>
            {formatTime(saved.beta?.since) && <p><UiTrans k="admin.update.settings.betaRestore.since" slots={{ time: <Mono>{formatTime(saved.beta?.since)}</Mono> }} /></p>}
            <p>{t('admin.update.restore.maint')}</p>
          </div>
        </UiModal>
      )}
    </>
  )
}

export default SettingsTab
