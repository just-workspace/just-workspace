// 게시판 컴포넌트 — 댓글 @멘션 자동완성, 페이지 번호, 글 행, 게시판 만들기 slug, 편집기 값 내보내기
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

const { BoardCommentInput } = await import('~/components/board/BoardCommentInput')
const { BoardPagination } = await import('~/components/board/BoardPagination')
const { BoardPostRow } = await import('~/components/board/BoardPostRow')
const { BoardCreateModal } = await import('~/components/board/BoardCreateModal')
const { RichEditor } = await import('~/components/editor/RichEditor')
const { authStore } = await import('~/composables/useAuth')

beforeEach(() => {
  api.calls = []
  api.handler = () => ({})
  authStore.setState({ user: { id: 'me', username: 'me' } as any })
})

describe('BoardCommentInput', () => {
  it('@ 뒤 글자로 후보를 찾고(나는 빼고) Enter 로 "@아이디 " 를 넣는다', async () => {
    vi.useFakeTimers()
    api.handler = () => [
      { id: 'me', username: 'me', display_name: '나' },
      { id: 'u2', username: 'kim', display_name: '김서연' },
    ]
    render(<BoardCommentInput postId="p1" />)
    const box = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '안녕 @ki', selectionStart: 7 } })
    await act(async () => { vi.advanceTimersByTime(160); await Promise.resolve(); await Promise.resolve() })
    expect(api.calls[0]).toMatchObject({ url: '/api/board/mention-users', opts: { params: { q: 'ki', limit: 8 } } })
    const opts = screen.getAllByRole('option')
    expect(opts).toHaveLength(1)
    expect(opts[0].textContent).toContain('@kim')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('안녕 @kim ')
    expect(screen.queryByRole('listbox')).toBeNull()
    vi.useRealTimers()
  })

  it('Ctrl+Enter 로 등록하고 답글이면 parent_id 를 붙인다', async () => {
    const onDone = vi.fn()
    api.handler = (_u, o) => (o.method === 'POST' ? { id: 'c1' } : [])
    render(<BoardCommentInput postId="p1" parentId="c0" onDone={onDone} />)
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: ' 답글 ' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }) })
    expect(api.calls[0]).toMatchObject({ url: '/api/board/posts/p1/comments', opts: { method: 'POST', body: { content: '답글', parent_id: 'c0' } } })
    expect(onDone).toHaveBeenCalled()
  })
})

describe('BoardPagination', () => {
  it('현재 쪽 aria-current, 처음·끝에서 화살표 막힘', () => {
    const onGo = vi.fn()
    render(<BoardPagination current={1} total={9} pages={[1, 2, '...', 9]} onGo={onGo} />)
    const btns = screen.getAllByRole('button')
    expect(btns[0]).toHaveProperty('disabled', true)
    expect(btns[1].getAttribute('aria-current')).toBe('page')
    fireEvent.click(btns[2])
    expect(onGo).toHaveBeenCalledWith(2)
  })
})

describe('BoardPostRow', () => {
  it('글 주소로 링크하고 안 읽음은 굵게, 필독·고정 배지', () => {
    renderInRouter(<BoardPostRow post={{ id: 'p1', board_id: 'b1', title: '공지', author: null, is_must_read: true, is_pinned: false, comment_count: 2, view_count: 5, has_attachments: false, created_at: new Date().toISOString() } as any} unread pinned />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/board/b1/p1')
    expect(screen.getByText('공지').className).toContain('font-bold')
    expect(link.textContent).toContain('[2]')
  })
})

describe('BoardCreateModal', () => {
  it('이름을 치면 slug 를 따라 만들고, 손으로 고친 slug 는 두고 간다', () => {
    render(<BoardCreateModal />)
    const [name, slug] = screen.getAllByRole('textbox') as HTMLInputElement[]
    fireEvent.change(name, { target: { value: 'D' } })
    fireEvent.change(name, { target: { value: 'De' } })
    fireEvent.change(name, { target: { value: 'Dev Notes' } })
    // 한 글자씩이 아니라 한 번에 바뀌면 Vue 와 같이 "한 글자 전" 비교가 어긋나 멈춘다
    expect(slug.value).toBe('de')
    fireEvent.change(name, { target: { value: 'Dev Notes!' } })
    expect(slug.value).toBe('de')
  })
})

describe('RichEditor', () => {
  it('처음 내용을 그리고 고치면 html·text 를 내보낸다', async () => {
    const onHtml = vi.fn(), onText = vi.fn()
    let handle: any = null
    render(<RichEditor ref={(h) => { handle = h }} initialContent="<p>처음</p>" onUpdateHtml={onHtml} onUpdateText={onText} />)
    expect(document.querySelector('.rich-editor')?.textContent).toContain('처음')
    expect(screen.getByRole('toolbar')).toBeTruthy()
    await act(async () => { handle.editor.commands.insertContent(' 더함') })
    expect(onHtml).toHaveBeenLastCalledWith(expect.stringContaining('더함'))
    expect(onText).toHaveBeenLastCalledWith(expect.stringContaining('처음'))
  })

  it('v3: 자리표시(@tiptap/extensions)·표(extension-table 통합)·링크(StarterKit 내장) 가 한 편집기에서 다 된다', async () => {
    const onHtml = vi.fn()
    let handle: any = null
    render(<RichEditor ref={(h) => { handle = h }} placeholder="본문을 쓰세요" onUpdateHtml={onHtml} />)
    expect(document.querySelector('.rich-editor .ProseMirror p.is-editor-empty')?.getAttribute('data-placeholder')).toBe('본문을 쓰세요')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '표' })) })
    expect(onHtml).toHaveBeenLastCalledWith(expect.stringContaining('<table'))
    expect(screen.getByRole('button', { name: '표' }).getAttribute('aria-pressed')).toBe('true')
    await act(async () => { handle.editor.chain().insertContent('<p>link-me</p>').run() })
    await act(async () => { handle.editor.chain().selectAll().setLink({ href: 'https://example.com/x' }).run() })
    expect(onHtml).toHaveBeenLastCalledWith(expect.stringContaining('href="https://example.com/x"'))
    // 확장이 한 번씩만 등록됐는지(StarterKit v3 의 밑줄·링크를 따로 또 넣으면 둘이 된다)
    const names = handle.editor.extensionManager.extensions.map((e: any) => e.name) as string[]
    for (const n of ['link', 'underline', 'placeholder', 'table', 'tableCell']) expect(names.filter(x => x === n), n).toHaveLength(1)
  })
})
