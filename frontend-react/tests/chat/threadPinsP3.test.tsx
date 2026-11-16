// 스레드 첫 답글 후 "따라가기" 알약이 즉시 "따라가는 중"으로 전환 · 고정 패널은 열 때마다 재조회하여 "고정한 사람" 표시
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const calls: string[] = []
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => { calls.push(url); return url.endsWith('/pins') ? { pins: [] } : {} }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { chatStore, sendThreadReply } = await import('~/composables/useChat')
const { ChatPinsPanel } = await import('~/components/chat/ChatPinsPanel')

describe('채팅 스레드·고정 패널', () => {
  it('답글을 보내면 activeThreadState.followed=true(서버 자동 팔로우와 맞춤)', () => {
    chatStore.setState({ selectedChannelId: 'c1', activeThreadId: 'p1', activeThreadState: { followed: false, unread_replies: 0, last_read_seq: null } as any })
    sendThreadReply('답', 'p1')
    expect(chatStore.getState().activeThreadState?.followed).toBe(true)
  })

  it('고정 패널: 이미 pins 가 있어도 열 때 다시 받는다', async () => {
    chatStore.setState({ selectedChannelId: 'c1', pins: [{ id: 'm1', content: 'x', channel_id: 'c1', parent_id: null, reply_count: 0 }] as any })
    render(<ChatPinsPanel />)
    await waitFor(() => expect(calls.some(u => u.includes('/pins'))).toBe(true))
  })
})
