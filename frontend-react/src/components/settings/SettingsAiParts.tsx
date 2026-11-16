/**
 * 설정 › AI 화면 조각.
 *  · SettingsAiModelChoice — 기본 모델 라디오 행(min 52, 선택 = 1.5 primary 테두리 + primary/0.08)
 *  · SettingsMaskedKey — 저장된 키 가림값 칸(점선 40, mono "sk-…a91f") + [바꾸기]
 *  · SettingsVerifiedMark — "연결 확인됨 · MM/DD"(success, role=status)
 */
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiRadio } from '~/components/ui/Radio'
import { UiIcon } from '~/components/ui/Icon'

export interface SettingsAiModelChoiceRow {
  /** 값(workspace · workspace_advanced · personal) */
  value: string
  /** 제목(600) */
  title: string
  /** 설명 12 muted */
  desc: string
  /** 선택 불가 */
  disabled: boolean
}

export interface SettingsAiModelChoiceProps {
  /** 현재 선택 값 */
  modelValue: string
  /** 선택 시(즉시 저장) */
  onUpdateModelValue: (v: string) => void
  /** 행 목록 */
  rows: SettingsAiModelChoiceRow[]
  /** radiogroup 이름 */
  ariaLabel: string
}

/** 기본 모델 라디오 행 묶음 */
export function SettingsAiModelChoice({ modelValue, onUpdateModelValue, rows, ariaLabel }: SettingsAiModelChoiceProps) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="-mt-0.5 flex flex-col gap-2">
      {rows.map(r => (
        <UiRadio
          key={r.value}
          modelValue={modelValue}
          onUpdateModelValue={v => onUpdateModelValue(String(v))}
          value={r.value}
          name="ai-default-model"
          description={r.desc}
          disabled={r.disabled}
          className={cn('min-h-[52px] w-full gap-3 rounded-[10px] px-3.5 py-2', modelValue === r.value ? 'border-[1.5px] border-primary bg-primary/[0.08]' : 'border border-border')}
        ><b className="font-semibold">{r.title}</b></UiRadio>
      ))}
    </div>
  )
}

export interface SettingsMaskedKeyProps {
  /** 칸 이름(API 키) */
  label: string
  /** 가림값(없으면 ●●●●) */
  hint: string
  /** [바꾸기] */
  onChange: () => void
}

/** 저장된 API 키 가림값 칸 + [바꾸기] */
export function SettingsMaskedKey({ label, hint, onChange }: SettingsMaskedKeyProps) {
  const { t } = useI18n()
  return (
    <>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="flex h-10 items-center rounded-[10px] border border-dashed border-input px-3 text-xs">
        <span className="font-mono">{hint || '●●●●'}</span>
        <button type="button" className="relative ml-auto text-xs font-semibold text-primary hover:underline after:absolute after:-inset-3 after:content-['']" onClick={onChange}>{t('settings.ai.changeKey')}</button>
      </span>
    </>
  )
}

/** "연결 확인됨 · MM/DD" */
export function SettingsVerifiedMark({ date }: {
  /** 확인 날짜(MM/DD) */
  date: string
}) {
  const { t } = useI18n()
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-success" role="status">
      <UiIcon name="check-circle" className="h-3.5 w-3.5" />{t('settings.ai.verified', { date })}
    </span>
  )
}
