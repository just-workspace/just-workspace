// AiAdminSettings(관리 › AI 의 본문, 주인 = AI 모듈): 설정·상태를 읽어 모델 행·상태 배지·도구 스위치를 그리고,
// 도구 묶음 스위치는 즉시 PUT /api/ai/governance(모두 허용이면 빈 목록). $fetch 는 가짜.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, act } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({ calls: [] as { url: string; opts?: any }[] }))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    if (url === '/api/ai/config' && !opts?.method) {
      return {
        kind: 'compatible', base_url: 'http://x', model: 'm1', advanced_model: '', max_tokens: 2048, external: false, has_key: false,
        governance: { allowed_tools: [], external_allow_data: false, allow_user_keys: false, daily_limit: 0, retention_days: 0 },
        available_tools: ['mail_search', 'files_read', 'web_search'], data_tools: ['mail_search'],
      }
    }
    if (url === '/api/ai/status') return { module_enabled: true }
    if (url === '/api/ai/config/test') return { ok: true, status: 'ok', ms: 2100, model: 'm1' }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { AiAdminSettings } = await import('~/components/ai/AiAdminSettings')
const { i18n } = await import('~/i18n')

beforeEach(() => { api.calls = [] })

describe('AiAdminSettings', () => {
  it('불러온 뒤 모델 행과 느림 배지, 읽기만으로는 저장 요청 없음', async () => {
    renderInRouter(<AiAdminSettings />)
    await waitFor(() => expect(screen.getByText(/m1/)).toBeTruthy())
    await waitFor(() => expect(screen.getByText(i18n.t('aiAdmin.status.slow', { s: '2.1' }))).toBeTruthy())
    expect(api.calls.some(c => c.opts?.method === 'PUT')).toBe(false)
  })

  it('웹 검색 끄기 → 즉시 거버넌스 저장(허용 목록 = 나머지)', async () => {
    renderInRouter(<AiAdminSettings />)
    const sw = await screen.findByRole('switch', { name: i18n.t('aiAdmin.webSearch') })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(sw) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/governance')).toBe(true))
    const put = api.calls.find(c => c.url === '/api/ai/governance')!
    expect(put.opts.method).toBe('PUT')
    expect(put.opts.body.allowed_tools).toEqual(['mail_search', 'files_read'])
  })
})
