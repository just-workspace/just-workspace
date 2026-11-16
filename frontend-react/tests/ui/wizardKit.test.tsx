// UI 키트 — 단계 목록 · 진행 막대 · 알림 상자 · 표 · 펼침 행 · 파일 올리기 영역
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { UiCallout } from '~/components/ui/Callout'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiDropzone } from '~/components/ui/Dropzone'
import { UiProgress, progressPercent } from '~/components/ui/Progress'
import { UiStepList, stepPosition, type UiStep } from '~/components/ui/StepList'
import { UiTable } from '~/components/ui/Table'

const LABELS = { done: '완료', current: '현재 단계', todo: '남음', skipped: '건너뜀' }
const STEPS: UiStep[] = [
  { id: 'a', label: '사전 점검', state: 'done' },
  { id: 'b', label: '파일 저장 위치', state: 'skipped' },
  { id: 'c', label: '구역 선택', state: 'current' },
  { id: 'd', label: '요약', state: 'todo' },
]

describe('UiStepList', () => {
  it('번호는 건너뛴 단계를 빼고 매긴다', () => {
    expect(stepPosition(STEPS)).toMatchObject({ numbers: [1, null, 2, 3], now: 2, total: 3 })
  })

  it('목록 — 현재 단계는 aria-current, 상태는 글자로도 전한다', () => {
    render(<UiStepList label="설치 단계" labels={LABELS} steps={STEPS} />)
    const list = screen.getByRole('list', { name: '설치 단계' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(items[2].getAttribute('aria-current')).toBe('step')
    expect(items[0].getAttribute('aria-current')).toBeNull()
    expect(within(items[0]).getByText('완료')).toBeTruthy()
    expect(within(items[1]).getByText('건너뜀')).toBeTruthy()
    expect(within(items[2]).getByText('현재 단계')).toBeTruthy()
    expect(within(items[2]).getByText('2')).toBeTruthy()
    expect(within(items[3]).getByText('남음')).toBeTruthy()
    expect(items[1].querySelector('.line-through')?.textContent).toBe('파일 저장 위치')
  })

  it('접힌 모습 — "2/3 단계 이름" 과 진행 막대', () => {
    render(<UiStepList variant="compact" label="설치 단계" labels={LABELS} steps={STEPS} />)
    expect(screen.getByText('2/3')).toBeTruthy()
    expect(screen.getByText('구역 선택')).toBeTruthy()
    const bar = screen.getByRole('progressbar', { name: '설치 단계' })
    expect(bar.getAttribute('aria-valuenow')).toBe('2')
    expect(bar.getAttribute('aria-valuemax')).toBe('3')
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('UiProgress', () => {
  it('채운 비율은 범위 안으로 자른다', () => {
    expect(progressPercent(3, 0, 6)).toBe(50)
    expect(progressPercent(9, 0, 6)).toBe(100)
    expect(progressPercent(-1, 0, 6)).toBe(0)
    expect(progressPercent(1, 5, 5)).toBe(0)
  })

  it('값이 있으면 그 비율로, 없으면 끝을 모르는 진행으로 그린다 — 실시간 낭독 영역이 아니다', () => {
    const { rerender } = render(<UiProgress label="설치 진행" value={2} max={8} />)
    const bar = screen.getByRole('progressbar', { name: '설치 진행' })
    expect(bar.getAttribute('aria-valuenow')).toBe('2')
    expect((bar.querySelector('[data-slot=bar]') as HTMLElement).style.width).toBe('25%')
    expect(bar.getAttribute('aria-live')).toBeNull()
    rerender(<UiProgress label="설치 진행" value={null} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  })

  it('용량 막대는 meter 역할', () => {
    render(<UiProgress as="meter" label="권장 메모리" value={7} max={16} tone="danger" />)
    expect(screen.getByRole('meter', { name: '권장 메모리' }).querySelector('[data-slot=bar]')?.className).toContain('bg-danger')
  })
})

describe('UiCallout', () => {
  it('제목 · 본문 · 행동을 그리고, tone 마다 아이콘이 다르다', () => {
    const { container } = render(
      <UiCallout tone="warning" title="레코드 2개가 맞지 않습니다." actions={<button type="button">다시 확인</button>}>설치 후 다시 확인할 수 있습니다.</UiCallout>,
    )
    expect(screen.getByText('레코드 2개가 맞지 않습니다.')).toBeTruthy()
    expect(screen.getByText('설치 후 다시 확인할 수 있습니다.')).toBeTruthy()
    expect(screen.getByRole('button', { name: '다시 확인' })).toBeTruthy()
    expect(container.firstElementChild?.getAttribute('data-tone')).toBe('warning')
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('role 은 호출처가 줄 때만 붙는다', () => {
    const { rerender } = render(<UiCallout tone="danger">오류</UiCallout>)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<UiCallout tone="danger" role="alert">오류</UiCallout>)
    expect(screen.getByRole('alert').textContent).toContain('오류')
    rerender(<UiCallout variant="plain" tone="success" role="status" title="확인됨">로그인했습니다.</UiCallout>)
    expect(screen.getByRole('status').textContent).toBe('확인됨 · 로그인했습니다.')
  })
})

describe('UiTable', () => {
  const rows = [{ port: '80', use: '접속' }, { port: '443', use: '접속' }]
  const columns = [
    { key: 'port', header: '포트', mono: true, cell: (r: typeof rows[number]) => r.port },
    { key: 'use', header: '용도', cell: (r: typeof rows[number]) => r.use },
  ]

  it('머리글은 열 머리글, 밀리는 영역은 이름이 있고 키보드로 닿는다', () => {
    render(<UiTable label="열 포트" columns={columns} rows={rows} rowKey={r => r.port} />)
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['포트', '용도'])
    expect(screen.getAllByRole('row')).toHaveLength(3)
    const region = screen.getByRole('region', { name: '열 포트' })
    expect(region.getAttribute('tabindex')).toBe('0')
    expect(region.className).toContain('overflow-x-auto')
    expect(screen.getByText('80').className).toContain('font-mono')
  })

  it('행이 없으면 대신 보일 내용을 그린다', () => {
    render(<UiTable label="열 포트" columns={columns} rows={[]} rowKey={r => r.port} empty="없음" />)
    expect(screen.getByText('없음')).toBeTruthy()
  })
})

describe('UiDisclosure', () => {
  it('머리를 누르면 펼쳐지고 aria-expanded 가 따라간다', () => {
    const onUpdate = vi.fn()
    render(<UiDisclosure title="저장 폴더 지정" description="기본 폴더를 사용합니다" onUpdateOpen={onUpdate}><p>안쪽</p></UiDisclosure>)
    const head = screen.getByRole('button', { name: /저장 폴더 지정/ })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('안쪽')).toBeNull()
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('안쪽')).toBeTruthy()
    expect(document.getElementById(head.getAttribute('aria-controls')!)?.textContent).toBe('안쪽')
    expect(onUpdate).toHaveBeenCalledWith(true)
    fireEvent.click(head)
    expect(screen.queryByText('안쪽')).toBeNull()
  })

  it('제어형 · 처음부터 펼침 · 펼칠 것이 없는 행', () => {
    const { rerender } = render(<UiDisclosure title="고급" open><p>안쪽</p></UiDisclosure>)
    expect(screen.getByText('안쪽')).toBeTruthy()
    rerender(<UiDisclosure title="고급" open={false}><p>안쪽</p></UiDisclosure>)
    expect(screen.queryByText('안쪽')).toBeNull()
    rerender(<UiDisclosure title="디스크" variant="row" collapsible={false} trailing={<span>통과</span>}><p>안쪽</p></UiDisclosure>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('통과')).toBeTruthy()
  })
})

describe('UiDropzone', () => {
  const file = (name: string) => new File(['x'], name, { type: 'application/octet-stream' })

  it('버튼으로 고른 파일을 알린다(하나만)', () => {
    const onFiles = vi.fn()
    const { container } = render(<UiDropzone title="백업 파일을 여기에 끌어다 놓습니다" buttonLabel="파일 선택" onFiles={onFiles} />)
    expect(screen.getByRole('button', { name: '파일 선택' })).toBeTruthy()
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file('a.bak'), file('b.bak')] } })
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.bak'])
  })

  it('끌어다 놓으면 표시가 바뀌고 놓은 파일을 알린다', () => {
    const onFiles = vi.fn()
    const { container } = render(<UiDropzone title="여기에 놓습니다" buttonLabel="파일 선택" multiple onFiles={onFiles} />)
    const zone = container.firstElementChild as HTMLElement
    fireEvent.dragOver(zone)
    expect(zone.getAttribute('data-over')).toBe('true')
    fireEvent.drop(zone, { dataTransfer: { files: [file('a.pem'), file('b.pem')] } })
    expect(zone.getAttribute('data-over')).toBeNull()
    expect(onFiles.mock.calls[0][0]).toHaveLength(2)
  })

  it('꺼져 있으면 받지 않는다 · 한 줄 모양은 찬 칸을 실선으로', () => {
    const onFiles = vi.fn()
    const { container, rerender } = render(<UiDropzone title="인증서" buttonLabel="파일 선택" disabled onFiles={onFiles} />)
    fireEvent.drop(container.firstElementChild as HTMLElement, { dataTransfer: { files: [file('a.pem')] } })
    expect(onFiles).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '파일 선택' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<UiDropzone layout="row" filled title="인증서" description="fullchain.pem" buttonLabel="변경" onFiles={onFiles} />)
    expect(screen.getByText('fullchain.pem')).toBeTruthy()
    expect((container.firstElementChild as HTMLElement).className).not.toContain('border-dashed')
  })
})
