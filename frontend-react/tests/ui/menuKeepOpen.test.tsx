// 키트 — UiMenu 선택 후 닫힘 규칙(다중 토글은 열린 상태 유지 · radio·실행형은 닫힘)
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { menuKeepsOpen } from '~/components/ui/internal'
import { isMobileStore } from '~/composables/useIsMobile'

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: '메뉴' }))

/** 정렬(radio) + 다중 토글(checkbox) + 실행형이 혼합된 보기 메뉴 */
function ViewMenu(props: { onSelect?: (k: string) => void; closeOnSelect?: boolean; extra?: UiMenuItem[] }) {
  const [sort, setSort] = useState('date')
  const [on, setOn] = useState<Record<string, boolean>>({ ads: false, thread: true })
  return (
    <UiMenu
      closeOnSelect={props.closeOnSelect}
      items={[
        { key: 'date', label: '받은 날짜', radio: true, checked: sort === 'date' },
        { key: 'sender', label: '보낸 사람', radio: true, checked: sort === 'sender' },
        { key: 'ads', label: '광고 숨기기', checked: on.ads, separated: true },
        { key: 'thread', label: '대화로 묶기', checked: on.thread },
        { key: 'refresh', label: '새로 고침', separated: true },
        ...(props.extra ?? []),
      ]}
      onSelect={(k) => {
        props.onSelect?.(k)
        if (k === 'date' || k === 'sender') setSort(k)
        else if (k in on) setOn({ ...on, [k]: !on[k] })
      }}
    />
  )
}

describe('UiMenu 고른 뒤 닫힘 규칙', () => {
  afterEach(() => { isMobileStore.setState({ isMobile: false }) })

  it('다중 토글(checked) 은 열린 채로 여러 개를 연달아 켜고 끈다', () => {
    const onSelect = vi.fn()
    render(<ViewMenu onSelect={onSelect} />)
    openMenu()
    const ads = screen.getByRole('menuitemcheckbox', { name: '광고 숨기기' })
    fireEvent.click(ads)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: '광고 숨기기' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '대화로 묶기' }))
    expect(screen.getByRole('menuitemcheckbox', { name: '대화로 묶기' }).getAttribute('aria-checked')).toBe('false')
    expect(onSelect.mock.calls.map(c => c[0])).toEqual(['ads', 'thread'])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('단일 선택(radio) 은 menuitemradio 이고 고르면 닫힌다', () => {
    render(<ViewMenu />)
    openMenu()
    const sender = screen.getByRole('menuitemradio', { name: '보낸 사람' })
    expect(sender.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sender)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('실행형 항목은 지금처럼 닫힌다', () => {
    render(<ViewMenu />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '새로 고침' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('키보드 Enter/Space 도 같은 규칙(토글은 열린 채·포커스 유지, radio 는 닫힘)', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ViewMenu onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: '메뉴' }))
    screen.getByRole('menuitemcheckbox', { name: '광고 숨기기' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: '광고 숨기기' }))
    await user.keyboard(' ')
    expect(onSelect.mock.calls.map(c => c[0])).toEqual(['ads', 'ads'])
    expect(screen.getByRole('menu')).toBeTruthy()
    screen.getByRole('menuitemradio', { name: '보낸 사람' }).focus()
    await user.keyboard(' ')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('메뉴 closeOnSelect={false} 면 모두 열린 채, 항목 keepOpen:false 가 우선', () => {
    render(<ViewMenu closeOnSelect={false} extra={[{ key: 'done', label: '완료', keepOpen: false }]} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '새로 고침' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '보낸 사람' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '완료' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closeOnSelect={true} 면 토글도 닫히고, 항목 keepOpen:true 는 실행형이어도 열린 채', () => {
    render(<ViewMenu closeOnSelect extra={[{ key: 'more', label: '더 불러오기', keepOpen: true }]} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '더 불러오기' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '광고 숨기기' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('하위 메뉴의 토글 항목도 열린 채', () => {
    const onSelect = vi.fn()
    render(<UiMenu onSelect={onSelect} items={[{ key: 'cols', label: '열', children: [{ key: 'c-size', label: '크기', checked: true }, { key: 'c-run', label: '실행' }] }]} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /열/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '크기' }))
    expect(onSelect).toHaveBeenCalledWith('c-size')
    expect(screen.getByRole('menuitemcheckbox', { name: '크기' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '실행' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('모바일 시트도 같은 규칙', () => {
    isMobileStore.setState({ isMobile: true })
    render(<ViewMenu />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '광고 숨기기' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: '광고 숨기기' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: '보낸 사람' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('규칙 함수: 링크는 늘 닫힘', () => {
    expect(menuKeepsOpen({ key: 'a', label: 'a', checked: true, to: '/x' })).toBe(false)
    expect(menuKeepsOpen({ key: 'a', label: 'a', checked: false })).toBe(true)
    expect(menuKeepsOpen({ key: 'a', label: 'a', checked: false, radio: true })).toBe(false)
    expect(menuKeepsOpen({ key: 'a', label: 'a' }, false)).toBe(true)
  })
})
