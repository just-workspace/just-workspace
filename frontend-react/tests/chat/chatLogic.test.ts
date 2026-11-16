// 채팅 모듈 순수 로직 — chatMarkdown · useChatAttachments · useChatUi · chatStage
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mentionsMe, renderChatMarkdown, GROUP_MENTIONS } from '~/utils/chatMarkdown'
import {
  addFiles, buildFileMeta, chatAttachmentsStore, clear, formatChatFileSize, normalizeName, remove, selectTray,
} from '~/composables/useChatAttachments'
import { chatListTime, chatClock, chatUiStore, dmPartner, initialOf, openFilePicker } from '~/composables/useChatUi'
import { chatStore } from '~/composables/useChat'
import { depthOf, sameStage, stageFromQuery, stageFromState } from '~/utils/chatStage'

describe('chatMarkdown', () => {
  it('나·채널 전원 멘션만 강조 대상', () => {
    expect(mentionsMe('안녕 @kim', 'kim')).toBe(true)
    expect(mentionsMe('안녕 @lee', 'kim')).toBe(false)
    expect(mentionsMe('@채널 공지', 'kim')).toBe(true)
    expect(mentionsMe('메일 a@kim.com', 'kim')).toBe(false)
    expect(GROUP_MENTIONS.has('here')).toBe(true)
  })
  it('굵게·코드·링크·인용·멘션 칩', () => {
    // happy-dom 의 DOMPurify 는 선두 노드를 누락하는 경우가 있음(브라우저는 해당 없음) — 앞에 폐기용 요소를 배치
    const html = renderChatMarkdown('`z` a **굵게** `x<y` https://ex.com\n> 인용 @kim', { me: 'kim' })
    expect(html).toContain('<strong>굵게</strong>')
    expect(html).toContain('<code class="chat-inline-code">x&lt;y</code>')
    expect(html).toContain('href="https://ex.com"')
    expect(html).toContain('<blockquote class="chat-quote">')
    expect(html).toContain('chat-mention chat-mention-me')
  })
  it('스크립트는 지운다', () => {
    const html = renderChatMarkdown('a <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('useChatAttachments', () => {
  beforeEach(() => {
    chatAttachmentsStore.setState({ attachments: [] })
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x')
    globalThis.URL.revokeObjectURL = vi.fn()
  })
  it('크기 표기', () => {
    expect(formatChatFileSize(0)).toBe('0 B')
    expect(formatChatFileSize(1536)).toBe('1.5 KB')
    expect(formatChatFileSize(5 * 1048576)).toBe('5.0 MB')
    expect(formatChatFileSize(3 * 1073741824)).toBe('3.00 GB')
  })
  it('붙여넣은 image.png 는 시각 이름으로', () => {
    const f = new File(['x'], 'image.png', { type: 'image/png' })
    expect(normalizeName(f, true)).toMatch(/^paste-\d{8}-\d{6}\.png$/)
    expect(normalizeName(f, false)).toBe('image.png')
  })
  it('스레드 첨부는 대기(queued)로만 들어가고 채널·루트별로 나뉜다', () => {
    const f = new File(['abc'], 'a.txt', { type: 'text/plain' })
    const [a] = addFiles('ch1', [f], { parentId: 'root1' })
    expect(a.status).toBe('queued')
    expect(a.isImage).toBe(false)
    const all = chatAttachmentsStore.getState().attachments
    expect(selectTray(all, 'ch1', 'root1')).toHaveLength(1)
    expect(selectTray(all, 'ch1', null)).toHaveLength(0)
    expect(selectTray(all, null)).toHaveLength(0)
    remove(a.id)
    expect(chatAttachmentsStore.getState().attachments).toHaveLength(0)
  })
  it('파일 메타는 완료된 것만', () => {
    const f = new File(['abc'], 'a.png', { type: 'image/png' })
    const [a] = addFiles('ch1', [f], { parentId: 'r' })
    expect(buildFileMeta(a)).toBeNull()
    const done = { ...a, result: { path: 'shared/chat/ch1/a.png', name: 'a.png', size: 3 } }
    expect(JSON.parse(buildFileMeta(done)!)).toEqual({ path: 'shared/chat/ch1/a.png', name: 'a.png', size: 3, mime_type: 'image/png' })
    clear([a.id])
    expect(chatAttachmentsStore.getState().attachments).toHaveLength(0)
  })
})

describe('useChatUi', () => {
  it('DM 상대 · 이니셜', () => {
    const users = [{ id: '1', username: 'kim', display_name: '김', avatar_url: null }, { id: '2', username: 'lee', display_name: null, avatar_url: null }]
    expect(dmPartner({ name: 'kim,lee', type: 'dm' }, users, 'kim')?.id).toBe('2')
    expect(dmPartner({ name: 'kim,lee', type: 'public' }, users, 'kim')).toBeNull()
    expect(initialOf('kim')).toBe('K')
    expect(initialOf(null)).toBe('?')
  })
  it('파일 선택 요청은 숫자를 올린다', () => {
    const n = chatUiStore.getState().filePickerTick
    openFilePicker()
    expect(chatUiStore.getState().filePickerTick).toBe(n + 1)
  })
  it('목록 시각: 오늘은 HH:MM, 어제는 "어제"', () => {
    const t = (k: string) => (k === 'common.yesterday' ? '어제' : k)
    const now = new Date()
    expect(chatListTime(now.toISOString(), t)).toMatch(/\d{2}:\d{2}/)
    const y = new Date(now); y.setDate(y.getDate() - 1)
    expect(chatListTime(y.toISOString(), t)).toBe('어제')
    expect(chatListTime(null, t)).toBe('')
    expect(chatClock(now.toISOString())).toMatch(/\d{2}:\d{2}/)
  })
})

describe('chatStage — 모바일 단계 ↔ 주소', () => {
  beforeEach(() => {
    chatStore.setState({ selectedChannelId: null, activeThreadId: null, showSearchPanel: false, showMemberPanel: false, showPinsPanel: false })
    chatUiStore.setState({ collection: null })
  })
  it('상태 → 단계', () => {
    expect(stageFromState()).toEqual({})
    chatStore.setState({ selectedChannelId: 'c1', activeThreadId: 't1' })
    expect(stageFromState()).toEqual({ channel: 'c1', thread: 't1' })
    chatStore.setState({ activeThreadId: null, showPinsPanel: true })
    expect(stageFromState()).toEqual({ channel: 'c1', panel: 'pins' })
    chatStore.setState({ selectedChannelId: null, showPinsPanel: false })
    chatUiStore.setState({ collection: 'saved' })
    expect(stageFromState()).toEqual({ view: 'saved' })
  })
  it('주소 → 단계(모르는 값은 버린다) · 깊이 · 같음', () => {
    expect(stageFromQuery({ channel: 'c1', view: 'bogus', panel: 'x', other: '1' })).toEqual({ channel: 'c1' })
    expect(depthOf({})).toBe(0)
    expect(depthOf({ view: 'threads' })).toBe(1)
    expect(depthOf({ channel: 'c', thread: 't' })).toBe(2)
    expect(sameStage({ channel: 'c' }, { channel: 'c', thread: '' })).toBe(true)
    expect(sameStage({ channel: 'c' }, { channel: 'd' })).toBe(false)
  })
})
