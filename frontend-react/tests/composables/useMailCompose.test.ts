// 메일 작성 창 store — 열기·중복 방지·펼침 한도·닫기·로그아웃 시 비움(Vue app.vue watch 대응)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const nav = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('~/lib/router', async (orig) => {
  const real = await orig<typeof import('~/lib/router')>()
  return { ...real, navigateTo: (to: string) => { nav.calls.push(to) } }
})

const { useMailCompose, mailComposeStore, openCompose, openComposeFromQuery, closeCompose, setComposeMinimized, toggleComposeMaximized, setComposeTitle, _resetMailComposeStore } = await import('~/composables/useMailCompose')
const { authStore } = await import('~/composables/useAuth')
const { isMobileStore } = await import('~/composables/useIsMobile')

const wins = () => mailComposeStore.getState().windows
const msg = (id: string, subject: string) => ({ id, subject }) as any

beforeEach(() => {
  _resetMailComposeStore()
  isMobileStore.setState({ isMobile: false })
  nav.calls = []
})

describe('useMailCompose', () => {
  it('새 창을 열고 제목은 기본 문구', () => {
    const id = openCompose('new', null, null, { to: 'a@b.c' })
    expect(id).toBe('compose-1')
    expect(wins()).toHaveLength(1)
    expect(wins()[0]).toMatchObject({ mode: 'new', to: 'a@b.c', minimized: false, maximized: false, draftId: null })
    expect(wins()[0].title).toBe('새 메일')
  })

  it('답장 제목에 Re: 를 붙이고, 같은 원문 같은 모드는 기존 창을 펼친다', () => {
    const a = openCompose('reply', msg('m1', '안녕'))
    expect(wins()[0].title).toBe('Re: 안녕')
    setComposeMinimized(a!, true)
    expect(wins()[0].minimized).toBe(true)
    const b = openCompose('reply', msg('m1', '안녕'))
    expect(b).toBe(a)
    expect(wins()).toHaveLength(1)
    expect(wins()[0].minimized).toBe(false)
  })

  it('펼친 창은 2개까지 — 넘치면 오래된 것부터 최소화', () => {
    openCompose('new'); openCompose('new'); openCompose('new')
    expect(wins().map(w => w.minimized)).toEqual([true, false, false])
    // 최소화된 첫 창을 펼치면 다른 하나(가장 오래된 펼친 창)가 접힌다
    setComposeMinimized('compose-1', false)
    expect(wins().map(w => w.minimized)).toEqual([false, true, false])
  })

  it('크게 보기는 하나만 — 나머지는 최소화, 제목·닫기', () => {
    openCompose('new'); openCompose('new')
    toggleComposeMaximized('compose-2')
    expect(wins().map(w => [w.minimized, w.maximized])).toEqual([[true, false], [false, true]])
    setComposeTitle('compose-2', '')
    expect(wins()[1].title).toBe('새 메일')
    closeCompose('compose-1')
    expect(wins().map(w => w.id)).toEqual(['compose-2'])
  })

  it('모바일이면 창 대신 /mail/compose 로 간다', () => {
    isMobileStore.setState({ isMobile: true })
    expect(openCompose('reply', msg('m9', 'x'))).toBeNull()
    expect(nav.calls).toEqual(['/mail/compose?mode=reply&msgId=m9'])
    openComposeFromQuery('mode=new&to=z%40y.z')
    expect(nav.calls[1]).toBe('/mail/compose?mode=new&to=z%40y.z')
    expect(wins()).toHaveLength(0)
  })

  it('쿼리로 연 창 — 같은 초안이면 다시 열지 않는다', () => {
    openComposeFromQuery('mode=draft&draftId=d1')
    openComposeFromQuery('mode=draft&draftId=d1')
    expect(wins()).toHaveLength(1)
    expect(wins()[0]).toMatchObject({ mode: 'draft', draftId: 'd1', original: null, title: '임시 보관 메일' })
  })

  it('로그아웃(user → null)이면 창을 모두 비운다', () => {
    authStore.setState({ user: { id: 'u1' } as any })
    openCompose('new'); openCompose('new')
    expect(wins()).toHaveLength(2)
    authStore.setState({ loading: false }) // user 그대로면 안 지운다
    expect(wins()).toHaveLength(2)
    authStore.setState({ user: null })
    expect(wins()).toHaveLength(0)
  })

  it('useMailCompose() hook — windows·hasWindows', () => {
    const { result } = renderHook(() => useMailCompose())
    expect(result.current.hasWindows).toBe(false)
    act(() => { result.current.open('forward', msg('m2', 'Fwd: 원문')) })
    expect(result.current.hasWindows).toBe(true)
    expect(result.current.windows[0].title).toBe('Fwd: 원문')
  })
})
