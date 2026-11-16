// 문서 제목 스택 — 첫 마운트(직접 진입·새로고침)에도 페이지 제목이 App 의 앱 이름보다 우선해야 한다.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { useHead, _resetHead } from '~/lib/head'

function App({ children }: { children?: ReactNode }) {
  useHead({ title: 'acme' })
  return <>{children}</>
}
function Layout({ children }: { children?: ReactNode }) {
  useHead({}) // 제목 없이 link 만 사용하는 호출(예: 배지 파비콘) — 제목을 가리지 않아야 함
  return <>{children}</>
}
function Page({ title }: { title: string }) {
  useHead({ title })
  return null
}

beforeEach(() => {
  _resetHead()
  document.title = ''
  document.head.querySelectorAll('link[data-head-id]').forEach(el => el.remove())
})

describe('useHead 제목', () => {
  it('첫 마운트에 페이지 제목이 이긴다', () => {
    render(<App><Layout><Page title="파일 | acme" /></Layout></App>)
    expect(document.title).toBe('파일 | acme')
  })

  it('페이지 전환·내려감', () => {
    let setPage: (p: string | null) => void = () => {}
    function Switch() {
      const [p, sp] = useState<string | null>('파일 | acme')
      setPage = sp
      return p ? <Page key={p} title={p} /> : null
    }
    render(<App><Switch /></App>)
    expect(document.title).toBe('파일 | acme')
    act(() => setPage('캘린더 | acme'))
    expect(document.title).toBe('캘린더 | acme')
    act(() => setPage(null))
    expect(document.title).toBe('acme')
  })

  it('제목 변경은 반영되고 순서는 유지', () => {
    const { rerender } = render(<App><Page title="a" /></App>)
    rerender(<App><Page title="b" /></App>)
    expect(document.title).toBe('b')
  })

  it('나중에 마운트된 안쪽 호출(모달 등)이 이긴다', () => {
    const { rerender } = render(<App><Page title="파일" /></App>)
    rerender(<App><Page title="파일" /><Page title="미리보기" /></App>)
    expect(document.title).toBe('미리보기')
  })
})

describe('useHead link', () => {
  function Icon({ href }: { href: string }) {
    useHead({ link: [{ rel: 'icon', href, key: 'dynamic-favicon' }] })
    return null
  }
  it('안쪽 호출의 link 가 <head> 에서 뒤에 온다(첫 마운트에도)', () => {
    function AppIcon({ children }: { children?: ReactNode }) {
      useHead({ link: [{ rel: 'icon', href: '/plain.png', key: 'dynamic-favicon' }] })
      return <>{children}</>
    }
    render(<AppIcon><Icon href="/badged.png" /></AppIcon>)
    const hrefs = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[data-head-id]')).map(l => l.getAttribute('href'))
    expect(hrefs).toEqual(['/plain.png', '/badged.png'])
  })
})
