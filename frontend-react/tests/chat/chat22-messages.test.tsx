// 채팅 MESSAGES — 그룹 판정 · 마크다운 · 첨부 그리드 · 답장 원문 상태 · 점프 창 교체
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, render } from '@testing-library/react'

const api = vi.hoisted(() => ({
  handler: (_url: string, _opts?: any): any => ({}),
  calls: [] as Array<{ url: string; opts?: any }>,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { i18n } = await import('~/i18n')
const { continuesGroup, groupedFlags } = await import('~/utils/chatGrouping')
const { parseChatMarkdown, parseInline, stripChatMarkdown, isEmojiOnly, mentionsMe, CODE_FOLD_LINES } = await import('~/utils/chatMarkdown')
const { ChatMarkdown, tokenizeLine } = await import('~/components/chat/ChatMarkdown')
const { gridLayout, messageAttachments, attachmentKind } = await import('~/components/chat/ChatAttachmentGrid')
const { replyView, ChatReplyPreview } = await import('~/components/chat/ChatReplyPreview')
const { planJump } = await import('~/composables/useChatJump')
const { chatStore, replaceMessagesWindow, appendMessagesAfter, handleWSMessage } = await import('~/composables/useChat')
const { chatUiStore } = await import('~/composables/useChatUi')
const { quickReactions } = await import('~/components/chat/ChatMessageActions')
const { callsMeRow } = await import('~/components/chat/ChatMessage')
const { pinMetaOf } = await import('~/components/chat/ChatSystemMessage')

const t = (k: string, p?: any) => i18n.t(k, p)
const at = (min: number) => new Date(2026, 9, 22, 10, min).toISOString()
const M = (p: any = {}) => ({
  id: 'm' + Math.random().toString(36).slice(2), channel_id: 'c1', sender: { id: 'u1', username: 'kim', display_name: '김', avatar_url: null },
  content: 'hi', message_type: 'text', file_meta: null, parent_id: null, reply_count: 0, is_edited: false, is_deleted: false,
  created_at: at(0), updated_at: at(0), ...p,
})

describe('그룹 판정', () => {
  it('같은 사람 5분 안 = 이어짐, 5분 넘으면 새 그룹', () => {
    expect(continuesGroup(M({ created_at: at(4) }), M())).toBe(true)
    expect(continuesGroup(M({ created_at: at(5) }), M())).toBe(false)
  })
  it('답장 메시지는 늘 새 그룹', () => {
    expect(continuesGroup(M({ created_at: at(1), reply_to_id: 'x' }), M())).toBe(false)
    expect(groupedFlags([M(), M({ created_at: at(1) }), M({ created_at: at(2), reply_to_id: 'x' }), M({ created_at: at(3) })])).toEqual([false, true, false, true])
  })
  it('시스템 줄 · 다른 사람 · 새 메시지 선이면 끊긴다', () => {
    expect(continuesGroup(M({ created_at: at(1) }), M({ message_type: 'system' }))).toBe(false)
    expect(continuesGroup(M({ created_at: at(1), sender: { id: 'u2' } }), M())).toBe(false)
    const m = M({ id: 'n1', created_at: at(1) })
    expect(continuesGroup(m, M(), 'n1')).toBe(false)
  })
})

describe('마크다운 파서', () => {
  it('헤더 · -# · 목록 · 인용', () => {
    const b = parseChatMarkdown('# 큰\n## 중간\n### 작은\n-# 작은 글\n- 하나\n  - 둘\n1. 셋\n> 인용')
    expect(b.map(x => x.t)).toEqual(['h', 'h', 'h', 'sub', 'list', 'quote'])
    expect((b[0] as any).level).toBe(1)
    expect((b[4] as any).items.map((i: any) => [i.depth, i.ordered])).toEqual([[0, false], [1, false], [0, true]])
  })
  it('>>> 는 나머지 전부 인용', () => {
    const b = parseChatMarkdown('앞\n>>> 하나\n둘')
    expect(b[1].t).toBe('quote')
    expect(stripChatMarkdown('>>> 하나\n둘')).toBe('하나 둘')
  })
  it('스포일러 · 마스크 링크 · 밑줄 · 굵게 · 기울임 · 취소 · 인라인 코드', () => {
    const c = parseInline('||숨김|| [글](https://ex.com/a) __밑__ **굵** *기* ~~취~~ `코드`')
    const kinds = c.filter(n => n.t !== 'text').map(n => n.t)
    expect(kinds).toEqual(['spoiler', 'link', 'u', 'b', 'i', 's', 'code'])
    const link = c.find(n => n.t === 'link') as any
    expect(link.masked).toBe(true)
    expect(link.href).toBe('https://ex.com/a')
  })
  it('javascript: 마스크 링크는 링크가 아니다', () => {
    const c = parseInline('[눌러](javascript:alert(1))')
    expect(c.some(n => n.t === 'link')).toBe(false)
  })
  it('이스케이프 · 코드 안의 ||는 그대로 · snake_case', () => {
    expect(parseInline('\\*별\\*')).toEqual([{ t: 'text', v: '*별*' }])
    expect(parseInline('`||무효||`')).toEqual([{ t: 'code', v: '||무효||' }])
    expect(parseInline('a_b_c').every(n => n.t === 'text')).toBe(true)
  })
  it('코드 블록 언어 · 멘션(@first-last) · #482 는 채널 아님', () => {
    const b = parseChatMarkdown('```ts\nconst a = 1\n```')
    expect(b[0]).toEqual({ t: 'code', lang: 'ts', code: 'const a = 1' })
    const c = parseInline('@first-last 님 #482 #개발')
    expect(c.find(n => n.t === 'at')).toEqual({ t: 'at', name: 'first-last', group: false })
    expect(c.filter(n => n.t === 'channel').map((n: any) => n.ref)).toEqual(['개발'])
    expect((parseInline('@everyone')[0] as any).group).toBe(true)
  })
  it('jumbo: 이모지만이면 true', () => {
    expect(isEmojiOnly(parseChatMarkdown('🎉 👍'), () => false)).toBe(true)
    expect(isEmojiOnly(parseChatMarkdown('🎉 좋아'), () => false)).toBe(false)
    expect(isEmojiOnly(parseChatMarkdown(':ship_it:'), n => n === 'ship_it')).toBe(true)
    expect(isEmojiOnly(parseChatMarkdown(':nope:'), () => false)).toBe(false)
  })
  it('내 역할 멘션도 나를 부른 것', () => {
    expect(mentionsMe('@디자인 리뷰', 'kim', ['디자인'])).toBe(true)
    expect(mentionsMe('@백엔드 리뷰', 'kim', ['디자인'])).toBe(false)
  })
  it('토크나이저 — 키워드 · 문자열 · 함수 · 주석', () => {
    const k = tokenizeLine("const x = warmup('ko') // 주석", 'ts').filter(x => x.k).map(x => [x.k, x.v])
    expect(k).toEqual([['kw', 'const'], ['fn', 'warmup'], ['str', "'ko'"], ['cm', '// 주석']])
  })
})

describe('마크다운 그리기', () => {
  it('스포일러 버튼 aria-expanded → 누르면 펼침', () => {
    render(<ChatMarkdown content="발표: ||금요일||" />)
    const btn = screen.getByRole('button', { name: t('chat.msg.md.spoiler') })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(screen.queryByRole('button', { name: t('chat.msg.md.spoiler') })).toBeNull()
    expect(screen.getByText('금요일')).toBeTruthy()
  })
  it('헤더 크기 · -# muted', () => {
    const { container } = render(<ChatMarkdown content={'# 제목\n-# 작은'} />)
    expect(screen.getByRole('heading', { name: '제목' }).className).toContain('text-[24px]')
    expect(container.querySelector('[data-md="sub"]')!.className).toContain('text-muted-foreground')
  })
  it('마스크 링크 — 호버하면 실제 주소 툴팁(UiTooltip · body 포털이라 목록에 잘리지 않는다)', async () => {
    render(<ChatMarkdown content="[체크리스트](https://wiki.example.dev/release)" />)
    const a = screen.getByRole('link', { name: '체크리스트' })
    expect(a.getAttribute('href')).toBe('https://wiki.example.dev/release')
    fireEvent.focus(a)
    expect((await screen.findByRole('tooltip')).textContent).toBe('https://wiki.example.dev/release')
  })
  it('코드 블록 20줄 넘으면 접고 "N줄 더 보기"', () => {
    const code = Array.from({ length: CODE_FOLD_LINES + 14 }, (_, i) => `line${i}`).join('\n')
    const { container } = render(<ChatMarkdown content={'```\n' + code + '\n```'} />)
    expect(container.querySelectorAll('pre > div').length).toBe(CODE_FOLD_LINES)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('chat.msg.md.moreLines', { n: 14 })) }))
    expect(container.querySelectorAll('pre > div').length).toBe(CODE_FOLD_LINES + 14)
  })
  it('HTML 은 글자로(XSS 없음)', () => {
    const { container } = render(<ChatMarkdown content={'<img src=x onerror="alert(1)"> <script>x</script>'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img src=x')
  })
})

describe('첨부 그리드 배치', () => {
  const spans = (n: number) => gridLayout(n).cells.map(c => c.span)
  it('1–13장', () => {
    expect(spans(1)).toEqual([6])
    expect(spans(2)).toEqual([3, 3])
    expect(spans(3)).toEqual([4, 2, 2])
    expect(spans(4)).toEqual([3, 3, 3, 3])
    expect(spans(5)).toEqual([3, 3, 2, 2, 2])
    expect(spans(6)).toEqual([2, 2, 2, 2, 2, 2])
    expect(spans(7)).toEqual([6, 2, 2, 2, 2, 2, 2])
    expect(spans(8)).toEqual([3, 3, 2, 2, 2, 2, 2, 2])
    expect(spans(9).length).toBe(9)
    expect(spans(10)[0]).toBe(6)
    for (let n = 1; n <= 13; n++) {
      const L = gridLayout(n)
      expect(L.cells.length).toBe(Math.min(n, 10))
      expect(L.more).toBe(Math.max(0, n - 10))
      // 줄마다 6칸이 꽉 찬다(3장 = 큰 칸이 두 줄)
      if (n !== 3) expect(L.cells.reduce((a, c) => a + c.span, 0) % 6).toBe(0)
    }
    expect(gridLayout(13).more).toBe(3)
    expect(gridLayout(0).cells).toEqual([])
  })
  it('옛 단일 file_meta 메시지도 1장', () => {
    const a = messageAttachments(M({ message_type: 'file', file_meta: JSON.stringify({ name: 'a.png', size: 10, mime_type: 'image/png', path: '/x/a.png' }) }) as any)
    expect(a).toHaveLength(1)
    expect(a[0].kind).toBe('image')
    expect(a[0].thumb).toContain('/api/files/preview')
    expect(messageAttachments(M({ message_type: 'system', file_meta: JSON.stringify({ kind: 'pin', message_id: 'x' }) }) as any)).toEqual([])
    expect(attachmentKind('', 'clip.mp4')).toBe('video')
    expect(attachmentKind('audio/mpeg', 'x')).toBe('audio')
  })
})

describe('답장 원문 상태', () => {
  const ref = (p: any) => ({ id: 'r1', state: 'ok', sender: { id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null }, content: '**굵게** 요약', message_type: 'text', has_attachment: false, attachment_kind: null, ...p })
  it('ok · 첨부만 · 삭제됨 · 불러올 수 없음 · 권한 없음', () => {
    expect(replyView({ reply_to: ref({}) } as any)).toMatchObject({ kind: 'ok', text: '굵게 요약', icon: null })
    expect(replyView({ reply_to: ref({ content: '', has_attachment: true, attachment_kind: 'image', message_type: 'file' }) } as any)).toMatchObject({ kind: 'ok', icon: 'image' })
    expect(replyView({ reply_to: ref({ state: 'deleted', sender: null }) } as any)).toEqual({ kind: 'deleted', icon: 'trash' })
    expect(replyView({ reply_to: ref({ state: 'unavailable', sender: null }) } as any)).toEqual({ kind: 'unavailable', icon: 'alert-circle' })
    expect(replyView({ reply_to: ref({ state: 'forbidden', sender: null }) } as any)).toEqual({ kind: 'forbidden', icon: 'lock' })
    expect(replyView({ reply_to: null, reply_to_id: 'x' } as any)).toEqual({ kind: 'unavailable', icon: 'alert-circle' })
    expect(replyView({ reply_to: null } as any)).toBeNull()
  })
  it('그리기 — 첨부만이면 "이미지", 삭제됨은 기울임, 누르면 jumpTo', () => {
    const { rerender } = render(<ChatReplyPreview message={M({ reply_to_id: 'r1', reply_to: ref({ content: '', has_attachment: true, attachment_kind: 'image' }) }) as any} display="cozy" />)
    expect(screen.getByText(t('chat.msg.reply.att.image'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(chatUiStore.getState().jumpTarget).toMatchObject({ channelId: 'c1', messageId: 'r1' })
    rerender(<ChatReplyPreview message={M({ reply_to_id: 'r1', reply_to: ref({ state: 'deleted', sender: null }) }) as any} display="cozy" />)
    const s = screen.getByText(t('chat.msg.reply.deleted'))
    expect(s.className).toContain('italic')
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })
  it('나에게 온 답장(@ 켬)이면 강조, @ 끔이면 아님', () => {
    const r = ref({ sender: { id: 'me', username: 'me', display_name: null, avatar_url: null } })
    expect(callsMeRow({ content: 'x', reply_to: r, reply_ping: true } as any, { id: 'me', username: 'me' }, [])).toBe(true)
    expect(callsMeRow({ content: 'x', reply_to: r, reply_ping: false } as any, { id: 'me', username: 'me' }, [])).toBe(false)
  })
})

describe('점프 창 교체', () => {
  beforeEach(() => {
    chatStore.setState({ selectedChannelId: 'c1', messages: [], hasMoreAfter: false, newBelowCount: 0 })
  })
  it('목록에 있으면 inList, 없으면 around 창 · 스레드 · 못 찾음', async () => {
    expect(await planJump('c1', 'a', [{ id: 'a' }], vi.fn() as any)).toEqual({ kind: 'inList' })
    const win = [M({ id: 'x1' }), M({ id: 'tg' }), M({ id: 'x2' })]
    const around = vi.fn(async () => ({ messages: win, has_more: true, has_more_after: true })) as any
    expect(await planJump('c1', 'tg', [], around)).toMatchObject({ kind: 'window', hasMore: true, hasMoreAfter: true })
    expect(around).toHaveBeenCalledWith('c1', 'tg', 50)
    expect(await planJump('c1', 'tg', [], (async () => ({ messages: [], thread_root_id: 'root' })) as any)).toEqual({ kind: 'thread', rootId: 'root' })
    expect(await planJump('c1', 'tg', [], (async () => ({ messages: [M({ id: 'other' })] })) as any)).toEqual({ kind: 'missing' })
  })
  it('창을 바꾸면 새 메시지는 붙지 않고, 끝까지 이어 붙이면 다시 실시간', () => {
    replaceMessagesWindow([M({ id: 'w1' }), M({ id: 'w2' })] as any, true, true)
    expect(chatStore.getState().hasMoreAfter).toBe(true)
    handleWSMessage({ type: 'new_message', message: M({ id: 'live1', sender: { id: 'u9', username: 'z' } }) })
    expect(chatStore.getState().messages.map(m => m.id)).toEqual(['w1', 'w2'])
    appendMessagesAfter([M({ id: 'w2' }), M({ id: 'w3' })] as any, false)
    expect(chatStore.getState().messages.map(m => m.id)).toEqual(['w1', 'w2', 'w3'])
    expect(chatStore.getState().hasMoreAfter).toBe(false)
    handleWSMessage({ type: 'new_message', message: M({ id: 'live2', sender: { id: 'u9', username: 'z' } }) })
    expect(chatStore.getState().messages.map(m => m.id)).toContain('live2')
  })
})

describe('실시간 수정·삭제 · 순서 · 중복', () => {
  it('message_delete — 모든 목록에서 빠지고, 답글이면 원문의 답글 수가 준다', () => {
    chatStore.setState({ selectedChannelId: 'c1', hasMoreAfter: false, messages: [M({ id: 'root', reply_count: 2 }), M({ id: 'x1' })] as any,
      threadMessages: [M({ id: 'r1', parent_id: 'root' }), M({ id: 'r2', parent_id: 'root' })] as any, pins: [M({ id: 'x1' })] as any, activeThreadId: 'root' })
    handleWSMessage({ type: 'message_delete', message_id: 'r2', channel_id: 'c1', parent_id: 'root' })
    expect(chatStore.getState().threadMessages.map(m => m.id)).toEqual(['r1'])
    expect(chatStore.getState().messages.find(m => m.id === 'root')!.reply_count).toBe(1)
    handleWSMessage({ type: 'message_delete', message_id: 'x1', channel_id: 'c1', parent_id: null })
    expect(chatStore.getState().messages.map(m => m.id)).toEqual(['root'])
    expect(chatStore.getState().pins).toEqual([])
    // 열어 둔 스레드의 원문이 지워지면 패널이 닫힌다
    handleWSMessage({ type: 'message_delete', message_id: 'root', channel_id: 'c1', parent_id: null })
    expect(chatStore.getState().activeThreadId).toBeNull()
  })
  it('message_update — 고친 본문이 목록에 반영되고 리액션 등은 지킨다', () => {
    chatStore.setState({ selectedChannelId: 'c1', messages: [M({ id: 'e1', content: '전', reactions: [{ emoji: '👍', count: 1 }] })] as any, threadMessages: [], pins: [] })
    handleWSMessage({ type: 'message_update', message: { id: 'e1', channel_id: 'c1', content: '후', is_edited: true } })
    const m = chatStore.getState().messages[0] as any
    expect(m.content).toBe('후'); expect(m.is_edited).toBe(true); expect(m.reactions).toHaveLength(1)
  })
  it('재접속 보충분이 늦게 와도 seq 순서로 끼우고, 같은 메시지는 두 번 세지 않는다', () => {
    chatStore.setState({ selectedChannelId: 'c1', hasMoreAfter: false, activeThreadId: null, threadMessages: [],
      messages: [M({ id: 's100', seq: 100 })] as any,
      channels: [{ id: 'c2', name: 'x', type: 'public', unread_count: 0 }] as any })
    const other = { id: 'u9', username: 'z' }
    handleWSMessage({ type: 'new_message', message: M({ id: 's105', seq: 105, sender: other }) })
    handleWSMessage({ type: 'new_message', message: M({ id: 's102', seq: 102, sender: other }) })
    expect(chatStore.getState().messages.map(m => m.id)).toEqual(['s100', 's102', 's105'])
    const dup = M({ id: 'o1', seq: 106, channel_id: 'c2', sender: other })
    handleWSMessage({ type: 'new_message', message: dup })
    handleWSMessage({ type: 'new_message', message: dup })
    expect(chatStore.getState().channels.find(c => c.id === 'c2')!.unread_count).toBe(1)
  })
})

describe('호버 바 · 고정 줄', () => {
  it('최근 리액션 3 — 없으면 👍 👀 🎉', () => {
    expect(quickReactions([])).toEqual(['👍', '👀', '🎉'])
    expect(quickReactions(['🔥', ':ship_it:'])).toEqual(['🔥', ':ship_it:', '👍'])
  })
  it('고정 시스템 줄 메타', () => {
    expect(pinMetaOf({ file_meta: JSON.stringify({ kind: 'pin', message_id: 'm9', actor_id: 'u1' }) } as any)).toEqual({ kind: 'pin', message_id: 'm9', actor_id: 'u1' })
    expect(pinMetaOf({ file_meta: null } as any)).toBeNull()
  })
})
