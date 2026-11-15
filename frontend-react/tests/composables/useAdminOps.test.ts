// 관리 운영 요약 — 순수 함수 검증.
import { describe, it, expect, vi, afterEach } from 'vitest'

const { daysUntil, RUN_STATUS_LABEL, RUN_STATUS_TONE } = await import('~/composables/useAdminOps')

describe('daysUntil (운영 요약 SSL D-n)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('openssl notAfter 형식을 남은 일수로 바꾼다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T10:42:00Z'))
    expect(daysUntil('Oct 27 12:00:00 2026 GMT')).toBe(12)
    expect(daysUntil('2026-10-15T23:00:00Z')).toBe(0)
  })

  it('지난 날짜는 음수, 못 읽는 값·빈 값은 null', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'))
    expect(daysUntil('2026-10-10T00:00:00Z')).toBeLessThan(0)
    expect(daysUntil('not a date')).toBeNull()
    expect(daysUntil('')).toBeNull()
    expect(daysUntil(null)).toBeNull()
  })
})

describe('원시 enum → 한글 (관리 6)', () => {
  it('시안 노트의 다섯 값을 한글로', () => {
    expect(RUN_STATUS_LABEL.success).toBe('완료')
    expect(RUN_STATUS_LABEL.partial).toBe('일부 실패')
    expect(RUN_STATUS_LABEL.running).toBe('진행 중')
    expect(RUN_STATUS_LABEL.idle).toBe('대기')
    expect(RUN_STATUS_LABEL.failed).toBe('실패')
  })
  it('상태마다 배지 톤이 있다', () => {
    for (const k of Object.keys(RUN_STATUS_LABEL)) expect(RUN_STATUS_TONE[k]).toBeTruthy()
  })
})

describe('ops-summary → 운영 요약 4칸', () => {
  it('SSL 을 못 읽으면(source·days_left null) 확인 불가(unknown)', async () => {
    const { fromOpsSummary } = await import('~/composables/useAdminOps')
    const o = fromOpsSummary({
      users: { pending: 2, active: 10, suspended: 1, open_invites: 3 },
      backup: { status: 'success', created_at: '2026-10-14T03:00:00Z' },
      ssl: { days_left: null, not_after: null, source: null },
      services: { ok: 8, down: 1, checking: 0, down_names: ['mail'] },
    })
    expect(o.pending).toBe(2)
    expect(o.ssl).toMatchObject({ unknown: true, days: null, installed: false })
    expect(o.services).toEqual({ ok: 8, total: 9, downNames: ['mail'] })
    expect(o.backup).toEqual({ at: '2026-10-14T03:00:00Z', status: 'success' })
  })

  it('만료일을 읽었으면 남은 일수·출처, 백업 기록 없으면 null', async () => {
    const { fromOpsSummary } = await import('~/composables/useAdminOps')
    const o = fromOpsSummary({
      users: { pending: 0, active: 1, suspended: 0, open_invites: 0 },
      backup: null,
      ssl: { days_left: 47, not_after: '2026-12-01T00:00:00+00:00', source: 'probe' },
      services: { ok: 3, down: 0, down_names: [] },
    })
    expect(o.ssl).toMatchObject({ unknown: false, days: 47, source: 'probe', installed: true })
    expect(o.backup).toBeNull()
    expect(o.services?.total).toBe(3)
  })
})
