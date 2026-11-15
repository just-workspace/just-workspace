import { describe, it, expect, beforeEach } from 'vitest'
import {
  setHeaderActions, clearHeaderActions, clearAllHeaderActions, getHeaderActions, wsShellApi, MAX_ACTIONS,
} from '~/composables/useShellHeaderActions'

// React 판 useShellHeaderActions 는 hook 이라, 테스트는 같은 상태를 직접 읽는다(Vue 판 actions.value 와 같은 값).
const useShellHeaderActions = () => ({ actions: { get value() { return getHeaderActions() } } })

describe('상단바 확장 자리', () => {
  beforeEach(() => clearAllHeaderActions())

  it('등록·바꾸기·해제', () => {
    const { actions } = useShellHeaderActions()
    const off = setHeaderActions([{ id: 'a', label: '패널', icon: 'sliders', pressed: false }])
    expect(actions.value.map(a => a.id)).toEqual(['a'])
    // 같은 owner 로 다시 set 하면 통째로 바뀐다
    setHeaderActions([{ id: 'a', label: '패널', icon: 'sliders', pressed: true }, { id: 'b', label: '실행', text: '실행' }])
    expect(actions.value.length).toBe(2)
    expect(actions.value[0].pressed).toBe(true)
    off()
    expect(actions.value.length).toBe(0)
  })

  it('owner 별로 따로, 잘못된 항목은 버린다, 최대 개수', () => {
    const { actions } = useShellHeaderActions()
    setHeaderActions([{ id: 'x', label: 'X', icon: 'wand' }], 'one')
    setHeaderActions([{ id: 'y', label: 'Y', icon: 'wand' }, { id: 'bad' } as any, { id: 'noicon', label: '아이콘도 글자도 없음' } as any], 'two')
    expect(actions.value.map(a => a.id)).toEqual(['x', 'y'])
    clearHeaderActions('one')
    expect(actions.value.map(a => a.id)).toEqual(['y'])
    setHeaderActions(Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, icon: 'dot' })), 'many')
    expect(actions.value.length).toBe(MAX_ACTIONS)
  })

  it('전역 API 는 같은 상태를 바꾼다', () => {
    const { actions } = useShellHeaderActions()
    expect(wsShellApi.version).toBe(1)
    const off = wsShellApi.setHeaderActions([{ id: 'g', label: 'G', icon: 'wand' }])
    expect(actions.value.map(a => a.id)).toEqual(['g'])
    off()
    expect(actions.value.length).toBe(0)
  })
})
