// 연락처 모듈 전용.
/**
 * 연락처 목록 초성 색인: 초성 구분 헤더 + 모바일 오른쪽 색인 바.
 * 한글 → ㄱ~ㅎ(쌍자음은 홑자음으로), 라틴 → A~Z, 나머지 → #.
 */

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
const FOLD: Record<string, string> = { 'ㄲ': 'ㄱ', 'ㄸ': 'ㄷ', 'ㅃ': 'ㅂ', 'ㅆ': 'ㅅ', 'ㅉ': 'ㅈ' }

export const HANGUL_KEYS = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
export const LATIN_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
export const OTHER_KEY = '#'

/** 색인 바 순서(★ ㄱ…ㅎ A #). ★ 은 즐겨찾기(백엔드 갭) 라 제외 */
export const INDEX_ORDER = [...HANGUL_KEYS, ...LATIN_KEYS, OTHER_KEY]

export function indexKeyOf(name: string | null | undefined): string {
  const s = (name || '').trim()
  if (!s) return OTHER_KEY
  const ch = s[0]
  const code = ch.charCodeAt(0)
  if (code >= 0xAC00 && code <= 0xD7A3) {
    const cho = CHO[Math.floor((code - 0xAC00) / 588)]
    return FOLD[cho] || cho
  }
  if (code >= 0x3131 && code <= 0x314E) {
    // 호환 자모(ㄱ ㄲ ㄴ …)
    const jamo = ch
    return FOLD[jamo] || (HANGUL_KEYS.includes(jamo) ? jamo : OTHER_KEY)
  }
  const up = ch.toUpperCase()
  if (/^[A-Z]$/.test(up)) return up
  return OTHER_KEY
}

function rank(key: string): number {
  const i = INDEX_ORDER.indexOf(key)
  return i === -1 ? INDEX_ORDER.length : i
}

export interface IndexedGroup<T> { key: string; items: T[] }

/** 이름으로 정렬·초성 묶기. sortBy='org' 면 회사 → 이름 순(헤더는 여전히 이름 초성) */
export function groupByIndex<T>(
  items: readonly T[],
  nameOf: (t: T) => string,
  orgOf: (t: T) => string = () => '',
  sortBy: 'name' | 'org' = 'name',
): IndexedGroup<T>[] {
  const cmp = (a: T, b: T) => {
    if (sortBy === 'org') {
      const o = orgOf(a).localeCompare(orgOf(b), 'ko')
      if (o !== 0) return o
    }
    return nameOf(a).localeCompare(nameOf(b), 'ko')
  }
  const sorted = [...items].sort(cmp)
  const map = new Map<string, T[]>()
  for (const it of sorted) {
    const k = indexKeyOf(nameOf(it))
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(it)
  }
  return [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([key, items]) => ({ key, items }))
}

/** 이니셜: 한글은 첫 글자, 라틴은 첫 글자 대문자 */
export function initialsOf(name: string | null | undefined): string {
  const s = (name || '').trim()
  if (!s) return '?'
  return s[0].toUpperCase()
}

/**
 * 그룹 점 색 — 그룹에 색 필드가 없어 이름으로 고정 배정한다. 범주 색 --cat-1…8.
 * Tailwind 가 utils 를 훑지 않으므로 클래스 대신 CSS 값(hsl(var(--cat-N)))을 돌려준다.
 */
export function groupDotColor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return `hsl(var(--cat-${(h % 8) + 1}))`
}
