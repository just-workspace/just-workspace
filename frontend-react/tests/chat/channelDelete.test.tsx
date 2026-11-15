// 채널 삭제 — 소유자에게만 머리 ⋯ "채널 삭제"(확인 후 DELETE). 예전엔 화면에 삭제·보관이 없어 지울 길이 없었다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({ calls: [] as { url: string; opts: any }[] }))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return { ok: true } }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { ChatHeader } = await import('~/components/chat/ChatHeader')
const { UiDialogHost } = await import('~/components/ui/DialogHost')
const { chatStore } = await import('~/composables/useChat')
const { setUser } = await import('~/composables/useAuth')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)

const ch = (o: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'qa', type: 'private', description: null, created_by: 'owner', is_archived: false, created_at: '', updated_at: '',
  member_count: 1, unread_count: 0, display_name: null, avatar_url: null, ...o,
})

beforeEach(() => { api.calls = [] })

function setup(me: string) {
  setUser({ id: me, username: me, display_name: me, email: null } as any)
  chatStore.setState({ channels: [ch()] as any, selectedChannelId: 'c1', members: [{ user_id: 'owner', username: 'owner', display_name: null, avatar_url: null, role: 'owner', is_online: true }] as any })
  renderInRouter(<><ChatHeader /><UiDialogHost /></>)
  fireEvent.click(screen.getByRole('button', { name: t('chat.header.menuLabel') }))
}

describe('ChatHeader 채널 삭제', () => {
  it('소유자: 확인 뒤 DELETE /api/chat/channels/{id}', async () => {
    setup('owner')
    fireEvent.click(await screen.findByText(t('chat.header.deleteChannel')))
    expect(await screen.findByText(t('chat.header.deleteConfirm', { name: 'qa' }))).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.delete') })) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/channels/c1' && c.opts.method === 'DELETE')).toBe(true))
    expect(chatStore.getState().selectedChannelId).toBeNull()
  })

  it('소유자가 아니면 항목 없음', async () => {
    setup('bob')
    await screen.findByText(t('chat.header.pins'))
    expect(screen.queryByText(t('chat.header.deleteChannel'))).toBeNull()
  })
})
