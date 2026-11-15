// "소스 코드" 링크 — 서버가 준 주소로, 새 창에서, 주소가 없거나 http(s) 가 아니면 숨긴다. 로그인 화면 바닥글에도 보인다.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceNotice, safeSourceUrl } from '~/components/SourceNotice'
import { AuthShell } from '~/components/auth/AuthShell'
import { siteConfigStore } from '~/composables/useSiteConfig'
import { setLocale } from '~/i18n'

const URL = 'https://git.example.com/acme/workspace'

beforeAll(async () => { await setLocale('ko') })
beforeEach(() => {
  siteConfigStore.setState({ sourceUrl: URL, license: 'AGPL-3.0-or-later', config: {} } as any)
})

describe('SourceNotice', () => {
  it('설명 한 줄과 새 창으로 여는 링크', () => {
    render(<SourceNotice />)
    const link = screen.getByRole('link', { name: '소스 코드' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByTestId('source-notice').textContent).toContain('AGPL-3.0-or-later')
  })

  it('주소가 없거나 http(s) 가 아니면 그리지 않는다', () => {
    for (const bad of ['', 'javascript:alert(1)', 'ftp://git.example.com/x', 'https://a b']) {
      siteConfigStore.setState({ sourceUrl: bad } as any)
      const view = render(<SourceNotice />)
      expect(view.queryByTestId('source-notice')).toBeNull()
      view.unmount()
    }
    expect(safeSourceUrl(` ${URL} `)).toBe(URL)
    expect(safeSourceUrl(null)).toBe('')
  })

  it('로그인 화면의 틀(AuthShell) 바닥에 작게 보인다', () => {
    render(<AuthShell><form aria-label="로그인" /></AuthShell>)
    const note = screen.getByTestId('source-notice')
    expect(note.querySelector('a')?.getAttribute('href')).toBe(URL)
    expect(note.textContent).toContain('AGPL-3.0-or-later')
  })
})
