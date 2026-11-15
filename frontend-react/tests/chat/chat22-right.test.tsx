// handover-22 RIGHT — 검색 질의 파서(칩 ↔ SearchParams 왕복 · 날짜 · has 여러 개) · 결과 묶음/강조
// · 스레드 목록(정렬 · 이름 없는 표시 40자 · 보관 판정 · 실시간 갱신) · 검색칸 칩 입력 · 스레드 행 · 포럼 썸네일
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const calls: Array<{ url: string; opts: any }> = []
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    calls.push({ url, opts })
    if (url.endsWith('/search')) return { items: [], total: 0, offset: 0, limit: 25 }
    if (url.includes('/threads')) return { items: [], has_more: false, default_auto_archive_minutes: 1440 }
    if (url.includes('/follow')) return { root_id: 'r1', channel_id: 'c1', followed: opts.method === 'POST' }
    return {}
  }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

import { authStore } from '~/composables/useAuth'
import { chatStore, type ChatMessage } from '~/composables/useChat'
import type { ThreadListItem, SearchHit } from '~/composables/chatApi22'
import {
  chatSearchStore, chipsToParams, describeChips, groupByChannel, highlightParts, isEmptyQuery, liveConvert, pageWindow,
  paramsToChips, parseSearchText, runSearch, _resetChatSearch, type SearchChip,
} from '~/composables/useChatSearch'
import {
  applyReply, handleThreadListEvent, isThreadArchived, plainLine, sortThreads, threadListStore, threadTitle, _resetThreadList,
} from '~/composables/useChatThreadList'
import { firstImageOf, postThumb } from '~/composables/useChatForum'
import { ChatSearchBox, isSearchShortcut } from '~/components/chat/ChatSearchBox'
import { ChatThreadRow } from '~/components/chat/ChatThreadList'

const msg = (p: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1', channel_id: 'c1', sender: { id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null },
  content: '안녕하세요', message_type: 'text', file_meta: null, parent_id: null, reply_count: 0,
  is_edited: false, is_deleted: false, created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-20T01:00:00Z', ...p,
})
const item = (id: string, p: Partial<ThreadListItem> = {}, last?: string): ThreadListItem => ({
  root: msg({ id, content: `원문 ${id}` }),
  thread: { name: null, display_name: `원문 ${id}`, archived: false, auto_archive_minutes: 4320, reply_count: 1, last_reply_at: last ?? null },
  last_reply: null, participants: [], unread: false, followed: false, ...p,
})

beforeEach(() => {
  calls.length = 0
  authStore.setState({ user: { id: 'u1', username: 'kim', display_name: '김서연', email: '', is_admin: false } as any })
  chatStore.setState({
    channels: [{ id: 'c1', name: '개발', type: 'public' } as any, { id: 'c2', name: '공지', type: 'public' } as any],
    allUsers: [{ id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null }, { id: 'u3', username: 'park', display_name: '박준', avatar_url: null }],
  })
  _resetChatSearch()
  _resetThreadList()
})

describe('검색 질의 파서', () => {
  it('칩 → SearchParams: 한 값 필터는 마지막 칩, has 는 여러 개(중복 제거), pinned', () => {
    const chips: SearchChip[] = [
      { key: 'from', value: 'lee', label: '이도윤' },
      { key: 'has', value: 'link' }, { key: 'has', value: 'image' }, { key: 'has', value: 'link' },
      { key: 'in', value: 'c1', label: '#개발' }, { key: 'in', value: 'c2', label: '#공지' },
      { key: 'during', value: '2026-10-22' }, { key: 'pinned', value: '' },
    ]
    expect(chipsToParams(chips, '  릴리스   노트 ')).toEqual({ q: '릴리스 노트', from: 'lee', has: ['link', 'image'], in: 'c2', during: '2026-10-22', pinned: true })
  })

  it('틀린 날짜·모르는 has 는 버린다', () => {
    expect(chipsToParams([{ key: 'before', value: '10/22' }, { key: 'has', value: 'gif' }], '')).toEqual({})
    expect(isEmptyQuery({})).toBe(true)
  })

  it('왕복: paramsToChips → chipsToParams 가 같은 질의(시안 순서, 이름 표시)', () => {
    const p = { q: '배포', from: 'lee', mentions: 'park', in: 'c1', has: ['link', 'file'] as any, before: '2026-10-01', after: '2026-09-01', pinned: true }
    const { chips, text } = paramsToChips(p, { user: u => (u === 'lee' ? '이도윤' : undefined), channel: id => (id === 'c1' ? '#개발' : undefined) })
    expect(chips.map(c => c.key)).toEqual(['from', 'in', 'has', 'has', 'mentions', 'before', 'after', 'pinned'])
    expect(chips[0].label).toBe('이도윤')
    expect(chipsToParams(chips, text)).toEqual(p)
    expect(describeChips(chips.slice(0, 3))).toBe('from:이도윤 in:#개발 has:링크')
  })

  it('붙여 넣은 글: 키 토큰은 칩, 사람·채널 이름은 값으로, 나머지는 글자', () => {
    const r = parseSearchText('from:이도윤 has:링크 has:image during:2026-10-22 before:어제 in:#개발 is:pinned 릴리스', {
      user: q => (q === '이도윤' ? { value: 'lee', label: '이도윤' } : null),
      channel: q => (q === '개발' ? { value: 'c1', label: '#개발' } : null),
    })
    expect(r.text).toBe('before:어제 릴리스')
    expect(chipsToParams(r.chips, r.text)).toEqual({ q: 'before:어제 릴리스', from: 'lee', has: ['link', 'image'], during: '2026-10-22', in: 'c1', pinned: true })
  })

  it('입력 중 변환: 끝이 "from:" 이면 대기 칩, is:pinned 는 바로 칩', () => {
    expect(liveConvert('from:')).toEqual({ text: '', pending: 'from' })
    expect(liveConvert('릴리스 has:')).toEqual({ text: '릴리스 ', pending: 'has' })
    expect(liveConvert('xfrom:')).toBeNull()
    expect(liveConvert('is:pinned 노트')?.chip).toEqual({ key: 'pinned', value: '' })
    expect(liveConvert('릴리스')).toBeNull()
  })
})

describe('검색 결과', () => {
  const hit = (id: string, ch: string): SearchHit => ({ ...msg({ id, channel_id: ch }), channel_name: ch === 'c1' ? '개발' : '공지', channel_type: 'public' })
  it('연속한 같은 채널끼리 묶고, 채널이 바뀌면 새 제목', () => {
    const g = groupByChannel([hit('a', 'c1'), hit('b', 'c1'), hit('c', 'c2'), hit('d', 'c1')])
    expect(g.map(x => [x.channelName, x.items.map(i => i.id).join('')])).toEqual([['개발', 'ab'], ['공지', 'c'], ['개발', 'd']])
  })
  it('일치 강조: 낱말 여러 개 · 대소문자 무시 · 특수 문자', () => {
    expect(highlightParts('오늘 오후에 릴리스 노트 정리', '릴리스')).toEqual([{ t: '오늘 오후에 ', hit: false }, { t: '릴리스', hit: true }, { t: ' 노트 정리', hit: false }])
    expect(highlightParts('Deploy v2.1 deploy', 'deploy v2.1').filter(p => p.hit).map(p => p.t)).toEqual(['Deploy', 'v2.1', 'deploy'])
    expect(highlightParts('abc', '')).toEqual([{ t: 'abc', hit: false }])
  })
  it('쪽 번호 창', () => {
    expect(pageWindow(0, 2)).toEqual([0, 1])
    expect(pageWindow(5, 10)).toEqual([3, 4, 5, 6, 7])
    expect(pageWindow(9, 10)).toEqual([5, 6, 7, 8, 9])
  })
  it('runSearch: /search 에 칩 질의 + 정렬·쪽, 오른쪽 자리를 연다', async () => {
    chatSearchStore.setState({ chips: [{ key: 'from', value: 'lee' }, { key: 'has', value: 'link' }, { key: 'has', value: 'file' }], text: '릴리스' })
    await runSearch()
    const c = calls.find(x => x.url.endsWith('/search'))!
    expect(c.opts.query).toMatchObject({ q: '릴리스', from: 'lee', has: 'link,file', sort: 'new', offset: 0, limit: 25 })
    expect(chatStore.getState().showSearchPanel).toBe(true)
  })
})

describe('스레드 목록', () => {
  it('이름 없는 스레드 = 원문 첫 40자(코드 포인트) + … 를 따옴표 안에, 기울임 표시', () => {
    const long = '캐시 키 바꾸는 PR 올렸습니다. 리뷰 부탁드려요 — 특히 locale 부분을 봐 주세요 🙏 감사'
    const r = threadTitle({ name: null, display_name: '' }, { content: long })
    expect(r.unnamed).toBe(true)
    expect(r.text.startsWith('“캐시 키 바꾸는 PR 올렸습니다. 리')).toBe(true)
    expect(Array.from(r.text.slice(1, -2)).length).toBeLessThanOrEqual(40)
    expect(r.text.endsWith('…”')).toBe(true)
    expect(threadTitle({ name: null, display_name: '' }, { content: '**짧은** 글' })).toEqual({ text: '“짧은 글”', unnamed: true })
    expect(threadTitle({ name: 'p99 콜드 스타트 확인', display_name: 'x' }, { content: 'y' })).toEqual({ text: 'p99 콜드 스타트 확인', unnamed: false })
    expect(plainLine('> 인용\n`code` [링크](http://x)')).toBe('인용 code 링크')
  })

  it('최근 활동순 정렬(마지막 답글 → 없으면 원문 시각)', () => {
    const a = item('a', {}, '2026-10-22T09:00:00Z')
    const b = item('b', {}, '2026-10-22T10:00:00Z')
    const c = item('c', { root: msg({ id: 'c', created_at: '2026-10-22T11:00:00Z' }) })
    expect(sortThreads([a, b, c]).map(x => x.root.id)).toEqual(['c', 'b', 'a'])
  })

  it('보관 판정: 명시 보관 또는 마지막 활동 + 자동 보관 지남', () => {
    const now = new Date('2026-10-23T00:00:00Z').getTime()
    expect(isThreadArchived(item('a', {}, '2026-10-22T23:00:00Z'), now)).toBe(false)
    expect(isThreadArchived(item('a', {}, '2026-10-19T00:00:00Z'), now)).toBe(true)   // 3일 지남
    expect(isThreadArchived(item('a', { thread: { ...item('a').thread, archived: true } }), now)).toBe(true)
  })

  it('답글 반영: 수 +1 · 마지막 답글 · 참여자 맨 앞(최대 5) · 남이 쓰면 안 읽음', () => {
    const r = applyReply(item('a', { participants: [{ id: 'u3', username: 'park', display_name: '박준', avatar_url: null }] }), msg({ id: 'x', parent_id: 'a', content: '확인', created_at: '2026-10-23T00:00:00Z' }), 'u1')
    expect(r.thread.reply_count).toBe(2)
    expect(r.last_reply?.content).toBe('확인')
    expect(r.participants.map(p => p.id)).toEqual(['u2', 'u3'])
    expect(r.unread).toBe(true)
  })

  it('실시간: new_message(parent_id) 가 오면 그 행을 갱신하고 맨 위로', () => {
    threadListStore.setState({ channelId: 'c1', tab: 'active', items: [item('a', {}, '2026-10-22T10:00:00Z'), item('b', {}, '2026-10-22T09:00:00Z')] })
    handleThreadListEvent({ type: 'new_message', message: msg({ id: 'x', parent_id: 'b', content: '새 답글', created_at: '2026-10-23T00:00:00Z' }) })
    const s = threadListStore.getState()
    expect(s.items[0].root.id).toBe('b')
    expect(s.items[0].last_reply?.content).toBe('새 답글')
    // 같은 답글이 thread_update 로 또 와도 한 번만 센다
    handleThreadListEvent({ type: 'thread_update', root_id: 'b', channel_id: 'c1', reply: msg({ id: 'x', parent_id: 'b', content: '새 답글', created_at: '2026-10-23T00:00:00Z' }) })
    expect(threadListStore.getState().items[0].thread.reply_count).toBe(2)
  })

  it('실시간: 보관 탭의 스레드에 답글 = 보관 해제 → 보관 탭에서 빠진다', () => {
    threadListStore.setState({ channelId: 'c1', tab: 'archived', items: [item('a')] })
    handleThreadListEvent({ type: 'new_message', message: msg({ id: 'x', parent_id: 'a' }) })
    expect(threadListStore.getState().items).toHaveLength(0)
  })

  it('행: 이름 없는 스레드는 기울임, 안 읽음 점, 팔로우 bell 누르면 토글만(열기 아님)', () => {
    const onOpen = vi.fn(), onToggle = vi.fn()
    render(<ul><ChatThreadRow item={item('a', { unread: true, followed: true })} archivedTab={false} mobile={false} onOpen={onOpen} onToggleFollow={onToggle} /></ul>)
    expect(screen.getByText('“원문 a”').className).toContain('italic')
    expect(screen.getByRole('img', { name: '안 읽음' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '팔로우 해제' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /스레드 열기/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('검색칸', () => {
  it('from: 를 치면 대기 칩 → 사람 제안 → Enter 로 칩, 빈 칸 Backspace 로 지움', async () => {
    render(<ChatSearchBox />)
    const input = screen.getByRole('combobox', { name: '메시지 검색' })
    act(() => { input.focus() })
    fireEvent.change(input, { target: { value: 'from:' } })
    expect(chatSearchStore.getState().pending).toBe('from')
    fireEvent.change(input, { target: { value: '이도' } })
    expect(await screen.findByRole('option', { name: /이도윤/ })).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chatSearchStore.getState().chips).toEqual([{ key: 'from', value: 'lee', label: '이도윤' }])
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(chatSearchStore.getState().chips).toEqual([])
  })

  it('포커스하면 필터 안내 목록(시안 순서)', () => {
    render(<ChatSearchBox />)
    const input = screen.getByRole('combobox', { name: '메시지 검색' })
    act(() => { input.focus() })
    fireEvent.focus(input)
    const keys = screen.getAllByRole('option').map(o => o.querySelector('b')?.textContent)
    expect(keys).toEqual(['from:', 'in:', 'has:', 'mentions:', 'before:', 'after:', 'during:', 'is:pinned'])
  })
})

describe('검색 단축키(디스코드 실측 Ctrl+F · ⌘F)', () => {
  const k = (p: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '', ...p }) as KeyboardEvent
  it('Ctrl+F(맥 ⌘F)만, 한글 입력기(e.code)도', () => {
    expect(isSearchShortcut(k({ ctrlKey: true, key: 'f' }), false)).toBe(true)
    expect(isSearchShortcut(k({ ctrlKey: true, key: 'ㄹ', code: 'KeyF' }), false)).toBe(true)
    expect(isSearchShortcut(k({ metaKey: true, key: 'f' }), true)).toBe(true)
    expect(isSearchShortcut(k({ ctrlKey: true, key: 'k' }), false)).toBe(false)
    expect(isSearchShortcut(k({ ctrlKey: true, shiftKey: true, key: 'f' }), false)).toBe(false)
  })
  it('채팅 화면: Ctrl+F 는 검색칸 포커스 + 기본 찾기 막음, Ctrl+K 는 건드리지 않음(전역 팔레트)', () => {
    render(<ChatSearchBox />)
    const input = screen.getByRole('combobox', { name: '메시지 검색' })
    Object.defineProperty(input, 'offsetParent', { configurable: true, get: () => document.body })
    const ek = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ek)
    expect(ek.defaultPrevented).toBe(false)
    const ef = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ef)
    expect(ef.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
  })
})

describe('포럼', () => {
  it('첫 이미지: HTML img · 마크다운 · 서버 썸네일 우선', () => {
    expect(firstImageOf('<p>a</p><img alt="x" src="/f/1.png"><img src="/f/2.png">')).toBe('/f/1.png')
    expect(firstImageOf('글 ![사진](https://x/y.jpg "t")')).toBe('https://x/y.jpg')
    expect(firstImageOf('그냥 글')).toBeNull()
    expect(postThumb({ thumbnail_url: '/t.png', content: '<img src="/c.png">' } as any)).toBe('/t.png')
  })
})
