// 개인 설정 모듈 — useMySessions 꾸미기 함수, 문구 끼워 넣기, 비밀번호 날짜, 메일 표기, 화면 조각 렌더
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { i18n } from '~/i18n'
import { sessionBaseName, sessionIcon, sessionKind, sessionName, sessionWhen, type MySession } from '~/composables/useMySessions'
import { UiTrans } from '~/components/ui/Trans'
import { passwordChangedDay } from '~/components/settings/SettingsPasswordCard'
import { mailProtocolLabel, mailSyncTime } from '~/components/settings/SettingsMailParts'
import { SettingsRow } from '~/components/settings/SettingsRow'
import { SettingsSessionRow } from '~/components/settings/SettingsSessionRow'
import { SettingsDeviceRow } from '~/components/settings/SettingsDeviceRow'
import { SettingsNotifyMatrix } from '~/components/settings/SettingsNotifyParts'
import { SettingsHeader } from '~/components/settings/SettingsHeader'

const t = (k: string, a?: any) => i18n.t(k, a)
const base: MySession = {
  id: 's1', current: false, device: '', browser: 'Chrome', os: 'macOS', device_type: 'desktop', app: null,
  ip: '10.0.0.1', hostname: 'host.lan', created_at: null, last_seen_at: null,
}

describe('useMySessions 꾸미기', () => {
  it('기기 이름 — 브라우저 on OS · 데스크톱 앱 · 이 기기', () => {
    expect(sessionBaseName(t, base)).toBe('Chrome on macOS')
    expect(sessionBaseName(t, { ...base, os: null })).toBe('Chrome')
    expect(sessionBaseName(t, { ...base, app: 'desktop' })).toBe(t('settings.devices.desktopAppOs', { os: 'macOS' }))
    expect(sessionBaseName(t, { ...base, app: 'desktop', os: null })).toBe(t('settings.devices.desktopApp'))
    expect(sessionBaseName(t, { ...base, browser: null, os: null })).toBe(t('settings.account.browserFallback'))
    expect(sessionName(t, { ...base, current: true })).toBe(t('settings.devices.thisDevice', { name: 'Chrome on macOS' }))
    // 데스크톱 앱은 현재여도 "이 기기" 를 붙이지 않는다(Vue 와 같음)
    expect(sessionName(t, { ...base, current: true, app: 'desktop' })).toBe(t('settings.devices.desktopAppOs', { os: 'macOS' }))
  })

  it('종류·아이콘', () => {
    expect(sessionKind(t, base)).toBe(t('settings.sessions.kindWeb'))
    expect(sessionKind(t, { ...base, device_type: 'tablet' })).toBe(t('settings.sessions.kindMobileWeb'))
    expect(sessionKind(t, { ...base, app: 'desktop' })).toBe(t('settings.sessions.kindDesktop'))
    expect(sessionIcon(base)).toBe('monitor')
    expect(sessionIcon({ ...base, device_type: 'mobile' })).toBe('smartphone')
  })

  it('마지막 활동 — 5분 안·분·시간·어제·날짜', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    const ago = (m: number) => new Date(now - m * 60000).toISOString()
    expect(sessionWhen(t, 'ko', null, now)).toBe('')
    expect(sessionWhen(t, 'ko', ago(2), now)).toBe(t('settings.account.activeNow'))
    expect(sessionWhen(t, 'ko', ago(30), now)).toBe(t('settings.devices.minutesAgo', { n: 30 }))
    expect(sessionWhen(t, 'ko', ago(180), now)).toBe(t('settings.devices.hoursAgo', { n: 3 }))
    expect(sessionWhen(t, 'ko', ago(60 * 30), now)).toBe(t('settings.sessions.yesterday'))
    expect(sessionWhen(t, 'ko', ago(60 * 24 * 5), now)).toMatch(/10/)
  })
})

describe('UiTrans (설정 문구)', () => {
  it('슬롯을 끼워 그린다', () => {
    const { container } = render(<UiTrans k="settings.apps.since" as="span" slots={{ since: <b>어제</b>, last: <i>오늘</i> }} />)
    expect(container.querySelector('span')!.textContent).toBe(t('settings.apps.since', { since: '어제', last: '오늘' }))
    expect(container.querySelector('b')!.textContent).toBe('어제')
  })
})

describe('순수 꾸미기', () => {
  it('비밀번호 마지막 변경일', () => {
    expect(passwordChangedDay(null)).toBe('')
    expect(passwordChangedDay('bad')).toBe('')
    expect(passwordChangedDay('2026-03-05T10:00:00')).toBe('2026-03-05')
  })
  it('메일 프로토콜·동기화 시각', () => {
    expect(mailProtocolLabel({ protocol: 'pop3' })).toBe('POP3/SMTP')
    expect(mailProtocolLabel({})).toBe('IMAP/SMTP')
    expect(mailSyncTime(null)).toBe('')
    expect(mailSyncTime('2026-10-17T09:05:00')).toBe('09:05')
  })
})

describe('설정 화면 조각', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('SettingsHeader — 제목·부제(md 이상에서만 보임)', () => {
    const { container } = render(<SettingsHeader title="계정" subtitle="부제" />)
    expect(container.firstElementChild!.className).toContain('hidden md:block')
    expect(screen.getByRole('heading', { name: '계정' })).toBeTruthy()
  })

  it('SettingsRow — stack·inline 레이아웃', () => {
    const { rerender, container } = render(<SettingsRow title="테마" description="설명"><span>ctl</span></SettingsRow>)
    expect(container.firstElementChild!.className).toContain('sm:flex-row')
    rerender(<SettingsRow layout="inline" title="메일" description="d" className="border-t"><span>ctl</span></SettingsRow>)
    expect(container.firstElementChild!.className).toContain('min-h-12')
    expect(container.firstElementChild!.className).toContain('border-t')
  })

  it('SettingsSessionRow — 현재 기기 배지 / 로그아웃 버튼', () => {
    const onRevoke = vi.fn()
    const { rerender } = render(<SettingsSessionRow icon="monitor" name="Chrome on macOS" kind="웹" ip="1.2.3.4" recentShort="r" recent="R" current />)
    expect(screen.getByText(t('settings.sessions.thisDevice'))).toBeTruthy()
    rerender(<SettingsSessionRow icon="monitor" name="Chrome on macOS" kind="웹" ip="1.2.3.4" hostname="" recentShort="r" recent="R" onRevoke={onRevoke} />)
    // 접속 주소 칸(답변서 B7): 호스트 이름이 없으면 IP
    expect(screen.getAllByText('1.2.3.4', { exact: false }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: t('settings.devices.revokeAria', { name: 'Chrome on macOS' }) }))
    expect(onRevoke).toHaveBeenCalledOnce()
  })

  it('SettingsDeviceRow — 현재 표시', () => {
    render(<SettingsDeviceRow icon="smartphone" name="Safari on iOS" meta="1.1.1.1 · 지금" hostname="h" current />)
    expect(screen.getByText(t('settings.account.current'))).toBeTruthy()
    expect(screen.getByText('· h', { exact: false })).toBeTruthy()
  })

  it('SettingsNotifyMatrix — 체크 바꾸면 종류·채널을 알린다', async () => {
    const onChange = vi.fn()
    render(
      <SettingsNotifyMatrix
        rows={[{ type: 'mention', name: '멘션', desc: '설명' }]}
        value={() => ({ in_app: true, push: false, email: true })}
        channelLabel={{ in_app: 'A', push: 'P', email: 'E' }}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByLabelText('멘션 — P'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('mention', 'push', true))
  })
})
