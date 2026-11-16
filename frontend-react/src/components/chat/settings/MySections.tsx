/**
 * 채팅 설정 — "내 설정" 그룹: 프로필 · 메시지 표시 · 알림(음성은 VoiceSection).
 * 프로필: 소개(190자) · 시간대(프로필 팝아웃의 현지 시각) → updateMyChatProfile, 미저장 변경 바.
 *   표시 이름·아바타는 계정 설정(/settings/account) 링크.
 * 메시지 표시: cozy / compact(UiRadioCard row) + 그룹 간격 0/4/8/16/24(UiSegment) — useUserPrefs, 즉시 저장.
 *   아래에 기존 설정 › 채팅의 ① 입력 카드(Enter 키 · 링크 미리보기 · 미디어 펼치기)를 그대로 재사용한다.
 * 알림: 기존 설정 › 채팅의 ② 알림 카드(키워드 · 방해 금지 시간)를 그대로 재사용한다.
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { addToast } from '~/composables/useToast'
import { authStore } from '~/composables/useAuth'
import { closeChatSettings } from '~/composables/useChatUi'
import { fetchChatProfile, updateMyChatProfile } from '~/composables/chatApi22'
import {
  CHAT_GROUP_GAPS, setChatGroupGap, setChatMessageDisplay, userPrefsStore, type ChatGroupGap, type ChatMessageDisplay,
} from '~/composables/useUserPrefs'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiSelect } from '~/components/ui/Select'
import { UiButton } from '~/components/ui/Button'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSegment } from '~/components/ui/Segment'
import { ChatInputPrefsCard, ChatNotifyPrefsCard } from '~/pages/settings/chat'
import { SettingsFrame } from './ServerSections'
import { SaveBar } from './SaveBar'
import { errorText, useSettingsCtx } from './parts'
import { requestLeave, setSettingsDirty } from './settingsStore'

export const BIO_MAX = 190

function timezones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
  try { const v = f?.('timeZone'); if (v?.length) return v } catch { /* 구버전 브라우저 */ }
  return ['Asia/Seoul', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC']
}

function goAccount() {
  if (!requestLeave()) return
  closeChatSettings()
  void navigateTo('/settings/account')
}

export function ProfileSection() {
  const { t } = useI18n()
  const { mobile } = useSettingsCtx()
  const me = useStore(authStore, s => s.user)
  const [base, setBase] = useState<{ bio: string; timezone: string } | null>(null)
  const [draft, setDraft] = useState<{ bio: string; timezone: string }>({ bio: '', timezone: '' })
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!me?.id) return
    fetchChatProfile(me.id)
      .then(p => { const b = { bio: p.bio ?? '', timezone: p.timezone ?? '' }; setBase(b); setDraft(b) })
      .catch(e => { setErr(errorText(e, t('chat.settings.profile.loadFail'))); setBase({ bio: '', timezone: '' }) })
  }, [me?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!base && (draft.bio !== base.bio || draft.timezone !== base.timezone)
  useEffect(() => { setSettingsDirty(dirty) }, [dirty])
  useEffect(() => () => setSettingsDirty(false), [])
  const tzOpts = useMemo(() => [{ value: '', label: t('chat.settings.profile.tzNone') }, ...timezones().map(z => ({ value: z, label: z.replace(/_/g, ' ') }))], [t])

  async function save() {
    setSaving(true)
    try {
      const p = await updateMyChatProfile({ bio: draft.bio.trim() || null, timezone: draft.timezone || null })
      const b = { bio: p.bio ?? '', timezone: p.timezone ?? '' }
      setBase(b); setDraft(b)
      addToast('success', t('chat.settings.dirty.saved'))
    } catch (e) { addToast('error', errorText(e, t('chat.settings.dirty.saveFail'))) } finally { setSaving(false) }
  }

  const name = me?.display_name || me?.username || ''
  return (
    <SettingsFrame title={t('chat.settings.profile.title')} sub={t('chat.settings.profile.sub')}>
      {err && <p role="alert" className="text-[13px] text-danger">{err}</p>}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
        <UiAvatar src={me?.avatar_url} fallback={name.charAt(0) || '?'} textSize={14} className="h-12 w-12" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-semibold">{name}</p>
          <p className="truncate font-mono text-[12px] text-muted-foreground">@{me?.username}</p>
        </div>
        <UiButton type="button" variant="outline" size="sm" iconRight="external-link" onClick={goAccount}>{t('chat.settings.profile.editAccount')}</UiButton>
      </div>
      <UiTextarea
        label={t('chat.settings.profile.bio')}
        hint={t('chat.settings.profile.bioHint', { n: draft.bio.length, max: BIO_MAX })}
        rows={4}
        maxLength={BIO_MAX}
        modelValue={draft.bio}
        disabled={!base}
        onUpdateModelValue={v => setDraft(d => ({ ...d, bio: v.slice(0, BIO_MAX) }))}
      />
      <UiSelect
        label={t('chat.settings.profile.timezone')}
        hint={t('chat.settings.profile.timezoneHint')}
        options={tzOpts}
        search
        modelValue={draft.timezone}
        disabled={!base}
        onUpdateModelValue={v => setDraft(d => ({ ...d, timezone: v ? String(v) : '' }))}
      />
      {dirty && <SaveBar mobile={mobile} saving={saving} onRevert={() => base && setDraft(base)} onSave={() => void save()} />}
    </SettingsFrame>
  )
}

export function DisplaySection() {
  const { t } = useI18n()
  const display = useStore(userPrefsStore, s => s.prefs.chatMessageDisplay)
  const gap = useStore(userPrefsStore, s => s.prefs.chatGroupGap)
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
  return (
    <SettingsFrame title={t('chat.settings.display.title')} sub={t('chat.settings.display.sub')}>
      <div role="radiogroup" aria-labelledby="chat-display-label" className="flex flex-col gap-2">
        <span id="chat-display-label" className="text-[13px] font-medium">{t('chat.settings.display.mode')}</span>
        {(['cozy', 'compact'] as ChatMessageDisplay[]).map(v => (
          <UiRadioCard
            key={v}
            layout="row"
            name="chat-display"
            value={v}
            modelValue={display}
            title={t(`chat.settings.display.${v}`)}
            description={t(`chat.settings.display.${v}Desc`)}
            onUpdateModelValue={() => setChatMessageDisplay(v)}
          />
        ))}
        {coarse && <p className="text-[12px] text-muted-foreground">{t('chat.settings.display.touchNote')}</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <span id="chat-gap-label" className="text-[13px] font-medium">{t('chat.settings.display.gap')}</span>
        <UiSegment
          className="self-start"
          ariaLabel={t('chat.settings.display.gap')}
          modelValue={gap}
          items={CHAT_GROUP_GAPS.map(g => ({ value: g, label: `${g}px` }))}
          onUpdateModelValue={v => setChatGroupGap(Number(v) as ChatGroupGap)}
        />
        <span className="text-[12px] text-muted-foreground">{t('chat.settings.display.gapHint')}</span>
      </div>
      <ChatInputPrefsCard />
    </SettingsFrame>
  )
}

export function NotifySection() {
  const { t } = useI18n()
  return (
    <SettingsFrame title={t('chat.settings.notify.title')} sub={t('chat.settings.notify.sub')}>
      <ChatNotifyPrefsCard />
    </SettingsFrame>
  )
}
