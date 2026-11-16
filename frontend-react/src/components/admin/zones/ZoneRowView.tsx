/**
 * 구역 한 행 — 이름·설명, 권장 메모리, 상태(색 + 아이콘 + 글자), [설정], 켜기 스위치.
 * 진행·결과는 행 내부에 펼쳐 표시한다: 켜는 중(받기·설정·연결), 끄는 중, 방금 켰습니다(열 포트 안내), 껐습니다, 실패(다시 시도·기록).
 * 활성 상태이나 로그인 연동이 보류된 구역은 "연동 보류" 배지 + 한 줄 설명 + [다시 연결]. 재연결 작업도 동일 위치에서 진행 상태를 표시한다.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { zonesApi, localized, recommendGb, formatPorts, isActive, type ZoneRow } from '~/composables/useSystemZones'
import { UiSwitch } from '~/components/ui/Switch'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiBadge } from '~/components/ui/Badge'
import { UiProgress } from '~/components/ui/Progress'

export interface ZoneRowViewProps {
  zone: ZoneRow
  /** 설치 관리자가 없거나 연결되지 않아 변경 불가 */
  readOnly: boolean
  /** 다른 구역의 작업이 진행 중(동시 1건) */
  locked: boolean
  /** 서버 재기동 중이어서 진행 상태를 조회하지 못하는 상태 */
  reconnecting: boolean
  onToggle: (on: boolean) => void
  onSettings: () => void
  onRetry: () => void
  onDismiss: () => void
  /** 보류된 연결을 재시도한다 */
  onReconnect?: () => void
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ZoneRowView({ zone, readOnly, locked, reconnecting, onToggle, onSettings, onRetry, onDismiss, onReconnect }: ZoneRowViewProps) {
  const { t, locale } = useI18n()
  const name = localized(zone.name, locale)
  const job = zone.job
  const active = isActive(job)
  const failed = job?.status === 'failed'
  const done = job?.status === 'done'
  const kind = job?.kind
  // 연결 보류 — 활성 상태이고 현재 실행 중인 작업이 없을 때만 별도 표시한다(재연결 실패 직후에는 실패 줄이 대신 안내한다)
  const pending = zone.enabled && !!zone.pending && !active && !failed

  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState<string[] | null>(null)
  const [logError, setLogError] = useState(false)
  async function loadLog(): Promise<string[] | null> {
    if (!job) return null
    try { const r = await zonesApi.jobLog(job.id); setLog(r.lines); setLogError(false); return r.lines } catch { setLogError(true); return null }
  }
  async function toggleLog() {
    const next = !logOpen
    setLogOpen(next)
    if (next && log === null) await loadLog()
  }
  async function download() {
    const lines = log ?? await loadLog()
    if (lines) downloadText(`${zone.id}-${job?.id ?? 'log'}.log`, lines.join('\n') + '\n')
  }

  // 상태 표시
  const st = active
    ? { tone: kind === 'disable' ? 'text-muted-foreground' : 'text-primary', icon: 'loader', spin: true,
        text: reconnecting || job.status === 'unknown' ? t('admin.zones.status.reconnecting') : t(`admin.zones.status.${kind === 'disable' ? 'disabling' : kind === 'update' ? 'updating' : kind === 'reconnect' ? 'reconnectJob' : 'enabling'}`) }
    : failed
      ? { tone: 'text-danger', icon: 'alert-circle', spin: false, text: t(`admin.zones.status.${kind === 'disable' ? 'disableFailed' : kind === 'update' ? 'updateFailed' : kind === 'reconnect' ? 'reconnectFailed' : 'enableFailed'}`) }
      : pending
        ? { tone: 'text-warning', icon: 'alert-triangle', spin: false, text: t('admin.zones.status.pending') }
      : zone.enabled
        ? { tone: 'text-success', icon: 'check-circle', spin: false, text: t('admin.zones.status.on') }
        : { tone: 'text-muted-foreground', icon: 'minus', spin: false, text: t('admin.zones.status.off') }

  // 스위치는 목표 상태를 표시한다
  const switchOn = active ? kind !== 'disable' : zone.enabled
  const failedStage = job?.stages?.find(s => s.status === 'failed')?.id
  const failText = kind === 'disable'
    ? t('admin.zones.fail.disable', { name })
    : kind === 'update'
      ? t('admin.zones.fail.update', { name })
    : kind === 'reconnect'
      ? t('admin.zones.fail.reconnect', { name })
      : t(`admin.zones.fail.${failedStage === 'pull' || failedStage === 'configure' || failedStage === 'connect' ? failedStage : 'generic'}`, { name })
  const failHelp = kind === 'disable'
    ? `${t('admin.zones.fail.stayOn')} ${t('admin.zones.fail.seeLog')}`
    : kind === 'update'
      ? t('admin.zones.fail.seeLog')
    : kind === 'reconnect'
      ? t('admin.zones.fail.reconnectHelp')
      : `${t('admin.zones.fail.stayOff')} ${failedStage === 'pull' ? t('admin.zones.fail.checkInternet') : t('admin.zones.fail.seeLog')}`

  return (
    <div
      className={cn('flex flex-col border-t border-border', failed && 'bg-danger/10', done && kind !== 'disable' && 'bg-success/10')}
      data-testid={`zone-${zone.id}`}
      data-state={active ? 'busy' : failed ? 'failed' : done ? 'fresh' : pending ? 'pending' : zone.enabled ? 'on' : 'off'}
    >
      <div className="flex min-h-[52px] flex-wrap items-center gap-3 px-4 py-1">
        <span className="flex min-w-0 flex-1 basis-[220px] flex-col">
          <span className="text-[13.5px] font-medium">{name}</span>
          <span className="text-xs leading-4 text-muted-foreground">{localized(zone.summary, locale)}</span>
        </span>
        <span className="w-[76px] shrink-0 text-right font-mono text-xs text-muted-foreground">
          {zone.recommend_mb ? t('admin.zones.cost', { n: recommendGb(zone.recommend_mb) }) : t('admin.zones.costNone')}
        </span>
        <span className={cn('inline-flex w-[112px] shrink-0 items-center gap-1.5 text-[13px] font-medium', st.tone)} data-testid={`zone-${zone.id}-status`}>
          <UiIcon name={st.icon} className={cn('h-4 w-4', st.spin && 'animate-spin motion-reduce:animate-none')} />{st.text}
        </span>
        {zone.enabled && zone.has_settings && !readOnly && (
          <UiButton variant="outline" size="xs" disabled={active || locked} aria-label={t('admin.zones.settingsAria', { name })} onClick={onSettings}>{t('admin.zones.settings')}</UiButton>
        )}
        <UiSwitch ariaLabel={t('admin.zones.toggleAria', { name })} modelValue={switchOn} disabled={readOnly || active || locked} onUpdateModelValue={onToggle} />
      </div>

      {/* 연결 보류 */}
      {pending && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[13px]" role="status" data-testid={`zone-${zone.id}-pending`}>
          <UiBadge tone="warning" tint size={18}>{t('admin.zones.pending.badge')}</UiBadge>
          <span className="min-w-0 flex-1 basis-[220px] text-muted-foreground">{t('admin.zones.pending.desc')}</span>
          {!readOnly && onReconnect && (
            <UiButton variant="outline" size="xs" icon="refresh" disabled={locked} aria-label={t('admin.zones.pending.reconnectAria', { name })} onClick={onReconnect}>{t('admin.zones.pending.reconnect')}</UiButton>
          )}
        </div>
      )}

      {/* 켜는 중 · 설정 적용 중 · 다시 연결 중 */}
      {active && kind !== 'disable' && job.stages.length > 0 && (
        <div className="flex flex-col gap-2 px-4 pb-3.5">
          {job.stages.map(s => (
            <div key={s.id} className="flex items-center gap-3 text-xs leading-4" data-testid={`zone-${zone.id}-stage-${s.id}`}>
              <span className="w-[132px] shrink-0 truncate text-muted-foreground">{t(`admin.zones.stage.${s.id}`)}</span>
              <UiProgress className="min-w-0 flex-1" size="sm" label={t(`admin.zones.stage.${s.id}`)} value={s.status === 'done' ? 100 : s.status === 'running' ? null : 0} />
              <span className="w-[52px] shrink-0 text-right text-muted-foreground">{t(`admin.zones.stageStatus.${s.status}`)}</span>
            </div>
          ))}
        </div>
      )}
      {active && kind === 'disable' && <p className="px-4 pb-3 text-xs leading-4 text-muted-foreground">{t('admin.zones.offing')}</p>}

      {/* 종료 직후 */}
      {done && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[13px]" role="status">
          {kind === 'disable' ? (
            <span className="min-w-0 flex-1 text-muted-foreground">{t('admin.zones.fresh.off')}</span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 font-medium text-success">
                <UiIcon name="check-circle" className="h-4 w-4" />
                {kind === 'update' ? t('admin.zones.fresh.updated') : kind === 'reconnect' ? t('admin.zones.fresh.reconnected') : `${t('admin.zones.fresh.on')}${zone.menu ? ` ${t('admin.zones.fresh.menu')}` : ''}`}
              </span>
              <span className="min-w-0 flex-1 basis-[200px] text-muted-foreground">
                {job.ports.length > 0 && <><span className="font-mono">{formatPorts(job.ports)}</span>{t('admin.zones.fresh.ports')}</>}
              </span>
            </>
          )}
          <UiIconButton label={t('common.close')} icon="close" size="sm" onClick={onDismiss} />
        </div>
      )}

      {/* 실패 */}
      {failed && (
        <div className="flex flex-col gap-3 px-4 pb-3.5">
          <div className="flex flex-col gap-1 text-[13px]" role="alert">
            <span>{failText}</span>
            <span className="text-muted-foreground">{failHelp}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <UiButton size="sm" icon="refresh" disabled={locked} onClick={onRetry}>{t('admin.zones.fail.retry')}</UiButton>
            <UiButton size="sm" variant="secondary" onClick={onDismiss}>{kind === 'enable' ? t('admin.zones.fail.leaveOff') : t('common.close')}</UiButton>
            <UiButton size="sm" variant="outline" icon="terminal" iconRight={logOpen ? 'chevron-up' : 'chevron-down'} aria-expanded={logOpen} onClick={() => { void toggleLog() }}>{t('admin.zones.fail.showLog')}</UiButton>
            <UiButton size="sm" variant="outline" icon="download" onClick={() => { void download() }}>{t('admin.zones.fail.downloadLog')}</UiButton>
          </div>
          {logOpen && (
            <pre className="m-0 max-h-[132px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 font-mono text-xs leading-[18px] text-muted-foreground" data-testid={`zone-${zone.id}-log`}>
              {logError ? t('admin.zones.fail.logError') : log === null ? '…' : log.length ? log.join('\n') : t('admin.zones.fail.logEmpty')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export default ZoneRowView
