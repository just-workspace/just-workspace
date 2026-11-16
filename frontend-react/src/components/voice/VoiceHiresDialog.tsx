/**
 * 하이레조 활성화 확인 — 데스크톱 앱, 최초 1회. alertdialog 440:
 * "하이레조를 활성화하면 이 장치를 독점 사용합니다" + 장치 이름 굵게 + 지연·이어폰 안내 + 형식 mono 상자 + "다음부터 묻지 않기" + [취소][독점하고 활성화].
 * 열림 상태는 useVoice.hiresPrompt(confirmHiresExclusive 가 설정) — 3단계(네이티브 전송)가 장치 이름·형식을 전달하여 호출한다. 렌더링은 셸(layouts/default)이 수행한다.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { useVoice } from '~/composables/useVoice'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiTrans } from '~/components/ui/Trans'

export function VoiceHiresDialog() {
  const { t } = useI18n()
  const { hiresPrompt, setPrefs } = useVoice()
  const [skip, setSkip] = useState(false)
  if (!hiresPrompt) return null
  const { deviceName, format, resolve } = hiresPrompt

  function decide(ok: boolean) {
    if (ok && skip) void setPrefs({ hiresAskSkip: true })
    resolve(ok)
  }

  return (
    <UiModal
      confirm
      danger
      persistent
      size="440"
      ariaLabel={t('chat.voice.hires.title')}
      onClose={() => decide(false)}
      footer={(
        <>
          <UiButton variant="ghost" onClick={() => decide(false)}>{t('chat.voice.hires.cancel')}</UiButton>
          <UiButton onClick={() => decide(true)}>{t('chat.voice.hires.confirm')}</UiButton>
        </>
      )}
    >
      <div className="flex flex-col gap-4" data-testid="voice-hires-dialog">
        <p className="text-[18px] font-semibold">{t('chat.voice.hires.title')}</p>
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          <UiTrans k="chat.voice.hires.desc" slots={{ device: <b className="font-semibold text-foreground">{deviceName}</b> }} />
        </p>
        <div className="rounded-md border border-muted-foreground/40 px-3 py-2 font-mono text-[13px]">{format}</div>
        <UiCheckbox label={t('chat.voice.hires.skip')} modelValue={skip} onUpdateModelValue={setSkip} />
      </div>
    </UiModal>
  )
}

export default VoiceHiresDialog
