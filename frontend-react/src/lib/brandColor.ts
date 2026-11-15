/**
 * 브랜딩 강조색 자동 보정(답변서 B2) — 순수 함수(DOM 없음). App 의 applyBrandTheme 과 관리 › 브랜딩 화면이 같이 쓴다.
 *
 * 기준 두 가지:
 *  (a) 글자·아이콘 — 강조색(primary)이 그 테마의 card·background 위 4.5:1 미만이면, 그 테마에서만 밝기(L)만 조정한다
 *      (라이트는 어둡게, 다크는 밝게, 색상·채도 유지). 4.5:1 이 될 때까지 1% 씩.
 *  (b) 버튼 바탕 — primary-foreground 와 4.5:1 미만이면 글자를 흰/검 중 대비가 높은 쪽으로.
 * 저장 조건 = 조정 후 양쪽 테마 모두 (a)(b) 통과.
 *
 * 추가로 반전색 토스트(bg-foreground) 위 행동 버튼용 `--primary-inverse` 도 같은 방식으로 맞춘다(답변서 C8):
 * 라이트 토스트 바탕 = 라이트 foreground(어두움) → 밝게, 다크 토스트 바탕 = 다크 foreground(밝음) → 어둡게.
 *
 * 테마 표면 값은 assets/css/main.css 토큰과 같아야 한다(바꾸면 여기도).
 */

export type Hsl = { h: number; s: number; l: number }
export type ThemeName = 'light' | 'dark'

/** main.css 토큰 — 대비 계산용 표면 */
export const THEME_SURFACES: Record<ThemeName, { background: Hsl; card: Hsl; foreground: Hsl }> = {
  light: { background: { h: 216, s: 25, l: 98 }, card: { h: 0, s: 0, l: 100 }, foreground: { h: 216, s: 28, l: 14 } },
  dark: { background: { h: 218, s: 22, l: 7 }, card: { h: 215, s: 22, l: 11 }, foreground: { h: 216, s: 25, l: 92 } },
}

/** 기본 primary-foreground(테마별, main.css 와 같음) */
const DEFAULT_FG: Record<ThemeName, Hsl> = { light: { h: 0, s: 0, l: 100 }, dark: { h: 218, s: 22, l: 7 } }
const WHITE: Hsl = { h: 0, s: 0, l: 100 }
const BLACK: Hsl = { h: 0, s: 0, l: 0 }

export const MIN_CONTRAST = 4.5

/** #RRGGBB 형식인지 */
export function isHexColor(v: string): boolean { return /^#[0-9a-fA-F]{6}$/.test(v) }

/** hex → HSL(정수 반올림 — CSS 변수에 넣는 값과 같은 정밀도) */
export function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return null
  const r = parseInt(m[1], 16) / 255
  const g = parseInt(m[2], 16) / 255
  const b = parseInt(m[3], 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/** HSL → 8비트 RGB(브라우저가 그리는 값) */
export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const S = s / 100, L = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255)) as [number, number, number]
}

export function hslToHex(c: Hsl): string {
  return '#' + hslToRgb(c).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** CSS 변수 값 형식 `h s% l%` */
export function hslVar(c: Hsl): string { return `${c.h} ${c.s}% ${c.l}%` }

function lin(v: number) { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
/** WCAG 상대 휘도 */
export function luminance(c: Hsl): number {
  const [r, g, b] = hslToRgb(c).map(lin)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG 대비(반올림 없음) */
export function contrastRatio(a: Hsl, b: Hsl): number {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
/** 표시용 소수 1자리(내림 — 4.49 가 4.5 로 보이지 않게) */
export function fmtRatio(r: number): number { return Math.floor(r * 10) / 10 }

/**
 * 밝기(L)만 1% 씩 옮겨 모든 바탕 위 4.5:1 을 맞춘다. 이미 통과면 그대로.
 * @param dir -1 어둡게 · +1 밝게
 */
export function adjustLightness(c: Hsl, against: Hsl[], dir: -1 | 1, min = MIN_CONTRAST): Hsl {
  const ok = (x: Hsl) => against.every(bg => contrastRatio(x, bg) >= min)
  let cur = { ...c }
  while (!ok(cur)) {
    const next = cur.l + dir
    if (next < 0 || next > 100) break
    cur = { ...cur, l: next }
  }
  return cur
}

/** 바탕 위 글자로 흰/검 중 대비가 높은 쪽 */
export function bestOnColor(bg: Hsl): Hsl {
  return contrastRatio(WHITE, bg) >= contrastRatio(BLACK, bg) ? WHITE : BLACK
}

export interface BrandThemeValues {
  /** 실제로 쓰는 primary(조정 후) */
  primary: Hsl
  /** 조정 전 기준값(라이트 = 입력값, 다크 = 입력값에서 채도 +8 · 밝기 +7) */
  base: Hsl
  /** 밝기를 조정했는가 */
  adjusted: boolean
  /** 버튼 글자 */
  primaryForeground: Hsl
  /** 버튼 글자를 흰/검으로 바꿨는가 */
  foregroundAdjusted: boolean
  /** 반전색 토스트 위 행동 글자 */
  primaryInverse: Hsl
  /** 조정 후 대비(card·background 중 낮은 쪽 / 버튼 글자) */
  textContrast: number
  buttonContrast: number
  /** 조정 후 통과 */
  passes: boolean
}

/** 기준값(조정 전) — 다크는 기존 규칙(채도 +8, 밝기 +7) */
export function baseFor(theme: ThemeName, brand: Hsl): Hsl {
  return theme === 'light' ? { ...brand } : { h: brand.h, s: Math.min(brand.s + 8, 100), l: Math.min(brand.l + 7, 100) }
}

/** 한 테마의 primary·primary-foreground·primary-inverse 를 정한다 */
export function resolveThemeBrand(theme: ThemeName, brand: Hsl): BrandThemeValues {
  const surf = THEME_SURFACES[theme]
  const base = baseFor(theme, brand)
  const primary = adjustLightness(base, [surf.card, surf.background], theme === 'light' ? -1 : 1)
  const textContrast = Math.min(contrastRatio(primary, surf.card), contrastRatio(primary, surf.background))
  let fg = DEFAULT_FG[theme]
  let foregroundAdjusted = false
  if (contrastRatio(fg, primary) < MIN_CONTRAST) { fg = bestOnColor(primary); foregroundAdjusted = true }
  const buttonContrast = contrastRatio(fg, primary)
  // 토스트 바탕 = 그 테마의 foreground. 라이트 토스트는 어두우니 밝게, 다크 토스트는 밝으니 어둡게.
  const inverseBase = baseFor(theme === 'light' ? 'dark' : 'light', brand)
  const primaryInverse = adjustLightness(inverseBase, [surf.foreground], theme === 'light' ? 1 : -1)
  return {
    primary, base, adjusted: primary.l !== base.l,
    primaryForeground: fg, foregroundAdjusted,
    primaryInverse,
    textContrast, buttonContrast,
    passes: textContrast >= MIN_CONTRAST && buttonContrast >= MIN_CONTRAST,
  }
}

/** 두 테마 다 — 형식이 틀리면 null */
export function resolveBrandTheme(hex: string): Record<ThemeName, BrandThemeValues> | null {
  const hsl = hexToHsl(hex)
  if (!hsl) return null
  return { light: resolveThemeBrand('light', hsl), dark: resolveThemeBrand('dark', hsl) }
}

/** 저장 조건: 조정 후 양쪽 통과 */
export function brandPasses(hex: string): boolean {
  const r = resolveBrandTheme(hex)
  return !!r && r.light.passes && r.dark.passes
}

/** <style id="brand-theme"> 에 넣는 CSS(:root = 라이트, .dark = 다크) */
export function brandThemeCss(hex: string): string | null {
  const r = resolveBrandTheme(hex)
  if (!r) return null
  const block = (v: BrandThemeValues) => `
      --primary: ${hslVar(v.primary)};
      --primary-foreground: ${hslVar(v.primaryForeground)};
      --primary-inverse: ${hslVar(v.primaryInverse)};
      --ring: ${hslVar(v.primary)};`
  return `
    :root {${block(r.light)}
    }
    .dark {${block(r.dark)}
    }
  `
}
