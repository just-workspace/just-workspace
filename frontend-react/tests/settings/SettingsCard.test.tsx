// SettingsCard(토대 공용 — 설정·관리·AI·메일 설정이 공용으로 사용) 렌더·저장 모델
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { isMobileStore } from '~/composables/useIsMobile'
import { getSharedState, resetSharedState } from '~/lib/state'

describe('SettingsCard', () => {
  it('제목·설명·본문, 변경 없으면 저장 비활성', () => {
    render(<SettingsCard title="프로필" description="설명" changes={0}>본문</SettingsCard>)
    expect(screen.getByText('프로필')).toBeTruthy()
    expect(screen.getByText('설명')).toBeTruthy()
    expect(screen.getByText('본문')).toBeTruthy()
    const save = screen.getByRole('button', { name: '저장' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('변경 있으면 저장·되돌리기 이벤트', () => {
    const onSave = vi.fn(); const onReset = vi.fn()
    render(<SettingsCard title="T" changes={2} onSave={onSave} onReset={onReset}>x</SettingsCard>)
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    fireEvent.click(screen.getByRole('button', { name: '변경 취소' }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('모바일 하단 바는 탭바를 숨기는 신호를 올리고, 언마운트 때 내린다', () => {
    resetSharedState()
    isMobileStore.setState({ isMobile: true })
    const { unmount } = render(<SettingsCard title="T" changes={1} mobileBar="full">x</SettingsCard>)
    expect(getSharedState('mobile-detail-open')).toBe(true)
    unmount()
    expect(getSharedState('mobile-detail-open')).toBe(false)
    isMobileStore.setState({ isMobile: false })
  })
})
