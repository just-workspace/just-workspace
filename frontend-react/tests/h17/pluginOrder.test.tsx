// 플러그인 manifest order — 레일·모바일 전체 시트(useNav) 순서
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { platformStore, type PlatformModule } from '~/composables/usePlatform'
import { authStore } from '~/composables/useAuth'
import { useNav, compareNavItems } from '~/composables/useNav'

const mod = (id: string, type: string, extra: Partial<PlatformModule> = {}): PlatformModule => ({
  id, name: id, icon: 'puzzle', route: `/${id}`, type, requires: [], enabled: true, ...extra,
})

describe('플러그인 order', () => {
  beforeEach(() => { authStore.setState({ user: { id: 'u', username: 'u', is_admin: false } as any }) })

  it('플러그인 묶음: order 작은 순 → order 없음(서버 순서 그대로)', () => {
    platformStore.setState({
      loaded: true,
      modules: [
        mod('mail', 'builtin', { category: 'communication' }),
        mod('p-alpha', 'plugin'),
        mod('p-beta', 'plugin', { order: 20 }),
        mod('p-gamma', 'plugin'),
        mod('p-delta', 'plugin', { order: 10 }),
      ],
    })
    const { result } = renderHook(() => useNav())
    const plugin = result.current.groups.find(g => g.key === 'plugin')!
    expect(plugin.items.map(i => i.id)).toEqual(['p-delta', 'p-beta', 'p-alpha', 'p-gamma'])
    // 레일 항목에 정렬용 order 를 포함하지 않음
    expect(plugin.items.every(i => !('order' in i))).toBe(true)
    // 모바일 전체 시트가 사용하는 flat 도 동일 순서
    expect(result.current.flat.map(i => i.id).filter(id => id.startsWith('p-'))).toEqual(['p-delta', 'p-beta', 'p-alpha', 'p-gamma'])
  })

  it('카테고리 묶음 안에서도 내장 다음에 플러그인 order 순', () => {
    platformStore.setState({
      loaded: true,
      modules: [
        mod('p-late', 'plugin', { category: 'communication' }),
        mod('p-early', 'plugin', { category: 'communication', order: 1 }),
        mod('chat', 'builtin', { category: 'communication' }),
        mod('mail', 'builtin', { category: 'communication' }),
      ],
    })
    const { result } = renderHook(() => useNav())
    expect(result.current.groups.find(g => g.key === 'communication')!.items.map(i => i.id)).toEqual(['mail', 'chat', 'p-early', 'p-late'])
  })

  it('compareNavItems — 같은 order 는 0(안정)', () => {
    expect(compareNavItems({ id: 'a', order: 3 }, { id: 'b', order: 3 }, 'plugin')).toBe(0)
    expect(compareNavItems({ id: 'a' }, { id: 'b', order: 3 }, 'plugin')).toBe(1)
    expect(compareNavItems({ id: 'a', order: null }, { id: 'b' }, 'plugin')).toBe(0)
  })
})
