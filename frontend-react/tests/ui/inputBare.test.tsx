// R5 키트 — UiInput variant="bare"(검색 줄)
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { UiInput } from '~/components/ui/Input'

describe('UiInput variant="bare"', () => {
  it('테두리·배경·링 없음, 높이 44, 바깥 줄이 focus-within:bg-accent', () => {
    const { container } = render(<UiInput variant="bare" icon="search" placeholder="검색" className="border-b border-border" />)
    const input = screen.getByPlaceholderText('검색')
    expect(input.className).toContain('h-11')
    expect(input.className).toContain('border-0')
    expect(input.className).toContain('bg-transparent')
    expect(input.className).not.toContain('ring')
    expect(input.className).not.toContain('bg-background')
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain('focus-within:bg-accent')
    expect(row.className).toContain('border-b')
  })

  it('기본 변형은 그대로(테두리 상자 · 포커스 링 · 줄 배경 없음)', () => {
    const { container } = render(<UiInput placeholder="이름" />)
    const input = screen.getByPlaceholderText('이름')
    expect(input.className).toContain('border-input')
    expect(input.className).toContain('focus:ring-2')
    expect(input.className).toContain('h-10')
    expect((container.firstElementChild as HTMLElement).className).not.toContain('focus-within:bg-accent')
  })
})
