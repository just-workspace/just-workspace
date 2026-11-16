/**
 * 목록 밀도 선택 — 라디오 카드 3(편안 56 / 기본 48 / 조밀 40) + 행 간격 미리보기.
 * 터치 기기에서는 조밀을 차단한다(compactAllowed=false).
 *
 * @example <SettingsDensityPicker modelValue={density} onUpdateModelValue={setDensity} compactAllowed />
 */
import { useI18n } from '~/i18n'
import type { Density } from '~/composables/useUserPrefs'
import { UiRadioCard } from '~/components/ui/RadioCard'

export interface SettingsDensityPickerProps {
  /** 현재 밀도 */
  modelValue: Density
  /** 선택 시 */
  onUpdateModelValue: (v: Density) => void
  /** 조밀 선택 가능 여부(터치 기기면 false) */
  compactAllowed: boolean
}

export function SettingsDensityPicker({ modelValue, onUpdateModelValue, compactAllowed }: SettingsDensityPickerProps) {
  const { t } = useI18n()
  const DENSITY = [
    { value: 'comfortable' as const, title: t('settings.density.comfortable'), meta: '56', gap: 9 },
    { value: 'default' as const, title: t('settings.density.default'), meta: '48', gap: 6 },
    { value: 'compact' as const, title: t('settings.density.compact'), meta: '40', gap: 3 },
  ]
  return (
    <div role="radiogroup" aria-label={t('settings.display.density')} className="grid grid-cols-3 gap-3">
      {DENSITY.map(d => (
        <UiRadioCard
          key={d.value}
          modelValue={modelValue}
          onUpdateModelValue={v => onUpdateModelValue(v as Density)}
          value={d.value}
          title={d.title}
          meta={d.meta}
          disabled={d.value === 'compact' && !compactAllowed}
        >
          <span className="flex flex-col rounded-sm bg-background p-2" style={{ gap: `${d.gap}px` }} aria-hidden="true">
            <span className="h-[7px] w-[80%] rounded bg-muted" /><span className="h-[7px] w-[60%] rounded bg-muted" /><span className="h-[7px] w-[70%] rounded bg-muted" />
          </span>
        </UiRadioCard>
      ))}
    </div>
  )
}

export default SettingsDensityPicker
