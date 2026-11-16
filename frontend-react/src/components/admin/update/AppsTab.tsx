/**
 * 업데이트 › 앱 배포 — 현재 서버 버전에 함께 포함된 앱 설치 파일(데스크톱·모바일).
 * 포함된 항목만 표시한다. 하나도 포함되지 않은 버전이면 빈 상태와 안내를 표시한다.
 */
import { useI18n } from '~/i18n'
import { writeClipboard } from '~/lib/clipboard'
import { addToast } from '~/composables/useToast'
import { updateApi, type AppFile } from '~/composables/useSystemUpdate'
import { Mono, Unavailable, useLoad } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiInput } from '~/components/ui/Input'
import { UiTable } from '~/components/ui/Table'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'

const KNOWN = ['windows-desktop', 'android']
const absolute = (url: string) => (/^https?:\/\//.test(url) || typeof location === 'undefined' ? url : location.origin + (url.startsWith('/') ? url : `/${url}`))

export function AppsTab() {
  const { t } = useI18n()
  const { data, error, unavailable, reload } = useLoad(() => updateApi.apps())

  if (unavailable) return <Unavailable reason={unavailable} />
  if (!data) {
    return error
      ? <UiErrorTile placement="card" title={t('admin.update.apps.loadError')} onRetry={() => { void reload() }} />
      : <UiCard><UiSkeleton preset="list" rows={3} /></UiCard>
  }

  const appName = (r: AppFile) => (KNOWN.includes(r.kind) ? t(`admin.update.apps.kind.${r.kind}.app`) : r.kind)
  const osName = (r: AppFile) => (KNOWN.includes(r.kind) ? t(`admin.update.apps.kind.${r.kind}.os`) : '')
  const full = (r: AppFile) => [osName(r), appName(r)].filter(Boolean).join(' ')
  function download(r: AppFile) {
    const a = document.createElement('a')
    a.href = r.url ?? ''
    a.download = r.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  async function copy(r: AppFile) {
    try { await writeClipboard(absolute(r.url ?? '')); addToast('success', t('admin.update.apps.copied')) } catch { addToast('error', t('common.copyFailed')) }
  }

  return (
    <>
      <p className="text-[13px] text-muted-foreground"><UiTrans k="admin.update.apps.intro" slots={{ version: <Mono>{data.version}</Mono> }} /></p>

      {data.download_page && data.apps.length > 0 && (
        <UiInput readonly mono label={t('admin.update.apps.pageLabel')} hint={t('admin.update.apps.pageHint')} modelValue={absolute(data.download_page)} />
      )}

      <UiCard className="overflow-hidden">
        <h2 className="px-4 py-2.5 text-base font-semibold leading-6">{t('admin.update.apps.files')}</h2>
        {data.apps.length === 0 ? (
          <div className="border-t border-border" data-testid="update-apps-empty">
            <UiEmptyState variant="panel" icon="download" title={t('admin.update.apps.empty')} />
          </div>
        ) : (
          <UiTable
            className="border-t border-border"
            label={t('admin.update.apps.files')}
            minWidthClass="min-w-[620px]"
            rows={data.apps}
            rowKey={r => `${r.kind}:${r.filename}`}
            columns={[
              { key: 'app', header: t('admin.update.apps.col.app'), className: 'whitespace-nowrap', cell: appName },
              { key: 'os', header: t('admin.update.apps.col.os'), cell: osName },
              { key: 'ver', header: t('admin.update.notes.version'), mono: true, cell: r => r.version ?? '' },
              { key: 'file', header: t('admin.update.apps.col.file'), mono: true, className: 'text-muted-foreground [overflow-wrap:anywhere]', cell: r => r.filename },
              {
                key: 'act', header: '',
                cell: r => (r.url ? (
                  <div className="-my-1.5 flex justify-end gap-1">
                    <UiIconButton icon="copy" label={t('admin.update.apps.copy', { name: full(r) })} onClick={() => { void copy(r) }} />
                    <UiIconButton icon="download" label={t('admin.update.apps.get', { name: full(r) })} onClick={() => download(r)} />
                  </div>
                ) : null),
              },
            ]}
          />
        )}
      </UiCard>

      <p className="text-xs leading-[18px] text-muted-foreground">{t('admin.update.apps.footnote')}</p>
    </>
  )
}

export default AppsTab
