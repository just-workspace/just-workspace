// 홈 대시보드 배치 규칙(handover 17 · Dash17 renderVals) — 주 줄 · 행 수 상한 · row span · 개인/관리자 배치 합치기.
import { describe, it, expect } from 'vitest'
import {
  PRIMARY, PRIMARY_NEW, REST, REST_NEW, CARD_KEYS, maxRowsFor, rowSpanFor, planTier, drawOrder, resolveLayout, mergeOrder,
  parseLayout, toSaved, moveKey, stepKey, startColumns, tierHeights, type CardKey,
} from '~/lib/dashLayout'

const span = (k: CardKey) => (k === 'inbox' || k === 'cont' ? 2 : 1)

describe('주 줄(시안 결과표)', () => {
  it.each([
    [1, []],
    [2, ['inbox']],
    [3, ['inbox', 'today']],
    [4, ['inbox', 'today', 'ai']],
    [5, ['inbox', 'today', 'ai']],
    [6, ['inbox', 'today', 'ai', 'cont']],
  ])('%i열', (cols, tier) => {
    expect(planTier([...PRIMARY, ...REST], PRIMARY, span, cols)).toEqual(tier)
  })
  it('신규 사용자: 시작하기는 주 줄 밖(전폭) — 주 줄은 오늘 → 포커스 → 나에게 온 것', () => {
    const visible: CardKey[] = ['start', ...PRIMARY_NEW, ...REST_NEW]
    expect(planTier(visible, PRIMARY_NEW, span, 3)).toEqual(['today', 'ai'])
    expect(planTier(visible, PRIMARY_NEW, span, 4)).toEqual(['today', 'ai', 'inbox'])
    const tier = planTier(visible, PRIMARY_NEW, span, 3)
    const order = drawOrder(visible, tier, PRIMARY_NEW)
    expect(order).not.toContain('start')
    expect(order.slice(0, 4)).toEqual(['today', 'ai', 'inbox', 'discover'])
  })
  it('신규 사용자 기본 순서는 시작하기가 맨 앞(편집 패널 목록 — 숨기기·다시 보기)', () => {
    const r = resolveLayout({ available: [...CARD_KEYS], isNew: true })
    expect(r.order.slice(0, 4)).toEqual(['start', 'today', 'ai', 'inbox'])
    const hidden = resolveLayout({ available: [...CARD_KEYS], isNew: true, user: { order: r.order, hidden: ['start'] } })
    expect(hidden.hidden.has('start')).toBe(true)
  })
  it('시작하기 항목 열 = 판 열 수에 맞춰 1·2·3', () => {
    expect([1, 2, 3, 4, 6].map(startColumns)).toEqual([1, 2, 3, 3, 3])
  })
  it('못 든 후보는 보조 영역 맨 앞', () => {
    const visible = [...PRIMARY, ...REST]
    const tier = planTier(visible, PRIMARY, span, 3)
    expect(drawOrder(visible, tier, PRIMARY).slice(0, 5)).toEqual(['inbox', 'today', 'ai', 'cont', 'tasks'])
  })
  it('숨긴 후보는 건너뛴다', () => {
    expect(planTier(['inbox', 'ai', 'cont'], PRIMARY, span, 3)).toEqual(['inbox', 'ai'])
  })
})

describe('높이', () => {
  it('주 줄 같은 높이는 내용 있는 카드끼리만 — 빈 카드·AI 꺼짐은 자기 높이', () => {
    const h = { inbox: 92, today: 92, ai: 210, cont: 400 }
    const filled = (k: CardKey) => k === 'cont' || k === 'inbox'
    expect(tierHeights(['inbox', 'today', 'ai', 'cont'], { ...h, inbox: 300 }, filled)).toEqual({ inbox: 400, today: 92, ai: 210, cont: 400 })
    // 다 비면 각자 내용 높이
    expect(tierHeights(['today', 'ai'], h, () => false)).toEqual({ today: 92, ai: 210 })
    // 높이를 아직 모르면 fallback
    expect(tierHeights(['today'], {}, () => true, 240)).toEqual({ today: 240 })
  })
  it('행 수 상한 = 실효 높이 <1000 5 · <1300 6 · 그 이상 7', () => {
    expect([maxRowsFor(900), maxRowsFor(999), maxRowsFor(1000), maxRowsFor(1299), maxRowsFor(1300), maxRowsFor(1920)]).toEqual([5, 5, 6, 6, 7, 7])
  })
  it('row span = ceil((높이 + 20) / 4)', () => {
    expect(rowSpanFor(48 + 44 * 3)).toBe(Math.ceil((180 + 20) / 4))
    expect(rowSpanFor(401)).toBe(106)
    expect(rowSpanFor(0)).toBe(5)
  })
})

describe('배치 합치기', () => {
  const all = [...CARD_KEYS].filter(k => k !== 'start' && k !== 'discover')
  it('저장 없음 = 기본 순서', () => {
    const r = resolveLayout({ available: all, isNew: false })
    expect(r.order.slice(0, 6)).toEqual(['inbox', 'today', 'ai', 'cont', 'tasks', 'mail'])
    expect(r.size.inbox).toBe(2)
    expect(r.size.tasks).toBe(1)
  })
  it('개인 배치가 관리자 기본보다 앞서고, 고정 카드는 숨김·크기를 못 바꾼다', () => {
    const admin = parseLayout(JSON.stringify({ order: ['notice', 'inbox'], hidden: ['git'], size: { notice: 2 }, locked: ['notice'] }))
    const user = parseLayout({ order: ['today', 'inbox'], hidden: ['notice', 'store'], size: { notice: 1, inbox: 1 } })
    const r = resolveLayout({ available: all, isNew: false, admin, user })
    expect(r.order.slice(0, 2)).toEqual(['today', 'inbox'])
    expect(r.hidden.has('notice')).toBe(false)
    expect(r.hidden.has('store')).toBe(true)
    expect(r.hidden.has('git')).toBe(false) // 개인 배치가 있으면 관리자 숨김 대신 개인 숨김
    expect(r.size.notice).toBe(2)
    expect(r.size.inbox).toBe(1)
    expect(r.locked.has('notice')).toBe(true)
  })
  it('관리자 기본만 있으면 그 순서·숨김', () => {
    const admin = parseLayout({ order: ['notice'], hidden: ['git'] })
    const r = resolveLayout({ available: all, isNew: false, admin })
    expect(r.order[0]).toBe('notice')
    expect(r.hidden.has('git')).toBe(true)
  })
  it('저장 순서에 없는 카드는 기본 순서에서 앞선 카드들 가운데 가장 뒤에 놓인 것 뒤에', () => {
    expect(mergeOrder(['inbox', 'today', 'ai', 'cont'], ['ai', 'inbox'], ['inbox', 'today', 'ai', 'cont'])).toEqual(['ai', 'inbox', 'today', 'cont'])
    expect(mergeOrder(['inbox', 'today'], ['today', 'nope' as CardKey], ['inbox', 'today'])).toEqual(['today', 'inbox'])
  })
  it('parseLayout 은 모르는 키·잘못된 크기를 버린다', () => {
    expect(parseLayout({ order: ['inbox', 'x', 'inbox'], size: { inbox: 3, today: 2 } })).toEqual({ v: 1, order: ['inbox'], hidden: [], size: { today: 2 }, locked: [] })
    expect(parseLayout('{bad')).toBeNull()
    expect(parseLayout([1])).toBeNull()
  })
  it('toSaved 는 기본 크기와 다른 것만 남긴다', () => {
    const r = resolveLayout({ available: ['inbox', 'today'], isNew: false, user: { order: ['inbox', 'today'], size: { today: 2 } } })
    expect(toSaved(r)).toEqual({ v: 1, order: ['inbox', 'today'], hidden: [], size: { today: 2 } })
  })
})

describe('순서 바꾸기', () => {
  const o: CardKey[] = ['inbox', 'today', 'ai', 'cont']
  it('끌어 놓기', () => {
    expect(moveKey(o, 'cont', 'today')).toEqual(['inbox', 'cont', 'today', 'ai'])
    expect(moveKey(o, 'inbox', 'ai')).toEqual(['today', 'ai', 'inbox', 'cont'])
    expect(moveKey(o, 'inbox', 'inbox')).toEqual(o)
  })
  it('키보드 한 칸', () => {
    expect(stepKey(o, 'today', -1)).toEqual(['today', 'inbox', 'ai', 'cont'])
    expect(stepKey(o, 'cont', 1)).toEqual(o)
  })
})
