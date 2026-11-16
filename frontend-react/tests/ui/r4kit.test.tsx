// 키트 추가분 — 부품의 렌더·키보드 동작
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiModal } from '~/components/ui/Modal'

describe('UiRadioCard layout="row"', () => {
  it('점 · 제목 · 설명 · meta 를 한 줄로 그리고 선택 시 border-primary bg-primary/5', () => {
    const onUpdate = vi.fn()
    render(<UiRadioCard layout="row" value="a" title="이 일정만" description="다른 반복은 그대로" meta="10/17" modelValue="b" onUpdateModelValue={onUpdate} />)
    const r = screen.getByRole('radio', { name: /이 일정만/ })
    expect(r.className).toContain('h-14')
    expect(r.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('다른 반복은 그대로').className).toContain('truncate')
    expect(screen.getByText('10/17')).toBeTruthy()
    fireEvent.click(r)
    expect(onUpdate).toHaveBeenCalledWith('a')
  })

  it('선택된 행 표시와 metaSlot', () => {
    render(<UiRadioCard layout="row" value="a" title="T" modelValue="a" metaSlot={<b>배지</b>} meta="안보임" />)
    const r = screen.getByRole('radio')
    expect(r.getAttribute('aria-checked')).toBe('true')
    expect(r.className).toContain('border-primary')
    expect(r.className).toContain('bg-primary/5')
    expect(screen.getByText('배지')).toBeTruthy()
    expect(screen.queryByText('안보임')).toBeNull()
  })
})

describe('UiModal confirm size', () => {
  it('확인형 기본은 384(max-w-sm)', () => {
    render(<UiModal confirm title="삭제" onClose={() => {}}>본문</UiModal>)
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-sm')
  })
  it("확인형도 size='400' 을 받는다", () => {
    render(<UiModal confirm size="400" title="반복 일정 삭제" onClose={() => {}}>본문</UiModal>)
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-[400px]')
  })
  it('폼형 기본은 md 그대로', () => {
    render(<UiModal title="폼" onClose={() => {}}>본문</UiModal>)
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-md')
  })
  it("고르기 창 size='680' — lg 는 512 그대로", () => {
    const { unmount } = render(<UiModal size="680" title="고르기" onClose={() => {}}>본문</UiModal>)
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-[680px]')
    unmount()
    render(<UiModal size="lg" title="폼" onClose={() => {}}>본문</UiModal>)
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-lg')
  })
})

import { UiTrans, transNodes } from '~/components/ui/Trans'
import { UiButton } from '~/components/ui/Button'
import { setMessages } from '~/i18n'
import ko from '~/i18n/locales/ko.json'

describe('UiTrans', () => {
  const fmt = (msg: string) => (named: Record<string, string>) => msg.replace(/\{(\/?\w+)\}/g, (_, k) => named[k] ?? '')

  it('{open}…{/open} 감싸는 태그에 함수 슬롯을 안쪽 글자로 부른다', () => {
    const { container } = render(<p>{transNodes(fmt('느리면 {open}미리보기로 열기{/open} 하세요'), { open: (t) => <a>{t}</a> })}</p>)
    expect(container.innerHTML).toBe('<p>느리면 <a>미리보기로 열기</a> 하세요</p>')
  })

  it('{link} 자리 표시자(닫는 태그 없음)는 노드를 그 자리에 둔다', () => {
    const { container } = render(<p>{transNodes(fmt('줄 {one} 범위 {range}.'), { one: <b>#L1</b>, range: <i>#L1-L2</i> })}</p>)
    expect(container.innerHTML).toBe('<p>줄 <b>#L1</b> 범위 <i>#L1-L2</i>.</p>')
  })

  it('중첩 태그와 섞인 자리 표시자', () => {
    const { container } = render(<p>{transNodes(fmt('{a}앞 {b}굵게{/b} 뒤{/a} {n}'), { a: (c) => <u>{c}</u>, b: (c) => <b>{c}</b>, n: <i>3</i> })}</p>)
    expect(container.innerHTML).toBe('<p><u>앞 <b>굵게</b> 뒤</u> <i>3</i></p>')
  })

  it('실제 번역 키 + values + 버튼 슬롯', () => {
    setMessages('ko', { ...(ko as Record<string, unknown>), __r4: { slow: '{name}님, {open}미리보기로 열기{/open} 를 누르세요', cnt: '파일 없음 | 파일 {n}개 {b}보기{/b}' } })
    const onClick = vi.fn()
    render(<UiTrans k="__r4.slow" as="p" values={{ name: '민지' }} slots={{ open: (t) => <UiButton variant="link" size="xs" onClick={onClick}>{t}</UiButton> }} />)
    const btn = screen.getByRole('button', { name: '미리보기로 열기' })
    expect(btn.closest('p')!.textContent).toBe('민지님, 미리보기로 열기 를 누르세요')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalled()
  })

  it('count 로 복수형을 고른다', () => {
    render(<UiTrans k="__r4.cnt" as="span" count={3} values={{ n: 3 }} slots={{ b: (t) => <b>{t}</b> }} />)
    expect(screen.getByText('보기').tagName).toBe('B')
    expect(screen.getByText('보기').parentElement!.textContent).toBe('파일 3개 보기')
  })

  it('as 가 없으면 감싸지 않는다', () => {
    const { container } = render(<div><UiTrans k="__r4.slow" values={{ name: 'A' }} slots={{ open: (t) => <i>{t}</i> }} /></div>)
    expect(container.firstElementChild!.innerHTML).toBe('A님, <i>미리보기로 열기</i> 를 누르세요')
  })
})

import { UiAppRail } from '~/components/ui/AppRail'
import { UiTopbar } from '~/components/ui/Topbar'
import { UiTabbar } from '~/components/ui/Tabbar'
import { renderInRouter } from './helpers'

describe('UiAppRail', () => {
  const groups = [
    { key: 'h', items: [{ id: 'home', label: '홈', icon: 'home', to: '/', active: true }] },
    { key: 'talk', label: '소통', items: [
      { id: 'chat', label: '채팅', icon: 'chat', to: '/chat', badge: 120, ariaLabel: '채팅 — 120' },
      { id: 'meetings', label: '회의', icon: 'video', to: '/meetings', live: true },
    ] },
  ]
  it('라우터 없이도 props 만으로 그린다(디자인 툴) — 활성·배지 99+·live 점', () => {
    render(<UiAppRail groups={groups} brand={{ name: 'Workspace' }} avatar={<span>아바타</span>} />)
    const home = screen.getByRole('link', { name: '홈' })
    expect(home.getAttribute('aria-current')).toBe('page')
    expect(home.getAttribute('href')).toBe('/')
    expect(screen.getByRole('link', { name: '채팅 — 120' }).textContent).toContain('99+')
    expect(screen.getByRole('img', { name: '통화 중' })).toBeTruthy()
    expect(screen.getByText('아바타')).toBeTruthy()
    // 레일: 묶음 머리글 대신 구분선
    expect(screen.queryByText('소통')).toBeNull()
  })
  it('wide 면 머리글·이름·footerAction, 누르면 onNavigate', () => {
    const onNav = vi.fn()
    renderInRouter(<UiAppRail wide groups={groups} avatar={<span>A</span>} userName="하나" footerAction={<button>고정</button>} onNavigate={onNav} />)
    expect(screen.getByText('소통')).toBeTruthy()
    expect(screen.getByText('하나')).toBeTruthy()
    expect(screen.getByRole('button', { name: '고정' })).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '회의' }))
    expect(onNav).toHaveBeenCalledWith(expect.objectContaining({ id: 'meetings' }), expect.anything())
  })
  it('접힘·펼침에서 아이콘 자리가 같다 — 아이콘 칸·행 여백·머리글 칸의 클래스가 wide 와 무관', () => {
    // 좌표는 jsdom 이 측정할 수 없으므로 "자리를 정하는 클래스가 두 모습에서 같다"로 검증한다(가운데 정렬·폭별 여백이 재도입되면 실패)
    const shape = (wide: boolean) => {
      const { container, unmount } = render(<UiAppRail wide={wide} groups={groups} brand={{ name: 'Workspace' }} avatar={<span>A</span>} userName="하나" footerAction={<button>고정</button>} />)
      const links = [...container.querySelectorAll('nav a')]
      const layout = (el: Element) => [...el.classList].filter(c => /^(p[xlr]?-|gap-|justify-|h-|w-|m[xlr]?-)/.test(c)).sort().join(' ')
      const out = {
        rows: links.map(layout),
        slots: links.map(a => a.querySelector('[data-rail-slot]')!.className),
        slotFirst: links.map(a => a.querySelector('[data-rail-slot]') === a.querySelector(':scope > span:not(.absolute)')),
        heads: [...container.querySelectorAll('[data-rail-head]')].map(h => h.className),
        brand: layout(container.querySelector('aside > a')!),
        footer: layout(container.querySelector('aside > div:last-child')!),
        aside: layout(container.querySelector('aside')!).replace(/w-sidebar(-rail)?/, 'w-*'),
      }
      unmount()
      return out
    }
    const rail = shape(false), wide = shape(true)
    expect(wide).toEqual(rail)
    expect(rail.slots).toHaveLength(3)
    expect(rail.slotFirst.every(Boolean)).toBe(true)
    expect(rail.heads).toHaveLength(1)
    expect(rail.rows.join(' ')).not.toContain('justify-center')
    expect(rail.footer).not.toContain('justify-center')
  })
})

describe('UiTopbar', () => {
  it('경로 3단·검색·벨 배지·아바타', () => {
    const onSearch = vi.fn(), onBell = vi.fn(), onAvatar = vi.fn(), onPin = vi.fn()
    render(<UiTopbar crumbs={['워크스페이스', '메일', '받은편지함']} onTogglePin={onPin} onSearch={onSearch} onBell={onBell} bellCount={7}
      user={{ name: '하나', status: 'online' }} onAvatarClick={onAvatar} actions={<button>확장</button>} />)
    const nav = screen.getByRole('navigation')
    expect(nav.textContent).toBe('워크스페이스/메일/받은편지함')
    expect(screen.getByText('받은편지함').className).toContain('font-semibold')
    fireEvent.click(screen.getAllByRole('button', { name: /이동|검색/ })[0]); expect(onSearch).toHaveBeenCalled()
    const bell = screen.getByRole('button', { name: /활동/ })
    expect(bell.textContent).toContain('7')
    fireEvent.click(bell); expect(onBell).toHaveBeenCalled()
    const av = screen.getByRole('button', { name: /하나/ })
    expect(av.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(av); expect(onAvatar).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '확장' })).toBeTruthy()
  })
  it('모바일은 제목 한 줄, 벨·고정 버튼 없음', () => {
    render(<UiTopbar mobile crumbs={['워크스페이스', '메일']} onTogglePin={() => {}} onBell={() => {}} />)
    expect(screen.getByRole('heading', { name: '메일' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /활동/ })).toBeNull()
  })
})

describe('UiTabbar', () => {
  it('활성·배지·점, 누르면 onSelect(id)', () => {
    const onSelect = vi.fn()
    render(<UiTabbar onSelect={onSelect} tabs={[
      { id: 'home', label: '홈', icon: 'home', active: true },
      { id: 'chat', label: '채팅', icon: 'chat', badge: 6 },
      { id: 'mail', label: '메일', icon: 'mail', dot: true },
      { id: 'all', label: '전체', icon: 'grid', buttonProps: { 'aria-haspopup': 'dialog' } },
    ]} />)
    expect(screen.getByRole('button', { name: '홈' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: '채팅 — 6' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '안 읽음' })).toBeTruthy()
    const all = screen.getByRole('button', { name: '전체' })
    expect(all.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(all); expect(onSelect).toHaveBeenCalledWith('all')
  })
})

import { UiToast } from '~/components/ui/Toast'
import { toast as pushToast, toastStore } from '~/composables/useToast'
import { act } from '@testing-library/react'
import { cn } from '~/lib/utils'

describe('토스트 행동 버튼 · 빗금 유틸', () => {
  it('행동형 토스트: 6초 기본, 반전 강조색 링크 버튼', () => {
    toastStore.setState({ toasts: [] })
    const onClick = vi.fn()
    render(<UiToast />)
    act(() => { pushToast({ title: '#개발 통화에서 나왔습니다', description: '12분 · 아직 3명', action: { label: '다시 참여', onClick } }) })
    expect(toastStore.getState().toasts[0].duration).toBe(6000)
    const btn = screen.getByRole('button', { name: '다시 참여' })
    expect(btn.className).toContain('text-primary-inverse')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalled()
    toastStore.setState({ toasts: [] })
  })
  it('bg-cat-hatch 는 바탕색과 같이 써도 지워지지 않는다', () => {
    expect(cn('bg-primary', 'bg-cat-hatch')).toBe('bg-primary bg-cat-hatch')
  })
})

import { UiInput } from '~/components/ui/Input'
describe('UiInput readonly 복사', () => {
  it('복사 버튼은 한 줄 고정 + 최소 폭', () => {
    render(<div style={{ width: 260 }}><UiInput readonly modelValue="https://example.test/very/long/address" label="서버 주소" /></div>)
    const btn = screen.getByRole('button', { name: '복사' })
    expect(btn.className).toContain('whitespace-nowrap')
    expect(btn.className).toContain('min-w-14')
  })
})

import { UiChip } from '~/components/ui/Chip'
describe('UiChip surface="raised"', () => {
  it('떠 있는 면 위 꺼진 칩·✕ 테두리는 muted-foreground/35, 켜지면 톤 색', () => {
    render(<><UiChip label="월" surface="raised" removable /><UiChip label="화" surface="raised" modelValue /><UiChip label="수" /></>)
    expect(screen.getByRole('button', { name: '월' }).className).toContain('border-muted-foreground/35')
    expect(screen.getAllByRole('button').find(b => b.getAttribute('aria-label')?.includes('월'))!.className).toContain('border-muted-foreground/35')
    expect(screen.getByRole('button', { name: /화/ }).className).toContain('border-primary/50')
    expect(screen.getByRole('button', { name: '수' }).className).toContain('border-border')
  })
})

import { UiMenu } from '~/components/ui/Menu'
describe('UiMenu 확장', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: '메뉴' }))

  it('description 한 줄', () => {
    render(<UiMenu items={[{ key: 'own', label: '공동 소유 지정', disabled: true, description: '원 소유자만' }]} />)
    open()
    const row = screen.getByRole('menuitem', { name: /공동 소유 지정/ })
    expect(row.textContent).toContain('원 소유자만')
    expect(screen.getByText('원 소유자만').className).toContain('truncate')
  })

  it('하위 메뉴: → 로 열고 첫 항목 포커스, ← 로 닫고 부모로, Enter 로 고르면 전체 닫힘', () => {
    const onSelect = vi.fn()
    render(<UiMenu onSelect={onSelect} items={[
      { key: 'a', label: '보통' },
      { key: 'dnd', label: '방해 금지', children: [{ key: 'dnd-30', label: '30분' }, { key: 'dnd-60', label: '1시간' }] },
    ]} />)
    open()
    const parent = screen.getByRole('menuitem', { name: /방해 금지/ })
    expect(parent.getAttribute('aria-haspopup')).toBe('menu')
    parent.focus()
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    expect(parent.getAttribute('aria-expanded')).toBe('true')
    const first = screen.getByRole('menuitem', { name: '30분' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '1시간' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.queryByRole('menuitem', { name: '30분' })).toBeNull()
    expect(document.activeElement).toBe(parent)
    fireEvent.click(parent)
    fireEvent.click(screen.getByRole('menuitem', { name: '1시간' }))
    expect(onSelect).toHaveBeenCalledWith('dnd-60')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('하위 메뉴: 호버 지연(150ms 열림 · 다른 항목 250ms 뒤 닫힘)', () => {
    vi.useFakeTimers()
    render(<UiMenu items={[{ key: 'a', label: '보통' }, { key: 's', label: '정렬', children: [{ key: 's1', label: '이름' }] }]} />)
    open()
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /정렬/ }))
    act(() => { vi.advanceTimersByTime(100) })
    expect(screen.queryByRole('menuitem', { name: '이름' })).toBeNull()
    act(() => { vi.advanceTimersByTime(60) })
    expect(screen.getByRole('menuitem', { name: '이름' })).toBeTruthy()
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '보통' }))
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByRole('menuitem', { name: '이름' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(60) })
    expect(screen.queryByRole('menuitem', { name: '이름' })).toBeNull()
    vi.useRealTimers()
  })

  it('펼침 패널(자유 내용): 입력이 글자를 받고(타입어헤드 아님) Tab 은 패널 안, Esc 는 패널만 닫음', () => {
    const save = vi.fn()
    render(<UiMenu items={[
      { key: 'a', label: '알림' },
      { key: 'st', label: '상태 메시지', panel: ({ back }) => (
        <div><input aria-label="문구" data-autofocus="" /><button onClick={() => { save(); back() }}>저장</button></div>
      ) },
    ]} />)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /상태 메시지/ }))
    const dlg = screen.getByRole('dialog', { name: '상태 메시지' })
    const input = screen.getByRole('textbox', { name: '문구' })
    expect(document.activeElement).toBe(input)
    // 문자 키는 메뉴 타입어헤드로 전달되지 않음
    fireEvent.keyDown(input, { key: '알' })
    expect(document.activeElement).toBe(input)
    // 마지막 요소에서 Tab → 처음으로(메뉴 닫힘 아님)
    const btn = screen.getByRole('button', { name: '저장' })
    btn.focus()
    fireEvent.keyDown(btn, { key: 'Tab' })
    expect(document.activeElement).toBe(input)
    expect(dlg.isConnected).toBe(true)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '상태 메시지' })).toBeNull()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('content 슬롯: 메뉴 위쪽 자유 내용, 안에서 Tab 은 닫지 않는다', () => {
    render(<UiMenu content={<input aria-label="검색" />} items={[{ key: 'x', label: '항목' }]} />)
    open()
    const input = screen.getByRole('textbox', { name: '검색' })
    input.focus()
    fireEvent.keyDown(input, { key: 'x' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})

import { isMobileStore } from '~/composables/useIsMobile'
describe('UiMenu 모바일 시트 하위 메뉴', () => {
  it('눌러서 한 단계 들어가고 "뒤로" 로 나온다', () => {
    isMobileStore.setState({ isMobile: true })
    const onSelect = vi.fn()
    render(<UiMenu onSelect={onSelect} items={[{ key: 'dnd', label: '방해 금지', children: [{ key: 'dnd-30', label: '30분' }] }]} />)
    fireEvent.click(screen.getByRole('button', { name: '메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /방해 금지/ }))
    expect(screen.getByRole('menuitem', { name: '30분' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '뒤로' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /방해 금지/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '30분' }))
    expect(onSelect).toHaveBeenCalledWith('dnd-30')
    isMobileStore.setState({ isMobile: false })
  })
})

import { UiMentionList, useUiMentionList } from '~/components/ui/MentionList'
import { useState as useStateT } from 'react'
describe('UiMentionList', () => {
  const people = [
    { id: '1', label: '김민지', secondary: 'minji@x.test' },
    { id: '2', label: '박서준', secondary: '댓글' },
    { id: '3', label: '이하나', secondary: '보기' },
  ]
  function Harness({ onPick, anchored = false }: { onPick: (i: number) => void; anchored?: boolean }) {
    const [open, setOpen] = useStateT(true)
    const [anchor, setAnchor] = useStateT<HTMLTextAreaElement | null>(null)
    const m = useUiMentionList({ count: people.length, open, onPick: (i) => { onPick(i); setOpen(false) }, onClose: () => setOpen(false) })
    return (
      <div className="relative">
        {open && <UiMentionList id={m.id} options={people} activeIndex={m.active} onActiveChange={m.setActive} onPick={m.pick}
          anchor={anchored ? anchor : undefined}
          heading="이 파일을 볼 수 있는 사람" footer="볼 권한이 없는 사람은 언급해도 알림이 가지 않습니다" />}
        <textarea ref={setAnchor} aria-label="댓글" {...m.inputProps} onKeyDown={(e) => { m.onKeyDown(e) }} />
      </div>
    )
  }

  it('머리글·행·보조 글·바닥 줄, 선택 행에 ↵ 키캡, 입력에 aria-activedescendant', () => {
    render(<Harness onPick={() => {}} />)
    expect(screen.getByText('이 파일을 볼 수 있는 사람')).toBeTruthy()
    expect(screen.getByText('볼 권한이 없는 사람은 언급해도 알림이 가지 않습니다')).toBeTruthy()
    const opts = screen.getAllByRole('option')
    expect(opts).toHaveLength(3)
    expect(opts[0].getAttribute('aria-selected')).toBe('true')
    expect(opts[0].className).toContain('h-9')
    expect(opts[0].textContent).toContain('↵')
    expect(opts[1].textContent).not.toContain('↵')
    const input = screen.getByRole('combobox', { name: '댓글' })
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0].id)
  })

  it('↑↓ 로 돌고 Enter 로 고른다, Esc 는 닫는다', () => {
    const onPick = vi.fn()
    const { unmount } = render(<Harness onPick={onPick} />)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(1)
    expect(screen.queryByRole('listbox')).toBeNull()
    unmount()
    render(<Harness onPick={onPick} />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false')
  })

  it('Ctrl+Enter 는 고르지 않는다(보내기 단축키), 마우스로 고르기', () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', ctrlKey: true })
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByRole('option', { name: /이하나/ }))
    expect(onPick).toHaveBeenCalledWith(2)
  })

  it('anchor 를 주면 body 포털 + fixed', () => {
    render(<Harness onPick={() => {}} anchored />)
    const lb = screen.getByRole('listbox')
    expect(lb.closest('.fixed')).toBeTruthy()
  })
})

import { installHostGlobals } from '~/plugins/hostGlobals'
describe('플러그인용 호스트 키트 window.__WS_UI__', () => {
  it('키트 부품과 toast·dialog 를 노출하고, 플러그인 컴포넌트가 그대로 쓸 수 있다', () => {
    installHostGlobals()
    const kit = window.__WS_UI__!
    expect(kit.version).toBe(1)
    for (const k of ['UiButton', 'UiModal', 'UiMenu', 'UiTrans', 'UiMentionList', 'UiTopbar', 'useToast', 'toast', 'useDialog', 'confirmBox']) expect(kit).toHaveProperty(k)
    expect(kit).not.toHaveProperty('UiToast')
    // 번들이 치환된 형태: const { UiButton } = window.__WS_UI__
    const { UiButton: B } = kit
    const onClick = vi.fn()
    render(<B size="xs" onClick={onClick}>플러그인 버튼</B>)
    fireEvent.click(screen.getByRole('button', { name: '플러그인 버튼' }))
    expect(onClick).toHaveBeenCalled()
  })
})

describe('UiButton icon · iconRight', () => {
  it('icon 은 글자 왼쪽, iconRight 는 오른쪽 — 16, 간격 gap-1.5', () => {
    render(<UiButton icon="plus" iconRight="chevron-down">일정</UiButton>)
    const b = screen.getByRole('button', { name: '일정' })
    expect(b.className).toContain('gap-1.5')
    const svgs = b.querySelectorAll('svg')
    expect(svgs).toHaveLength(2)
    expect(svgs[0].getAttribute('data-slot')).toBe('icon')
    expect(svgs[1].getAttribute('data-slot')).toBe('icon-right')
    expect(svgs[0].getAttribute('class')).toContain('h-4 w-4')
    expect(b.firstChild).toBe(svgs[0])
    expect(b.lastChild).toBe(svgs[1])
  })
  it('아이콘이 없으면 svg 도 간격도 없다', () => {
    render(<UiButton>저장</UiButton>)
    const b = screen.getByRole('button', { name: '저장' })
    expect(b.querySelector('svg')).toBeNull()
    expect(b.className).not.toContain('gap-1.5')
  })
})
