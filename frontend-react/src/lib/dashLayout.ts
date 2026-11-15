/**
 * 홈 대시보드 배치 규칙 — 순수 함수만.
 *
 * - 시작하기(신규 사용자)는 주 줄에 넣지 않는다 — 칩 줄 아래·주 줄 위 전폭 카드, 항목은 startColumns 열 격자.
 * - 주 줄: 후보 순서(나에게 온 것 2칸 → 오늘 → 오늘의 포커스 → 이어서 하기 2칸)를 열 수를 넘지 않게 앞에서부터 채운다.
 *   못 들어가는 후보는 건너뛰고 다음 후보를 본다(시안 그대로). 주 줄 같은 높이는 내용 있는 카드끼리만(tierHeights):
 *   빈 상태 카드·AI 꺼짐 카드는 자기 높이. 주 줄에 못 든 후보는 보조 영역 맨 앞.
 *   신규 사용자는 오늘 → 포커스 → 나에게 온 것.
 * - 보조 영역: 열 쌓기 — grid-auto-rows 4px + dense, 카드마다 row span = ceil((높이 + 20) / 4).
 * - 카드 행 수 상한 = 실효 높이 <1000 5행 · <1300 6행 · 그 이상 7행.
 * - 크기 2단계 1칸/2칸(열이 1이면 1칸). 기본 2칸 = 나에게 온 것 · 이어서 하기. 시작하기는 늘 전폭(크기 없음).
 * - 개인 배치(/api/me/prefs dash.layout) > 관리자 기본 배치(appcfg dash.layout) > 기본 순서.
 *   관리자 고정(locked) 카드는 숨김·크기를 바꿀 수 없다(순서만).
 *
 * 값 모양은 백엔드 app/dashboard/layout.py 와 같다.
 */

export const CARD_KEYS = [
  'start', 'inbox', 'today', 'ai', 'cont', 'tasks', 'mail', 'later', 'team', 'git',
  'board', 'notice', 'chans', 'store', 'meet', 'discover', 'lab',
] as const
export type CardKey = typeof CARD_KEYS[number]
export type CardSpan = 1 | 2

export interface DashLayout {
  v?: number
  order?: CardKey[]
  hidden?: CardKey[]
  size?: Partial<Record<CardKey, CardSpan>>
  /** 관리자 기본 배치에서만 — 모든 사람에게 고정 */
  locked?: CardKey[]
}

/** 주 줄 후보 */
export const PRIMARY: readonly CardKey[] = ['inbox', 'today', 'ai', 'cont']
export const PRIMARY_NEW: readonly CardKey[] = ['today', 'ai', 'inbox']
/** 판 밖(주 줄 위) 전폭 카드 — 그리드에 넣지 않는다. 편집 패널 목록에는 있다(숨기기·다시 보기) */
export const FULL_WIDTH: readonly CardKey[] = ['start']
/** 보조 영역 기본 순서(+ 진행 중 회의 + 네트워크 랩) */
export const REST: readonly CardKey[] = ['tasks', 'mail', 'later', 'team', 'git', 'board', 'notice', 'chans', 'store', 'meet', 'lab']
/** 신규 사용자 보조 영역(시안 #new: 둘러볼 채널 · 공지 먼저) */
export const REST_NEW: readonly CardKey[] = ['discover', 'notice', 'cont', 'tasks', 'mail', 'later', 'team', 'git', 'board', 'chans', 'store', 'meet', 'lab']
/** 기본 2칸 */
export const DEFAULT_SPAN: Partial<Record<CardKey, CardSpan>> = { inbox: 2, cont: 2 }
/** 주 줄 카드 중 비어도 제자리 빈 상태를 보이는 것(나머지는 "비어 있는 카드" 묶음으로) */
export const INLINE_EMPTY: readonly CardKey[] = ['inbox', 'today', 'ai']

/** 카드 행 수 상한(실효 높이) */
export function maxRowsFor(effectiveHeight: number): number {
  return effectiveHeight >= 1300 ? 7 : effectiveHeight >= 1000 ? 6 : 5
}

/** 시작하기 전폭 카드의 항목 열 수 — 판 열 수에 맞춰 1·2·3(3열 이상은 3) */
export function startColumns(cols: number): number {
  return Math.max(1, Math.min(3, cols))
}

/**
 * 주 줄 카드별 높이: 내용 있는 카드(filled)끼리만 그중 가장 큰 높이로 맞추고, 나머지(빈 상태·AI 꺼짐·로딩)는 자기 높이.
 * 내용 있는 카드가 없으면 모두 자기 높이. 높이를 아직 모르면 fallback.
 */
export function tierHeights(
  tier: readonly CardKey[], heights: Partial<Record<CardKey, number>>, filled: (k: CardKey) => boolean, fallback = 240,
): Partial<Record<CardKey, number>> {
  const own = (k: CardKey) => heights[k] ?? fallback
  const full = tier.filter(filled)
  const max = full.length ? Math.max(...full.map(own)) : 0
  const out: Partial<Record<CardKey, number>> = {}
  for (const k of tier) out[k] = filled(k) ? max : own(k)
  return out
}

/** 보조 영역 row span(행 4px, 아래 간격 20 포함) */
export function rowSpanFor(heightPx: number): number {
  return Math.ceil((Math.max(0, heightPx) + 20) / 4)
}

export function isCardKey(k: unknown): k is CardKey {
  return typeof k === 'string' && (CARD_KEYS as readonly string[]).includes(k)
}

function keys(v: unknown): CardKey[] {
  if (!Array.isArray(v)) return []
  const out: CardKey[] = []
  for (const k of v) if (isCardKey(k) && !out.includes(k)) out.push(k)
  return out
}

/** 서버 값 → 배치(모르는 키·형식은 버림). 객체가 아니면 null */
export function parseLayout(v: unknown): DashLayout | null {
  let o = v
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return null }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const size: Partial<Record<CardKey, CardSpan>> = {}
  if (r.size && typeof r.size === 'object') {
    for (const [k, s] of Object.entries(r.size as Record<string, unknown>)) if (isCardKey(k) && (s === 1 || s === 2)) size[k] = s
  }
  return { v: 1, order: keys(r.order), hidden: keys(r.hidden), size, locked: keys(r.locked) }
}

export interface ResolvedLayout {
  /** 쓸 수 있는 카드 전부(숨김 포함), 보이는 순서 */
  order: CardKey[]
  hidden: Set<CardKey>
  size: Record<CardKey, CardSpan>
  locked: Set<CardKey>
}

/**
 * 기본 순서 위에 저장된 순서를 얹는다. 저장된 순서에 없는 카드(새로 생긴 카드 등)는 기본 순서에서 앞선 카드들 가운데
 * 가장 뒤에 놓인 것 바로 뒤에 끼운다(앞선 카드가 없으면 맨 뒤).
 * @param available 이 사용자가 쓸 수 있는 카드(모듈·권한·신규 여부로 거른 것)
 */
export function mergeOrder(base: readonly CardKey[], saved: readonly CardKey[] | undefined, available: readonly CardKey[]): CardKey[] {
  const avail = new Set(available)
  const out = (saved ?? []).filter(k => avail.has(k))
  const full = [...base, ...available.filter(k => !base.includes(k))]
  for (let i = 0; i < full.length; i++) {
    const k = full[i]
    if (!avail.has(k) || out.includes(k)) continue
    // 기본 순서에서 앞선 카드들 가운데 가장 뒤에 놓인 것 바로 뒤에. 앞선 카드가 하나도 없으면 맨 뒤
    let at = -1
    for (let j = 0; j < i; j++) at = Math.max(at, out.indexOf(full[j]))
    at = at < 0 ? out.length : at + 1
    out.splice(at, 0, k)
  }
  return out
}

/** 개인 > 관리자 기본 > 기본 순서로 합친 배치 */
export function resolveLayout(opts: {
  available: readonly CardKey[]
  isNew: boolean
  user?: DashLayout | null
  admin?: DashLayout | null
}): ResolvedLayout {
  const { available, isNew, user, admin } = opts
  const base = isNew ? [...FULL_WIDTH, ...PRIMARY_NEW, ...REST_NEW] : [...PRIMARY, ...REST]
  const locked = new Set((admin?.locked ?? []).filter(k => available.includes(k)))
  const savedOrder = user?.order?.length ? user.order : admin?.order
  const order = mergeOrder(base, savedOrder, available)
  const hiddenSrc = user ? (user.hidden ?? []) : (admin?.hidden ?? [])
  const hidden = new Set(hiddenSrc.filter(k => !locked.has(k)))
  // 고정 카드는 관리자가 숨겼더라도 보인다(고정 = 모두에게 보이게)
  const size = {} as Record<CardKey, CardSpan>
  for (const k of CARD_KEYS) {
    const def = DEFAULT_SPAN[k] ?? 1
    const a = admin?.size?.[k]
    const u = locked.has(k) ? undefined : user?.size?.[k]
    size[k] = u ?? a ?? def
  }
  return { order, hidden, size, locked }
}

/** 주 줄(시안: 후보를 순서대로 보며 남은 칸에 들어가면 넣는다). 열이 1이면 주 줄 없음 */
export function planTier(visible: readonly CardKey[], primary: readonly CardKey[], spanOf: (k: CardKey) => number, cols: number): CardKey[] {
  if (cols <= 1) return []
  const cand = visible.filter(k => primary.includes(k))
  const tier: CardKey[] = []
  let used = 0
  for (const k of cand) {
    const sp = Math.min(spanOf(k), cols)
    if (used + sp <= cols) { tier.push(k); used += sp }
  }
  return tier
}

/** 판에 그릴 순서 = 주 줄 → 주 줄에 못 든 후보 → 나머지(숨김·전폭 카드 제외) */
export function drawOrder(visible: readonly CardKey[], tier: readonly CardKey[], primary: readonly CardKey[]): CardKey[] {
  return [
    ...tier,
    ...visible.filter(k => primary.includes(k) && !tier.includes(k)),
    ...visible.filter(k => !primary.includes(k) && !FULL_WIDTH.includes(k)),
  ]
}

/** 배치를 저장 모양으로(개인 배치 — 고정은 넣지 않는다) */
export function toSaved(r: ResolvedLayout, withLocked = false): DashLayout {
  const size: Partial<Record<CardKey, CardSpan>> = {}
  for (const k of r.order) if (r.size[k] !== (DEFAULT_SPAN[k] ?? 1)) size[k] = r.size[k]
  const out: DashLayout = { v: 1, order: [...r.order], hidden: r.order.filter(k => r.hidden.has(k)), size }
  if (withLocked) out.locked = r.order.filter(k => r.locked.has(k))
  return out
}

/** 순서에서 from 을 to 자리로 옮긴다(to 앞에) */
export function moveKey(order: readonly CardKey[], from: CardKey, to: CardKey): CardKey[] {
  if (from === to) return [...order]
  const rest = order.filter(k => k !== from)
  const at = rest.indexOf(to)
  if (at < 0) return [...order]
  const fromIdx = order.indexOf(from), toIdx = order.indexOf(to)
  // 뒤로 옮길 때는 대상 뒤에(끌어 놓은 자리를 지나간 것으로)
  rest.splice(fromIdx < toIdx ? at + 1 : at, 0, from)
  return rest
}

/** 한 칸 앞/뒤로(키보드) */
export function stepKey(order: readonly CardKey[], key: CardKey, delta: -1 | 1): CardKey[] {
  const i = order.indexOf(key), j = i + delta
  if (i < 0 || j < 0 || j >= order.length) return [...order]
  const out = [...order]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}
