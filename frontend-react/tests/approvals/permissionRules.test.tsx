// 허용·거부 규칙 창(Claude Code /permissions) — 이 대화 허용·항상 허용·거부를 보고 빼고 더한다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  respond: (_url: string, _opts?: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.respond(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { AiPermissionRules } = await import('~/components/ai/AiPermissionRules')
const { i18n } = await import('~/i18n')
const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)

const TOOLS = [
  { name: 'files_write_text', title: '텍스트 파일 만들기', risk: 'low' },
  { name: 'files_delete', title: '파일 지우기', risk: 'high' },
  { name: 'mail_send', title: '메일 보내기', risk: 'high' },
]

beforeEach(() => {
  api.calls = []
  api.respond = (url, opts) => {
    if (url === '/api/approvals/rules' && opts?.method === 'PUT') return opts.body
    if (url.startsWith('/api/approvals/rules/conversation/')) return { conversation: [] }
    return { allow: ['files_write_text'], deny: ['mail_send'], conversation: ['files_delete'], tools: TOOLS }
  }
})

describe('허용·거부 규칙 창', () => {
  it('세 묶음을 보여 주고, 항상 허용에서 빼면 PUT 으로 저장', async () => {
    render(<AiPermissionRules conversationId="c1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(t('ai.rules.allow'))).toBeTruthy())
    expect(api.calls[0].opts?.query).toEqual({ conversation_id: 'c1' })
    expect(document.body.textContent).toContain('파일 지우기')
    expect(document.body.textContent).toContain('메일 보내기')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('ai.rules.remove', { title: '텍스트 파일 만들기' }) })) })
    const put = api.calls.find(c => c.opts?.method === 'PUT')
    expect(put?.opts?.body).toEqual({ allow: [], deny: ['mail_send'] })
  })

  it('이 대화 허용 빼기 = DELETE', async () => {
    render(<AiPermissionRules conversationId="c1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(t('ai.rules.conversation'))).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('ai.rules.remove', { title: '파일 지우기' }) })) })
    expect(api.calls.some(c => c.url === '/api/approvals/rules/conversation/c1/files_delete' && c.opts?.method === 'DELETE')).toBe(true)
  })

  it('대화 밖(새 대화 전)에는 이 대화 묶음을 숨긴다', async () => {
    render(<AiPermissionRules conversationId={null} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(t('ai.rules.allow'))).toBeTruthy())
    expect(screen.queryByText(t('ai.rules.conversation'))).toBeNull()
  })
})
