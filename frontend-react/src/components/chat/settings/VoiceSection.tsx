/**
 * 음성 · 눌러서 말하기 — 개인 설정(useUserPrefs, 계정에 저장).
 * 입력 모드(UiRadioCard row: 음성 감지 / 눌러서 말하기) · 단축키 기록(누르면 "키를 누르세요…" + 지금 키캡, Esc = 취소) ·
 * 놓기 지연 UiSlider 0–2000 ms(10 단계, 값 mono) · 브라우저 안내 한 줄 · 다른 단축키(Ctrl+Shift+M 음소거 · Ctrl+Shift+D 듣기 끔 — 계정 패널).
 * 아래에 음질·장치(VoiceQualityContent) — 접속 줄 팝오버와 같은 설정.
 * PTT 강제(#voice-forced): 이 워크스페이스에서 내 '음성 감지 사용'(USE_VAD) 권한이 없으면 음성 감지 잠김 + warn banner.
 */
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiIcon } from '~/components/ui/Icon'
import { UiSlider } from '~/components/ui/Slider'
import { userPrefsStore, setChatVoiceMode, setChatPttKey, setChatPttReleaseMs } from '~/composables/useUserPrefs'
import { PERM, canWorkspace, useChatRoles } from '~/composables/useChatRoles'
import { VoiceQualityContent } from '~/components/voice/VoiceQualityPanel'
import { pttKeyLabel } from './settingsLogic'
import { MobileHeader, SettingsBanner, SettingsHeader, useSettingsCtx } from './parts'

export function VoiceSection() {
  const { t } = useI18n()
  const { mobile, backToMenu } = useSettingsCtx()
  const mode = useStore(userPrefsStore, s => s.prefs.chatVoiceMode)
  const key = useStore(userPrefsStore, s => s.prefs.chatPttKey)
  const releaseMs = useStore(userPrefsStore, s => s.prefs.chatPttReleaseMs)
  const forced = !useChatRoles(s => canWorkspace(PERM.USE_VAD, s))
  const eff = forced ? 'ptt' : mode
  const [recording, setRecording] = useState(false)
  const [ms, setMs] = useState(releaseMs)
  useEffect(() => { setMs(releaseMs) }, [releaseMs])

  useEffect(() => {
    if (!recording) return
    function onKey(e: KeyboardEvent) {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.code === 'Escape') { setRecording(false); return }
      if (e.code) setChatPttKey(e.code)
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  const body = (
    <div className="flex flex-col gap-5">
      {forced && <SettingsBanner tone="warn" icon="lock">{t('chat.settings.voice.forcedBanner')}</SettingsBanner>}
      <div role="radiogroup" aria-labelledby="voice-mode-label" className="flex flex-col gap-2">
        <span id="voice-mode-label" className="text-[13px] font-medium">{t('chat.settings.voice.mode')}</span>
        <UiRadioCard
          layout="row"
          name="voice-mode"
          value="vad"
          modelValue={eff}
          title={t('chat.settings.voice.vad')}
          description={forced ? t('chat.settings.voice.vadForced') : t('chat.settings.voice.vadDesc')}
          disabled={forced}
          onUpdateModelValue={() => setChatVoiceMode('vad')}
        />
        <UiRadioCard
          layout="row"
          name="voice-mode"
          value="ptt"
          modelValue={eff}
          title={t('chat.settings.voice.ptt')}
          description={t('chat.settings.voice.pttDesc')}
          onUpdateModelValue={() => setChatVoiceMode('ptt')}
        />
      </div>
      <div className={cn('grid gap-5', mobile ? 'grid-cols-1' : 'grid-cols-2')}>
        <div className="flex flex-col gap-1.5">
          <span id="ptt-key-label" className="text-[13px] font-medium">{t('chat.settings.voice.key')}</span>
          <button
            type="button"
            aria-labelledby="ptt-key-label"
            aria-describedby="ptt-key-state"
            data-ptt-recording={recording ? '' : undefined}
            className={cn(
              'flex h-11 items-center gap-2 rounded-md border-2 bg-card px-3 text-left text-[14px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
              recording ? 'border-ring' : 'border-border hover:border-muted-foreground/60',
            )}
            onClick={() => setRecording(r => !r)}
          >
            {recording && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-danger motion-safe:animate-pulse" />}
            <span id="ptt-key-state" aria-live="polite" className="flex-1">{recording ? t('chat.settings.voice.recording') : t('chat.settings.voice.change')}</span>
            <span className="text-[12px] text-muted-foreground">{t('chat.settings.voice.now')}</span>
            <UiKeycap>{pttKeyLabel(key)}</UiKeycap>
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex text-[13px] font-medium">
            <span id="ptt-release-label" className="flex-1">{t('chat.settings.voice.release')}</span>
            <span className="font-mono">{ms} ms</span>
          </div>
          <div className="flex h-11 items-center">
            <UiSlider
              className="w-full"
              ariaLabelledby="ptt-release-label"
              min={0}
              max={2000}
              step={10}
              pageStep={100}
              modelValue={ms}
              onUpdateModelValue={setMs}
              onCommit={setChatPttReleaseMs}
              formatValue={v => `${v}ms`}
            />
          </div>
          <p className="text-[12px] text-muted-foreground">{t('chat.settings.voice.releaseHelp')}</p>
        </div>
      </div>
      <p className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[13px]">
        <UiIcon name="info" className="mt-px h-4 w-4 shrink-0 text-muted-foreground" />
        {t('chat.settings.voice.browserNote')}
      </p>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">{t('chat.settings.voice.otherKeys')}</span>
        {[{ l: t('chat.settings.voice.muteKey'), k: 'M' }, { l: t('chat.settings.voice.deafenKey'), k: 'D' }].map(r => (
          <div key={r.k} className="flex items-center gap-2 text-[14px]">
            <span className="w-24 text-muted-foreground">{r.l}</span>
            <UiKeycap>Ctrl</UiKeycap><UiKeycap>Shift</UiKeycap><UiKeycap>{r.k}</UiKeycap>
          </div>
        ))}
      </div>
      {/* 음질·장치 — 접속 줄 팝오버(VoiceQualityPanel)와 같은 내용. 접속 안 해도 여기서 미리 고른다(디스코드 음성·비디오 설정) */}
      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <VoiceQualityContent mobile={mobile} />
      </div>
    </div>
  )
  if (mobile) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title={t('chat.settings.voice.title')} onBack={backToMenu} />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{body}</div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title={t('chat.settings.voice.title')} sub={t('chat.settings.voice.sub')} />
      {body}
    </div>
  )
}

export default VoiceSection
