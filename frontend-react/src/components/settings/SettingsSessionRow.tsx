/**
 * "내 세션" 표의 한 행(min 52).
 * 데스크톱 4열(1.6fr 1fr 1fr 110): 기기(타일 30 + 이름 600 + 종류 12) / 접속 주소(역방향 DNS 호스트 이름, 없으면 IP — mono) / 최근 활동 / 행동.
 * 모바일은 기기 아래 한 줄(종류 · IP · 최근 활동)로 접고 위치·최근 열은 숨긴다.
 * 행동: 현재 기기 = "이 기기" success 틴트 배지, 나머지 = [로그아웃](32 테두리, danger 글자).
 *
 * @example <SettingsSessionRow icon="monitor" name="Chrome on macOS" kind="웹" ip="1.2.3.4" recentShort="3분 전" recent="3분 전" />
 */
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiBadge } from '~/components/ui/Badge'

export interface SettingsSessionRowProps {
  /** 아이콘 이름(monitor · smartphone) */
  icon: string
  /** 기기 이름 */
  name: string
  /** 앱 종류(웹 · 모바일 웹 · 데스크톱 앱) */
  kind: string
  /** IP */
  ip: string
  /** 역방향 DNS 호스트(없으면 —) */
  hostname?: string
  /** 모바일 접힘 줄의 최근 활동 문구(현재 기기는 "지금 활동 중") */
  recentShort: string
  /** 데스크톱 "최근 활동" 열 문구(현재 기기는 "지금") */
  recent: string
  /** 지금 이 기기 */
  current?: boolean
  /** 로그아웃 버튼 비활성 */
  disabled?: boolean
  /** [로그아웃] */
  onRevoke?: () => void
}

/** 접속 주소 칸 — 역방향 DNS 호스트 이름, 없으면 IP. 지역 이름은 쓰지 않는다 */
export function sessionAddress(hostname: string | null | undefined, ip: string | null | undefined): string {
  return hostname || ip || '—'
}

export function SettingsSessionRow({ icon, name, kind, ip, hostname, recentShort, recent, current = false, disabled = false, onRevoke }: SettingsSessionRowProps) {
  const { t } = useI18n()
  return (
    <div role="row" className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 md:grid md:grid-cols-[1.6fr_1fr_1fr_110px] md:gap-0">
      <span role="cell" className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground"><UiIcon name={icon} className="h-[15px] w-[15px]" /></span>
        <span className="min-w-0">
          <b className="block truncate font-semibold text-foreground">{name}</b>
          <span className="block truncate text-xs text-muted-foreground">{kind}<span className="md:hidden"> · <span className="font-mono">{sessionAddress(hostname, ip)}</span> · {recentShort}</span></span>
        </span>
      </span>
      <span role="cell" className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block" title={hostname ? ip : undefined}>{sessionAddress(hostname, ip)}</span>
      <span role="cell" className="hidden text-xs text-muted-foreground md:block">{recent}</span>
      <span role="cell" className="shrink-0 text-right">
        {current
          ? <UiBadge tone="success" tint>{t('settings.sessions.thisDevice')}</UiBadge>
          : (
            <button
              type="button"
              className="relative inline-flex h-8 items-center rounded-sm border border-border px-2.5 text-xs font-semibold text-danger hover:bg-danger/10 after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] disabled:opacity-50"
              disabled={disabled}
              aria-label={t('settings.devices.revokeAria', { name })}
              onClick={onRevoke}
            >{t('auth.logout')}</button>
          )}
      </span>
    </div>
  )
}

export default SettingsSessionRow
