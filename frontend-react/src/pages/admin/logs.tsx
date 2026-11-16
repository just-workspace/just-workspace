/**
 * 관리 › 시스템 › 접근 로그.
 * 디자인 시안이 없는 화면 → 공용 표 규격(th 11/600 0.06em, 행 40 조밀 로그, 하단 바 48 mono 범위 + 32 버튼)과
 * 커맨드 바 필터(서비스 선택)로 구성.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { cn } from '~/lib/utils'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { useAdminAnalytics } from '~/composables/useAdminAnalytics'
import { fmtLogTime, codeTone } from '~/components/admin/analyticsFormat'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIconButton } from '~/components/ui/IconButton'

const LIMIT = 50
const SERVICES = ['', 'mail', 'calendar', 'contacts', 'files', 'meetings', 'git', 'admin', 'auth']

export default function AdminLogsPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.logs.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const { accessLogs, fetchAccessLogs } = useAdminAnalytics()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [service, setService] = useState<string>('')
  const [page, setPage] = useState(1)

  const options = SERVICES.map(s => ({
    value: s,
    label: s === '' ? t('admin.analytics.services.all') : s === 'git' ? 'Git' : t(`admin.analytics.services.${s}`),
  }))

  async function load(p = page, svc = service) {
    setLoading(true); setError(false)
    try {
      const r = await fetchAccessLogs(p, LIMIT, svc || undefined)
      if (!r) setError(true)
    } catch { setError(true) } finally { setLoading(false) }
  }
  // onMounted(load) + watch(service → 1쪽부터)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; void load(); return }
    setPage(1); void load(1, service)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service])

  const totalPages = accessLogs ? Math.max(1, Math.ceil(accessLogs.total / accessLogs.limit)) : 1
  function go(p: number) { setPage(p); void load(p) }

  if (!user?.is_admin) return null

  return (
    <AdminPageShell title={t('admin.logs.title')} subtitle={t('admin.logs.subtitle')}>
      <div className="flex flex-wrap items-center gap-2">
        <UiSelect modelValue={service} onUpdateModelValue={v => setService(String(v ?? ''))} options={options} size="sm" className="w-full sm:w-[200px]" aria-label={t('admin.logs.serviceAria')} />
      </div>

      {loading && !accessLogs
        ? <UiSkeleton preset="table" rows={8} framed />
        : error
          ? <UiErrorTile placement="panel" title={t('admin.logs.loadError')} onRetry={() => void load()} />
          : !accessLogs?.logs.length
            ? <UiEmptyState variant="full" icon="list" title={t('admin.analytics.accessLogs.empty')} />
            : (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-[13px]">
                    <thead>
                      <tr className="h-9 border-b border-border bg-card text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
                        <th scope="col" className="px-4">{t('admin.analytics.accessLogs.col.time')}</th>
                        <th scope="col" className="px-3">{t('admin.analytics.accessLogs.col.ip')}</th>
                        <th scope="col" className="px-3">{t('admin.analytics.accessLogs.col.path')}</th>
                        <th scope="col" className="px-3">{t('admin.analytics.accessLogs.col.status')}</th>
                        <th scope="col" className="px-3 text-right">{t('admin.analytics.accessLogs.col.response')}</th>
                        <th scope="col" className="px-3">{t('admin.analytics.accessLogs.col.browser')}</th>
                        <th scope="col" className="px-4">{t('admin.analytics.accessLogs.col.user')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accessLogs.logs.map(log => (
                        <tr key={log.id} className="h-10 border-b border-border last:border-b-0 hover:bg-accent/40">
                          <td className="whitespace-nowrap px-4 font-mono text-[11px] text-muted-foreground">{fmtLogTime(log.created_at)}</td>
                          <td className="px-3 font-mono text-xs">{log.ip_address}</td>
                          <td className="max-w-[280px] truncate px-3" title={`${log.method} ${log.path}`}><span className="font-mono text-[11px] text-muted-foreground">{log.method}</span> {log.path}</td>
                          <td className={cn('px-3 font-mono text-xs font-semibold', codeTone(log.status_code))}>{log.status_code}</td>
                          <td className="px-3 text-right font-mono text-[11px] text-muted-foreground">{log.response_time_ms} ms</td>
                          <td className="px-3 text-muted-foreground">{log.browser || '—'}</td>
                          <td className="px-4">{log.username || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex h-12 items-center gap-2 border-t border-border bg-card px-4">
                  <span className="flex-1 font-mono text-[11px] text-muted-foreground">
                    {((accessLogs.page - 1) * accessLogs.limit) + 1}–{Math.min(accessLogs.page * accessLogs.limit, accessLogs.total)} / {accessLogs.total.toLocaleString()}
                  </span>
                  <UiIconButton label={t('admin.common.prevPage')} icon="chevron-left" variant="outline" disabled={accessLogs.page <= 1 || loading} onClick={() => go(accessLogs.page - 1)} />
                  <UiIconButton label={t('admin.common.nextPage')} icon="chevron-right" variant="outline" disabled={accessLogs.page >= totalPages || loading} onClick={() => go(accessLogs.page + 1)} />
                </div>
              </div>
            )}
    </AdminPageShell>
  )
}
