/**
 * 전송 패널 — 업로드·다운로드 진행 표시는 본 패널로 단일화.
 *  데스크톱: 왼쪽 아래(레일 64 + 24, 아래 24) 폭 380, rounded 12, 그림자.
 *    머리 48 "올리는 중 3 / 5 · 약 40초 남음" + [모두 취소] + 접기 → 전체 진행 3px(가로 전체) →
 *    파일 행 52: 이름 13 + 아래 줄(진행 중 = 4px 막대 + mono 11 "64% · 1.4 / 2.2 MB" / 실패 = danger 12 사유 /
 *    완료 = "완료 · 2.1 MB" / 대기 = "대기 중") · 오른쪽(완료 ✓ "폴더에서 보기" success · 실패 [다시 시도] · 진행·대기 ✕ "취소")
 *    → 안내 12 "창을 닫아도 계속 올립니다 · 탭을 닫으면 멈춤".
 *  모바일: 탭바 위 8(선택 바 표시 중이면 그 위) · 좌우 12 · rounded 14 · 머리 52 · 행 48.
 * 기존 디스크 기록 진행률(서버가 실제로 기록한 바이트, NFS)은 진행 중 행의 mono 줄 끝에 "· 디스크 80%"로 덧붙여 표시한다(데스크톱).
 */
import { useState, type CSSProperties } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { formatSize } from '~/lib/files'
import { useTransfers, type Transfer } from '~/composables/useTransfers'
import { useSidebar } from '~/composables/useSidebar'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'

export interface FilesTransferPanelProps {
  /** 모바일 선택 바 표시 중이면 그 위로 배치(64 추가) */
  raised?: boolean
}

const ICON_BTN = 'relative grid h-8 w-8 shrink-0 place-items-center rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-1 before:content-[\'\']'

const live = (x: Transfer) => x.status === 'active' || x.status === 'queued'
function pct(x: Transfer) { return x.total ? Math.min(100, Math.round(x.loaded / x.total * 100)) : 0 }
function diskPct(x: Transfer) { return x.total ? Math.min(100, Math.round(x.written / x.total * 100)) : 0 }
function running(x: Transfer) { return x.status === 'active' && (x.loaded > 0 || x.speed > 0) }
/** 진행 중 mono 줄: "64% · 1.4 / 2.2 MB" */
function progressText(x: Transfer) {
  const sizes = x.total ? `${formatSize(x.loaded, '0 B')} / ${formatSize(x.total)}` : formatSize(x.loaded, '0 B')
  return x.total ? `${pct(x)}% · ${sizes}` : sizes
}

export function FilesTransferPanel({ raised = false }: FilesTransferPanelProps) {
  const { transfers, cancelTransfer, cancelAll, removeTransfer, clearFinished, activeCount } = useTransfers()
  const [collapsed, setCollapsed] = useState(false)
  const { t } = useI18n()
  // 주메뉴를 고정(236)하면 그 오른쪽으로 이동 — 고정 주메뉴(z-sidebar)가 본 패널(z-drawer)을 덮어 왼쪽이 잘리던 문제(토스트와 동일한 규칙)
  const { pushes } = useSidebar()

  const ups = transfers.filter(x => x.dir === 'up')
  const downs = transfers.filter(x => x.dir === 'down')
  const liveUps = ups.filter(live).length
  const failed = transfers.filter(x => x.status === 'error').length
  const hasFinished = transfers.some(x => !live(x))

  const heading = (() => {
    const group = liveUps ? ups : downs
    if (activeCount) {
      const done = group.filter(x => !live(x)).length
      const cur = Math.min(group.length, done + 1)
      return { verb: liveUps ? t('files.transfer.uploading') : t('files.transfer.downloading'), count: `${cur} / ${group.length}` }
    }
    if (failed) return { verb: t('files.transfer.failedCount', { n: failed }), count: '' }
    return { verb: t('files.transfer.done'), count: '' }
  })()

  // 전체 진행률·남은 시간(취소 제외 전체 합산 — 대기 중은 0 으로 포함)
  const activeList = transfers.filter(x => x.status === 'active')
  const overall = (() => {
    const all = transfers.filter(x => x.status !== 'canceled')
    const total = all.reduce((s, x) => s + (x.total || 0), 0)
    const loaded = all.reduce((s, x) => s + (x.status === 'done' ? (x.total || x.loaded) : x.loaded), 0)
    return total ? Math.min(100, Math.round(loaded / total * 100)) : (activeCount ? 0 : 100)
  })()
  const eta = (() => {
    const remain = transfers.filter(live).reduce((s, x) => s + Math.max(0, (x.total || 0) - x.loaded), 0)
    const speed = activeList.reduce((s, x) => s + (x.speed || 0), 0)
    if (!remain || !speed) return ''
    const s = Math.round(remain / speed)
    if (s < 60) return t('files.transfer.remainSeconds', { s: Math.max(1, s) })
    if (s < 3600) return t('files.transfer.remainMinutes', { m: Math.round(s / 60) })
    return t('files.transfer.remainHours', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) })
  })()

  /** 조용한 줄(완료·대기·취소) */
  function quietText(x: Transfer) {
    if (x.status === 'done') return t('files.transfer.completedWith', { size: formatSize(x.total || x.loaded, '0 B') })
    if (x.status === 'canceled') return t('files.transfer.canceled')
    return t('files.transfer.waitingLong')
  }

  function showInFolder(x: Transfer) {
    if (!x.folder) return
    void navigateTo({ path: '/files', query: { path: x.folder } })
  }

  const hasUploads = ups.length > 0
  const bottom = `calc(64px + 8px + env(safe-area-inset-bottom)${raised ? ' + 64px' : ''})`

  if (!transfers.length) return null

  return (
    <div
      role="region"
      aria-label={t('files.transfer.label')}
      className={clsx('fixed left-3 right-3 z-drawer bottom-[var(--tp-b)] md:bottom-6 md:right-auto md:w-[380px]', pushes ? 'md:left-[260px]' : 'md:left-[88px]')}
      style={{ '--tp-b': bottom } as CSSProperties}
    >
      <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-lg md:rounded-lg md:shadow-[0_16px_40px_hsl(var(--scrim)/0.55)]">
        {/* 머리 */}
        <div className="flex h-[52px] items-center gap-1.5 border-b border-border pl-3.5 pr-1.5 text-[13px] md:h-12">
          <span className="min-w-0 flex-1 truncate" role="status">
            <b className="font-semibold">{heading.verb} {heading.count && <span className="font-mono">{heading.count}</span>}</b>
            {eta && <span className="text-muted-foreground"> · {eta}</span>}
          </span>
          {activeCount
            ? (
              <button
                type="button"
                className="h-10 shrink-0 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={cancelAll}
              >{t('files.transfer.cancelAll')}</button>
            )
            : hasFinished
              ? (
                <button
                  type="button"
                  className="h-10 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={clearFinished}
                >{t('common.clear')}</button>
              )
              : null}
          <UiIconButton
            label={collapsed ? t('files.transfer.expand') : t('files.transfer.collapse')}
            icon="chevron-down"
            size="md"
            noTooltip
            aria-expanded={!collapsed}
            className={collapsed ? '[&>svg]:rotate-180' : ''}
            onClick={() => setCollapsed(v => !v)}
          />
        </div>
        {/* 전체 진행 3px */}
        <div className="h-[3px] bg-muted" role="progressbar" aria-valuenow={overall} aria-valuemin={0} aria-valuemax={100} aria-label={t('files.transfer.overall')}>
          <div className={clsx('h-full transition-all duration-200', failed && !activeCount ? 'bg-danger' : 'bg-primary')} style={{ width: `${overall}%` }} />
        </div>

        {!collapsed && (
          <>
            <ul className="max-h-72 overflow-y-auto">
              {transfers.map(x => (
                <li key={x.id} className="flex min-h-12 items-center gap-2.5 border-b border-border py-1.5 pl-3.5 pr-1.5 text-[13px] md:min-h-[52px]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate" title={x.name}>{x.name}</div>
                    {/* 진행 중: 막대 4 + mono */}
                    {running(x)
                      ? (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="h-1 flex-1 rounded-full bg-muted" aria-hidden="true"><span className="block h-full rounded-full bg-primary transition-all duration-200" style={{ width: `${pct(x)}%` }} /></span>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                            {progressText(x)}{x.dir === 'up' && !!x.total && !!x.written && <span className="hidden md:inline"> · {t('files.transfer.disk', { percent: diskPct(x) })}</span>}
                          </span>
                        </div>
                      )
                      : x.status === 'error'
                        ? <div className="truncate text-xs font-medium text-danger" title={x.error}>{x.error || t('files.transfer.failed')}</div>
                        : <div className="text-xs text-muted-foreground">{quietText(x)}</div>}
                  </div>

                  {x.status === 'done' && x.folder
                    ? (
                      <button
                        type="button"
                        aria-label={t('files.transfer.showInFolder')}
                        title={t('files.transfer.showInFolder')}
                        className={`${ICON_BTN} text-success hover:bg-accent`}
                        onClick={() => showInFolder(x)}
                      ><UiIcon name="check" strokeWidth={3} className="h-4 w-4" /></button>
                    )
                    : x.status === 'done'
                      ? (
                        <span role="img" aria-label={t('files.transfer.completed')} className="grid h-8 w-8 shrink-0 place-items-center text-success">
                          <UiIcon name="check" strokeWidth={3} className="h-4 w-4" />
                        </span>
                      )
                      : x.status === 'error' && x.retry
                        ? (
                          <button
                            type="button"
                            className="relative inline-flex h-7 shrink-0 items-center rounded-sm border border-border px-2.5 text-xs font-semibold hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
                            onClick={() => x.retry?.()}
                          >{t('common.retry')}</button>
                        )
                        : null}
                  {live(x)
                    ? (
                      <button
                        type="button"
                        aria-label={t('files.transfer.cancelItem', { name: x.name })}
                        className={`${ICON_BTN} text-muted-foreground hover:bg-accent hover:text-foreground`}
                        onClick={() => cancelTransfer(x.id)}
                      ><UiIcon name="close" strokeWidth={2.2} className="h-[15px] w-[15px]" /></button>
                    )
                    : x.status === 'canceled' || (x.status === 'error' && !x.retry)
                      ? (
                        <button
                          type="button"
                          aria-label={t('files.transfer.removeItem', { name: x.name })}
                          className={`${ICON_BTN} text-muted-foreground hover:bg-accent hover:text-foreground`}
                          onClick={() => removeTransfer(x.id)}
                        ><UiIcon name="close" strokeWidth={2.2} className="h-[15px] w-[15px]" /></button>
                      )
                      : null}
                </li>
              ))}
            </ul>
            {hasUploads && <p className="px-3.5 py-2 text-xs text-muted-foreground">{t('files.transfer.keepGoing')}</p>}
          </>
        )}
      </div>
    </div>
  )
}

export default FilesTransferPanel
