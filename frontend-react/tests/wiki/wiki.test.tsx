// 위키 컴포넌트 — 트리 인라인 입력·키보드, 버전 패널 표기, 레일 백링크, 사이드바 검색 디바운스
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, act } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { WikiPageTreeNode } = await import('~/components/wiki/WikiPageTreeNode')
const { WikiVersionPanel } = await import('~/components/wiki/WikiVersionPanel')
const { WikiRail } = await import('~/components/wiki/WikiRail')
const { WikiSidebar } = await import('~/components/wiki/WikiSidebar')

const author = { username: 'kim', display_name: '김서연' }
const node = (id: string, children: any[] = [], o: Record<string, unknown> = {}): any => ({
  id, parent_id: null, title: `제목 ${id}`, slug: id, sort_order: 0, is_pinned: false, version: 1, author, updated_at: '', children, ...o,
})

beforeEach(() => { api.calls = []; api.handler = () => ({}) })

describe('WikiPageTreeNode', () => {
  it('하위를 그리고 ← 로 접는다(행 자신에서만)', () => {
    render(<WikiPageTreeNode node={node('a', [node('b')])} selectedId="b" depth={0} />)
    const rows = screen.getAllByRole('treeitem')
    expect(rows).toHaveLength(2)
    expect(rows[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(rows[0], { key: 'ArrowLeft' })
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
    expect(rows[0].getAttribute('aria-expanded')).toBe('false')
  })

  it('인라인 새 페이지: Enter 로 만들기, 빈 값 blur 는 취소', () => {
    const onCreateDraft = vi.fn(), onCancelDraft = vi.fn()
    render(<WikiPageTreeNode node={node('a')} selectedId={undefined} depth={0} canWrite draftParentId="a" onCreateDraft={onCreateDraft} onCancelDraft={onCancelDraft} />)
    const input = screen.getByPlaceholderText(/./) as HTMLInputElement
    fireEvent.change(input, { target: { value: '  새 문서 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreateDraft).toHaveBeenCalledWith('a', '새 문서')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCancelDraft).toHaveBeenCalled()
  })

  it('이름 바꾸기: 같은 이름이면 취소, 다르면 rename', () => {
    const onRename = vi.fn(), onCancelRename = vi.fn()
    render(<WikiPageTreeNode node={node('a')} selectedId={undefined} depth={0} canWrite renamingId="a" onRename={onRename} onCancelRename={onCancelRename} />)
    const input = screen.getByDisplayValue('제목 a')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCancelRename).toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '새 이름' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('a', '새 이름')
  })
})

describe('WikiVersionPanel', () => {
  it('맨 위는 "현재", 단어 수 +/−, 선택 표시', () => {
    const versions: any[] = [
      { id: 'v2', version_number: 2, title: '', content: '', author, created_at: '2026-10-15T10:44:00' },
      { id: 'v1', version_number: 1, title: '', content: '', author, created_at: '2026-10-14T09:00:00' },
    ]
    const onSelect = vi.fn()
    render(<WikiVersionPanel versions={versions} selectedNumber={1} stats={{ 2: { added: 3, removed: 1 } }} onSelect={onSelect} />)
    const rows = screen.getAllByRole('button').filter(b => b.textContent?.startsWith('v'))
    expect(rows[0].textContent).toContain('+3−1')
    expect(rows[1].getAttribute('aria-current')).toBe('true')
    fireEvent.click(rows[0])
    expect(onSelect).toHaveBeenCalledWith(versions[0])
  })
})

describe('WikiRail', () => {
  it('백링크를 읽어 다른 스페이스면 "스페이스 › 제목"으로 그린다', async () => {
    api.handler = () => ({ items: [
      { id: 'x', title: '가리키는 글', space_name: '개발', url: '/wiki?space=s1&page=x', link_type: 'wiki', snippet: '' },
      { id: 'y', title: '다른 글', space_name: '인사', url: '/wiki?space=s2&page=y', link_type: 'wiki', snippet: '' },
    ] })
    renderInRouter(<WikiRail toc={[]} activeIndex={0} versions={[]} pageId="p 1" spaceName="개발" />)
    await act(async () => { await Promise.resolve() })
    expect(api.calls[0].url).toBe('/api/wiki/pages/p%201/backlinks')
    const links = await screen.findAllByRole('link')
    expect(links[0].textContent).toBe('가리키는 글')
    expect(links[1].textContent).toBe('인사다른 글')
  })
})

describe('WikiSidebar', () => {
  it('검색어는 250ms 뒤 한 번만 올린다', () => {
    vi.useFakeTimers()
    const onSearch = vi.fn()
    render(<WikiSidebar space={{ id: 's', name: '개발' } as any} tree={[]} pages={[]} selectedId={undefined} canWrite={false}
      draftParentId={undefined} renamingId={null} memberCount={3} searchResults={[]} mobile={false} onSearch={onSearch} />)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: '가' } })
    fireEvent.change(input, { target: { value: '가나' } })
    act(() => { vi.advanceTimersByTime(260) })
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('가나')
    vi.useRealTimers()
  })
})

describe('WikiPageTreeNode 히트 영역', () => {
  it('하위 페이지 추가 버튼은 relative — 넓힌 히트 영역이 행 전체를 덮지 않는다', () => {
    render(<WikiPageTreeNode node={node('a')} selectedId={undefined} depth={0} canWrite />)
    const add = screen.getByRole('button', { name: '하위 페이지 추가' })
    expect(add.className.split(/\s+/)).toContain('relative')
  })
})
