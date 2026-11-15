// 공유 링크를 이메일로 보내기: 주소 규칙(lib/files) · 칩 입력 · 공유 모달(새 링크 + 보내기, 기존 링크 ⋮ 보내기·보낸 기록). $fetch 는 가짜.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

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

const { i18n } = await import('~/i18n')
const files = await import('~/composables/useFiles')
const lib = await import('~/lib/files')
const { FilesFileShareModal } = await import('~/components/files/FileShareModal')
const { setUser } = await import('~/composables/useAuth')
const { resetSharedState } = await import('~/lib/state')

const t = (k: string, p?: Record<string, unknown>) => i18n.t(k, p as any)
const item = (name: string) => ({ name, path: `my/${name}`, is_dir: false, size: 10, modified_at: null, mime_type: null }) as import('~/composables/useFiles').FileItem
const BOB = { id: 'bob', username: 'bob', display_name: 'Bob', email: 'bob@corp.test', avatar_url: null, is_self: false }

function inRouter(ui: React.ReactElement) {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

const link = (o: Record<string, unknown> = {}) => ({
  id: 'L1', token: 'tok', display_name: 'a.txt', file_path: 'my/a.txt', expires_at: null, max_downloads: null,
  download_count: 0, created_at: '2026-10-18T00:00:00Z', can_edit: false, has_password: false, allow_download: true,
  paths: ['my/a.txt'], email_count: 0, ...o,
})

beforeEach(() => {
  files._resetFilesStore()
  resetSharedState()
  api.calls = []
  api.handler = () => ({})
  setUser({ id: 'u1', username: 'me', display_name: '나', email: 'me@corp.test', primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('lib/files 이메일 규칙', () => {
  it('형식 검사·나누기·중복/한도', () => {
    expect(lib.isEmail('a@b.co')).toBe(true)
    expect(lib.isEmail('a@b')).toBe(false)
    expect(lib.isEmail('a b@c.d')).toBe(false)
    expect(lib.splitEmails(' a@b.co, c@d.co;e@f.co\nx ')).toEqual(['a@b.co', 'c@d.co', 'e@f.co', 'x'])
    const r = lib.addEmails(['a@b.co'], ['A@B.co', 'new@x.io', 'bad@'], 2)
    expect(r).toEqual({ list: ['a@b.co', 'new@x.io'], bad: ['bad@'], overflow: 0 })
    expect(lib.addEmails(['a@b.co', 'c@d.co'], ['e@f.co'], 2).overflow).toBe(1)
  })
  it('외부 추정 — 디렉터리 이메일·내 도메인이면 내부', () => {
    expect(lib.isExternalEmail('Bob@corp.test', ['bob@corp.test'], null)).toBe(false)
    expect(lib.isExternalEmail('new@corp.test', [], 'me@corp.test')).toBe(false)
    expect(lib.isExternalEmail('guest@example.com', ['bob@corp.test'], 'me@corp.test')).toBe(true)
  })
  it('linkMeta 에 메일 보낸 수', () => {
    const tr = (k: string, p?: Record<string, unknown>) => t(k, p)
    expect(lib.linkMeta({ ...link(), email_count: 3 }, tr)).toContain(t('files.linkMeta.emailed', { n: 3 }))
    expect(lib.linkMeta(link(), tr)).not.toContain(t('files.linkMeta.emailed', { n: 0 }))
  })
})

describe('공유 모달 — 이메일로 보내기', () => {
  it('새 링크: 칩(형식 오류 표시·외부 표시) → [링크 만들고 보내기] → 만들기 후 발송(비밀번호 안 보냄)', async () => {
    let links: any[] = []
    api.handler = (url, opts) => {
      if (url === '/api/auth/users') return [BOB]
      if (url === '/api/files/share/list') return links
      if (url === '/api/files/share' && opts.method === 'POST') { links = [link({ has_password: true })]; return { ...link({ has_password: true }), url: 'x' } }
      if (url === '/api/files/share/L1/email') {
        return { ok: true, sent: 2, failed: 0, results: [], items: [], limits: { per_send: 20, per_hour: 50, remaining: 48 } }
      }
      if (url.includes('share-user')) return { shares: [], owner: null }
      return []
    }
    inRouter(<FilesFileShareModal items={[item('a.txt')]} initialTab="link" />)
    const input = await screen.findByLabelText(t('files.shareEmail.label'))
    fireEvent.change(input, { target: { value: 'guest@example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: ',' })
    expect(await screen.findByText(t('files.shareEmail.badEmail', { email: 'nope' }))).toBeTruthy()
    // 형식 오류 글자가 남아 있으면 보내기 막힘
    const btn = screen.getByRole('button', { name: t('files.shareEmail.createSend', { n: 1 }) })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'bob@corp.test' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // 외부 표시는 guest 만
    expect(screen.getAllByText(t('files.shareEmail.external')).length).toBe(1)
    expect(screen.getByText('Bob')).toBeTruthy()

    // 비밀번호 켜면 "메일에 안 들어감" 안내
    fireEvent.click(screen.getByRole('switch', { name: t('files.shareModal.password') }))
    fireEvent.change(document.querySelector('input[autocomplete="new-password"]')!, { target: { value: 'pw1234' } })
    expect(screen.getByText(t('files.shareEmail.passwordNote'))).toBeTruthy()
    fireEvent.change(screen.getByLabelText(t('files.shareEmail.messageLabel')), { target: { value: '확인 부탁' } })

    fireEvent.click(screen.getByRole('button', { name: t('files.shareEmail.createSend', { n: 2 }) }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/files/share/L1/email')).toBe(true))
    const mail = api.calls.find(c => c.url === '/api/files/share/L1/email')!
    expect(mail.opts.body.emails).toEqual(['guest@example.com', 'bob@corp.test'])
    expect(mail.opts.body.message).toBe('확인 부탁')
    expect(JSON.stringify(mail.opts.body)).not.toContain('pw1234')
    expect(mail.opts.body.locale).toBeTruthy()
    const create = api.calls.find(c => c.url === '/api/files/share' && c.opts.method === 'POST')!
    expect(create.opts.body.password).toBe('pw1234')
  })

  it('기존 링크 ⋮ 이메일로 보내기 → 보낸 기록(외부·실패 표시) · 보내면 기록 갱신', async () => {
    const log = [
      { id: 'e1', email: 'guest@example.com', user_id: null, external: true, ok: true, sent_by: 'u1', sent_by_name: '나', created_at: '2026-10-18T01:00:00Z' },
      { id: 'e2', email: 'bob@corp.test', user_id: 'bob', external: false, ok: false, sent_by: 'bob', sent_by_name: 'Bob', created_at: '2026-10-18T00:30:00Z' },
    ]
    api.handler = (url) => {
      if (url === '/api/auth/users') return [BOB]
      if (url === '/api/files/share/list') return [link({ email_count: 1 })]
      if (url === '/api/files/share/L1/emails') return { items: log, limits: { per_send: 20, per_hour: 50, remaining: 7 } }
      if (url === '/api/files/share/L1/email') {
        return { ok: true, sent: 1, failed: 0, results: [{ email: 'new@example.com', ok: true, external: true, user_id: null }],
          items: [{ id: 'e3', email: 'new@example.com', user_id: null, external: true, ok: true, sent_by: 'u1', sent_by_name: '나', created_at: '2026-10-18T02:00:00Z' }, ...log],
          limits: { per_send: 20, per_hour: 50, remaining: 6 } }
      }
      if (url.includes('share-user')) return { shares: [], owner: null }
      return []
    }
    inRouter(<FilesFileShareModal items={[item('a.txt')]} initialTab="link" />)
    expect(await screen.findByText(new RegExp(t('files.linkMeta.emailed', { n: 1 })))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('files.shareModal.linkMenu') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('files.shareEmail.menu') }))
    expect(await screen.findByText('guest@example.com')).toBeTruthy()
    expect(screen.getByText('Bob · bob@corp.test')).toBeTruthy()
    expect(screen.getByText(t('files.shareEmail.logFailed'))).toBeTruthy()
    expect(screen.getByText(t('files.shareEmail.logBy', { name: 'Bob' }))).toBeTruthy()
    expect(screen.getByText(t('files.shareEmail.remaining', { n: 7 }))).toBeTruthy()

    const inputs = screen.getAllByLabelText(t('files.shareEmail.label'))
    const panelInput = inputs[0]
    fireEvent.change(panelInput, { target: { value: 'new@example.com' } })
    fireEvent.keyDown(panelInput, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: t('files.shareEmail.send', { n: 1 }) }))
    expect(await screen.findByText('new@example.com')).toBeTruthy()
    expect(screen.getByText(t('files.shareEmail.remaining', { n: 6 }))).toBeTruthy()
  })

  it('만료된 링크는 보내기 칸 대신 안내', async () => {
    api.handler = (url) => {
      if (url === '/api/files/share/list') return [link({ expires_at: '2020-01-01T00:00:00Z' })]
      if (url === '/api/files/share/L1/emails') return { items: [], limits: { per_send: 20, per_hour: 50, remaining: 50 } }
      if (url.includes('share-user')) return { shares: [], owner: null }
      return []
    }
    inRouter(<FilesFileShareModal items={[item('a.txt')]} initialTab="link" />)
    fireEvent.click(await screen.findByRole('button', { name: t('files.shareModal.linkMenu') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('files.shareEmail.menu') }))
    expect(await screen.findByText(t('files.shareEmail.inactive'))).toBeTruthy()
    expect(await screen.findByText(t('files.shareEmail.logEmpty'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('files.shareEmail.send', { n: 0 }) })).toBeNull()
  })
})
