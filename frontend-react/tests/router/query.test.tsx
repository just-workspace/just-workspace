// 쿼리 직렬화 — vue-router(4.x) 와 동일한 주소 형태인지, 기존 링크·딥링크 파싱이 유지되는지 검증.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { createBrowserRouter, createMemoryRouter, RouterProvider } from 'react-router'
import {
  stringifyQuery, parseQuery, normalizeSearch, resolve, setAppRouter, navigateTo, useRoute,
} from '~/lib/router'
import { NuxtLink } from '~/components/NuxtLink'

afterEach(() => { setAppRouter(null); window.history.replaceState(null, '', '/') })

describe('stringifyQuery (vue-router 규칙)', () => {
  it('/ = ? : @ , 는 그대로 둔다', () => {
    expect(stringifyQuery({ path: 'my/QA-parity' })).toBe('path=my/QA-parity')
    expect(stringifyQuery({ compose: 'mode=new' })).toBe('compose=mode=new')
    expect(stringifyQuery({ redirect: '/a?b=c' })).toBe('redirect=/a?b=c')
    expect(stringifyQuery({ v: 'a:b@c,d;e$' })).toBe('v=a:b@c,d;e$')
  })
  it('& # + 공백은 인코딩(공백은 +)', () => {
    expect(stringifyQuery({ q: 'a&b' })).toBe('q=a%26b')
    expect(stringifyQuery({ q: 'a#b' })).toBe('q=a%23b')
    expect(stringifyQuery({ q: 'a+b c' })).toBe('q=a%2Bb+c')
    expect(stringifyQuery({ q: '100%' })).toBe('q=100%25')
  })
  it('키의 = 는 인코딩, | [ ] { } ^ ` 는 그대로', () => {
    expect(stringifyQuery({ 'a=b': '1' })).toBe('a%3Db=1')
    expect(stringifyQuery({ q: '|[]{}^`' })).toBe('q=|[]{}^`')
  })
  it('한글은 UTF-8 퍼센트 인코딩', () => {
    expect(stringifyQuery({ path: 'my/메모.txt' })).toBe('path=my/%EB%A9%94%EB%AA%A8.txt')
  })
  it('null 은 키만, undefined 는 생략, 배열은 반복', () => {
    expect(stringifyQuery({ a: null, b: undefined, c: ['1', null, undefined, '2'] })).toBe('a&c=1&c&c=2')
    expect(stringifyQuery({ n: 0, e: '' })).toBe('n=0&e=')
  })
})

describe('파싱 회귀(예전 encodeURIComponent 링크도 같은 값)', () => {
  it('%2F 와 / 는 같은 값', () => {
    expect(parseQuery('?path=my%2FQA-parity')).toEqual({ path: 'my/QA-parity' })
    expect(parseQuery('?path=my/QA-parity')).toEqual({ path: 'my/QA-parity' })
  })
  it('+ 는 공백, %2B 는 +', () => {
    expect(parseQuery('q=a%2Bb+c')).toEqual({ q: 'a+b c' })
  })
  it('직렬화 왕복이 값을 보존', () => {
    const q = { path: 'my/a b&c#d+e=f?g', x: ['1', '2'], k: null }
    expect(parseQuery(stringifyQuery(q))).toEqual(q)
  })
  it('normalizeSearch', () => {
    expect(normalizeSearch('?path=my%2FQA-parity')).toBe('?path=my/QA-parity')
    expect(normalizeSearch('?compose=mode%3Dnew')).toBe('?compose=mode=new')
    expect(normalizeSearch('')).toBe('')
    expect(normalizeSearch('?')).toBe('')
  })
})

describe('resolve', () => {
  it('문자열 주소의 쿼리도 정규화(해시는 유지)', () => {
    const r = resolve('/files?path=my%2FQA-parity#x')
    expect(r.fullPath).toBe('/files?path=my/QA-parity#x')
    expect(r.query).toEqual({ path: 'my/QA-parity' })
  })
  it('객체 주소', () => {
    expect(resolve({ path: '/office/open', query: { path: 'my/a.txt' } }).fullPath).toBe('/office/open?path=my/a.txt')
    expect(resolve({ path: '/mail', query: { compose: 'mode=new' } }).fullPath).toBe('/mail?compose=mode=new')
  })
})

function ShowQuery() {
  const route = useRoute()
  return <div data-testid="q">{JSON.stringify(route.query)}|{route.fullPath}</div>
}

describe('딥링크·이동', () => {
  it('딥링크 진입: 값은 그대로 읽고 주소창은 vue-router 모양으로 바꾼다', async () => {
    window.history.replaceState(null, '', '/files?path=my%2FQA-parity')
    const router = createBrowserRouter([{ path: '*', element: <ShowQuery /> }])
    setAppRouter(router)
    render(<RouterProvider router={router} />)
    expect(screen.getByTestId('q').textContent).toContain('{"path":"my/QA-parity"}')
    expect(window.location.pathname + window.location.search).toBe('/files?path=my/QA-parity')
    router.dispose()
  })

  it('navigateTo(문자열) 도 같은 모양', async () => {
    const router = createMemoryRouter([{ path: '*', element: <ShowQuery /> }], { initialEntries: ['/'] })
    setAppRouter(router)
    render(<RouterProvider router={router} />)
    await act(async () => { await navigateTo(`/files?path=${encodeURIComponent('my/a b')}`) })
    expect(router.state.location.pathname + router.state.location.search).toBe('/files?path=my/a+b')
    expect(screen.getByTestId('q').textContent).toContain('{"path":"my/a b"}')
  })

  it('NuxtLink 문자열 href 도 정규화', () => {
    const router = createMemoryRouter([{ path: '*', element: <NuxtLink to="/files?path=my%2Fx">go</NuxtLink> }])
    render(<RouterProvider router={router} />)
    expect(screen.getByText('go').getAttribute('href')).toBe('/files?path=my/x')
  })
})
