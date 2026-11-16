/**
 * 설정 › 보안 "내 세션"
 * + 모바일 카드 스택.
 * 데스크톱: 카드 머리 = 제목 + "로그인된 기기 N대 · …" + 오른쪽 [이 기기 빼고 모두 로그아웃](32, danger 테두리 0.6).
 *   표 머리 36(11/600 0.06em muted) + 행 SettingsSessionRow. "접속 주소" 칸 = 호스트 이름(없으면 IP), mono.
 * 모바일(md 미만): "로그인된 기기 n" 머리 + 기기 카드(SettingsSessionCard) 스택 + 맨 아래 [이 기기 빼고 모두 로그아웃](outline lg danger).
 * 데이터·동작은 useMySessions(계정 "로그인된 기기" 카드와 공유). 마운트 시 조회한다.
 *
 * @example <SettingsSessionsTable />
 */
import { useEffect } from 'react'
import { useI18n } from '~/i18n'
import { useMySessions } from '~/composables/useMySessions'
import { useIsMobile } from '~/composables/useIsMobile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { SettingsCard } from './SettingsCard'
import { SettingsSessionRow, sessionAddress } from './SettingsSessionRow'

export interface SettingsSessionCardProps {
  /** 아이콘 이름(monitor · smartphone) */
  icon: string
  /** 기기 이름("Chrome on macOS") */
  name: string
  /** 접속 주소 — 호스트 이름(없으면 IP), mono */
  address: string
  /** 마지막 활동("지금 활동 중" · "2시간 전") */
  when: string
  /** 현재 기기 — success 틴트 배지 "이 기기", 로그아웃 버튼 없음 */
  current?: boolean
  /** 로그아웃 버튼 비활성 */
  disabled?: boolean
  /** [로그아웃] */
  onRevoke?: () => void
}

/**
 * 모바일 세션 카드: 타일 36 · 이름 15/600(+ "이 기기" 배지) · 접속 주소 11 mono · 마지막 활동 12 · [로그아웃] ghost danger.
 */
export function SettingsSessionCard({ icon, name, address, when, current = false, disabled = false, onRevoke }: SettingsSessionCardProps) {
  const { t } = useI18n()
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card py-3 pl-3.5 pr-1">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><UiIcon name={icon} className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{name}</span>
          {current && <UiBadge tone="success" tint size={18}>{t('settings.sessions.thisDevice')}</UiBadge>}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{address}</div>
        <div className="text-xs text-muted-foreground">{when}</div>
      </div>
      {!current && (
        <UiButton variant="ghost" size="sm" className="text-danger" disabled={disabled} aria-label={t('settings.devices.revokeAria', { name })} onClick={onRevoke}>{t('auth.logout')}</UiButton>
      )}
    </div>
  )
}

export function SettingsSessionsTable() {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const { sessions, loading, loadError, busy, others, load, name, baseName, kind, icon, when, revoke, revokeOthers } = useMySessions()
  useEffect(() => { void load() }, [load])

  if (isMobile) {
    return (
      <section className="flex flex-col gap-3" aria-label={t('settings.sessions.title')}>
        <p className="text-xs font-semibold text-muted-foreground">{t('settings.sessions.mobileHead')} <span className="font-mono">{sessions.length}</span></p>
        {loading
          ? <UiSkeleton preset="list" rows={3} />
          : loadError
            ? <UiErrorTile placement="panel" title={t('settings.devices.loadError')} onRetry={() => void load()} />
            : !sessions.length
              ? <UiEmptyState variant="inline" title={t('settings.devices.empty')} />
              : sessions.map(s => (
                <SettingsSessionCard
                  key={s.id}
                  icon={icon(s)}
                  name={baseName(s)}
                  address={sessionAddress(s.hostname, s.ip)}
                  when={s.current ? t('settings.account.activeNow') : when(s.last_seen_at)}
                  current={s.current}
                  disabled={busy !== null}
                  onRevoke={() => void revoke(s)}
                />
              ))}
        {others.length > 0 && (
          <UiButton variant="outline" size="lg" className="mt-1 w-full text-danger" disabled={busy !== null} onClick={() => void revokeOthers()}>{t('settings.sessions.revokeOthers')}</UiButton>
        )}
      </section>
    )
  }

  return (
    <SettingsCard
      title={t('settings.sessions.title')}
      description={loading ? undefined : t('settings.sessions.desc', { n: sessions.length })}
      flush
      header={others.length > 0 && (
        <button
          type="button"
          className="relative inline-flex h-8 shrink-0 items-center rounded-[10px] border border-danger/60 px-3 text-xs font-semibold text-danger hover:bg-danger/10 after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => void revokeOthers()}
        >{t('settings.sessions.revokeOthers')}</button>
      )}
    >
      {loading
        ? <UiSkeleton preset="list" rows={3} className="border-t border-border" />
        : loadError
          ? <UiErrorTile placement="panel" title={t('settings.devices.loadError')} className="border-t border-border" onRetry={() => void load()} />
          : !sessions.length
            ? <UiEmptyState variant="inline" inset title={t('settings.devices.empty')} className="border-t border-border" />
            : (
              <div role="table" aria-label={t('settings.sessions.title')} className="text-[13px]">
                <div role="row" className="hidden h-9 grid-cols-[1.6fr_1fr_1fr_110px] items-center border-t border-border px-5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground md:grid">
                  <span role="columnheader">{t('settings.sessions.colDevice')}</span>
                  <span role="columnheader">{t('settings.sessions.colWhere')}</span>
                  <span role="columnheader">{t('settings.sessions.colRecent')}</span>
                  <span role="columnheader"><span className="sr-only">{t('settings.sessions.colAction')}</span></span>
                </div>
                {sessions.map(s => (
                  <SettingsSessionRow
                    key={s.id}
                    icon={icon(s)}
                    name={name(s)}
                    kind={kind(s)}
                    ip={s.ip}
                    hostname={s.hostname}
                    recentShort={s.current ? t('settings.account.activeNow') : when(s.last_seen_at)}
                    recent={s.current ? t('settings.sessions.now') : when(s.last_seen_at)}
                    current={s.current}
                    disabled={busy !== null}
                    onRevoke={() => void revoke(s)}
                  />
                ))}
              </div>
            )}
    </SettingsCard>
  )
}

export default SettingsSessionsTable
