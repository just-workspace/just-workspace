// 셸 구역 감사 수정 — 공용 부품(Select 포커스 복귀 · 모달 끌어 놓기) · 오류 경계 · 알림(방해 금지·읽음 동기화) · 푸시 이동 주소 · 플러그인 id
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

import { UiSelect } from '~/components/ui/Select'
import { UiModal } from '~/components/ui/Modal'
import { AppErrorBoundary } from '~/components/AppErrorBoundary'
import { toastStore } from '~/composables/useToast'
import { shellStore, setUserMenuOpen, openActivity } from '~/composables/useShell'
import { pushTargetPath } from '~/composables/usePwa'
import { isValidPluginId, loadPlugin } from '~/plugins/pluginHost'
import {
  notificationsStore, handleNotificationEvent, handleNotificationRead, type AppNotification,
} from '~/composables/useNotifications'

const OPTS = [{ value: 'a', label: '가' }, { value: 'b', label: '나' }]

describe('UiSelect — 닫히면 콤보박스 버튼으로 포커스가 돌아온다', () => {
  it('옵션을 고르면', () => {
    const onUpdate = vi.fn()
    render(<UiSelect aria-label="정렬" options={OPTS} modelValue="a" onUpdateModelValue={onUpdate} />)
    const btn = screen.getByRole('combobox')
    fireEvent.click(btn)
    fireEvent.click(screen.getByRole('option', { name: '나' }))
    expect(onUpdate).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('목록에서 Esc 로 닫아도(모달까지 닫지 않고)', () => {
    const onClose = vi.fn()
    render(<UiModal title="설정" onClose={onClose}><UiSelect aria-label="정렬" options={OPTS} modelValue="a" /></UiModal>)
    const btn = screen.getByRole('combobox')
    fireEvent.click(btn)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(btn)
    // 포커스가 모달 안에 있으므로 Esc 가 모달을 닫음
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('UiModal — 스크림 클릭', () => {
  it('안에서 누르기 시작해 스크림에서 떼면 닫지 않는다(글자 끌어 고르기)', () => {
    const onClose = vi.fn()
    render(<UiModal title="새 폴더" onClose={onClose}><input aria-label="이름" /></UiModal>)
    const scrim = screen.getByRole('dialog').parentElement!
    fireEvent.mouseDown(screen.getByLabelText('이름'))
    fireEvent.click(scrim)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('스크림에서 누르고 떼면 닫는다', () => {
    const onClose = vi.fn()
    render(<UiModal title="새 폴더" onClose={onClose}><input aria-label="이름" /></UiModal>)
    const scrim = screen.getByRole('dialog').parentElement!
    fireEvent.mouseDown(scrim)
    fireEvent.click(scrim)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('AppErrorBoundary', () => {
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); toastStore.setState({ toasts: [] }) })
  afterEach(() => { spy.mockRestore() })

  it('렌더 오류가 나면 빈 화면이 아니라 오류 타일을 그리고, 다시 시도로 복구한다', () => {
    let broken = true
    function Page() { if (broken) throw new Error('Cannot read properties of undefined'); return <p>본문</p> }
    renderInRouter(<AppErrorBoundary scope="layout"><Page /></AppErrorBoundary>)
    expect(screen.queryByText('본문')).toBeNull()
    const retry = screen.getAllByRole('button')[0]
    // 사용자에게는 원문(영어) 오류가 아닌 본 프로젝트의 안내 문구 표시
    expect(toastStore.getState().toasts.some(t => t.message.includes('Cannot read'))).toBe(false)
    broken = false
    fireEvent.click(retry)
    expect(screen.getByText('본문')).toBeTruthy()
  })
})

describe('셸 열림 상태', () => {
  it('사용자 메뉴를 열면 활동 패널은 닫힌다(패널이 메뉴 자리를 덮는다)', () => {
    openActivity()
    setUserMenuOpen(true)
    expect(shellStore.getState()).toMatchObject({ userMenuOpen: true, activityOpen: false })
    setUserMenuOpen(false)
    expect(shellStore.getState().userMenuOpen).toBe(false)
  })
})

describe('알림', () => {
  const notif = (id: string, read = false): AppNotification => ({
    id, user_id: 'u', type: 'mention', title: '멘션', body: null, link: '/chat', is_read: read, created_at: new Date().toISOString(),
  })
  let made: string[]
  beforeEach(() => {
    made = []
    class FakeNotification {
      static permission = 'granted'
      onclick: (() => void) | null = null
      constructor(title: string) { made.push(title) }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification)
    notificationsStore.setState({ notifications: [], unreadCount: 0, totalCount: 0, currentTypes: null })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('방해 금지(quiet) 알림은 배지만 올리고 브라우저 알림을 띄우지 않는다', () => {
    handleNotificationEvent(notif('n1'), { quiet: true })
    expect(notificationsStore.getState().unreadCount).toBe(1)
    expect(made).toEqual([])
    handleNotificationEvent(notif('n2'))
    expect(made).toEqual(['멘션'])
  })

  it('다른 기기에서 읽으면 배지를 맞추고, 다 읽었으면 목록도 읽음으로', () => {
    notificationsStore.setState({ notifications: [notif('a'), notif('b')], unreadCount: 2 })
    handleNotificationRead(1)
    expect(notificationsStore.getState().unreadCount).toBe(1)
    expect(notificationsStore.getState().notifications.every(n => !n.is_read)).toBe(true)
    handleNotificationRead(0)
    expect(notificationsStore.getState().unreadCount).toBe(0)
    expect(notificationsStore.getState().notifications.every(n => n.is_read)).toBe(true)
    handleNotificationRead('x')
    expect(notificationsStore.getState().unreadCount).toBe(0)
  })
})

describe('주소 검사', () => {
  it('푸시 알림 이동 주소는 같은 출처 앱 경로만', () => {
    expect(pushTargetPath('/chat?channel=c1')).toBe('/chat?channel=c1')
    for (const bad of ['https://evil.example/', '//evil.example', '/' + String.fromCharCode(92) + 'evil', '/api/auth/logout', 'chat', null, 3]) {
      expect(pushTargetPath(bad)).toBeNull()
    }
  })

  it('플러그인 id 는 영문·숫자·-·_ 만 — 경로를 벗어나는 값은 불러오지 않는다', async () => {
    expect(isValidPluginId('sample-notes')).toBe(true)
    expect(isValidPluginId('../../x')).toBe(false)
    expect(isValidPluginId('a/b')).toBe(false)
    expect(isValidPluginId('')).toBe(false)
    await expect(loadPlugin('../../git/o/r/raw')).rejects.toThrow('invalid plugin id')
  })
})
