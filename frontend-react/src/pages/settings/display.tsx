// Vue 원본: frontend/pages/settings/display.vue
// 설정 › 표시: 목록 밀도 라디오 카드 3(편안 56 / 기본 48 / 조밀 40, 터치 기기 조밀 불가) + 테마·언어·주 시작·시간대 행(선택 200).
// 즉시 저장 + "저장됨 ✓". 값은 useUserPrefs 가 이 기기에 바로 쓰고 서버(/api/me/prefs)와 동기화한다 — 다른 기기에서도 같은 설정.
// 화면 크기: UiSegment 자동·100·125·150·200·300% + hint "자동: 이 화면에서 N% (W×H)". 이 기기만(localStorage) — 계정 동기화 안 함.
// 모바일(<768)엔 배율을 쓰지 않으므로 그리지 않는다.
import { useMemo, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useUserPrefs, type Density, type Prefs } from '~/composables/useUserPrefs'
import { useColorMode } from '~/composables/useColorMode'
import { useIsMobile } from '~/composables/useIsMobile'
import { useViewport, setUiScalePref } from '~/composables/useViewport'
import { UI_SCALE_CHOICES, uiScaleAllowed, type UiScalePref } from '~/lib/fluid'
import { UiSegment } from '~/components/ui/Segment'
import { UiSelect } from '~/components/ui/Select'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { SettingsRow } from '~/components/settings/SettingsRow'
import { SettingsDensityPicker } from '~/components/settings/SettingsDensityPicker'
import { tzSelectSearch, tzZoneNames } from '~/utils/timezoneBand'

export default function SettingsDisplayPage() {
  const { appName } = useSiteConfig()
  const { t, locale, locales, setLocale } = useI18n()
  useHead({ title: `${t('settings.display.title')} | ${appName}` })

  const { density, setDensity, compactAllowed, prefs, setWeekStart, setTimezone } = useUserPrefs()
  const colorMode = useColorMode()
  const isMobile = useIsMobile()
  const vp = useViewport()
  // 실효 폭 1280 미만이 되는 값은 비활성 + 툴팁. 자동은 늘 가능
  const SCALE = UI_SCALE_CHOICES.map((v) => {
    const ok = uiScaleAllowed(v, vp.rawWidth)
    return { value: v, label: v === 'auto' ? t('settings.display.uiScaleAuto') : `${v}%`, disabled: !ok, tooltip: ok ? undefined : t('settings.display.uiScaleTooBig') }
  })

  const [saved, setSaved] = useState(false)
  function flash() { setSaved(true); setTimeout(() => { setSaved(false) }, 2000) }

  const THEME = [{ value: 'light', label: t('settings.theme.light') }, { value: 'dark', label: t('settings.theme.dark') }, { value: 'system', label: t('settings.theme.system') }]
  const LOCALES = locales.map(l => ({ value: l.code, label: l.name }))
  const WEEK = [{ value: 'locale', label: t('settings.display.weekLocale') }, { value: 'mon', label: t('settings.display.monday') }, { value: 'sun', label: t('settings.display.sunday') }, { value: 'sat', label: t('settings.calendarPrefs.sat') }]
  const TZ = useMemo(() => {
    const sys = Intl.DateTimeFormat().resolvedOptions().timeZone
    const names = tzZoneNames()
    return [{ value: '', label: t('settings.display.tzSystem', { tz: sys }) }, ...names.map(n => ({ value: n, label: n }))]
  }, [t])
  const tzSearch = useMemo(() => tzSelectSearch(t), [t])

  return (
    <>
      <SettingsHeader title={t('settings.display.title')} subtitle={t('settings.display.subtitle')} />

      <SettingsCard title={t('settings.display.density')} description={t('settings.display.densityDesc')} saved={saved}>
        <SettingsDensityPicker modelValue={density} onUpdateModelValue={(v: Density) => { setDensity(v); flash() }} compactAllowed={compactAllowed} />
      </SettingsCard>

      {!isMobile && (
        <SettingsCard title={t('settings.display.uiScale')} saved={saved}>
          <UiSegment
            items={SCALE}
            modelValue={vp.pref}
            onUpdateModelValue={v => { if (v != null) { setUiScalePref(v as UiScalePref); flash() } }}
            ariaLabel={t('settings.display.uiScale')}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t('settings.display.uiScaleHint', { pct: Math.round(vp.auto * 100), w: vp.rawWidth, h: vp.rawHeight })}
          </p>
        </SettingsCard>
      )}

      <SettingsCard flush saved={saved}>
        <div className="divide-y divide-border">
          <SettingsRow title={t('settings.display.theme')} description={t('settings.display.themeDesc')}>
            <UiSelect modelValue={colorMode.preference} onUpdateModelValue={v => { colorMode.setPreference(String(v)); flash() }} options={THEME} size="sm" className="w-full sm:w-[200px]" aria-label={t('settings.display.theme')} />
          </SettingsRow>
          <SettingsRow title={t('settings.display.language')} description={t('settings.display.languageDesc')}>
            <UiSelect modelValue={locale} onUpdateModelValue={v => { void setLocale(String(v)); flash() }} options={LOCALES} size="sm" className="w-full sm:w-[200px]" aria-label={t('settings.display.language')} />
          </SettingsRow>
          <SettingsRow title={t('settings.display.weekStart')} description={t('settings.display.weekStartDesc')}>
            <UiSelect modelValue={prefs.weekStart} onUpdateModelValue={v => { setWeekStart(v as Prefs['weekStart']); flash() }} options={WEEK} size="sm" className="w-full sm:w-[200px]" aria-label={t('settings.display.weekStart')} />
          </SettingsRow>
          <SettingsRow title={t('settings.display.timezone')} description={t('settings.display.timezoneDesc')}>
            <UiSelect modelValue={prefs.timezone || ''} onUpdateModelValue={v => { setTimezone(String(v)); flash() }} options={TZ} search={tzSearch} size="sm" className="w-full sm:w-[200px]" aria-label={t('settings.display.timezone')} />
          </SettingsRow>
        </div>
      </SettingsCard>
    </>
  )
}
