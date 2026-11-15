// UiSegment — 툴팁 있는 비활성 칸(handover 16 답 9 "이 화면에서는 너무 큽니다")
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UiSegment } from '~/components/ui/Segment'

describe('UiSegment tooltip + disabled', () => {
  it('툴팁 있는 비활성 칸은 aria-disabled 로 남고 눌러도 안 바뀜', () => {
    const on = vi.fn()
    render(<UiSegment ariaLabel="크기" modelValue="auto" onUpdateModelValue={on} items={[
      { value: 'auto', label: '자동' },
      { value: 300, label: '300%', disabled: true, tooltip: '이 화면에서는 너무 큽니다' },
      { value: 100, label: '100%', disabled: true },
    ]} />)
    const big = screen.getByRole('radio', { name: '300%' })
    expect(big.getAttribute('aria-disabled')).toBe('true')
    expect((big as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(big)
    expect(on).not.toHaveBeenCalled()
    // 툴팁 없는 비활성은 예전처럼 disabled
    expect((screen.getByRole('radio', { name: '100%' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
