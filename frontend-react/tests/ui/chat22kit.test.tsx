// 채팅 키트 — UiSlider · UiTriToggle · UiColorSwatches · UiDatePopover/UiMiniCalendar · UiDragHandle/UiDropLine · UiEmojiGrid · UiMentionList 슬롯
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { UiSlider } from '~/components/ui/Slider'
import { UiTriToggle, type UiTriValue } from '~/components/ui/TriToggle'
import { UiColorSwatches, roleColorToken, ROLE_COLOR_OPTIONS } from '~/components/ui/ColorSwatches'
import { UiDatePopover, UiMiniCalendar, toYmd, fromYmd } from '~/components/ui/DatePopover'
import { UiDragHandle, UiDropLine } from '~/components/ui/DragHandle'
import { UiEmojiGrid, type UiEmojiItem } from '~/components/ui/EmojiGrid'
import { UiMentionList, useUiMentionList } from '~/components/ui/MentionList'
import { iconPaths, ICON_PATHS } from '~/utils/icons'

describe('UiSlider', () => {
  it('aria 값·valuetext·눈금, 키보드 step/Page/Home/End', () => {
    const onUpdate = vi.fn(), onCommit = vi.fn()
    render(<UiSlider ariaLabel="음량" min={0} max={200} step={5} marks={[100]} modelValue={120} onUpdateModelValue={onUpdate} onCommit={onCommit} formatValue={v => `${v}%`} />)
    const s = screen.getByRole('slider', { name: '음량' })
    expect(s.getAttribute('aria-valuenow')).toBe('120')
    expect(s.getAttribute('aria-valuetext')).toBe('120%')
    expect(s.getAttribute('aria-valuemax')).toBe('200')
    expect(s.querySelector('[data-mark="100"]')).toBeTruthy()
    fireEvent.keyDown(s, { key: 'ArrowRight' })
    expect(onUpdate).toHaveBeenLastCalledWith(125)
    expect(onCommit).toHaveBeenLastCalledWith(125)
    fireEvent.keyDown(s, { key: 'PageDown' })
    expect(onUpdate).toHaveBeenLastCalledWith(70)
    fireEvent.keyDown(s, { key: 'End' })
    expect(onUpdate).toHaveBeenLastCalledWith(200)
    fireEvent.keyDown(s, { key: 'Home' })
    expect(onUpdate).toHaveBeenLastCalledWith(0)
  })

  it('비제어: 키로 값이 바뀌고 범위를 넘지 않는다', () => {
    render(<UiSlider ariaLabel="v" min={0} max={10} />)
    const s = screen.getByRole('slider')
    fireEvent.keyDown(s, { key: 'ArrowLeft' })
    expect(s.getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(s, { key: 'ArrowUp' })
    expect(s.getAttribute('aria-valuenow')).toBe('1')
  })
})

describe('UiTriToggle', () => {
  it('radiogroup · 3칸 · 선택 바탕색 · 화살표로 옮기며 고름', () => {
    function Host() {
      const [v, setV] = useState<UiTriValue>('inherit')
      return <UiTriToggle ariaLabel="메시지 보내기" modelValue={v} onUpdateModelValue={setV} />
    }
    render(<Host />)
    expect(screen.getByRole('radiogroup', { name: '메시지 보내기' })).toBeTruthy()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    expect(radios[1].className).toContain('bg-foreground/20')
    expect(radios[1].className).toContain('h-8')
    expect(radios[1].tabIndex).toBe(0)
    expect(radios[0].tabIndex).toBe(-1)
    fireEvent.keyDown(radios[1], { key: 'ArrowRight' })
    expect(screen.getAllByRole('radio')[2].getAttribute('aria-checked')).toBe('true')
    expect(screen.getAllByRole('radio')[2].className).toContain('bg-success/15')
    fireEvent.click(screen.getAllByRole('radio')[0])
    expect(screen.getAllByRole('radio')[0].className).toContain('bg-danger/15')
  })

  it('touch: 44 정사각, 글자는 aria-label 로만', () => {
    render(<UiTriToggle size="touch" ariaLabel="x" modelValue="allow" />)
    const r = screen.getByRole('radio', { name: '허용' })
    expect(r.className).toContain('h-11 w-11')
    expect(r.textContent).toBe('')
  })
})

describe('UiColorSwatches', () => {
  it('8 견본 + 색 없음, 고른 것 체크·ring, 화살표, null 값', () => {
    const onUpdate = vi.fn()
    render(<UiColorSwatches ariaLabel="역할 색" modelValue="success" onUpdateModelValue={onUpdate} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(9)
    expect(radios[2].getAttribute('aria-checked')).toBe('true')
    expect(radios[2].className).toContain('bg-role-3')
    expect(radios[2].className).toContain('ring-2')
    expect(radios[2].querySelector('svg')).toBeTruthy()
    expect(radios[8].className).toContain('border-dashed')
    expect(radios[8].getAttribute('aria-label')).toBe('색 없음')
    fireEvent.keyDown(radios[2], { key: 'ArrowLeft' })
    expect(onUpdate).toHaveBeenLastCalledWith('accent')
    fireEvent.click(radios[8])
    expect(onUpdate).toHaveBeenLastCalledWith(null)
  })

  it('roleColorToken: 백엔드 키 · cat-N · 모르는 값', () => {
    expect(roleColorToken('primary')).toBe('role-1')
    expect(roleColorToken('foreground')).toBe('role-8')
    expect(roleColorToken('cat-5')).toBe('role-5')
    expect(roleColorToken('role-2')).toBe('role-2')
    expect(roleColorToken('nope')).toBeNull()
    expect(roleColorToken(null)).toBeNull()
    expect(ROLE_COLOR_OPTIONS.map(o => o.colorClass)).toEqual(['bg-role-1', 'bg-role-2', 'bg-role-3', 'bg-role-4', 'bg-role-5', 'bg-role-6', 'bg-role-7', 'bg-role-8'])
  })
})

describe('UiMiniCalendar / UiDatePopover', () => {
  it('ymd 도우미', () => {
    expect(toYmd(new Date(2026, 9, 5))).toBe('2026-10-05')
    expect(fromYmd('2026-10-05')?.getDate()).toBe(5)
    expect(fromYmd('bad')).toBeNull()
  })

  it('고른 날 primary · 오늘 ring · 키보드 이동 · 월 이동', () => {
    const onPick = vi.fn()
    render(<UiMiniCalendar value="2026-10-14" today="2026-10-23" onPick={onPick} />)
    const sel = document.querySelector<HTMLElement>('[data-ymd="2026-10-14"]')!
    expect(sel.className).toContain('bg-primary')
    expect(sel.getAttribute('aria-selected')).toBe('true')
    expect(sel.tabIndex).toBe(0)
    const today = document.querySelector<HTMLElement>('[data-ymd="2026-10-23"]')!
    expect(today.className).toContain('ring-primary')
    expect(today.getAttribute('aria-current')).toBe('date')
    expect(screen.getByRole('grid').querySelectorAll('[role=row]').length).toBeGreaterThanOrEqual(5)
    fireEvent.keyDown(sel, { key: 'ArrowDown' })
    expect(document.querySelector<HTMLElement>('[data-ymd="2026-10-21"]')!.tabIndex).toBe(0)
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-ymd="2026-10-21"]')!, { key: 'PageDown' })
    expect(screen.getByText('2026년 11월')).toBeTruthy()
    fireEvent.click(document.querySelector<HTMLElement>('[data-ymd="2026-11-21"]')!)
    expect(onPick).toHaveBeenCalledWith('2026-11-21')
    fireEvent.click(screen.getByRole('button', { name: '이전 달' }))
    expect(screen.getByText('2026년 10월')).toBeTruthy()
  })

  it('min/max 밖은 고를 수 없다', () => {
    const onPick = vi.fn()
    render(<UiMiniCalendar today="2026-10-23" max="2026-10-23" onPick={onPick} />)
    const d = document.querySelector<HTMLElement>('[data-ymd="2026-10-24"]')!
    expect(d.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(d)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('팝오버: body 포털 · 고르면 onPick + 닫기 · Esc 닫기', () => {
    const onPick = vi.fn(), onClose = vi.fn()
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const { rerender } = render(<UiDatePopover open anchor={anchor} today="2026-10-23" onPick={onPick} onClose={onClose} />)
    const dlg = screen.getByRole('dialog', { name: '날짜 고르기' })
    expect(dlg.parentElement).toBe(document.body)
    expect(dlg.className).toContain('fixed')
    fireEvent.click(document.querySelector<HTMLElement>('[data-ymd="2026-10-10"]')!)
    expect(onPick).toHaveBeenCalledWith('2026-10-10')
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(dlg, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    rerender(<UiDatePopover open={false} anchor={anchor} onPick={onPick} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    anchor.remove()
  })
})

describe('UiDragHandle / UiDropLine', () => {
  it('이름 "순서 바꾸기" · ↑↓ = onMove · hoverOnly', () => {
    const onMove = vi.fn()
    render(<UiDragHandle hoverOnly onMove={onMove} />)
    const b = screen.getByRole('button', { name: '순서 바꾸기' })
    expect(b.className).toContain('opacity-0')
    expect(b.className).toContain('group-hover:opacity-100')
    fireEvent.keyDown(b, { key: 'ArrowUp' })
    fireEvent.keyDown(b, { key: 'ArrowDown' })
    expect(onMove.mock.calls).toEqual([[-1], [1]])
  })
  it('자리 선은 aria-hidden, 2px primary + 8px 원', () => {
    const { container } = render(<UiDropLine />)
    const el = container.querySelector('[data-drop-line]')!
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.innerHTML).toContain('h-0.5')
    expect(el.innerHTML).toContain('h-2 w-2')
  })
})

describe('UiEmojiGrid', () => {
  const items: UiEmojiItem[] = [
    ...'👍 👀 🎉 🔥 ✅ 🙏 😂 ❤️ 🚀 💯 🤔'.split(' ').map(g => ({ key: g, glyph: g, label: g })),
    { key: ':otter:', imageUrl: '/e/otter.gif', label: ':otter:', custom: true, animated: true },
  ]

  it('grid → row(열 수) → gridcell, 셀 40, 커스텀 primary/10 · GIF', () => {
    render(<UiEmojiGrid ariaLabel="자주 쓴" items={items} columns={9} onPick={() => {}} />)
    const grid = screen.getByRole('grid', { name: '자주 쓴' })
    expect(grid.querySelectorAll('[role=row]')).toHaveLength(2)
    const cells = screen.getAllByRole('gridcell')
    expect(cells[0].className).toContain('h-10')
    expect(cells[0].tabIndex).toBe(0)
    const otter = screen.getByRole('gridcell', { name: ':otter:' })
    expect(otter.className).toContain('bg-primary/10')
    expect(otter.textContent).toContain('GIF')
    expect(otter.querySelector('img')).toBeTruthy()
  })

  it('화살표 이동 · onActive · Enter = onPick · 첫 줄 ↑ = onExit', () => {
    const onPick = vi.fn(), onActive = vi.fn(), onExit = vi.fn()
    render(<UiEmojiGrid items={items} columns={9} onPick={onPick} onActive={onActive} onExit={onExit} />)
    const cells = () => screen.getAllByRole('gridcell')
    fireEvent.keyDown(cells()[0], { key: 'ArrowRight' })
    expect(onActive).toHaveBeenLastCalledWith(items[1], 1)
    expect(cells()[1].className).toContain('bg-foreground/20')
    expect(cells()[1].className).toContain('ring-2')
    fireEvent.keyDown(cells()[1], { key: 'ArrowDown' })
    expect(onActive).toHaveBeenLastCalledWith(items[10], 10)
    fireEvent.keyDown(cells()[10], { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(items[10], expect.anything())
    fireEvent.keyDown(cells()[10], { key: 'ArrowUp' })
    fireEvent.keyDown(cells()[1], { key: 'ArrowUp' })
    expect(onExit).toHaveBeenCalledWith('up', 1)
  })

  it('touch: 44 · 기본 8열', () => {
    render(<UiEmojiGrid size="touch" items={items} onPick={() => {}} />)
    expect(screen.getAllByRole('gridcell')[0].className).toContain('h-11')
    expect(screen.getByRole('grid').querySelectorAll('[role=row]')[0].children).toHaveLength(8)
  })
})

describe('UiMentionList 슬롯(trailing · disabled · disabledReason · leading)', () => {
  it('꼬리표·이유를 그리고 비활성 행은 클릭·Enter 로 안 골라진다', () => {
    const onPick = vi.fn()
    function Host() {
      const opts = [
        { id: 'a', label: '디자인', trailing: <span>역할</span> },
        { id: 'b', label: '경영진', disabled: true, disabledReason: '멘션할 수 없는 역할', leading: <span data-testid="lead">●</span> },
      ]
      const m = useUiMentionList({ count: opts.length, open: true, onPick, onClose: () => {}, isDisabled: i => !!opts[i].disabled })
      return (
        <div className="relative">
          <UiMentionList id={m.id} options={opts} activeIndex={m.active} onActiveChange={m.setActive} onPick={m.pick} />
          <input aria-label="입력" {...m.inputProps} onKeyDown={e => { m.onKeyDown(e) }} />
        </div>
      )
    }
    render(<Host />)
    expect(screen.getByText('역할')).toBeTruthy()
    expect(screen.getByText('멘션할 수 없는 역할')).toBeTruthy()
    expect(screen.getByTestId('lead')).toBeTruthy()
    const rows = screen.getAllByRole('option')
    expect(rows[1].getAttribute('aria-disabled')).toBe('true')
    fireEvent.mouseDown(rows[1])
    expect(onPick).not.toHaveBeenCalled()
    const input = screen.getByRole('combobox', { name: '입력' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(0)
  })
})

describe('아이콘', () => {
  it('새 이름은 고유 경로, messages-square 는 chat 별칭이 아니다', () => {
    for (const n of ['smile-plus', 'messages-square', 'grip-vertical', 'play', 'pause', 'slash']) expect(ICON_PATHS[n]).toBeTruthy()
    expect(iconPaths('messages-square')).not.toBe(ICON_PATHS.chat)
  })
})
