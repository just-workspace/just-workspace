// 키트 — UiTextarea autoGrow + maxRows(프롬프트 입력)
// 높이 = 내용(1~maxRows 줄), 포커스와 무관 — 포커스만으로 maxRows 까지 펼치지 않는다. 비면 1줄.
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { UiTextarea } from '~/components/ui/Textarea'

const setScrollHeight = (ta: HTMLTextAreaElement, h: number) =>
  Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => h })

describe('UiTextarea autoGrow', () => {
  it('비면 1줄 44 — 포커스해도 펼치지 않고, 포커스가 빠져도 그대로', () => {
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    render(<UiTextarea autoGrow maxRows={4} placeholder="프롬프트" onFocus={onFocus} onBlur={onBlur} />)
    const ta = screen.getByPlaceholderText('프롬프트') as HTMLTextAreaElement
    expect(ta.getAttribute('rows')).toBe('1')
    expect(ta.style.height).toBe('44px')
    expect(ta.dataset.expanded).toBe('false')
    fireEvent.focus(ta)
    expect(ta.style.height).toBe('44px')
    expect(ta.dataset.expanded).toBe('false')
    fireEvent.blur(ta)
    expect(ta.style.height).toBe('44px')
    // 포커스·블러 콜백은 그대로 넘어간다
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onBlur).toHaveBeenCalledTimes(1)
  })

  it('내용 높이만큼 자라고(포커스 무관) 포커스가 빠져도 내용 높이 유지 · 넘치면 maxRows 에서 멈추고 안에서 스크롤', () => {
    render(<UiTextarea autoGrow placeholder="p" />)
    const ta = screen.getByPlaceholderText('p') as HTMLTextAreaElement
    fireEvent.focus(ta)
    // 두 줄 — 내용 62 + 테두리 2
    setScrollHeight(ta, 62)
    fireEvent.change(ta, { target: { value: '한 줄\n두 줄' } })
    expect(ta.style.height).toBe('64px')
    expect(ta.style.overflowY).toBe('hidden')
    expect(ta.dataset.expanded).toBe('true')
    fireEvent.blur(ta)
    expect(ta.style.height).toBe('64px')
    // 기본 maxRows 6 — 줄 20 × 6 + 패딩 22 + 테두리 2 = 144 에서 멈춤
    setScrollHeight(ta, 300)
    fireEvent.change(ta, { target: { value: '한 줄\n두 줄\n세 줄\n네 줄\n다섯\n여섯\n일곱\n여덟' } })
    expect(ta.style.height).toBe('144px')
    expect(ta.style.overflowY).toBe('auto')
    // 다 지우면 1줄
    setScrollHeight(ta, 42)
    fireEvent.change(ta, { target: { value: '' } })
    expect(ta.style.height).toBe('44px')
    expect(ta.style.overflowY).toBe('hidden')
    expect(ta.dataset.expanded).toBe('false')
  })

  it('처음부터 내용이 있으면 내용 높이(포커스 전)', () => {
    const { rerender } = render(<UiTextarea autoGrow maxRows={4} placeholder="m" modelValue="" />)
    const ta = screen.getByPlaceholderText('m') as HTMLTextAreaElement
    setScrollHeight(ta, 82)
    rerender(<UiTextarea autoGrow maxRows={4} placeholder="m" modelValue={'a\nb\nc'} />)
    expect(ta.style.height).toBe('84px')
  })

  it('autoGrow 없으면 rows 그대로·높이 손대지 않음, ref 는 textarea', () => {
    let el: HTMLTextAreaElement | null = null
    render(<UiTextarea rows={3} placeholder="q" ref={(n) => { el = n }} />)
    const ta = screen.getByPlaceholderText('q') as HTMLTextAreaElement
    expect(ta.getAttribute('rows')).toBe('3')
    expect(ta.style.height).toBe('')
    expect(ta.dataset.expanded).toBeUndefined()
    expect(el).toBe(ta)
  })
})
