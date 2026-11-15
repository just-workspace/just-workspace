/**
 * 로그인된 기기 한 줄(행 56).
 * 아이콘 타일 32 + 기기 이름(600) + "IP · 마지막 활동 · 호스트" 12 muted,
 * 오른쪽 "현재"(success 글자) 또는 [로그아웃](danger 글자 버튼).
 *
 * @example <SettingsDeviceRow icon="monitor" name="Chrome on macOS" meta="1.2.3.4 · 지금 활동 중" current />
 */
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { SettingsTextAction } from './SettingsTextAction'

export interface SettingsDeviceRowProps {
  /** 아이콘 이름(monitor · smartphone) */
  icon: string
  /** 기기 이름 */
  name: string
  /** "IP · 마지막 활동"(mono) */
  meta: string
  /** 역방향 DNS 호스트(있으면 " · 호스트") */
  hostname?: string
  /** 지금 이 기기 — 오른쪽에 "현재" */
  current?: boolean
  /** 로그아웃 버튼 비활성 */
  disabled?: boolean
  /** [로그아웃] */
  onRevoke?: () => void
}

export function SettingsDeviceRow({ icon, name, meta, hostname, current = false, disabled = false, onRevoke }: SettingsDeviceRowProps) {
  const { t } = useI18n()
  return (
    <div className="flex h-14 items-center gap-3 border-t border-border px-5 text-[13px]">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground"><UiIcon name={icon} className="h-[15px] w-[15px]" /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-foreground">{name}</div>
        <div className="truncate text-xs text-muted-foreground"><span className="font-mono">{meta}</span>{hostname && <span> · {hostname}</span>}</div>
      </div>
      {current
        ? <span className="shrink-0 text-xs font-semibold text-success">{t('settings.account.current')}</span>
        : (
          <SettingsTextAction disabled={disabled} aria-label={t('settings.devices.revokeAria', { name })} onClick={onRevoke}>
            {t('auth.logout')}
          </SettingsTextAction>
        )}
    </div>
  )
}

export default SettingsDeviceRow
