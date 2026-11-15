/**
 * 채팅 설정 — 워크스페이스 "개요" · "알림 기본값"(서버 설정 GET/PUT /api/chat/server-settings).
 * 개요: 이름(비면 사이트 이름이 자리표시 — 사이드바 머리 이름) · 설명 → 저장 안 된 변경 띠(되돌리기 · 저장).
 * 알림 기본값: 모든 메시지 / @멘션만 / 알림 없음(UiRadioCard row) — 고르면 바로 저장. 이미 바꾼 개인 설정은 그대로.
 * 서버에 없으면(404) "서버가 아직 지원하지 않습니다", can_edit false 면 보기만.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { UiInput } from '~/components/ui/Input'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiRadioCard } from '~/components/ui/RadioCard'
import type { ChatNotifyLevel } from '~/composables/chatApi22'
import { loadServerSettings, saveServerSettings, useChatServer } from './serverSettingsStore'
import { SaveBar } from './SaveBar'
import { MobileHeader, SettingsBanner, SettingsHeader, errorText, useSettingsCtx } from './parts'
import { setSettingsDirty } from './settingsStore'

function useServer() {
  const settings = useChatServer(s => s.settings)
  const state = useChatServer(s => s.state)
  useEffect(() => { void loadServerSettings(true) }, [])
  return { settings, state }
}

function StateBanner({ state, canEdit }: { state: string; canEdit: boolean }) {
  const { t } = useI18n()
  if (state === 'unsupported') return <SettingsBanner tone="info" icon="info">{t('chat.settings.server.unsupported')}</SettingsBanner>
  if (state === 'error') return <SettingsBanner tone="danger" icon="alert-circle">{t('chat.settings.server.loadFail')}</SettingsBanner>
  if (state === 'ok' && !canEdit) return <SettingsBanner tone="info" icon="lock">{t('chat.settings.server.readOnly')}</SettingsBanner>
  return null
}

function Frame({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  const { mobile, backToMenu } = useSettingsCtx()
  if (mobile) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title={title} onBack={backToMenu} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">{children}</div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title={title} sub={sub} />
      {children}
    </div>
  )
}

export function OverviewSection() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const { mobile } = useSettingsCtx()
  const { settings, state } = useServer()
  const base = { name: settings?.name ?? '', description: settings?.description ?? '' }
  const [draft, setDraft] = useState(base)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft({ name: settings?.name ?? '', description: settings?.description ?? '' }) }, [settings?.name, settings?.description])
  const dirty = draft.name !== base.name || draft.description !== base.description
  useEffect(() => { setSettingsDirty(dirty) }, [dirty])
  useEffect(() => () => setSettingsDirty(false), [])
  const canEdit = state === 'ok' && !!settings?.can_edit

  async function save() {
    setSaving(true)
    try {
      await saveServerSettings({ name: draft.name.trim() || null, description: draft.description.trim() || null })
      addToast('success', t('chat.settings.dirty.saved'))
    } catch (e) { addToast('error', errorText(e, t('chat.settings.dirty.saveFail'))) } finally { setSaving(false) }
  }

  return (
    <Frame title={t('chat.settings.overview.title')} sub={t('chat.settings.overview.sub')}>
      <StateBanner state={state} canEdit={!!settings?.can_edit} />
      <UiInput
        label={t('chat.settings.overview.name')}
        hint={t('chat.settings.overview.nameHint', { app: appName })}
        placeholder={appName}
        maxLength={100}
        modelValue={draft.name}
        disabled={!canEdit}
        onUpdateModelValue={v => setDraft(d => ({ ...d, name: v }))}
      />
      <UiTextarea
        label={t('chat.settings.overview.description')}
        rows={3}
        maxLength={500}
        modelValue={draft.description}
        disabled={!canEdit}
        onUpdateModelValue={v => setDraft(d => ({ ...d, description: v }))}
      />
      {dirty && <SaveBar mobile={mobile} saving={saving} onRevert={() => setDraft(base)} onSave={() => void save()} />}
    </Frame>
  )
}

const LEVELS: ChatNotifyLevel[] = ['all', 'mentions', 'none']

export function NotifyDefaultSection() {
  const { t } = useI18n()
  const { settings, state } = useServer()
  const [busy, setBusy] = useState(false)
  const canEdit = state === 'ok' && !!settings?.can_edit
  async function pick(v: ChatNotifyLevel) {
    if (!settings || v === settings.default_notify_level) return
    setBusy(true)
    try { await saveServerSettings({ default_notify_level: v }); addToast('success', t('chat.settings.dirty.saved')) } catch (e) {
      addToast('error', errorText(e, t('chat.settings.dirty.saveFail')))
    } finally { setBusy(false) }
  }
  return (
    <Frame title={t('chat.settings.notifyDefault.title')} sub={t('chat.settings.notifyDefault.sub')}>
      <StateBanner state={state} canEdit={!!settings?.can_edit} />
      {state === 'ok' && settings && (
        <div role="radiogroup" aria-label={t('chat.settings.notifyDefault.title')} className="flex flex-col gap-2">
          {LEVELS.map(v => (
            <UiRadioCard
              key={v}
              layout="row"
              name="notify-default"
              value={v}
              modelValue={settings.default_notify_level}
              title={t(`chat.settings.notifyDefault.${v}`)}
              description={t(`chat.settings.notifyDefault.${v}Desc`)}
              disabled={!canEdit || busy}
              onUpdateModelValue={() => void pick(v)}
            />
          ))}
          <p className="text-[12px] text-muted-foreground">{t('chat.settings.notifyDefault.note')}</p>
        </div>
      )}
      {state === 'loading' && <p className="text-[13px] text-muted-foreground">{t('common.loading')}</p>}
    </Frame>
  )
}

export { Frame as SettingsFrame }
