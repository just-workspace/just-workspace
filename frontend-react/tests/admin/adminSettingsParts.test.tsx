// 관리 › 설정 계열(로그인 방식·백업·앱 빌드·브랜딩·서비스 상태·메일 OAuth) 순수 로직 + 렌더
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { i18n } from '~/i18n'
import { ldapChangeCount, normalizeAuthOrder, dropOrder, moveOrder, type LdapCfg } from '~/components/admin/AdminLoginMethods'
import { fmtBackupSize, localTimeFromUtcHour, backupHourOptions } from '~/components/admin/AdminBackup'
import { fmtAppSize, fmtDay } from '~/components/admin/AdminAppBuild'
import { brandContrast, contrastBlocked, isHexColor } from '~/components/admin/brandingContrast'

const apiMock = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('~/lib/api', async (orig) => ({ ...(await orig<any>()), $fetch: apiMock.fetch }))

import { servicesStore, fetchServices } from '~/composables/useServices'
import { AdminMailOAuth } from '~/components/admin/AdminMailOAuth'

const t = (k: string, p?: any) => i18n.t(k, p)

describe('로그인 방식 순서', () => {
  it('서버 순서 정규화 — 빠진 것 뒤에, sso 끝', () => {
    expect(normalizeAuthOrder(['ldap'])).toEqual(['ldap', 'local', 'sso'])
    expect(normalizeAuthOrder(undefined)).toEqual(['local', 'ldap', 'sso'])
    expect(normalizeAuthOrder(['ldap', 'local', 'bogus'])).toEqual(['ldap', 'local', 'sso'])
  })
  it('끌어 놓기 — sso 는 고정, 같은 자리는 null', () => {
    expect(dropOrder(['local', 'ldap', 'sso'], 'ldap', 'local')).toEqual(['ldap', 'local', 'sso'])
    expect(dropOrder(['local', 'ldap', 'sso'], 'local', 'ldap')).toEqual(['ldap', 'local', 'sso'])
    expect(dropOrder(['local', 'ldap', 'sso'], 'local', 'sso')).toBeNull()
    expect(dropOrder(['local', 'ldap', 'sso'], null, 'ldap')).toBeNull()
  })
  it('키보드 이동 — 범위 밖 null', () => {
    expect(moveOrder(['local', 'ldap', 'sso'], 'ldap', -1)).toEqual(['ldap', 'local', 'sso'])
    expect(moveOrder(['local', 'ldap', 'sso'], 'local', -1)).toBeNull()
    expect(moveOrder(['local', 'ldap', 'sso'], 'ldap', 1)).toBeNull()
  })
  it('LDAP 변경 건수 — 문자열 비교, 비밀번호는 입력 여부, enabled 제외', () => {
    const base = { enabled: false, host: 'h', port: 389, use_ssl: false, bind_dn: '', bind_password: '', base_dn: '', user_filter: 'f', attr_email: 'mail', attr_name: 'displayName', auto_provision: true, has_bind_password: false } as LdapCfg
    expect(ldapChangeCount({ ...base, port: '389' }, base)).toBe(0)
    expect(ldapChangeCount({ ...base, enabled: true }, base)).toBe(0)
    expect(ldapChangeCount({ ...base, host: 'x', bind_password: 'p' }, base)).toBe(2)
  })
})

describe('백업·앱 빌드 서식', () => {
  it('크기', () => {
    expect(fmtBackupSize(0)).toBe('')
    expect(fmtBackupSize(1536)).toBe('1.5 KB')
    expect(fmtAppSize(5 * 1024 * 1024)).toBe('5 MB')
  })
  it('UTC 시 → 브라우저 시간대의 시각', () => {
    // offsetMin = UTC − 현지(분): UTC+9 는 -540, UTC-5 는 300, UTC+5:30 은 -330
    expect(localTimeFromUtcHour(18, -540)).toBe('03:00')
    expect(localTimeFromUtcHour('0', -540)).toBe('09:00')
    expect(localTimeFromUtcHour(3, 300)).toBe('22:00')
    expect(localTimeFromUtcHour(20, -330)).toBe('01:30')
    expect(localTimeFromUtcHour(7, 0)).toBe('07:00')
  })
  it('시각 선택지 — 값은 UTC 시, 현지 시각 순', () => {
    const opts = backupHourOptions(-540)
    expect(opts).toHaveLength(24)
    expect(opts[0]).toEqual({ value: '15', label: '00:00' })
    expect(opts[3]).toEqual({ value: '18', label: '03:00' })
    expect(new Set(opts.map(o => o.value)).size).toBe(24)
  })
  it('MM/DD', () => {
    expect(fmtDay(null)).toBe('')
    expect(fmtDay('nope')).toBe('')
    expect(fmtDay('2026-03-05T12:00:00')).toBe('03/05')
  })
})

describe('브랜딩 대비', () => {
  it('형식·대비·막힘', () => {
    expect(isHexColor('#3B82F6')).toBe(true)
    expect(isHexColor('3B82F6')).toBe(false)
    expect(brandContrast('#zzz')).toBeNull()
    const c = brandContrast('#3B82F6')!
    expect(c.light).toBeGreaterThan(1)
    expect(contrastBlocked(c)).toBe(false)
    // B2: 조정 전 4.5 미만이어도 밝기 자동 조정으로 통과 — 조정된 테마는 실제 값을 반환
    const grey = brandContrast('#767676')!
    expect(contrastBlocked(grey)).toBe(false)
    expect(grey.light).toBeGreaterThanOrEqual(4.5)
    expect(grey.lightAdjusted).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('useServices', () => {
  beforeEach(() => apiMock.fetch.mockReset())
  it('성공하면 목록, 실패하면 이전 값 유지', async () => {
    apiMock.fetch.mockResolvedValueOnce([{ name: 'a', url: null, status: 'ok', response_ms: 3, internal_only: false }])
    await fetchServices()
    expect(servicesStore.getState().services).toHaveLength(1)
    expect(servicesStore.getState().loading).toBe(false)
    apiMock.fetch.mockRejectedValueOnce(new Error('x'))
    await fetchServices()
    expect(servicesStore.getState().services).toHaveLength(1)
    expect(apiMock.fetch).toHaveBeenCalledWith('/api/services/status', { credentials: 'include' })
  })
})

describe('AdminMailOAuth', () => {
  beforeEach(() => apiMock.fetch.mockReset())
  it('제공자 카드 2장 · 설정됨/미설정 · redirect URI', async () => {
    apiMock.fetch.mockResolvedValue({
      google: { client_id: 'gid', has_secret: true, tenant: '', redirect_uri: 'https://x/cb' },
      microsoft: { client_id: '', has_secret: false, tenant: 'common', redirect_uri: 'https://x/cb2' },
    })
    render(<AdminMailOAuth />)
    await waitFor(() => expect(screen.getByDisplayValue('https://x/cb')).toBeTruthy())
    expect(screen.getByText('OAuth2 · Google (Gmail · Workspace)')).toBeTruthy()
    expect(screen.getAllByText(t('adminParts.mailOAuth.configured')).length).toBeGreaterThan(0)
    expect(screen.getAllByText(t('adminParts.mailOAuth.notConfigured')).length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('common')).toBeTruthy()
  })
})
