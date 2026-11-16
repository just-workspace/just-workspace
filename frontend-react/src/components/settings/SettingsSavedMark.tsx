/**
 * "저장됨 ✓" 표시(12/600 success, role=status) — 카드 머리 밖에서 즉시 저장 행 옆에 배치하는 경우에 사용한다.
 * (카드 머리에는 SettingsCard 의 saved prop 을 사용한다.)
 *
 * @example {saved && <SettingsSavedMark />}
 */
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiIcon } from '~/components/ui/Icon'

export interface SettingsSavedMarkProps {
  /** 체크 아이콘 크기 — 13(기본, 알림) · 14(메일 읽음 확인 행) */
  iconSize?: 13 | 14
}

export function SettingsSavedMark({ iconSize = 13 }: SettingsSavedMarkProps) {
  const { t } = useI18n()
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-success" role="status">
      <UiIcon name="check" className={cn(iconSize === 14 ? 'h-3.5 w-3.5' : 'h-[13px] w-[13px]')} strokeWidth={3} />{t('settingsCard.saved')}
    </span>
  )
}

export default SettingsSavedMark
