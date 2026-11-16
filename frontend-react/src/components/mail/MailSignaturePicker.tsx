/**
 * "서명: 기본 ▾". 텍스트 형태로 표시되는 네이티브 선택. 히트 영역 40.
 */
import { useI18n } from '~/i18n'
import type { Signature } from '~/composables/useMailSignature'
import { UiIcon } from '~/components/ui/Icon'

export interface MailSignaturePickerProps {
  /** 선택한 서명 id. null = 없음 */
  modelValue?: string | null
  /** 서명 변경 */
  onUpdateModelValue?: (v: string | null) => void
  /** 서명 목록 */
  signatures: readonly Signature[]
  /** 루트에 추가할 클래스 */
  className?: string
}

/** 서명 선택(네이티브 select 를 텍스트 위에 투명하게 배치) */
export function MailSignaturePicker({ modelValue = null, onUpdateModelValue, signatures, className }: MailSignaturePickerProps) {
  const { t } = useI18n()
  return (
    // 외부 클래스를 단순 연결(tailwind-merge 로 text-xs 를 제거하면 text-xs 의 줄 높이까지 소실되어 글자 위치가 달라짐)
    <label className={`relative inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground${className ? ` ${className}` : ''}`}>
      <span>{t('mail.signature.current', { name: signatures.find(s => s.id === modelValue)?.name || t('common.none') })}</span>
      <UiIcon name="chevron-down" className="h-3 w-3" strokeWidth={2.4} />
      <select
        value={modelValue ?? ''}
        onChange={e => onUpdateModelValue?.(e.target.value === '' ? null : e.target.value)}
        aria-label={t('mail.compose.signature')}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">{t('common.none')}</option>
        {signatures.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_default ? ` ${t('mail.compose.signatureDefault')}` : ''}</option>)}
      </select>
    </label>
  )
}

export default MailSignaturePicker
