// 파일 store — 목록 요청·선택·정렬·뷰 전환
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

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

const files = await import('~/composables/useFiles')
const { filesStore } = files

const item = (name: string, o: Record<string, unknown> = {}) => ({ name, path: `my/${name}`, is_dir: false, size: 0, modified_at: null, mime_type: null, ...o })

beforeEach(() => {
  files._resetFilesStore()
  api.calls = []
  api.handler = () => ({})
})

describe('useFiles', () => {
  it('fetchFiles — 목록을 받고 선택을 비우고 공유 집계를 따로 부른다', async () => {
    files.setSelectedItems(new Set(['my/x']))
    api.handler = (url) => {
      if (url === '/api/files/list') return { path: 'my/docs', items: [item('a')] }
      if (url === '/api/files/share-user/counts') return { items: { a: { users: 1, link: false } } }
      return {}
    }
    await files.fetchFiles('my/docs')
    expect(api.calls[0]).toMatchObject({ url: '/api/files/list', opts: { params: { path: 'my/docs' } } })
    expect(api.calls[1]).toMatchObject({ url: '/api/files/share-user/counts', opts: { params: { path: 'my/docs' } } })
    const s = filesStore.getState()
    expect(s.currentPath).toBe('my/docs')
    expect(s.selectedItems.size).toBe(0)
    await vi.waitFor(() => expect(files.isShared({ ...item('a'), path: 'my/docs/a' })).toBe(true))
  })

  it('정렬 — 폴더 먼저, 같은 필드를 다시 누르면 방향 반전', () => {
    filesStore.setState({ items: [item('b', { size: 5 }), item('a', { size: 9 }), item('z', { is_dir: true })] })
    expect(files.filesSortedItems().map(i => i.name)).toEqual(['z', 'a', 'b'])
    files.toggleSort('name')
    expect(files.filesSortedItems().map(i => i.name)).toEqual(['z', 'b', 'a'])
    files.toggleSort('size')
    expect(filesStore.getState()).toMatchObject({ sortField: 'size', sortDir: 'asc' })
    expect(files.filesSortedItems().map(i => i.name)).toEqual(['z', 'b', 'a'])
  })

  it('선택 토글·전체 선택(다시 누르면 해제)', () => {
    filesStore.setState({ items: [item('a'), item('b')] })
    files.toggleSelect('my/a')
    expect([...filesStore.getState().selectedItems]).toEqual(['my/a'])
    files.selectAll()
    expect(filesStore.getState().selectedItems.size).toBe(2)
    files.selectAll()
    expect(filesStore.getState().selectedItems.size).toBe(0)
  })

  it('경로 조각 — 루트는 i18n 이름', () => {
    expect(files.filesBreadcrumbs('my/docs/2026')).toEqual([
      { label: '내 파일', path: 'my' },
      { label: 'docs', path: 'my/docs' },
      { label: '2026', path: 'my/docs/2026' },
    ])
  })

  it('setView(trash) — 휴지통을 받고 인라인 편집·선택을 끈다', async () => {
    files.setInlineEdit({ kind: 'new-folder' })
    api.handler = () => ({ items: [{ name: 't', trash_name: 't1' }], retention_days: 30 })
    files.setView('trash')
    await vi.waitFor(() => expect(filesStore.getState().trashRetentionDays).toBe(30))
    expect(api.calls[0].url).toBe('/api/files/trash')
    expect(filesStore.getState()).toMatchObject({ view: 'trash', inlineEdit: null })
  })

  it('useFiles() hook — sortedItems·breadcrumbs·setter', () => {
    const { result } = renderHook(() => files.useFiles())
    expect(result.current.breadcrumbs).toEqual([{ label: '내 파일', path: 'my' }])
    act(() => { filesStore.setState({ items: [item('b'), item('a')] }) })
    expect(result.current.sortedItems.map(i => i.name)).toEqual(['a', 'b'])
    act(() => { result.current.setViewMode('grid') })
    expect(result.current.viewMode).toBe('grid')
    expect(typeof result.current.navigateTo).toBe('function')
  })
})
