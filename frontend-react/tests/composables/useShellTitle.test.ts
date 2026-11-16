// 상단바 제목 덮어쓰기(__WS_SHELL__.setTitle) — 설정·변경·원복·owner·정리
import { describe, it, expect, beforeEach } from 'vitest'
import { setTitle, clearTitle, clearAllTitles, getShellTitle, MAX_TITLE_LENGTH } from '~/composables/useShellTitle'
import { wsShellApi } from '~/composables/useShellHeaderActions'

describe('상단바 제목', () => {
  beforeEach(() => clearAllTitles())

  it('걸기·바꾸기·해제 함수로 원복', () => {
    const off = setTitle('첫 제목')
    expect(getShellTitle()).toBe('첫 제목')
    setTitle('둘째 제목')
    expect(getShellTitle()).toBe('둘째 제목')
    off()
    expect(getShellTitle()).toBe('')
  })

  it('null·빈 문자열·문자열 아닌 값 = 원복, 공백은 한 칸으로 다듬고 길면 자른다', () => {
    setTitle('  여러   칸\n줄 ')
    expect(getShellTitle()).toBe('여러 칸 줄')
    setTitle(null)
    expect(getShellTitle()).toBe('')
    setTitle('x')
    setTitle('   ')
    expect(getShellTitle()).toBe('')
    setTitle(42 as unknown as string)
    expect(getShellTitle()).toBe('')
    setTitle('가'.repeat(MAX_TITLE_LENGTH + 50))
    expect(getShellTitle().length).toBe(MAX_TITLE_LENGTH)
  })

  it('owner 별로 따로 — 마지막에 건 것이 보이고, 그것을 풀면 앞의 것이 다시 보인다', () => {
    setTitle('A', 'one')
    setTitle('B', 'two')
    expect(getShellTitle()).toBe('B')
    clearTitle('two')
    expect(getShellTitle()).toBe('A')
    // 동일 owner 를 다시 설정하면 맨 뒤로 이동
    setTitle('B', 'two')
    setTitle('A2', 'one')
    expect(getShellTitle()).toBe('A2')
    clearTitle('nobody') // 존재하지 않는 owner 는 no-op
    clearAllTitles()
    expect(getShellTitle()).toBe('')
  })

  it('전역 API(__WS_SHELL__) 가 같은 상태를 바꾼다', () => {
    expect(wsShellApi.version).toBe(1)
    const off = wsShellApi.setTitle('전역 제목')
    expect(getShellTitle()).toBe('전역 제목')
    off()
    expect(getShellTitle()).toBe('')
    wsShellApi.setTitle('또')
    wsShellApi.clearTitle()
    expect(getShellTitle()).toBe('')
  })
})
