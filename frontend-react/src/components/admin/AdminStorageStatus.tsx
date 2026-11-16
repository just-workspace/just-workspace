/**
 * 관리 › 저장소 — 저장소 상태 카드.
 * 종류(이 서버의 디스크 / 네트워크 저장소) · 위치 · 연결 상태(색 + 아이콘 + 글자) · 여유 공간 · 마지막 확인, [다시 확인].
 * 연결이 끊긴 경우 상단에 경고 상자를 표시하고, 해당 기간에는 15초마다 자동으로 재확인한다(연결되면 경고 제거).
 * 값이 없는 줄(위치를 알 수 없는 설치 등)은 숨긴다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { formatSize } from '~/lib/date'
import { recheckStorage } from '~/composables/useStorageStatus'
import { UiCard } from '~/components/ui/Card'
import { UiCallout } from '~/components/ui/Callout'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiProgress } from '~/components/ui/Progress'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'

export interface StorageState {
  guarded: boolean
  kind: 'local' | 'nfs'
  location: string | null
  state: 'ok' | 'down'
  reason: string | null
  write: boolean | null
  lock: boolean | null
  total_bytes: number | null
  used_bytes: number | null
  free_bytes: number | null
  checked_at: string | null
  down_since: string | null
}

export const storageCardTiming = { downMs: 15_000 }

function Row({ label, first, children }: { label: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('flex min-h-11 flex-wrap items-center gap-3 px-4 py-1', !first && 'border-t border-border')}>
      <dt className="w-[104px] shrink-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 basis-[200px]">{children}</dd>
    </div>
  )
}

export function AdminStorageStatus({ className }: { className?: string }) {
  const { t, locale } = useI18n()
  const [st, setSt] = useState<StorageState | null>(null)
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(false)
  const alive = useRef(true)

  const load = useCallback(async (force: boolean) => {
    setChecking(true)
    try {
      const r = await $fetch<StorageState>(force ? '/api/admin/system/storage/recheck' : '/api/admin/system/storage', force ? { method: 'POST' } : undefined)
      if (!alive.current) return
      setSt(r); setError(false)
      if (force) void recheckStorage()      // 알림 띠·파일 탭도 함께 갱신
    } catch {
      if (alive.current) setError(true)
    } finally {
      if (alive.current) setChecking(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load(false)
    return () => { alive.current = false }
  }, [load])

  // 연결이 끊긴 동안에만 자동 재확인
  const down = st?.state === 'down'
  useEffect(() => {
    if (!down) return
    const id = setInterval(() => { void load(true) }, storageCardTiming.downMs)
    return () => clearInterval(id)
  }, [down, load])

  const when = (iso: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  }

  if (error && !st) return <UiErrorTile placement="card" title={t('admin.storageStatus.loadError')} onRetry={() => { void load(false) }} className={className} />
  if (!st) return <UiCard className={className}><UiSkeleton preset="list" rows={4} /></UiCard>

  const nfs = st.kind === 'nfs'
  const conn = down
    ? { tone: 'text-danger', icon: 'alert-circle', text: t('admin.storageStatus.conn.down') }
    : st.write === false
      ? { tone: 'text-warning', icon: 'alert-triangle', text: t('admin.storageStatus.conn.noWrite') }
      : st.lock === false
        ? { tone: 'text-warning', icon: 'alert-triangle', text: t('admin.storageStatus.conn.noLock') }
        : { tone: 'text-success', icon: 'check-circle', text: nfs ? t('admin.storageStatus.conn.okNfs') : t('admin.storageStatus.conn.ok') }
  const usedPct = st.total_bytes && st.used_bytes != null ? Math.round((st.used_bytes / st.total_bytes) * 100) : 0
  const since = when(st.down_since)
  const reasonKey = st.reason && ['missing', 'unreadable', 'mismatch', 'unresponsive'].includes(st.reason) ? st.reason : null

  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="storage-status">
      {down && (
        <UiCallout
          tone="danger"
          role="alert"
          title={t('admin.storageStatus.down.title')}
          actions={<UiButton size="sm" icon="refresh" disabled={checking} onClick={() => { void load(true) }}>{t('admin.storageStatus.recheck')}</UiButton>}
        >
          <span className="text-muted-foreground">
            {since && <><span className="font-mono">{since}</span>{t('admin.storageStatus.down.since')}{' · '}</>}
            {t('admin.storageStatus.down.effect')}{' '}
            {nfs ? t('admin.storageStatus.down.checkNfs') : t('admin.storageStatus.down.checkLocal')}{' '}
            {t('admin.storageStatus.down.auto')}
            {reasonKey && <>{' '}<span data-testid="storage-reason">{t(`admin.storageStatus.reason.${reasonKey}`)}</span></>}
          </span>
        </UiCallout>
      )}

      <UiCard className="overflow-hidden">
        <dl className="m-0 flex flex-col text-[13.5px]">
          <Row label={t('admin.storageStatus.kind')} first>{nfs ? t('admin.storageStatus.kindNfs') : t('admin.storageStatus.kindLocal')}</Row>
          {st.location && <Row label={t('admin.storageStatus.location')}><span className="break-all font-mono">{st.location}</span></Row>}
          <Row label={t('admin.storageStatus.connLabel')}>
            <span className={cn('inline-flex flex-wrap items-center gap-1.5 font-medium', conn.tone)} data-testid="storage-conn">
              <UiIcon name={conn.icon} className="h-4 w-4" />{conn.text}
            </span>
          </Row>
          <Row label={t('admin.storageStatus.free')}>
            {down || st.free_bytes == null ? (
              <span>{t('admin.storageStatus.freeUnknown')}</span>
            ) : (
              <span className="flex flex-wrap items-center gap-3">
                <span className="font-mono">{formatSize(st.free_bytes)}</span>
                <UiProgress as="meter" label={t('admin.storageStatus.usedAria')} value={usedPct} size="sm" className="min-w-0 flex-1 basis-40" />
              </span>
            )}
          </Row>
          {when(st.checked_at) && <Row label={t('admin.storageStatus.checkedAt')}><span className="font-mono">{when(st.checked_at)}</span></Row>}
        </dl>
      </UiCard>

      <div className="flex flex-wrap items-center gap-3">
        <UiButton variant="secondary" icon="refresh" disabled={checking} onClick={() => { void load(true) }}>
          {checking ? t('admin.storageStatus.checking') : t('admin.storageStatus.recheck')}
        </UiButton>
      </div>

      <UiCallout variant="plain" tone="info" role="status"><span className="text-muted-foreground">{t('admin.storageStatus.note')}</span></UiCallout>
    </div>
  )
}

export default AdminStorageStatus
