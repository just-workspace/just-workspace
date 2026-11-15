// 단축키 도움말의 모듈별 묶음 등록.
// 테스트에서 쓰는 길:
//  · 등록/해제: registerPageShortcuts(컴포넌트 밖) + 페이지 hook usePageShortcuts(renderHook)
//  · 읽기: usePageShortcutGroups(renderHook) / getPageShortcutGroups(getter 를 지금 읽음)
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { registerPageShortcuts, getPageShortcutGroups, usePageShortcutGroups, usePageShortcuts, type ShortcutItem } from '~/composables/useShortcuts'

describe('usePageShortcuts', () => {
  it('등록한 묶음이 도움말 목록에 붙고, 해제하면 빠진다', () => {
    const { result } = renderHook(() => usePageShortcutGroups())
    let off = () => {}
    act(() => { off = registerPageShortcuts('메일', [{ keys: ['C'], label: '새 메일' }]) })
    expect(result.current.map(g => g.title)).toContain('메일')
    act(() => off())
    expect(result.current.map(g => g.title)).not.toContain('메일')
  })

  it('getter 목록은 상태를 따라가고, 빈 묶음은 숨긴다', () => {
    let canWrite = false
    const off = registerPageShortcuts('위키', () => (canWrite ? [{ keys: ['E'], label: '편집' }] : []))
    expect(getPageShortcutGroups().find(g => g.title === '위키')).toBeUndefined()
    canWrite = true
    expect(getPageShortcutGroups().find(g => g.title === '위키')?.items).toEqual([{ keys: ['E'], label: '편집' }])
    off()
  })

  it('페이지 hook: 마운트 동안 등록, 목록이 바뀌면 갱신, 언마운트 때 해제', () => {
    const groups = renderHook(() => usePageShortcutGroups())
    const page = renderHook(({ items }: { items: ShortcutItem[] }) => usePageShortcuts('위키', items), { initialProps: { items: [] as ShortcutItem[] } })
    expect(groups.result.current.find(g => g.title === '위키')).toBeUndefined()
    page.rerender({ items: [{ keys: ['E'], label: '편집' }] })
    expect(groups.result.current.find(g => g.title === '위키')?.items).toEqual([{ keys: ['E'], label: '편집' }])
    page.unmount()
    expect(groups.result.current.find(g => g.title === '위키')).toBeUndefined()
  })
})
