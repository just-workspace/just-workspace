/**
 * 언어 전환과 화면 밝기 전환 — 마법사의 모든 화면에 표시된다.
 * 밝기는 <html> 의 `dark` 클래스로 전환한다(기본 다크). 선택값은 이 브라우저에만 저장한다(설정값일 뿐 비밀이 아니다).
 */
import { useEffect, useState } from 'react'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { useLocale, useT } from '../i18n'

const THEME_KEY = 'jw-installer-theme'

function readTheme(): 'dark' | 'light' {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: 'dark' | 'light') {
  document.documentElement.classList.toggle('dark', theme !== 'light')
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
}

export function ShellTools() {
  const t = useT()
  const { locale, locales, setLocale } = useLocale()
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme)

  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => { document.documentElement.lang = locale }, [locale])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try { window.localStorage.setItem(THEME_KEY, next) } catch { /* 저장에 실패해도 전환은 가능 */ }
  }

  return (
    <div className="flex items-center gap-1.5">
      <UiSegment
        size="sm"
        ariaLabel={t('common.language')}
        items={locales.map(l => ({ value: l.code, label: l.name }))}
        modelValue={locale}
        onUpdateModelValue={v => { if (v != null) void setLocale(String(v)) }}
      />
      <UiIconButton
        label={theme === 'dark' ? t('common.themeToLight') : t('common.themeToDark')}
        icon={theme === 'dark' ? 'sun' : 'moon'}
        onClick={toggle}
      />
    </div>
  )
}
