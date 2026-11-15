// 관리(사용자·개요·접근 로그·초대) 순수 로직
import { describe, it, expect } from 'vitest'
import { i18n } from '~/i18n'
import {
  statusOf, nameOf, serverSort, userListParams, nextSort, userMenuItems, deviceHint, fmtLast, rangeText, type AdminUser,
} from '~/components/admin/adminUsers'
import { buildOpsTiles, svcState, latencyWarnMsOf, fmtWhen } from '~/components/admin/dashboardTiles'
import { analyticsTimeAgo, maskIp, codeTone, mmddLabel } from '~/components/admin/analyticsFormat'
import { parseInviteEmails, badInviteEmails, sortInvites } from '~/components/admin/AdminInviteModal'
import { periodDays } from '~/composables/useAdminAnalytics'
import type { AdminOps } from '~/composables/useAdminOps'

const t = (k: string, p?: any) => i18n.t(k, p)
const base: AdminUser = { id: 'u1', username: 'kim', display_name: null, email: null, recovery_email: null, is_admin: false, is_active: true, created_at: null }

describe('adminUsers', () => {
  it('statusOf — 서버 status 우선, 없으면 is_active·로그인 이력', () => {
    expect(statusOf({ ...base, status: 'pending' })).toBe('pending')
    expect(statusOf(base)).toBe('active')
    expect(statusOf({ ...base, is_active: false, last_login_at: '2026-01-01' })).toBe('suspended')
    expect(statusOf({ ...base, is_active: false })).toBe('pending')
    expect(nameOf({ username: 'a', display_name: '가' })).toBe('가')
  })

  it('정렬·쿼리', () => {
    expect(serverSort('name', 1)).toBe('display_name')
    expect(serverSort('last', -1)).toBe('-last_login_at')
    expect(nextSort({ key: 'name', dir: 1 }, 'name')).toEqual({ key: 'name', dir: -1 })
    expect(nextSort({ key: 'name', dir: 1 }, 'last')).toEqual({ key: 'last', dir: -1 })
    expect(userListParams({ q: '', pending: false, admin: false, suspended: false, group: '' }, 'display_name', 1))
      .toEqual({ sort: 'display_name', page: 1, size: 50 })
    expect(userListParams({ q: 'x', pending: true, admin: true, suspended: true, group: 'g' }, '-display_name', 2))
      .toEqual({ sort: '-display_name', page: 2, size: 50, q: 'x', status: 'pending,suspended', role: 'admin', group: 'g' })
  })

  it('⋮ 메뉴 — 승인 대기 / 활성(본인·남) / 정지', () => {
    expect(userMenuItems({ ...base, status: 'pending', email_verified: false }, 'me', t).map(i => i.key)).toEqual(['approve', 'reject', 'resend'])
    expect(userMenuItems({ ...base, status: 'active' }, 'other', t).map(i => i.key)).toEqual(['role', 'sessions', 'logout', 'reset', 'suspend', 'delete'])
    expect(userMenuItems({ ...base, status: 'active' }, 'u1', t).map(i => i.key)).toEqual(['sessions', 'logout', 'reset'])
    expect(userMenuItems({ ...base, status: 'suspended' }, 'other', t).map(i => i.key)).toEqual(['reset', 'approve', 'delete'])
    // 2단계 인증을 켠 사용자에게만 초기화 메뉴(승인 대기는 제외)
    expect(userMenuItems({ ...base, status: 'active', has_2fa: true }, 'other', t).map(i => i.key)).toEqual(['role', 'sessions', 'logout', 'reset', 'reset2fa', 'suspend', 'delete'])
    expect(userMenuItems({ ...base, status: 'pending', has_2fa: true }, 'me', t).map(i => i.key)).not.toContain('reset2fa')
  })

  it('deviceHint·fmtLast·rangeText', () => {
    expect(deviceHint('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari', t)).toBe('Chrome on Windows')
    expect(deviceHint('Mozilla (Macintosh) Edg/1', t)).toBe('Edge on macOS')
    expect(deviceHint('', t)).toBe(t('admin.users.unknownDevice'))
    const now = new Date(2026, 9, 17, 12, 0)
    expect(fmtLast(null, t, now)).toBe('—')
    expect(fmtLast(new Date(2026, 9, 17, 11, 59).toISOString(), t, now)).toBe(t('admin.users.justNow'))
    expect(fmtLast(new Date(2026, 9, 16, 9, 0).toISOString(), t, now)).toBe(t('common.yesterday'))
    expect(fmtLast(new Date(2026, 8, 3, 9, 0).toISOString(), t, now)).toBe('09/03')
    expect(rangeText(1, 0)).toBe('0')
    expect(rangeText(2, 120)).toBe('51–100 / 120')
  })
})

describe('개요(dashboard)', () => {
  const ops: AdminOps = {
    loaded: true, pending: 2, users: { pending: 2, active: 5, suspended: 0, open_invites: 1 },
    backup: null, ssl: { installed: true, notAfter: '2026-11-01T00:00:00Z', days: 15, source: 'file', unknown: false },
    services: { ok: 3, total: 4, downNames: ['git'] },
  }
  it('운영 요약 4칸 톤·값', () => {
    const tiles = buildOpsTiles(ops, t)
    expect(tiles.map(x => x.tone)).toEqual(['warning', 'warning', 'warning', 'warning'])
    expect(tiles[0].to).toBe('/admin/users?filter=pending')
    expect(tiles[1].value).toBe(t('admin.dashboard.noRecord'))
    expect(tiles[3].hint).toBe(t('admin.dashboard.servicesDown', { names: 'git' }))
    const unloaded = buildOpsTiles({ loaded: false, pending: null, users: null, backup: undefined, ssl: null, services: null }, t)
    expect(unloaded.every(x => x.value === '…' && x.tone === 'neutral')).toBe(true)
    const unknownSsl = buildOpsTiles({ ...ops, ssl: { installed: false, notAfter: null, days: null, source: null, unknown: true } }, t)
    expect(unknownSsl[2].tone).toBe('neutral')
    expect(unknownSsl[2].value).toBe(t('admin.dashboard.sslUnknown'))
  })
  it('서비스 상태·지연 기준', () => {
    expect(svcState({ status: 'down', response_ms: null }, 800, t).dot).toBe('down')
    expect(svcState({ status: 'checking', response_ms: null }, 800, t).dot).toBe('connecting')
    expect(svcState({ status: 'ok', response_ms: 900 }, 800, t).dot).toBe('slow')
    expect(svcState({ status: 'ok', response_ms: 100 }, 800, t).dot).toBe('ok')
    expect(latencyWarnMsOf({})).toBe(800)
    expect(latencyWarnMsOf({ 'system.latency_warn_ms': ' 300 ' })).toBe(300)
    expect(latencyWarnMsOf({ 'system.latency_warn_ms': '-1' })).toBe(800)
  })
  it('fmtWhen — 오늘/어제/그 밖', () => {
    const today = new Date(2026, 9, 17, 12, 0)
    expect(fmtWhen(new Date(2026, 9, 17, 3, 5).toISOString(), t, today)).toBe(t('admin.dashboard.whenToday', { time: '03:05' }))
    expect(fmtWhen(new Date(2026, 9, 1, 3, 5).toISOString(), t, today)).toBe('10/1 03:05')
  })
})

describe('분석 카드·접근 로그·초대', () => {
  it('analyticsTimeAgo·maskIp·codeTone·mmdd·periodDays', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    expect(analyticsTimeAgo('', t)).toBe('-')
    expect(analyticsTimeAgo('2026-10-17T11:59:50Z', t, false, now)).toBe(t('common.justNow'))
    expect(analyticsTimeAgo('2026-10-17T09:00:00Z', t, false, now)).toBe(t('common.hoursAgo', { n: 3 }))
    expect(analyticsTimeAgo('2026-10-17T09:00:00Z', t, true, now)).toBe(t('common.minutesAgo', { n: 180 }))
    expect(analyticsTimeAgo('2026-10-14T12:00:00Z', t, false, now)).toBe(t('common.daysAgo', { n: 3 }))
    expect(maskIp('10.1.2.3')).toBe('10.1.x.x')
    expect(maskIp('2001:db8::1234:5678')).toBe('2001:db8::...')
    expect(codeTone(204)).toBe('text-success')
    expect(codeTone(302)).toBe('text-warning')
    expect(codeTone(500)).toBe('text-danger')
    expect(mmddLabel('2026-03-05T12:00:00')).toBe('03/05')
    expect([periodDays('today'), periodDays('7d'), periodDays('30d')]).toEqual([1, 7, 30])
  })
  it('초대 이메일 파싱·검사·정렬', () => {
    expect(parseInviteEmails(' a@b.co, c@d.io;\ne ')).toEqual(['a@b.co', 'c@d.io', 'e'])
    expect(badInviteEmails(['a@b.co', 'e', 'x@y'])).toEqual(['e', 'x@y'])
    const s = sortInvites([
      { id: '1', state: 'used', created_at: '2026-10-03' },
      { id: '2', state: 'open', created_at: '2026-10-01' },
      { id: '3', state: 'open', created_at: '2026-10-02' },
    ])
    expect(s.map(x => x.id)).toEqual(['3', '2', '1'])
  })
})
