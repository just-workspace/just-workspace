/**
 * 로그인된 기기 카드 — Vue components/settings/SettingsDevices.vue
 * (계정 화면 아래, 현재 기기 표시 + 개별 로그아웃).
 * 행은 SettingsDeviceRow. 머리 오른쪽 "다른 기기 모두 로그아웃"(시안에 없는 버튼 — 같은 글자 버튼 문법).
 * 데이터·동작은 useMySessions(설정 › 보안 "내 세션" 표와 공유). 마운트 때 불러온다.
 *
 * @example <SettingsDevices />
 */
import { useEffect } from 'react'
import { useI18n } from '~/i18n'
import { useMySessions, type MySession } from '~/composables/useMySessions'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { SettingsCard } from './SettingsCard'
import { SettingsDeviceRow } from './SettingsDeviceRow'
import { SettingsTextAction } from './SettingsTextAction'

export function SettingsDevices() {
  const { t } = useI18n()
  const { sessions, loading, loadError, busy, others, load, name, icon, when, revoke, revokeOthers } = useMySessions()
  useEffect(() => { void load() }, [load])

  function meta(s: MySession) {
    return [s.ip, s.current ? t('settings.account.activeNow') : when(s.last_seen_at)].filter(Boolean).join(' · ')
  }

  return (
    <SettingsCard
      title={t('settings.account.devicesTitle')}
      description={t('settings.account.devicesDesc')}
      flush
      header={others.length > 0 && (
        <SettingsTextAction disabled={busy !== null} onClick={() => void revokeOthers()}>{t('settings.devices.revokeOthers')}</SettingsTextAction>
      )}
    >
      {loading
        ? <UiSkeleton preset="list" rows={2} className="border-t border-border" />
        : loadError
          ? <UiErrorTile placement="panel" title={t('settings.devices.loadError')} className="border-t border-border" onRetry={() => void load()} />
          : (
            <>
              {sessions.map(s => (
                <SettingsDeviceRow
                  key={s.id}
                  icon={icon(s)}
                  name={name(s)}
                  meta={meta(s)}
                  hostname={s.hostname}
                  current={s.current}
                  disabled={busy !== null}
                  onRevoke={() => void revoke(s)}
                />
              ))}
              {!sessions.length && <UiEmptyState variant="inline" inset title={t('settings.devices.empty')} className="border-t border-border" />}
            </>
          )}
    </SettingsCard>
  )
}

export default SettingsDevices
