import { describe, it, expect } from 'vitest'
import {
  applyChannelPrefs,
  applyChannelUnread,
  applyDraftUpdate,
  applyPinUpdate,
  applyPresence,
  applyThreadFollow,
  applyThreadRead,
  applyThreadUpdate,
  bumpThreadMeta,
  collectLocalDrafts,
  countThreadUnread,
  draftKey,
  draftsFromList,
  isChannelBold,
  isMainTimelineMessage,
  presenceFromEvent,
  presencesFromSnapshot,
  replaceMessage,
  summarizeUnread,
  type ChannelLike,
  type ThreadSummary,
} from '~/lib/chatEvents'

// 채팅 WS 이벤트 → 상태 리듀서. 백엔드 이벤트 형태는 backend/tests/test_chat_prereq.py 와 일치시킨다.

function ch(id: string, over: Partial<ChannelLike> = {}): ChannelLike {
  return { id, type: 'public', unread_count: 0, mention_count: 0, group_mention: false, last_read_seq: 0, notify_level: 'mentions', muted: false, ...over }
}

function thread(id: string, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id, channel_id: 'c1', channel_name: 'general', channel_type: 'public', sender_id: 'alice', sender_name: 'Alice',
    content: 'root', created_at: '2026-10-01T00:00:00Z', reply_count: 1, unread_replies: 0, followed: true,
    last_read_seq: 10, last_reply: { id: 'r1', seq: 10, sender_id: 'bob', sender_name: 'Bob', content: 'first', created_at: '2026-10-01T01:00:00Z' },
    ...over,
  }
}

describe('안 읽음 · 알림 설정', () => {
  it('channel_unread 는 되감은 포인터와 배지를 그대로 반영한다', () => {
    const before = [ch('a', { unread_count: 0 }), ch('b')]
    const out = applyChannelUnread(before, { channel_id: 'a', seq: 41, unread_count: 2, mention_count: 1, group_mention: false })
    expect(out[0]).toMatchObject({ unread_count: 2, mention_count: 1, group_mention: false, last_read_seq: 41 })
    expect(out[1]).toBe(before[1])                     // 다른 채널 객체는 그대로
    expect(applyChannelUnread(before, { channel_id: 'zzz', seq: 1, unread_count: 1, mention_count: 0, group_mention: false })).toBe(before)
  })

  it('channel_prefs 는 바뀐 것이 없으면 같은 배열을 돌려준다', () => {
    const before = [ch('a')]
    expect(applyChannelPrefs(before, { channel_id: 'a', notify_level: 'mentions', muted: false })).toBe(before)
    const out = applyChannelPrefs(before, { channel_id: 'a', notify_level: 'all', muted: true })
    expect(out[0]).toMatchObject({ notify_level: 'all', muted: true })
  })

  it('뮤트는 굵게에서만 빠지고 멘션 숫자는 남는다 (백엔드 규칙)', () => {
    const list = [
      ch('loud', { unread_count: 3, mention_count: 1 }),
      ch('quiet', { unread_count: 5, mention_count: 2, muted: true }),
      ch('dm1', { type: 'dm', unread_count: 2 }),
      ch('dm2', { type: 'dm', unread_count: 4, muted: true }),
    ]
    expect(isChannelBold(list[0])).toBe(true)
    expect(isChannelBold(list[1])).toBe(false)
    const s = summarizeUnread(list)
    expect(s.totalUnread).toBe(3 + 2)                  // 뮤트 채널·뮤트 DM 제외
    expect(s.totalMentions).toBe(1 + 2 + 2)            // 멘션은 뮤트와 무관, DM 미읽음은 뮤트 아닌 것만
    expect(s.boldChannelIds).toEqual(['loud', 'dm1'])
  })
})

describe('프레즌스', () => {
  it('구서버(status 만)와 신서버(state·emoji·text) 이벤트를 같은 모양으로 받는다', () => {
    expect(presenceFromEvent({ user_id: 'u', status: 'online' })).toEqual({ state: 'online', emoji: null, text: null })
    expect(presenceFromEvent({ user_id: 'u', status: 'offline' })).toEqual({ state: 'offline', emoji: null, text: null })
    expect(presenceFromEvent({ user_id: 'u', status: 'online', state: 'dnd', emoji: '🔕', text: '집중' }))
      .toEqual({ state: 'dnd', emoji: '🔕', text: '집중' })
  })

  it('같은 상태면 맵을 그대로 돌려준다', () => {
    const before = { u: { state: 'away' as const, emoji: null, text: null } }
    expect(applyPresence(before, { user_id: 'u', state: 'away' })).toBe(before)
    expect(applyPresence(before, { user_id: 'u', state: 'online' }).u.state).toBe('online')
  })

  it('스냅샷 — statuses 가 없는 구서버 응답도 온라인 목록으로 채운다', () => {
    const a = presencesFromSnapshot({ online_user_ids: ['x'], statuses: { x: { state: 'dnd', emoji: null, text: null }, y: { state: 'offline', emoji: '🏖', text: '휴가' } } })
    expect(a.presences.x.state).toBe('dnd')
    expect(a.presences.y).toEqual({ state: 'offline', emoji: '🏖', text: '휴가' })
    expect([...a.online]).toEqual(['x'])
    const b = presencesFromSnapshot({ online_user_ids: ['x'] })
    expect(b.presences.x.state).toBe('online')
  })
})

describe('메시지 · 핀', () => {
  it('채널에도 보내기 한 답글만 메인 타임라인에 보인다', () => {
    expect(isMainTimelineMessage({ id: 'm', channel_id: 'c', parent_id: null })).toBe(true)
    expect(isMainTimelineMessage({ id: 'm', channel_id: 'c', parent_id: 'root' })).toBe(false)
    expect(isMainTimelineMessage({ id: 'm', channel_id: 'c', parent_id: 'root', thread_broadcast: true })).toBe(true)
  })

  it('message_update 는 서버 dict 에 없는 필드(reactions 등)를 지킨다', () => {
    const list = [{ id: 'm1', content: 'a', pinned_at: null as string | null, reactions: [{ emoji: '👍' }] }]
    const out = replaceMessage(list, { id: 'm1', content: 'a', pinned_at: '2026-10-15T00:00:00Z' })
    expect(out[0].pinned_at).toBe('2026-10-15T00:00:00Z')
    expect(out[0].reactions).toEqual([{ emoji: '👍' }])
    expect(replaceMessage(list, { id: 'nope' })).toBe(list)
  })

  it('핀 목록 — 새 핀은 맨 앞, 풀리면 빠지고, 다른 채널 것은 안 들어온다', () => {
    const p = (id: string, channel = 'c1', pinned = true) => ({ id, channel_id: channel, parent_id: null, pinned_at: pinned ? 't' : null })
    let pins = applyPinUpdate([p('m1')], p('m2'), 'c1')
    expect(pins.map(x => x.id)).toEqual(['m2', 'm1'])
    pins = applyPinUpdate(pins, p('m1', 'c1', false), 'c1')
    expect(pins.map(x => x.id)).toEqual(['m2'])
    expect(applyPinUpdate(pins, p('m9', 'other'), 'c1')).toBe(pins)
    expect(applyPinUpdate(pins, p('m8', 'c1', false), 'c1')).toBe(pins)
  })
})

describe('스레드', () => {
  it('thread_update 는 답글 수·미읽음·마지막 답글을 갱신하고 맨 위로 올린다', () => {
    const before = [thread('old', { last_reply: { id: 'o1', seq: 50, sender_id: 'x', sender_name: 'X', content: '', created_at: '2026-10-02T00:00:00Z' } }), thread('t1')]
    const out = applyThreadUpdate(before, {
      root_id: 't1', channel_id: 'c1', unread_replies: 1,
      reply: { id: 'r2', seq: 60, channel_id: 'c1', parent_id: 't1', content: 'second', created_at: '2026-10-03T00:00:00Z', sender: { id: 'carol', username: 'carol', display_name: 'Carol' } },
    })
    expect(out[0].id).toBe('t1')
    expect(out[0]).toMatchObject({ reply_count: 2, unread_replies: 1 })
    expect(out[0].last_reply).toMatchObject({ id: 'r2', seq: 60, sender_name: 'Carol' })
    // 동일 답글이 2회 수신되어도(new_message 와 thread_update) 답글 수는 1회만 증가
    expect(applyThreadUpdate(out, { root_id: 't1', channel_id: 'c1', unread_replies: 1, reply: out[0].last_reply! as any })[0].reply_count).toBe(2)
    // 목록에 없는 스레드면 그대로 반환(호출자가 재조회)
    expect(applyThreadUpdate(before, { root_id: 'new', channel_id: 'c1', unread_replies: 1, reply: { id: 'r', channel_id: 'c1', parent_id: 'new', content: '', created_at: 't' } })).toBe(before)
  })

  it('thread_read 는 마지막 답글에 닿았을 때만 미읽음을 0 으로', () => {
    const before = [thread('t1', { unread_replies: 2, last_read_seq: 5 })]
    expect(applyThreadRead(before, { root_id: 't1', seq: 10 })[0]).toMatchObject({ unread_replies: 0, last_read_seq: 10 })
    expect(applyThreadRead(before, { root_id: 't1', seq: 7 })[0]).toMatchObject({ unread_replies: 2, last_read_seq: 7 })
    const done = [thread('t1', { unread_replies: 0, last_read_seq: 10 })]
    expect(applyThreadRead(done, { root_id: 't1', seq: 10 })).toBe(done)
  })

  it('thread_follow — 끊으면 목록에서 빠지고, 켰는데 없으면 그대로', () => {
    const before = [thread('t1'), thread('t2')]
    expect(applyThreadFollow(before, { root_id: 't1', channel_id: 'c1', followed: false }).map(t => t.id)).toEqual(['t2'])
    expect(applyThreadFollow(before, { root_id: 'new', channel_id: 'c1', followed: true })).toBe(before)
    expect(applyThreadFollow(before, { root_id: 'nope', channel_id: 'c1', followed: false })).toBe(before)
  })

  it('목록으로 셸 배지를 다시 센다', () => {
    expect(countThreadUnread([thread('a', { unread_replies: 2 }), thread('b'), thread('c', { unread_replies: 1 })]))
      .toEqual({ threads: 2, replies: 3 })
  })
})

describe('임시글', () => {
  it('키는 채널, 스레드는 채널:루트', () => {
    expect(draftKey('c1')).toBe('c1')
    expect(draftKey('c1', null)).toBe('c1')
    expect(draftKey('c1', 'root')).toBe('c1:root')
  })

  it('draft_update — 내용이 같으면(발신 기기 에코) 같은 참조를 돌려준다', () => {
    const before = draftsFromList([{ channel_id: 'c1', parent_id: null, content: '쓰는 중', updated_at: 't0' }])
    expect(applyDraftUpdate(before, { channel_id: 'c1', parent_id: null, content: '쓰는 중', updated_at: 't1' })).toBe(before)
    // 아직 PUT 되지 않은 본 기기 입력값과 동일한 것도 무시
    expect(applyDraftUpdate(before, { channel_id: 'c1', parent_id: null, content: '쓰는 중...', updated_at: 't1' }, '쓰는 중...')).toBe(before)
    // 다른 기기의 변경은 수용
    const out = applyDraftUpdate(before, { channel_id: 'c1', parent_id: null, content: '다른 기기', updated_at: 't2' })
    expect(out.c1.content).toBe('다른 기기')
  })

  it('draft_update content null 은 삭제(전송 뒤 서버 정리)', () => {
    const before = draftsFromList([
      { channel_id: 'c1', parent_id: null, content: 'a', updated_at: null },
      { channel_id: 'c1', parent_id: 'root', content: 'b', updated_at: null },
    ])
    const out = applyDraftUpdate(before, { channel_id: 'c1', parent_id: null, content: null, updated_at: null })
    expect(Object.keys(out)).toEqual(['c1:root'])
    expect(applyDraftUpdate(out, { channel_id: 'c1', parent_id: null, content: null, updated_at: null })).toBe(out)
    // 본 기기가 이미 비웠으면(전송 직후) 처리 불필요
    expect(applyDraftUpdate(before, { channel_id: 'c1', parent_id: null, content: null, updated_at: null }, '')).toBe(before)
  })

  it('예전 localStorage 임시글을 걷어 온다 (빈 것·다른 키는 건너뛴다)', () => {
    const store = new Map<string, string>([
      ['chat-draft-c1', '남은 글'],
      ['chat-draft-c2', '   '],
      ['jw-chat-outbox', '[]'],
    ])
    const fake = {
      get length() { return store.size },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
    }
    expect(collectLocalDrafts(fake)).toEqual([{ key: 'chat-draft-c1', channelId: 'c1', content: '남은 글' }])
  })
})

describe('bumpThreadMeta', () => {
  const u = (id: string) => ({ id, username: id, display_name: null, avatar_url: null })
  it('답글 수·마지막 시각을 올리고 보낸 사람을 맨 앞으로(중복 없이 최대 5명)', () => {
    const root = { id: 'r', reply_count: 2, last_reply_at: 'a', thread_participants: [u('b'), u('c'), u('d'), u('e'), u('f')] }
    const out = bumpThreadMeta(root, { created_at: 'z', sender: u('d') })
    expect(out.reply_count).toBe(3)
    expect(out.last_reply_at).toBe('z')
    expect(out.thread_participants.map(p => p.id)).toEqual(['d', 'b', 'c', 'e', 'f'])
    const out2 = bumpThreadMeta(out, { created_at: 'zz', sender: u('g') })
    expect(out2.thread_participants.map(p => p.id)).toEqual(['g', 'd', 'b', 'c', 'e'])
  })
  it('참여자 정보가 없던 루트도 첫 답글로 채운다', () => {
    const out = bumpThreadMeta({ id: 'r', reply_count: 0 } as { id: string; reply_count: number; thread_participants?: ReturnType<typeof u>[] }, { created_at: 't', sender: u('a') })
    expect(out.thread_participants?.map(p => p.id)).toEqual(['a'])
  })
})
