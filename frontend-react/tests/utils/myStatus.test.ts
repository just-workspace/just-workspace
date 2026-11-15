import { describe, expect, it } from 'vitest'
import { menuPresence } from '~/utils/myStatus'

describe('내 상태 → 상태 3칸', () => {
  const now = Date.parse('2026-10-16T09:00:00Z')
  it('모드 그대로', () => {
    expect(menuPresence({ mode: 'auto', dnd_until: null }, now)).toBe('online')
    expect(menuPresence({ mode: 'away', dnd_until: null }, now)).toBe('away')
    expect(menuPresence({ mode: 'dnd', dnd_until: null }, now)).toBe('dnd')
  })
  it('오프라인으로 표시는 어느 칸도 아님', () => {
    expect(menuPresence({ mode: 'invisible', dnd_until: null }, now)).toBeNull()
  })
  it('방해 금지 기한 — 미래면 dnd, 지났으면 풀림', () => {
    expect(menuPresence({ mode: 'auto', dnd_until: '2026-10-16T10:00:00Z' }, now)).toBe('dnd')
    expect(menuPresence({ mode: 'dnd', dnd_until: '2026-10-16T08:00:00Z' }, now)).toBe('online')
  })
})
