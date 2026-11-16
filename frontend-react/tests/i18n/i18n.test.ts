// vue-i18n 문법 어댑터 — locales JSON 을 그대로 사용할 때 vue-i18n 과 동일한 결과인지 검증.
import { describe, it, expect } from 'vitest'
import { format, pluralDefault } from '~/i18n/compile'
import { act, renderHook } from '@testing-library/react'
import { i18n, setMessages, setLocale, useI18n } from '~/i18n'

const resolve = (msgs: Record<string, string>) => (k: string) => msgs[k]

describe('vue-i18n 문법 해석', () => {
  it('이름·목록 보간, 없는 값은 빈 문자열', () => {
    expect(format('안녕 {name}님', { named: { name: '철수' }, resolve: resolve({}) })).toBe('안녕 철수님')
    expect(format('{0} 와 {1}', { list: ['a', 'b'], resolve: resolve({}) })).toBe('a 와 b')
    expect(format('값 {x}', { resolve: resolve({}) })).toBe('값 ')
    expect(format('{ name }', { named: { name: 'sp' }, resolve: resolve({}) })).toBe('sp')
  })

  it("리터럴 {'@'} {'|'} 는 글자 그대로, 복수형 구분자로 보지 않는다", () => {
    expect(format("{page} · 관리 {'|'} {app}", { named: { page: '사용자', app: 'WS' }, resolve: resolve({}) })).toBe('사용자 · 관리 | WS')
    expect(format("kim{'@'}example.com", { resolve: resolve({}) })).toBe('kim@example.com')
  })

  it('복수형 — vue-i18n 기본 규칙', () => {
    const two = 'apple | apples'
    expect(format(two, { plural: 1, resolve: resolve({}) })).toBe('apple')
    expect(format(two, { plural: 2, resolve: resolve({}) })).toBe('apples')
    expect(format(two, { plural: 0, resolve: resolve({}) })).toBe('apples')
    const three = 'no apples | one apple | {count} apples'
    expect(format(three, { plural: 0, resolve: resolve({}) })).toBe('no apples')
    expect(format(three, { plural: 1, resolve: resolve({}) })).toBe('one apple')
    expect(format(three, { plural: 5, resolve: resolve({}) })).toBe('5 apples')
    expect(pluralDefault(-1, 2)).toBe(0)
  })

  it('연결 메시지 @:key · @.lower:key', () => {
    const r = resolve({ 'common.name': 'Name', 'a.b': '@:common.name!' })
    expect(format('@:common.name', { resolve: r })).toBe('Name')
    expect(format('@.lower:common.name', { resolve: r })).toBe('name')
    expect(format('x @:a.b', { resolve: r })).toBe('x Name!')
  })
})

describe('i18n 전역', () => {
  it('실제 ko 메시지(관리 제목) — 키·문구 그대로', () => {
    expect(i18n.t('admin.common.headTitle', { page: '사용자', app: 'WS' })).toBe('사용자 · 관리 | WS')
    expect(i18n.t('no.such.key')).toBe('no.such.key')
    expect(i18n.te('common.confirm')).toBe(true)
  })

  it('언어 전환', async () => {
    setMessages('en', { hello: 'Hello {name}' })
    await setLocale('en')
    expect(i18n.locale).toBe('en')
    expect(i18n.t('hello', { name: 'A' })).toBe('Hello A')
    await setLocale('ko')
    expect(i18n.locale).toBe('ko')
  })
})

// i18next 27 · react-i18next 18 로 업그레이드한 뒤에도 유지되어야 하는 동작(2026-11 의존성 업그레이드).
// `t('키', '문구')` 의 두 번째 인자 폴백은 i18next 가 아닌 이 어댑터(translate)가 처리한다 — 엔진 메이저 버전과 무관해야 한다.
describe('t(키, 기본 문구) 폴백 · 언어 전환 재렌더', () => {
  it('없는 키는 두 번째 인자 문구를, 있는 키는 번역을 돌려준다(전역 i18n)', () => {
    expect(i18n.t('no.such.key', '기본 문구')).toBe('기본 문구')
    expect(i18n.t('no.such.key', '')).toBe('')
    expect(i18n.t('common.confirm', '기본 문구')).not.toBe('기본 문구')
    expect(i18n.t('common.confirm', '기본 문구')).toBe(i18n.t('common.confirm'))
    // 객체(중간 노드)에 해당하는 키도 문자열이 아니므로 기본 문구 반환
    expect(i18n.t('common', '기본 문구')).toBe('기본 문구')
  })

  it('useI18n 훅의 t 도 같은 폴백 — 언어가 바뀌면 다시 그려 새 언어로 답한다', async () => {
    setMessages('en', { hello: 'Hello {name}' })
    const { result } = renderHook(() => useI18n())
    expect(result.current.locale).toBe('ko')
    expect(result.current.t('no.such.key', '기본 문구')).toBe('기본 문구')
    expect(result.current.t('hello', '인사')).toBe('인사')
    try {
      await act(async () => { await setLocale('en') })
      expect(result.current.locale).toBe('en')
      expect(result.current.t('hello', { name: 'A' })).toBe('Hello A')
      expect(result.current.t('no.such.key', 'Default text')).toBe('Default text')
    } finally {
      await act(async () => { await setLocale('ko') })
    }
    expect(result.current.locale).toBe('ko')
  })
})
