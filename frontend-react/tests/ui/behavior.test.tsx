// UI 키트 핵심 동작 — 클릭·v-model(onUpdateModelValue)·모달 ESC·토스트·다이얼로그·탭
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderInRouter } from './helpers'

import { UiButton } from '~/components/ui/Button'
import { UiSwitch } from '~/components/ui/Switch'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiModal } from '~/components/ui/Modal'
import { UiToast } from '~/components/ui/Toast'
import { UiDialogHost } from '~/components/ui/DialogHost'
import { UiTabs } from '~/components/ui/Tabs'
import { UiChip } from '~/components/ui/Chip'
import { UiInput } from '~/components/ui/Input'
import { UiSegment } from '~/components/ui/Segment'
import { UiMenu } from '~/components/ui/Menu'
import { toastStore, addToast, toast, removeToast } from '~/composables/useToast'
import { confirmBox, promptBox, dialogStore } from '~/composables/useDialog'

describe('UiButton', () => {
  it('클릭 이벤트를 부른다', () => {
    const onClick = vi.fn()
    render(<UiButton type="button" onClick={onClick}>저장</UiButton>)
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('as 로 다른 태그를 그린다', () => {
    render(<UiButton as="a" href="/x">링크</UiButton>)
    expect(screen.getByText('링크').tagName).toBe('A')
  })
})

describe('UiSwitch', () => {
  it('클릭하면 onUpdateModelValue(!값)', () => {
    const onUpdate = vi.fn()
    render(<UiSwitch ariaLabel="알림" modelValue={false} onUpdateModelValue={onUpdate} />)
    const sw = screen.getByRole('switch', { name: '알림' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onUpdate).toHaveBeenCalledWith(true)
  })

  it('disabled 면 바꾸지 않는다', () => {
    const onUpdate = vi.fn()
    render(<UiSwitch ariaLabel="알림" disabled onUpdateModelValue={onUpdate} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('modelValue 를 안 주면 스스로 토글한다', () => {
    render(<UiSwitch ariaLabel="알림" />)
    const sw = screen.getByRole('switch')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })
})

describe('UiCheckbox', () => {
  it('체크하면 onUpdateModelValue(true)', () => {
    const onUpdate = vi.fn()
    render(<UiCheckbox label="동의" modelValue={false} onUpdateModelValue={onUpdate} />)
    fireEvent.click(screen.getByLabelText('동의'))
    expect(onUpdate).toHaveBeenCalledWith(true)
  })

  it('제어형으로 값이 따라간다', () => {
    function Wrap() {
      const [v, setV] = useState(false)
      return <UiCheckbox label="동의" modelValue={v} onUpdateModelValue={setV} />
    }
    render(<Wrap />)
    const box = screen.getByLabelText('동의') as HTMLInputElement
    fireEvent.click(box)
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(box.checked).toBe(false)
  })
})

describe('UiModal', () => {
  it('열리면 dialog 를 그리고 ESC 로 onClose', () => {
    const onClose = vi.fn()
    render(<UiModal title="설정" onClose={onClose}><p>본문</p></UiModal>)
    const dlg = screen.getByRole('dialog', { name: '설정' })
    expect(dlg).toBeTruthy()
    fireEvent.keyDown(dlg, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('✕ 버튼·바깥 클릭으로 닫고, persistent 면 바깥 클릭은 무시', () => {
    const onClose = vi.fn()
    const { unmount } = render(<UiModal title="설정" onClose={onClose}>본문</UiModal>)
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    const overlay = screen.getByRole('dialog').parentElement!
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(2)
    unmount()

    const onClose2 = vi.fn()
    render(<UiModal title="설정" persistent onClose={onClose2}>본문</UiModal>)
    fireEvent.click(screen.getByRole('dialog').parentElement!)
    expect(onClose2).not.toHaveBeenCalled()
  })

  it('부모가 조건부로 그렸다 뗀다(열기/닫기)', () => {
    function Wrap() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>열기</button>
          {open && <UiModal title="창" onClose={() => setOpen(false)}>본문</UiModal>}
        </>
      )
    }
    render(<Wrap />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('열기'))
    const dlg = screen.getByRole('dialog', { name: '창' })
    fireEvent.keyDown(dlg, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('UiToast', () => {
  beforeEach(() => { toastStore.getState().toasts.forEach(t => removeToast(t.id)) })

  it('toastStore 의 토스트를 그린다', async () => {
    render(<UiToast />)
    act(() => { addToast('success', '저장했습니다', 0) })
    expect(await screen.findByText('저장했습니다')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('오류는 alert + 닫기 버튼, 같은 오류는 횟수로 합친다', async () => {
    render(<UiToast />)
    act(() => { addToast('error', '연결 실패'); addToast('error', '연결 실패') })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('연결 실패')
    expect(alert.textContent).toContain('2회')
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(toastStore.getState().toasts.length).toBe(0)
    // leave 애니메이션(150ms) 뒤 사라진다
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('행동 버튼을 누르면 실행 후 닫는다', async () => {
    const run = vi.fn()
    render(<UiToast />)
    act(() => { toast({ title: '삭제함', description: '파일 1개', action: { label: '되돌리기', onClick: run } }) })
    fireEvent.click(await screen.findByRole('button', { name: '되돌리기' }))
    expect(run).toHaveBeenCalled()
    await waitFor(() => expect(toastStore.getState().toasts.length).toBe(0))
  })
})

describe('UiDialogHost', () => {
  beforeEach(() => { dialogStore.getState().current?.resolve(false) })

  it('confirmBox 를 그리고 확인 시 true 로 resolve', async () => {
    render(<UiDialogHost />)
    let p!: Promise<boolean>
    act(() => { p = confirmBox('삭제할까요?', { title: '삭제', confirmLabel: '삭제하기' }) })
    expect(await screen.findByText('삭제할까요?')).toBeTruthy()
    // 포커스는 [취소]에서 시작(data-autofocus)
    expect(document.activeElement?.textContent).toBe('취소')
    act(() => { fireEvent.click(screen.getByRole('button', { name: '삭제하기' })) })
    await expect(p).resolves.toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('취소·ESC 는 false', async () => {
    render(<UiDialogHost />)
    let p!: Promise<boolean>
    act(() => { p = confirmBox('계속할까요?') })
    const dlg = await screen.findByRole('dialog')
    act(() => { fireEvent.keyDown(dlg, { key: 'Escape' }) })
    await expect(p).resolves.toBe(false)
  })

  it('promptBox 는 입력값으로 resolve', async () => {
    render(<UiDialogHost />)
    let p!: Promise<string | null>
    act(() => { p = promptBox('이름', { defaultValue: '기본' }) })
    const input = await screen.findByDisplayValue('기본')
    fireEvent.change(input, { target: { value: '새 이름' } })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await expect(p).resolves.toBe('새 이름')
  })
})

describe('UiTabs', () => {
  it('선택 변경 → onUpdateModelValue(key), ←→ 로 이동', () => {
    const onUpdate = vi.fn()
    renderInRouter(
      <UiTabs
        items={[{ key: 'all', label: '전체' }, { key: 'mine', label: '내 것', count: 3 }, { key: 'off', label: '꺼짐', disabled: true }]}
        modelValue="all"
        onUpdateModelValue={onUpdate}
      />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.click(tabs[1])
    expect(onUpdate).toHaveBeenLastCalledWith('mine')
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
    // 꺼진 탭은 건너뛴다 → 'mine'
    expect(onUpdate).toHaveBeenLastCalledWith('mine')
  })

  it('to 탭은 현재 경로로 선택을 판정한다', () => {
    renderInRouter(
      <UiTabs items={[{ key: 'p', label: '프로필', to: '/settings/profile' }, { key: 's', label: '보안', to: '/settings/security' }]} />,
      '/settings/security/2fa',
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].getAttribute('aria-selected')).toBe('false')
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
  })
})

describe('그 밖 v-model', () => {
  it('UiChip 토글 + onClick', () => {
    const onUpdate = vi.fn()
    const onClick = vi.fn()
    render(<UiChip label="안 읽음" modelValue={false} onUpdateModelValue={onUpdate} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: '안 읽음' }))
    expect(onUpdate).toHaveBeenCalledWith(true)
    expect(onClick).toHaveBeenCalled()
  })

  it('UiInput 입력 → onUpdateModelValue(문자열), ref 는 안쪽 input', () => {
    const onUpdate = vi.fn()
    const ref = { current: null as HTMLInputElement | null }
    render(<UiInput ref={ref} label="이름" modelValue="" onUpdateModelValue={onUpdate} />)
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '홍길동' } })
    expect(onUpdate).toHaveBeenCalledWith('홍길동')
    expect(ref.current?.tagName).toBe('INPUT')
  })

  it('UiSegment 클릭 선택', () => {
    const onUpdate = vi.fn()
    render(<UiSegment items={[{ value: 'm', label: '월' }, { value: 'w', label: '주' }]} modelValue="m" onUpdateModelValue={onUpdate} />)
    fireEvent.click(screen.getByRole('radio', { name: '주' }))
    expect(onUpdate).toHaveBeenCalledWith('w')
  })

  it('UiMenu 트리거로 열고 항목 고르기', () => {
    const onSelect = vi.fn()
    render(<UiMenu label="파일 메뉴" items={[{ key: 'rename', label: '이름 바꾸기' }, { key: 'del', label: '삭제', danger: true }]} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: '파일 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }))
    expect(onSelect).toHaveBeenCalledWith('del')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
