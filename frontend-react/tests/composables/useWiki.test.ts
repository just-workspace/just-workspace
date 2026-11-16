// 위키 store — 요청 주소·본문, 트리 구성, 삭제된 페이지 정리
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const wiki = await import('~/composables/useWiki')
const { wikiStore } = wiki

const node = (id: string, parent_id: string | null, sort_order: number, title = id) => ({
  id, parent_id, title, slug: id, sort_order, is_pinned: false, version: 1, author: { username: 'u', display_name: null }, updated_at: '',
})

beforeEach(() => {
  wiki._resetWikiStore()
  api.calls = []
  api.handler = () => ({})
})

describe('useWiki', () => {
  it('buildTree 는 sort_order → 제목 순으로 하위를 붙인다', () => {
    const tree = wiki.buildTree([node('b', null, 1), node('a', null, 1), node('c', 'a', 0), node('z', null, 0)])
    expect(tree.map(n => n.id)).toEqual(['z', 'a', 'b'])
    expect(tree[1].children.map((n: any) => n.id)).toEqual(['c'])
  })

  it('searchPages 는 빈 검색어면 요청 없이 비운다', async () => {
    wikiStore.setState({ searchResults: [node('x', null, 0)] })
    await wiki.searchPages('s1', '  ')
    expect(api.calls).toHaveLength(0)
    expect(wikiStore.getState().searchResults).toEqual([])
    api.handler = () => [node('y', null, 0)]
    await wiki.searchPages('s1', '키워드')
    expect(api.calls[0]).toMatchObject({ url: '/api/wiki/spaces/s1/search', opts: { params: { q: '키워드' } } })
    expect(wikiStore.getState().searchResults.map(n => n.id)).toEqual(['y'])
  })

  it('deletePage 는 스페이스 트리를 다시 받고 현재 페이지를 비운다', async () => {
    wikiStore.setState({ currentPage: { id: 'p1', space_id: 's1' } as any })
    api.handler = (url) => (url.endsWith('/pages') ? [node('p2', null, 0)] : {})
    await wiki.deletePage('p1')
    expect(api.calls.map(c => [c.url, c.opts.method])).toEqual([
      ['/api/wiki/pages/p1', 'DELETE'],
      ['/api/wiki/spaces/s1/pages', undefined],
    ])
    expect(wikiStore.getState().currentPage).toBeNull()
    expect(wikiStore.getState().pageTree.map(n => n.id)).toEqual(['p2'])
  })

  it('updatePage 는 PATCH 후 트리를 다시 받고 saving 을 끈다', async () => {
    api.handler = (url, opts) => (opts.method === 'PATCH' ? { id: 'p1', space_id: 's9', title: 'T' } : [])
    await wiki.updatePage('p1', { title: 'T' })
    expect(api.calls[0]).toMatchObject({ url: '/api/wiki/pages/p1', opts: { method: 'PATCH', body: { title: 'T' } } })
    expect(api.calls[1].url).toBe('/api/wiki/spaces/s9/pages')
    expect(wikiStore.getState().saving).toBe(false)
  })
})
