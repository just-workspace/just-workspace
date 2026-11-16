/**
 * 브랜딩 강조 색 대비 — 관리 › 브랜딩 화면용 얇은 래퍼(계산은 lib/brandColor 순수 함수).
 * 저장 조건 = "조정 후 양쪽 통과". 조정 전 대비가 부족한 테마는 밝기만 자동 조정하여 사용하고, 화면에 실제 값을 표시한다.
 */
import { fmtRatio, hslToHex, isHexColor, resolveBrandTheme } from '~/lib/brandColor'

export { isHexColor }

export interface BrandContrastInfo {
  /** 조정 후 card·background 중 낮은 쪽 대비(소수 1자리, 내림) */
  light: number
  dark: number
  /** 밝기를 자동 조정한 테마의 실제 값(#RRGGBB). 미조정 시 null */
  lightAdjusted: string | null
  darkAdjusted: string | null
  /** 버튼 글자를 흰색/검정으로 변경했는지 여부 */
  lightFgAdjusted: boolean
  darkFgAdjusted: boolean
  /** 조정 후 양쪽 통과 */
  passes: boolean
}

/** 형식 오류 시 null */
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

/** 저장 차단 여부 — 조정 후에도 한쪽이라도 미통과인 경우 */
export function contrastBlocked(c: BrandContrastInfo | null) {
  return !!c && !c.passes
}
