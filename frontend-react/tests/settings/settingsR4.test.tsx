// 설정·보안 — 캘린더·채팅 설정 조각, 2단계 인증 모달, 세션 카드, 비밀번호 체크 목록
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { i18n } from '~/i18n'
import { addKeyword } from '~/utils/chatKeywords'
import { fromServer, toServer, MAX_CHAT_KEYWORDS } from '~/composables/useUserPrefs'
import { resolveWeekStart, startOfWeek } from '~/utils/calendarLayout'
import { fetchedTime, subscriptionReason, SettingsSubscriptionRow } from '~/components/settings/SettingsCalendarParts'
import {
  formatOtp, groupSecret, recoveryCodesText, SettingsTwoFactorCodesModal, SettingsTwoFactorOffModal, SettingsTwoFactorRegenModal,
} from '~/components/settings/SettingsTwoFactor'
import { SettingsSessionCard } from '~/components/settings/SettingsSessionsTable'
import { sessionAddress, SettingsSessionRow } from '~/components/settings/SettingsSessionRow'
import { settingsPasswordRules } from '~/components/settings/SettingsPasswordCard'
import { moveItem, WALLPAPER_MAX } from '~/components/admin/brandingWallpapers'

const t = (k: string, a?: any) => i18n.t(k, a)

describe('알림 키워드 입력 규칙', () => {
  it('정리·중복·최대 개수·길이', () => {
    expect(addKeyword([], '  배포  ').list).toEqual(['배포'])
    expect(addKeyword(['배포'], 'hot   fix').list).toEqual(['배포', 'hot fix'])
    const same = ['Deploy']
    expect(addKeyword(same, 'deploy').list).toBe(same) // 대소문자 무시 중복은 그대로
    expect(addKeyword([], '   ').list).toEqual([])
    const full = Array.from({ length: MAX_CHAT_KEYWORDS }, (_, i) => `k${i}`)
    expect(addKeyword(full, 'new').error).toBe('full')
    expect(addKeyword([], 'x'.repeat(41)).error).toBe('long')
  })
})

describe('개인 설정 서버 키(캘린더·채팅)', () => {
  it('서버 값 검사', () => {
    expect(fromServer('calendarDefaultView', 'week')).toBe('week')
    expect(fromServer('calendarDefaultView', 'year')).toBeUndefined()
    expect(fromServer('calendarDefaultReminder', 10)).toBe(10)
    expect(fromServer('calendarDefaultReminder', '10')).toBeUndefined()
    expect(fromServer('chatEnterKey', 'newline')).toBe('newline')
    expect(fromServer('chatLinkPreview', false)).toBe(false)
    expect(fromServer('chatKeywords', ['배포', 1])).toBeUndefined()
    expect(fromServer('chatKeywords', ['배포'])).toEqual(['배포'])
    expect(fromServer('weekStart', 'sat')).toBe('sat')
  })
  it('없음·빈 목록은 서버 키를 지운다', () => {
    expect(toServer('calendarDefaultReminder', null)).toBeNull()
    expect(toServer('chatKeywords', [])).toBeNull()
    expect(toServer('chatKeywords', ['a'])).toEqual(['a'])
  })
})

describe('주 시작 요일 — 토요일', () => {
  it('sat → 6, 그 주 토요일부터', () => {
    expect(resolveWeekStart('sat', 'ko-KR')).toBe(6)
    const wed = new Date(2026, 9, 14, 15) // 2026-10-14 수
    const s = startOfWeek(wed, 6)
    expect(s.getDay()).toBe(6)
    expect(s.getDate()).toBe(10)
  })
})

describe('외부 캘린더 구독 조각', () => {
  it('실패 이유·받은 시각', () => {
    expect(subscriptionReason(t, '404')).toBe('404')
    expect(subscriptionReason(t, 'timeout')).toBe(t('settings.calendarPrefs.reason.timeout'))
    expect(subscriptionReason(t, 'weird')).toBe('weird')
    expect(subscriptionReason(t, null)).toBe('')
    const now = new Date(2026, 9, 17, 12)
    const today = new Date(2026, 9, 17, 10, 0)
    expect(fetchedTime(today.toISOString(), now)).toBe('10:00')
    expect(fetchedTime(new Date(2026, 9, 15, 9, 5).toISOString(), now)).toBe('10/15 09:05')
    expect(fetchedTime(null, now)).toBe('')
  })
  it('행 — 실패면 danger 배지, 아니면 받은 시각', () => {
    const base = { id: 'c1', name: '대한민국 공휴일', color: '#d83148', url: 'https://cal.example.com/h.ics', fetched_at: new Date().toISOString(), checked_at: null, error: null }
    const { rerender, container } = render(<SettingsSubscriptionRow sub={base} onAction={() => {}} />)
    expect(container.textContent).toContain('https://cal.example.com/h.ics')
    expect(container.textContent).toContain(t('settings.calendarPrefs.fetched'))
    rerender(<SettingsSubscriptionRow sub={{ ...base, error: '404' }} onAction={() => {}} />)
    expect(container.textContent).toContain(t('settings.calendarPrefs.failed', { reason: '404' }))
    expect(screen.getByRole('button', { name: t('settings.calendarPrefs.menu', { name: base.name }) })).toBeTruthy()
  })
})

describe('2단계 인증', () => {
  it('표기 도우미', () => {
    expect(formatOtp('48120')).toBe('481 20')
    expect(formatOtp('481 205 9')).toBe('481 205')
    expect(formatOtp('ab12')).toBe('12')
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
    expect(recoveryCodesText('WS', ['aaaa-bbbb', 'cccc-dddd'])).toContain('02  cccc-dddd')
  })

  it('2/2 — "저장했습니다" 체크해야 [완료]', () => {
    const onClose = vi.fn()
    render(<SettingsTwoFactorCodesModal codes={['k7x2-9qpd', 'm3vb-4tre']} onCopy={() => {}} onDownload={() => {}} onClose={onClose} />)
    expect(screen.getByText(t('settings.twoFactor.step2of2', { n: 2 }))).toBeTruthy()
    const done = screen.getByRole('button', { name: t('common.done') }) as HTMLButtonElement
    expect(done.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(t('settings.twoFactor.savedCheck')))
    expect(done.disabled).toBe(false)
    fireEvent.click(done)
    expect(onClose).toHaveBeenCalled()
  })

  it('끄기 — 코드 넣기 전엔 [끄기] 비활성', () => {
    const { rerender } = render(<SettingsTwoFactorOffModal code="" codeError="" working={false} onCode={() => {}} onDisable={() => {}} onClose={() => {}} />)
    const btn = () => screen.getAllByRole('button', { name: t('settings.twoFactor.turnOff') }).at(-1) as HTMLButtonElement
    expect(btn().disabled).toBe(true)
    rerender(<SettingsTwoFactorOffModal code="123 456" codeError="" working={false} onCode={() => {}} onDisable={() => {}} onClose={() => {}} />)
    expect(btn().disabled).toBe(false)
  })

  it('새로 발급 — 남은 코드 수 경고', () => {
    render(<SettingsTwoFactorRegenModal remaining={7} code="" codeError="" working={false} onCode={() => {}} onRegenerate={() => {}} onClose={() => {}} />)
    const warn = document.querySelector('.bg-warning\\/10')!
    expect(warn.textContent).toContain('7')
  })
})

describe('세션', () => {
  it('접속 주소 = 호스트 이름, 없으면 IP', () => {
    expect(sessionAddress('host-203-0-113-9.isp.example', '203.0.113.9')).toBe('host-203-0-113-9.isp.example')
    expect(sessionAddress('', '198.51.100.80')).toBe('198.51.100.80')
    expect(sessionAddress(null, null)).toBe('—')
    const { container } = render(<SettingsSessionRow icon="monitor" name="Chrome on macOS" kind="웹" ip="1.2.3.4" hostname="" recentShort="3분 전" recent="3분 전" />)
    expect(container.querySelector('.font-mono')!.textContent).toContain('1.2.3.4')
  })
  it('모바일 카드 — 이 기기는 배지만, 다른 기기는 [로그아웃]', () => {
    const onRevoke = vi.fn()
    const { rerender } = render(<SettingsSessionCard icon="smartphone" name="iPhone" address="host.example" when="지금" current />)
    expect(screen.getByText(t('settings.sessions.thisDevice'))).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<SettingsSessionCard icon="monitor" name="Chrome" address="1.2.3.4" when="2시간 전" onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onRevoke).toHaveBeenCalled()
  })
})

describe('비밀번호 체크 목록', () => {
  const ctx = ['alice', 'alice@x.io']
  const ok = (rs: ReturnType<typeof settingsPasswordRules>) => rs.map(r => `${r.key}:${r.ok ? 1 : 0}`).join(' ')
  it('흔한 비밀번호는 서버 응답 뒤에만 통과', () => {
    expect(ok(settingsPasswordRules('가을하늘연필바다', ctx, null))).toBe('length:1 common:0 distinct:1')
    expect(ok(settingsPasswordRules('가을하늘연필바다', ctx, { length: true, common: false, context: false, ok: true }))).toBe('length:1 common:1 distinct:1')
    expect(ok(settingsPasswordRules('password123', ctx, { length: true, common: true, context: false, ok: false }))).toBe('length:1 common:0 distinct:1')
  })
  it('아이디·이메일과 다름 · 8자', () => {
    expect(ok(settingsPasswordRules('alice2026', ctx, null))).toBe('length:1 common:0 distinct:0')
    expect(ok(settingsPasswordRules('short', ctx, null))).toBe('length:0 common:0 distinct:1')
    expect(ok(settingsPasswordRules('', ctx, null))).toBe('length:0 common:0 distinct:0')
  })
})

describe('브랜딩 로그인 배경 순서', () => {
  it('끌어 놓기 순서', () => {
    expect(WALLPAPER_MAX).toBe(4)
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    const same = ['a']
    expect(moveItem(same, 0, 0)).toBe(same)
    expect(moveItem(same, 0, 3)).toBe(same)
  })
})
