/**
 * 폰트 — 원격이 **실제로 쓴** 폰트(CSS.getPlatformFontsForNode)를 고정 폰트 키(FONT_KEYS)로 바꾼다.
 *
 * 세션 이미지에는 우리 묶음(Liberation2·DejaVu·Noto CJK)만 깔려 있고, 사용자 PC 는 같은 파일에서 만든 WOFF2(/rbi/<sid>/font/)로 그린다
 * → 원격 폭 = 로컬 폭(글꼴이 서로 다르면 — 예: 원격 DejaVu 대체 vs 사용자 Arial — 글리프 폭이 12 % 까지 어긋난다).
 * 작성자 웹폰트(@font-face)는 원격에서만 쓰이고 바이트는 넘어가지 않는다 — isCustomFont 면 우리 묶음의 비슷한 것으로 대체하고,
 * 아이콘 폰트(Font Awesome·Glyphicons 같은 사용자 영역 글리프)면 래스터로 보낸다(raster.ts).
 *
 * 캐시 키 = (계산된 font-family, 굵기, 기울임, 글자 계열[라틴만/한글·한자 포함/그 밖]). 한 페이지에서 호출은 몇 번뿐이다.
 * 결과가 오기 전에는 이름 규칙으로 추정(heuristic)하고, 다르면 그 노드들을 다시 보낸다.
 */
import { type FontKey, FONT_KEYS } from '../../protocol/vocab.ts'

export interface PlatformFont { familyName: string; postScriptName?: string; isCustomFont: boolean; glyphCount: number }

export interface FontInfo {
  keys: FontKey[]
  /** 작성자 웹폰트를 썼다(우리 묶음으로 대체했다) */
  custom: boolean
  /** 아이콘 폰트로 보인다 → 래스터 */
  icon: boolean
  /** 원격 결과(아직이면 추정) */
  resolved: boolean
}

const FAMILY_TO_KEY: [RegExp, FontKey][] = [
  [/^liberation sans/i, 'lsans'], [/^liberation serif/i, 'lserif'], [/^liberation mono/i, 'lmono'],
  [/^dejavu sans mono/i, 'dmono'], [/^dejavu serif/i, 'dserif'], [/^dejavu sans/i, 'dsans'],
  [/^noto sans cjk/i, 'cjks'], [/^noto serif cjk/i, 'cjkr'], [/^noto sans mono cjk/i, 'cjkm'],
]
export function platformToKey(family: string): FontKey | undefined {
  for (const [re, k] of FAMILY_TO_KEY) if (re.test(family.trim())) return k
  return undefined
}

export const ICON_FAMILY = /awesome|glyphicon|icon|material symbols|material icons|ionicons|feather|octicon|codicon/i
const PUA_RE = /[-]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/u
export function hasPua(t: string): boolean { return PUA_RE.test(t) }
const CJK_RE = /[ᄀ-ᇿ　-〿㄰-㆏㈀-㋿㐀-䶿一-鿿ꥠ-꥿가-힯ힰ-퟿豈-﫿＀-￯]/
export function scriptClass(t: string): 'l' | 'k' | 'o' {
  if (CJK_RE.test(t)) return 'k'
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) > 0x24f) return 'o'
  return 'l'
}

/** 계산된 font-family 목록 → 첫 패밀리 이름들(소문자, 따옴표 제거) */
export function familyList(ff: string): string[] {
  return ff.split(',').map(x => x.trim().replace(/^["']|["']$/g, '').trim().toLowerCase()).filter(Boolean).slice(0, 12)
}

/**
 * 이름 규칙 추정 — 세션 이미지의 fontconfig 가 하는 일을 흉내(정확한 값은 원격 결과가 덮는다).
 * 데비안 기본: sans-serif → DejaVu Sans, serif → DejaVu Serif, monospace → DejaVu Sans Mono,
 * Arial/Helvetica → Liberation Sans(fonts-liberation2 의 별칭 규칙), Times → Liberation Serif, Courier → Liberation Mono.
 */
export function heuristicKeys(ff: string, text: string): FontKey[] {
  const fams = familyList(ff)
  let base: FontKey = 'dsans'
  for (const f of fams) {
    if (/^(arial|helvetica|liberation sans|arimo|helvetica neue)/.test(f)) { base = 'lsans'; break }
    if (/^(times|times new roman|liberation serif|tinos)/.test(f)) { base = 'lserif'; break }
    if (/^(courier|courier new|liberation mono|cousine)/.test(f)) { base = 'lmono'; break }
    if (/^dejavu sans mono/.test(f) || f === 'monospace' || /^(consolas|menlo|monaco|ui-monospace)/.test(f)) { base = 'dmono'; break }
    if (/^dejavu serif/.test(f) || f === 'serif') { base = 'dserif'; break }
    if (/^dejavu sans/.test(f) || f === 'sans-serif' || f === 'system-ui' || f === '-apple-system') { base = 'dsans'; break }
    if (/^noto sans mono cjk/.test(f)) { base = 'cjkm'; break }
    if (/^noto sans cjk|^noto sans kr|^malgun|^맑은|^nanum|^apple sd/.test(f)) { base = 'cjks'; break }
    if (/^noto serif cjk|^noto serif kr|^batang|^바탕/.test(f)) { base = 'cjkr'; break }
  }
  const keys: FontKey[] = [base]
  if (scriptClass(text) === 'k' && base !== 'cjks' && base !== 'cjkr' && base !== 'cjkm') keys.push(base === 'lserif' || base === 'dserif' ? 'cjkr' : base === 'lmono' || base === 'dmono' ? 'cjkm' : 'cjks')
  return keys
}

export type FontQuery = (refId: number) => Promise<PlatformFont[] | undefined>

export class FontResolver {
  private cache = new Map<string, FontInfo>()
  private pending = new Map<string, Promise<void>>()
  /** 키 → 그 키로 변환된 노드 id(결과가 오면 다시 변환) */
  private users = new Map<string, Set<number>>()
  stats = { queries: 0, failed: 0, custom: 0, icon: 0, mismatch: 0 }

  constructor(private query: FontQuery, private onResolved: (ids: Iterable<number>) => void) {}

  reset(): void { this.cache.clear(); this.pending.clear(); this.users.clear() }

  /** 노드 id(텍스트)와 스타일 출처 요소 id(refId) 로 폰트 정보. 처음 보는 키면 원격에 물어 두고 추정값을 돌려준다 */
  resolve(nodeId: number, refId: number, ff: string, fw: string, fi: string, text: string): FontInfo {
    // 글자 계열을 따로 센다(라틴이 있나·한중일이 있나) — "OSPF 다중" 과 "다중" 은 다른 결과를 받아야 한다
    const key = `${ff}|${fw}|${fi}|${/[A-Za-z0-9]/.test(text) ? 'L' : ''}${scriptClass(text)}|${hasPua(text) ? 'p' : ''}`
    let set = this.users.get(key); if (!set) { set = new Set(); this.users.set(key, set) }
    set.add(nodeId)
    const hit = this.cache.get(key)
    if (hit) return hit
    const guess: FontInfo = { keys: heuristicKeys(ff, text), custom: false, icon: hasPua(text) && ICON_FAMILY.test(ff), resolved: false }
    if (!this.pending.has(key) && refId > 0) {
      this.pending.set(key, this.ask(key, refId, guess, text))
    }
    return guess
  }

  forget(nodeId: number): void { for (const s of this.users.values()) s.delete(nodeId) }

  private async ask(key: string, refId: number, guess: FontInfo, text: string): Promise<void> {
    this.stats.queries++
    let fonts: PlatformFont[] | undefined
    try { fonts = await this.query(refId) } catch { fonts = undefined }
    if (!fonts || !fonts.length) { this.stats.failed++; this.cache.set(key, { ...guess, resolved: true }); return }
    const sorted = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)
    const keys: FontKey[] = []
    let custom = false, iconLike = false
    for (const f of sorted) {
      const k = platformToKey(f.familyName)
      if (f.isCustomFont || !k) { custom = true; if (ICON_FAMILY.test(f.familyName) || (f.isCustomFont && hasPua(text))) iconLike = true; continue }
      if (!keys.includes(k)) keys.push(k)
    }
    // 순서: 라틴을 그리는 폰트 먼저, 한중일 폰트 뒤 — 브라우저는 글자마다 앞에서부터 고른다(한중일 폰트에도 라틴 글리프가 있어
    // 앞에 두면 라틴이 그 폰트로 그려진다). 원격 보고에 라틴 폰트가 없으면(한글만 있는 요소) 이름 규칙의 첫 폰트를 라틴 자리에.
    const CJK_KEYS: FontKey[] = ['cjks', 'cjkr', 'cjkm']
    const latin = keys.filter(k => !CJK_KEYS.includes(k))
    const cjk = keys.filter(k => CJK_KEYS.includes(k))
    const base = guess.keys[0]
    const head: FontKey[] = latin.length ? latin : CJK_KEYS.includes(base) ? [] : [base]
    // 작성자 웹폰트만 썼다 → 우리 묶음의 비슷한 것(추정)으로
    const merged = [...head, ...cjk]
    const fin = merged.length ? merged : guess.keys.filter(k => (FONT_KEYS as readonly string[]).includes(k))
    if (custom) this.stats.custom++
    // 아이콘 폰트로 그린 글자 — 사용자 영역이든 ASCII 든(Glyphicons '+') 래스터로. 보통 웹폰트는 우리 묶음으로 대체(네이티브 글자 유지)
    const info: FontInfo = { keys: fin.slice(0, 4), custom, icon: iconLike && (hasPua(text) || latin.length + cjk.length === 0), resolved: true }
    if (info.icon) this.stats.icon++
    this.cache.set(key, info)
    this.pending.delete(key)
    if (info.keys.join() !== guess.keys.join() || info.icon !== guess.icon) {
      this.stats.mismatch++
      const ids = this.users.get(key)
      if (ids && ids.size) this.onResolved([...ids])
    }
  }
}
