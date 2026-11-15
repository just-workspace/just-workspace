/**
 * 브랜딩 강조 색 대비 — 관리 › 브랜딩 화면용 얇은 포장(계산은 lib/brandColor 순수 함수).
 * 저장 조건 = "조정 후 양쪽 통과". 조정 전 대비가 모자란 테마는 밝기만 자동 조정해 쓰고, 화면에 실제 값을 보여 준다.
 */
import { fmtRatio, hslToHex, isHexColor, resolveBrandTheme } from '~/lib/brandColor'

export { isHexColor }

export interface BrandContrastInfo {
  /** 조정 후 card·background 중 낮은 쪽 대비(소수 1자리, 내림) */
  light: number
  dark: number
  /** 밝기를 자동 조정한 테마의 실제 값(#RRGGBB). 조정하지 않았으면 null */
  lightAdjusted: string | null
  darkAdjusted: string | null
  /** 버튼 글자를 흰/검으로 바꿨는가 */
  lightFgAdjusted: boolean
  darkFgAdjusted: boolean
  /** 조정 후 양쪽 통과 */
  passes: boolean
}

/** 형식이 틀리면 null */
export function brandContrast(hex: string): BrandContrastInfo | null {
  if (!isHexColor(hex)) return null
  const r = resolveBrandTheme(hex)
  if (!r) return null
  return {
    light: fmtRatio(r.light.textContrast),
    dark: fmtRatio(r.dark.textContrast),
    lightAdjusted: r.light.adjusted ? hslToHex(r.light.primary) : null,
    darkAdjusted: r.dark.adjusted ? hslToHex(r.dark.primary) : null,
    lightFgAdjusted: r.light.foregroundAdjusted,
    darkFgAdjusted: r.dark.foregroundAdjusted,
    passes: r.light.passes && r.dark.passes,
  }
}

/** 저장을 막는가 — 조정 후에도 한쪽이라도 통과 못 하면 */
export function contrastBlocked(c: BrandContrastInfo | null) {
  return !!c && !c.passes
}
