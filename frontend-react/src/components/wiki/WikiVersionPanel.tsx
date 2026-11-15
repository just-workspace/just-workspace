/**
 * 위키 버전 기록 패널 — Vue 판 components/wiki/WikiVersionPanel.vue 이식.
 *  행: v번호 34 mono · 작성자(맨 위는 "· 현재") / 시각 mono · +추가(success) −삭제(danger) 단어 수. 선택 = primary/13 바탕.
 *  모바일은 전체 화면("모바일은 전체 화면").
 */
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import type { WikiPageVersion } from '~/composables/useWiki'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'

export interface WikiVersionPanelProps {
  versions: WikiPageVersion[]
  selectedNumber: number | null
  /** version_number → 바로 앞 버전 대비 단어 수 */
  stats: Record<number, { added: number; removed: number }>
  loading?: boolean
  mobile?: boolean
  onSelect?: (v: WikiPageVersion) => void
  onClose?: () => void
}

function stamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 버전 목록 패널(데스크톱 320 / 모바일 전체 화면) */
export function WikiVersionPanel({ versions, selectedNumber, stats, loading, mobile, onSelect, onClose }: WikiVersionPanelProps) {
  const { t } = useI18n()
  return (
    <aside
      aria-label={t('wiki.versions.title')}
      className={cn('flex flex-col bg-card', mobile ? 'fixed inset-0 z-drawer pt-[env(safe-area-inset-top)]' : 'w-80 shrink-0 border-l border-border')}
    >
      <div className={cn('flex shrink-0 items-center border-b border-border pl-3.5 pr-1.5 text-[13px] font-semibold text-foreground', mobile ? 'h-14 text-base' : 'h-11')}>
        <span className="flex-1">{t('wiki.versions.title')}</span>
        <UiIconButton label={t('common.close')} icon="close" size={mobile ? 'lg' : 'sm'} noTooltip onClick={() => onClose?.()} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? <UiSkeleton preset="list" rows={5} /> : (
          <>
            {versions.map((v, i) => (
              <button
                key={v.id}
                type="button"
                className={cn(
                  'relative flex w-full gap-2.5 border-b border-border px-3.5 py-3 text-left text-[13px] transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selectedNumber === v.version_number ? 'bg-primary/[0.13] hover:bg-primary/[0.13]' : '',
                )}
                aria-current={selectedNumber === v.version_number ? 'true' : undefined}
                onClick={() => onSelect?.(v)}
              >
                <b className="w-[34px] shrink-0 font-mono text-xs font-bold text-foreground">v{v.version_number}</b>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-foreground">{v.author.display_name || v.author.username}{i === 0 && <> · {t('wiki.versions.current')}</>}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{stamp(v.created_at)}</span>
                    {stats[v.version_number] && (
                      <>
                        {' · '}<span className="font-mono text-success">+{stats[v.version_number].added}</span>
                        <span className="font-mono text-danger">−{stats[v.version_number].removed}</span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            ))}
            {!versions.length && <UiEmptyState variant="panel" icon="clock" title={t('wiki.versions.empty')} />}
          </>
        )}
      </div>
    </aside>
  )
}

export default WikiVersionPanel
