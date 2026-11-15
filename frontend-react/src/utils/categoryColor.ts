// 범주 색(11-A1) — --cat-1…8 토큰을 캘린더·라벨에 쓰는 규칙을 한곳에 모은다.
//
// 저장값은 계속 hex 다(CalDAV calendar-color 로 외부 클라이언트에 그대로 나가므로).
// 화면에서는 hex 를 범주 번호로 되돌려 테마별 토큰 색(hsl(var(--cat-N)))으로 그린다.
//  - CAT_HEX: 각 범주의 라이트 값 hex. 새 캘린더는 이 값으로 저장한다.
//  - LEGACY_HEX: 토큰 이전에 쓰던 기본 팔레트 → 가장 가까운 범주. 기존 캘린더도 토큰 색으로 보인다.
//  - 그 밖의 hex(외부에서 가져온 사용자 지정 색)는 hex 그대로 쓴다.

export const CAT_COUNT = 8

/** 범주 1…8 의 라이트 테마 값(hsl → hex). 저장·CalDAV 노출용 */
export const CAT_HEX = [
  '#2c6ddd', // 1 파랑 218 72% 52%
  '#21835f', // 2 초록 158 60% 32%
  '#ae5c13', // 3 주황 28 80% 38%
  '#d83148', // 4 빨강 352 68% 52%
  '#8c56d2', // 5 보라 266 58% 58%
  '#187b8b', // 6 청록 188 70% 32%
  '#c5349a', // 7 분홍 318 58% 49%
  '#8b6c18', // 8 갈황 44 70% 32%
] as const

/** 토큰 이전 기본 팔레트(파랑·빨강·초록·호박·보라·분홍·하늘·주황) → 범주 번호 */
const LEGACY_HEX: Record<string, number> = {
  '#3b82f6': 1,
  '#ef4444': 4,
  '#10b981': 2,
  '#f59e0b': 8,
  '#8b5cf6': 5,
  '#ec4899': 7,
  '#06b6d4': 6,
  '#f97316': 3,
}

/** 범주 이름 i18n 키(common.cat.N) — 이웃 계열을 색만으로 구분하지 않도록 이름을 같이 쓴다 */
export function catNameKey(n: number): string {
  return `common.cat.${n}`
}

/** 순번(0부터) → 범주 번호(1…8)와 빗금 여부. 9번째부터 1로 돌아가며 빗금을 얹는다 */
export function catForIndex(i: number): { cat: number; hatched: boolean } {
  const idx = Math.max(0, Math.floor(i))
  return { cat: (idx % CAT_COUNT) + 1, hatched: idx >= CAT_COUNT }
}

/** 저장된 색 값 → 범주 번호(1…8). 범주가 아니면 null */
export function catOf(color: string | null | undefined): number | null {
  if (!color) return null
  const c = color.trim().toLowerCase()
  const m = /^cat-([1-8])$/.exec(c)
  if (m) return Number(m[1])
  const i = (CAT_HEX as readonly string[]).indexOf(c)
  if (i >= 0) return i + 1
  return LEGACY_HEX[c] ?? null
}

/** CSS 색 — 범주면 테마 토큰, hex 면 그대로, 없으면 primary */
export function catColor(color: string | null | undefined, alpha?: number): string {
  const n = catOf(color)
  const a = alpha === undefined ? '' : ` / ${alpha}`
  if (n) return `hsl(var(--cat-${n})${a})`
  if (color && /^#[0-9a-f]{6}$/i.test(color)) {
    return alpha === undefined ? color : color + Math.round(alpha * 255).toString(16).padStart(2, '0')
  }
  return `hsl(var(--primary)${a})`
}

/**
 * 목록 순서대로 빗금이 필요한 항목 id. 앞 순번이 이미 같은 범주를 쓰고 있으면 빗금(9개 이상 순환).
 * 범주가 아닌 사용자 지정 hex 는 대상이 아니다.
 */
export function hatchedIds<T extends { id: string; color: string | null | undefined }>(list: readonly T[]): Set<string> {
  const used = new Set<number>()
  const out = new Set<string>()
  for (const it of list) {
    const n = catOf(it.color)
    if (!n) continue
    if (used.has(n)) out.add(it.id)
    else used.add(n)
  }
  return out
}
