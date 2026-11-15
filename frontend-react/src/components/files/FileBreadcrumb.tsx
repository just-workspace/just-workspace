/**
 * 커맨드 바 안 경로("경로는 바 안"):
 * 상위 조각 muted + ›, 현재 600. 상위 조각은 끌어다 놓기(이동) 대상.
 */
import { Fragment, useState, type DragEvent } from 'react'
import { useI18n } from '~/i18n'
import { clsx } from 'clsx'
import { cn } from '~/lib/utils'
import { DRAG_MIME } from '~/lib/files'
import { useFiles } from '~/composables/useFiles'
import { UiIcon } from '~/components/ui/Icon'

export interface FilesFileBreadcrumbProps {
  className?: string
  /** 앱 안 끌기를 조각에 놓음 — (옮길 경로들, 대상 폴더) */
  onDropMove?: (paths: string[], dst: string) => void
}

export function FilesFileBreadcrumb({ className, onDropMove }: FilesFileBreadcrumbProps) {
  const { breadcrumbs, navigateTo, view } = useFiles()
  const { t } = useI18n()

  const VIEW_LABEL: Record<string, string> = { 'shared-with-me': t('files.view.sharedWithMe'), recent: t('files.sidebar.recent'), starred: t('files.sidebar.starred'), links: t('files.share.linkLabel'), trash: t('files.view.trash') }

  const [dropPath, setDropPath] = useState<string | null>(null)
  function onDragOver(path: string, e: DragEvent) {
    if (!e.dataTransfer?.types.includes(DRAG_MIME) || path === 'users') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropPath(path)
  }
  function onDrop(path: string, e: DragEvent) {
    setDropPath(null)
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    try {
      const paths = JSON.parse(e.dataTransfer.getData(DRAG_MIME) || '[]') as string[]
      if (paths.length) onDropMove?.(paths, path)
    } catch { /* 무시 */ }
  }

  return (
    <nav aria-label={t('files.breadcrumb.label')} className={cn('flex min-w-0 items-center gap-1 text-[13px]', className)}>
      {view !== 'files'
        ? <b className="truncate font-semibold">{VIEW_LABEL[view]}</b>
        : breadcrumbs.map((c, i) => (
          i < breadcrumbs.length - 1
            ? (
              <Fragment key={c.path}>
                <button
                  type="button"
                  className={clsx(
                    'max-w-[160px] shrink truncate rounded-sm px-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    dropPath === c.path ? 'bg-primary/[0.13] text-foreground shadow-[inset_0_0_0_2px_hsl(var(--primary))]' : '',
                  )}
                  onClick={() => navigateTo(c.path)}
                  onDragOver={e => onDragOver(c.path, e)}
                  onDragLeave={() => setDropPath(null)}
                  onDrop={e => onDrop(c.path, e)}
                >{c.label}</button>
                <UiIcon name="chevron-right" className="h-3 w-3 shrink-0 text-muted-foreground" strokeWidth={2.4} />
              </Fragment>
            )
            : <b key={c.path} className="min-w-0 truncate px-1 font-semibold" aria-current="page">{c.label}</b>
        ))}
    </nav>
  )
}

export default FilesFileBreadcrumb
