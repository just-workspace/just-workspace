// R5 cal-admin — 시간대 띠(A1) · 구독 추가 모달(A2) · SSL 올리기 모달(A2) · 브랜딩 다크 자동 조정 줄(B9)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { i18n } from '~/i18n'

const apiMock = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('~/lib/api', async (orig) => ({ ...(await orig<any>()), $fetch: apiMock.fetch }))

import { keepTzBand, roParticle, tzBandKept, tzCity, tzMismatch, tzPlace, TZ_CITY_KO, utcOffsetLabel } from '~/utils/timezoneBand'
import { CalendarSubscribeModal, subscribeErrorKey, yearRange } from '~/components/calendar/CalendarSubscribeModal'
import { AdminSslUploadModal, sslErrorKey, uploadErrorField } from '~/components/admin/AdminSslUploadModal'
import { brandContrast } from '~/components/admin/brandingContrast'
import { resolveBrandTheme } from '~/lib/brandColor'

const t = (k: string, p?: any) => i18n.t(k, p)
const JAN = new Date('2026-01-15T12:00:00Z') // 서머타임 아님(LA = UTC−8)

describe('시간대 띠 — 순수 함수', () => {
  it('UTC 표기는 U+2212 음수 · 30분 단위', () => {
    expect(utcOffsetLabel('Asia/Seoul', JAN)).toBe('UTC+9')
    expect(utcOffsetLabel('America/Los_Angeles', JAN)).toBe('UTC−8')
    expect(utcOffsetLabel('Asia/Kolkata', JAN)).toBe('UTC+5:30')
    expect(utcOffsetLabel('UTC', JAN)).toBe('UTC')
  })
  it('도시 이름 · 실제로 쓰는 시간대', () => {
    expect(tzCity('America/Los_Angeles')).toBe('Los Angeles')
    expect(tzCity('UTC')).toBe('UTC')
  })
  it('ko 로케일만 주요 도시 한글(핸드오프 15-2), 표에 없으면 영문 · 이름만 쓰는 자리는 + UTC 오프셋', () => {
    expect(tzCity('America/Los_Angeles', 'ko')).toBe('로스앤젤레스')
    expect(tzCity('Asia/Seoul', 'ko')).toBe('서울')
    expect(tzCity('America/Argentina/Buenos_Aires', 'ko')).toBe('부에노스아이레스')
    expect(tzCity('America/Los_Angeles', 'en')).toBe('Los Angeles')
    expect(tzCity('Asia/Almaty', 'ko')).toBe('Almaty')
    expect(tzPlace('Asia/Almaty', 'ko', JAN)).toBe('Almaty (UTC+5)')
    expect(tzPlace('Asia/Almaty', 'en', JAN)).toBe('Almaty')
    expect(tzPlace('Europe/London', 'ko', JAN)).toBe('런던')
    expect(tzPlace('UTC', 'ko', JAN)).toBe('UTC')
    expect(Object.keys(TZ_CITY_KO).length).toBeGreaterThanOrEqual(40)
    // 표의 이름은 모두 실제 IANA 시간대(오타 방지)
    for (const z of Object.keys(TZ_CITY_KO)) expect(() => new Intl.DateTimeFormat('en', { timeZone: z })).not.toThrow()
  })
  it('(으)로 조사', () => {
    expect(roParticle('런던')).toBe('으로')
    expect(roParticle('서울')).toBe('로')
    expect(roParticle('도쿄')).toBe('로')
    expect(roParticle('Almaty (UTC+5)')).toBe('로')
  })
  it('설정이 비었거나 같은 오프셋이면 띄우지 않는다', () => {
    expect(tzMismatch('', 'America/Los_Angeles', JAN)).toBe(false)
    expect(tzMismatch('Asia/Seoul', 'Asia/Seoul', JAN)).toBe(false)
    expect(tzMismatch('Asia/Tokyo', 'Asia/Seoul', JAN)).toBe(false)
    expect(tzMismatch('Asia/Seoul', 'America/Los_Angeles', JAN)).toBe(true)
  })
  it('"그대로" 는 그 (설정, 기기) 조합만 기억한다', () => {
    localStorage.clear()
    expect(tzBandKept('Asia/Seoul', 'America/Los_Angeles')).toBe(false)
    keepTzBand('Asia/Seoul', 'America/Los_Angeles')
    expect(tzBandKept('Asia/Seoul', 'America/Los_Angeles')).toBe(true)
    expect(tzBandKept('Asia/Seoul', 'Europe/London')).toBe(false)
    expect(tzBandKept('Asia/Tokyo', 'America/Los_Angeles')).toBe(false)
  })
})

describe('구독 추가 모달', () => {
  beforeEach(() => { apiMock.fetch.mockReset() })

  it('연도 · 오류 문구 키', () => {
    expect(yearRange({ first_year: 2026, last_year: 2027 })).toBe('2026–2027')
    expect(yearRange({ first_year: 2026, last_year: 2026 })).toBe('2026')
    expect(yearRange({ first_year: null, last_year: null })).toBe('')
    expect(subscribeErrorKey('blocked')).toBe('calendar.subscribe.readError')
    expect(subscribeErrorKey('404')).toBe('calendar.subscribe.readError')
    expect(subscribeErrorKey('duplicate')).toBe('calendar.subscribe.duplicate')
    expect(subscribeErrorKey('scheme')).toBe('calendar.subscribe.invalidUrl')
  })

  it('칸을 벗어나면 읽고 → 확인 줄 · 이름 자동 채움 → 구독 추가', async () => {
    apiMock.fetch.mockImplementation(async (url: string, opts: any) => {
      if (url.endsWith('/preview')) return { url: 'https://cal.example.com/kr.ics', name: '대한민국 공휴일', count: 48, first_year: 2026, last_year: 2027 }
      return { id: 'c1', name: opts.body.name, color: opts.body.color, url: opts.body.url, fetched_at: null, checked_at: null, error: null }
    })
    const onAdded = vi.fn()
    const onClose = vi.fn()
    render(<CalendarSubscribeModal existingCount={4} onAdded={onAdded} onClose={onClose} />)
    const submit = screen.getByRole('button', { name: t('calendar.subscribe.submit') }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    const input = screen.getByLabelText(t('calendar.subscribe.url'))
    fireEvent.change(input, { target: { value: 'webcal://cal.example.com/kr.ics' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.getByText('2026–2027')).toBeTruthy())
    expect(apiMock.fetch).toHaveBeenCalledWith('/api/calendar/subscriptions/preview', { method: 'POST', body: { url: 'webcal://cal.example.com/kr.ics' } })
    expect((screen.getByLabelText(t('calendar.subscribe.name')) as HTMLInputElement).value).toBe('대한민국 공휴일')
    // 기본 색 = 순번 5번째 → 범주 5
    expect(screen.getByRole('radio', { name: t('common.cat.5') }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: t('common.cat.2') }))
    expect(submit.disabled).toBe(false)
    await act(async () => { fireEvent.click(submit) })
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    const body = apiMock.fetch.mock.calls[1][1].body
    expect(body).toEqual({ url: 'https://cal.example.com/kr.ics', name: '대한민국 공휴일', color: '#21835f' })
    expect(onClose).toHaveBeenCalled()
  })

  it('읽는 중… 은 확인 줄과 같은 자리·같은 상자에 스피너로(핸드오프 15-3)', async () => {
    let resolve!: (v: unknown) => void
    apiMock.fetch.mockImplementation(() => new Promise(r => { resolve = r }))
    render(<CalendarSubscribeModal onClose={() => {}} />)
    const input = screen.getByLabelText(t('calendar.subscribe.url'))
    fireEvent.change(input, { target: { value: 'https://cal.example.com/kr.ics' } })
    fireEvent.blur(input)
    const row = await screen.findByRole('status')
    expect(row.textContent).toContain(t('calendar.subscribe.reading'))
    expect(row.querySelector('.animate-spin')).toBeTruthy()
    const cls = row.className
    await act(async () => { resolve({ url: 'https://cal.example.com/kr.ics', name: null, count: 3, first_year: null, last_year: null }) })
    const row2 = screen.getByRole('status')
    expect(row2).toBe(row)   // 같은 요소(자리 그대로) — 내용만 바뀜
    expect(row2.className).toBe(cls)
    expect(row2.querySelector('.animate-spin')).toBeNull()
    expect(row2.textContent).not.toContain(t('calendar.subscribe.reading'))
  })

  it('못 읽으면 주소 칸 오류 · 이름·색 칸 없음 · [구독 추가] 비활성', async () => {
    apiMock.fetch.mockRejectedValue({ data: { detail: { code: 'blocked', message: 'x' } } })
    render(<CalendarSubscribeModal onClose={() => {}} />)
    const input = screen.getByLabelText(t('calendar.subscribe.url'))
    fireEvent.change(input, { target: { value: 'https://intranet.local/team.ics' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.getByText(t('calendar.subscribe.readError'))).toBeTruthy())
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByLabelText(t('calendar.subscribe.name'))).toBeNull()
    expect((screen.getByRole('button', { name: t('calendar.subscribe.submit') }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SSL 인증서 올리기 모달', () => {
  beforeEach(() => { apiMock.fetch.mockReset() })

  it('오류 코드 → 칸', () => {
    expect(sslErrorKey('key_mismatch')).toBe('admin.sslUpload.error.key_mismatch')
    expect(sslErrorKey('weird')).toBe('admin.sslUpload.error.read_failed')
    expect(uploadErrorField('key_encrypted')).toBe('key')
    expect(uploadErrorField('domain_mismatch')).toBe('cert')
  })

  const certInfo = { domains: ['*.example.com', 'example.com'], subject_cn: '*.example.com', issuer: 'Example Trust CA', not_before: '2026-01-01T00:00:00+00:00', not_after: '2099-01-14T00:00:00+00:00' }

  it('인증서를 고르면 정보 상자 · 키 짝이 맞을 때만 [올리고 적용]', async () => {
    apiMock.fetch.mockImplementation(async (url: string, opts: any) => {
      if (url.endsWith('/inspect')) {
        const hasKey = opts.body.has('key')
        return { cert: certInfo, cert_error: null, key_error: null, key_match: hasKey ? true : null, domain: 'example.com', domain_match: true, ok: hasKey }
      }
      return { message: 'ok' }
    })
    const onUploaded = vi.fn()
    const { container } = render(<AdminSslUploadModal onUploaded={onUploaded} onClose={() => {}} />)
    const apply = screen.getByRole('button', { name: t('admin.sslUpload.submit') }) as HTMLButtonElement
    const [certInput, keyInput] = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[]
    fireEvent.change(certInput, { target: { files: [new File(['c'], 'fullchain.pem')] } })
    await waitFor(() => expect(screen.getByText('*.example.com, example.com')).toBeTruthy())
    expect(screen.getByText('Example Trust CA')).toBeTruthy()
    expect(screen.getByText('fullchain.pem')).toBeTruthy()
    expect(apply.disabled).toBe(true)
    fireEvent.change(keyInput, { target: { files: [new File(['k'], 'privkey.pem')] } })
    await waitFor(() => expect(apply.disabled).toBe(false))
    await act(async () => { fireEvent.click(apply) })
    await waitFor(() => expect(onUploaded).toHaveBeenCalled())
    expect(container).toBeTruthy()
  })

  it('짝 불일치·도메인 불일치는 그 칸 오류, [올리고 적용] 비활성', async () => {
    apiMock.fetch.mockResolvedValue({ cert: { ...certInfo, domains: ['other.example.org'] }, cert_error: 'domain_mismatch', key_error: 'key_mismatch', key_match: false, domain: 'example.com', domain_match: false, ok: false })
    render(<AdminSslUploadModal onClose={() => {}} />)
    const [certInput, keyInput] = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[]
    fireEvent.change(certInput, { target: { files: [new File(['c'], 'c.pem')] } })
    fireEvent.change(keyInput, { target: { files: [new File(['k'], 'k.pem')] } })
    await waitFor(() => expect(screen.getByText(t('admin.sslUpload.error.key_mismatch'))).toBeTruthy())
    expect(screen.getByText(t('admin.sslUpload.error.domain_mismatch', { domain: 'example.com' }))).toBeTruthy()
    expect((screen.getByRole('button', { name: t('admin.sslUpload.submit') }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('B9 — "다크에서 자동 조정됨" 줄은 조정됐을 때만', () => {
  it('다크에서 조정 안 되는 색은 darkAdjusted = null', () => {
    for (const hex of ['#29A376', '#8C56D2', '#CA6A16', '#1F9AAD', '#3B82F6']) {
      const r = resolveBrandTheme(hex)!
      expect(brandContrast(hex)!.darkAdjusted).toBe(r.dark.adjusted ? expect.any(String) : null)
    }
    expect(brandContrast('#8C56D2')!.darkAdjusted).toBeNull()
    expect(brandContrast('#8C56D2')!.lightAdjusted).toBeNull()
  })
  it('다크에서 조정되는 색만 실제 값을 준다', () => {
    const c = brandContrast('#2563EB')!
    expect(resolveBrandTheme('#2563EB')!.dark.adjusted).toBe(true)
    expect(c.darkAdjusted).toMatch(/^#[0-9A-F]{6}$/)
  })
})
