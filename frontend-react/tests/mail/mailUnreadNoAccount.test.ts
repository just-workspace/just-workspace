// 메일 계정이 없는 사용자 — 셸 안 읽음 점 폴러가 /api/mail/mailboxes(404)를 호출하지 않음(화면마다 콘솔 404 발생 회귀)
import { describe, it, expect, vi } from 'vitest'

const calls: string[] = []
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => { calls.push(url); return url === '/api/mail/accounts' ? [] : { mailboxes: [] } }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { refreshMailUnread, mailUnreadStore } = await import('~/composables/useMailUnread')
const { setUser } = await import('~/composables/useAuth')

describe('메일 안 읽음 폴러 · 계정 없음', () => {
  it('계정 목록이 비면 mailboxes 를 부르지 않고, 다음 주기에도 다시 묻지 않는다', async () => {
    setUser({ id: 'u1', username: 'qa', display_name: 'QA', email: null } as any)
    await refreshMailUnread()
    await refreshMailUnread()
    expect(calls).toEqual(['/api/mail/accounts'])
    expect(mailUnreadStore.getState().count).toBeNull()
  })
})
