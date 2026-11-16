/**
 * 예약 보내기 시각 선택.
 * 작성 창 "보내기 ▾ › 예약 보내기"와 예약함 "시각 변경"이 공용으로 사용한다.
 * 시안에 본 대화상자가 없어 기존 폼 규격(UiModal sm + 라벨 위 입력 40 + [취소][확인])으로 구성했다.
 * 서버 규칙: 현재 시각+30초 이내면 즉시 발송, 1년 초과 시 400 — 여기서 사전 차단한다.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { toLocalInput, fromLocalInput, defaultScheduleTime } from '~/utils/mailQuery'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'

export interface MailScheduleDialogProps {
  /** 대화상자 제목 */
  title: string
  /** 확인 버튼 문구 */
  confirmLabel: string
  /** 초기 표시 시각(ISO). 없으면 다음 날 오전 8시 */
  initial?: string | null
  /** 처리 중(확인 비활성) */
  busy?: boolean
  /** 닫기 */
  onClose?: () => void
  /** 확인 — 선택한 시각 ISO */
  onConfirm?: (iso: string) => void
}

/** 예약 시각 선택 */
export function MailScheduleDialog({ title, confirmLabel, initial = null, busy = false, onClose, onConfirm }: MailScheduleDialogProps) {
  const { t } = useI18n()
  const [value, setValue] = useState(() => toLocalInput(initial ? new Date(initial) : defaultScheduleTime()))
  const [{ min, max }] = useState(() => ({
    min: toLocalInput(new Date(Date.now() + 60_000)),
    max: toLocalInput(new Date(Date.now() + 365 * 86_400_000)),
  }))
  const [touched, setTouched] = useState(false)

  const error = (() => {
    const iso = fromLocalInput(value)
    if (!iso) return t('mail.schedule.invalid')
    const ms = new Date(iso).getTime()
    if (ms <= Date.now() + 60_000) return t('mail.schedule.tooSoon')
    if (ms > Date.now() + 365 * 86_400_000) return t('mail.schedule.tooLate')
    return ''
  })()

  function submit() {
    setTouched(true)
    const iso = fromLocalInput(value)
    if (error || !iso) return
    onConfirm?.(iso)
  }

  return (
    <UiModal
      title={title}
      size="sm"
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" onClick={() => onClose?.()}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" type="submit" form="mail-schedule-form" disabled={busy}>{confirmLabel}</UiButton>
        </>
      )}
    >
      <form id="mail-schedule-form" className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <UiInput
          modelValue={value}
          onUpdateModelValue={setValue}
          type="datetime-local"
          label={t('mail.schedule.when')}
          min={min}
          max={max}
          mono
          error={touched ? error : ''}
          data-autofocus
          onBlur={() => setTouched(true)}
        />
        <p className="text-xs text-muted-foreground">{t('mail.schedule.hint')}</p>
      </form>
    </UiModal>
  )
}

export default MailScheduleDialog
