// 브랜딩 강조색 자동 보정(답변서 B2) — 순수 함수
import { describe, it, expect } from 'vitest'
import {
  adjustLightness, bestOnColor, brandPasses, brandThemeCss, contrastRatio, hexToHsl, hslToHex,
  resolveBrandTheme, THEME_SURFACES, MIN_CONTRAST,
} from '~/lib/brandColor'

const SWATCHES = ['#3B82F6', '#29A376', '#8C56D2', '#CA6A16', '#1F9AAD']

describe('brandColor', () => {
  it('hex ↔ HSL, 대비 계산(흰/검 21:1)', () => {
    expect(hexToHsl('#ff0000')).toEqual({ h: 0, s: 100, l: 50 })
    expect(hexToHsl('nope')).toBeNull()
    expect(hslToHex({ h: 0, s: 0, l: 100 })).toBe('#FFFFFF')
    expect(contrastRatio({ h: 0, s: 0, l: 0 }, { h: 0, s: 0, l: 100 })).toBeCloseTo(21, 5)
  })

  it('기본 5색은 조정 후 양쪽 테마 모두 통과(글자 4.5 · 버튼 4.5 · 토스트 행동 4.5)', () => {
    for (const hex of SWATCHES) {
      const r = resolveBrandTheme(hex)!
      expect(brandPasses(hex)).toBe(true)
      for (const th of ['light', 'dark'] as const) {
        const s = THEME_SURFACES[th]
        expect(contrastRatio(r[th].primary, s.card)).toBeGreaterThanOrEqual(MIN_CONTRAST)
        expect(contrastRatio(r[th].primary, s.background)).toBeGreaterThanOrEqual(MIN_CONTRAST)
        expect(contrastRatio(r[th].primaryForeground, r[th].primary)).toBeGreaterThanOrEqual(MIN_CONTRAST)
        expect(contrastRatio(r[th].primaryInverse, s.foreground)).toBeGreaterThanOrEqual(MIN_CONTRAST)
      }
    }
  })

  it('라이트는 어둡게·다크는 밝게, 색상·채도는 그대로 — 이미 통과하면 손대지 않는다', () => {
    const r = resolveBrandTheme('#3B82F6')!
    expect(r.light.adjusted).toBe(true)
    expect(r.light.primary.l).toBeLessThan(r.light.base.l)
    expect(r.light.primary.h).toBe(r.light.base.h)
    expect(r.light.primary.s).toBe(r.light.base.s)
    // 진한 남색은 라이트에선 그대로, 다크에선 밝힌다
    const navy = resolveBrandTheme('#1E3A8A')!
    expect(navy.light.adjusted).toBe(false)
    expect(navy.dark.adjusted).toBe(true)
    expect(navy.dark.primary.l).toBeGreaterThan(navy.dark.base.l)
  })

  it('adjustLightness 는 4.5 가 될 때까지 1% 씩', () => {
    const white = THEME_SURFACES.light.card
    const out = adjustLightness({ h: 60, s: 100, l: 50 }, [white], -1)
    expect(contrastRatio(out, white)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio({ ...out, l: out.l + 1 }, white)).toBeLessThan(4.5)
  })

  it('버튼 글자는 흰/검 중 높은 쪽', () => {
    expect(bestOnColor({ h: 60, s: 100, l: 50 })).toEqual({ h: 0, s: 0, l: 0 })
    expect(bestOnColor({ h: 218, s: 88, l: 30 })).toEqual({ h: 0, s: 0, l: 100 })
  })

  it('CSS: :root·.dark 에 primary·foreground·inverse·ring', () => {
    const css = brandThemeCss('#3B82F6')!
    expect(css).toMatch(/:root \{[\s\S]*--primary: 217 91% \d+%;[\s\S]*--primary-inverse:[\s\S]*--ring:/)
    expect(css).toMatch(/\.dark \{[\s\S]*--primary-foreground: 218 22% 7%;/)
    expect(brandThemeCss('bad')).toBeNull()
  })
})
