/**
 * 공유 링크 뷰 — 내가 만든 링크 전체. 시안 그림 없음 → 공통 규격(조밀 40 / 모바일 56).
 * 열: 파일 · 위치 · 상태(만료·1회용·다운로드 수) · 복사 · 회수. 파일 이름을 누르면 그 위치를 연다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useFiles, type FileItem, type ShareLinkListEntry } from '~/composables/useFiles'
import { useToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { linkMeta, parentLabel, shareUrl, type FilesTranslate } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiBadge } from '~/components/ui/Badge'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { FilesFileTypeIcon } from './FileTypeIcon'
import { writeClipboard } from '~/lib/clipboard'

export function FilesFileLinksView() {
  const { shareLinks, fetchShareLinks, deleteShareLink, openFileLocation } = useFiles()
  const { toast, addToast } = useToast()
  const { t } = useI18n()
  const tr: FilesTranslate = (k, p) => t(k, p ?? {})

  const [loading, setLoading] = useState(true)
  useEffect(() => { (async () => { await fetchShareLinks(); setLoading(false) })() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const links = shareLinks as ShareLinkListEntry[]

  async function copy(l: ShareLinkListEntry) {
    try {
      await writeClipboard(shareUrl(window.location.origin, l.token, !!l.can_edit, { hasPassword: l.has_password, allowDownload: l.allow_download, isFolder: l.is_folder }))
      toast({ type: 'success', title: t('files.links.copied') })
    } catch { addToast('error', t('files.links.copyError')) }
  }
  async function revoke(l: ShareLinkListEntry) {
    if (!await confirmBox(t('files.links.revokeConfirm', { name: l.display_name }), { title: t('files.links.revokeTitle'), confirmLabel: t('files.links.revoke'), danger: true })) return
    try {
      await deleteShareLink(l.id)
      toast({ type: 'success', title: t('files.links.revoked') })
    } catch (e: any) { addToast('error', e?.data?.detail || t('files.links.revokeError')) }
  }
  function open(l: ShareLinkListEntry) {
    openFileLocation({ name: l.display_name, path: l.file_path, is_dir: false, size: 0, modified_at: null, mime_type: null } as FileItem)
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-24 md:pb-0">
      {loading
        ? <UiSkeleton preset="list" rows={5} />
        : !links.length
          ? <UiEmptyState icon="link" title={t('files.links.emptyTitle')} description={t('files.links.emptyHint')} />
          : (
            <div role="table" aria-label={t('files.share.linkLabel')} className="text-[13px]">
              <div role="row" className="sticky top-0 z-10 hidden h-9 grid-cols-[40px_1fr_220px_260px_120px] items-center border-b border-border bg-background pr-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground md:grid">
                <span />
                <span role="columnheader">{t('files.detail.file')}</span>
                <span role="columnheader">{t('files.detail.location')}</span>
                <span role="columnheader">{t('files.links.status')}</span>
                <span role="columnheader"><span className="sr-only">{t('files.list.actions')}</span></span>
              </div>
              {links.map(l => (
                <div key={l.id} role="row" className="border-b border-border hover:bg-accent/40">
                  <div className="flex h-14 items-center gap-3 pl-4 pr-1 md:hidden">
                    <FilesFileTypeIcon item={{ name: l.display_name }} className="h-[22px] w-[22px]" strokeWidth={1.9} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(l)}>
                      <span className="block truncate text-[15px]">{l.display_name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{l.can_edit ? `${t('files.links.editable')} · ` : ''}{linkMeta(l, tr)}</span>
                    </button>
                    <UiIconButton label={t('files.links.copyItem', { name: l.display_name })} icon="copy" size="md" noTooltip onClick={() => copy(l)} />
                    <UiIconButton label={t('files.links.revokeItem', { name: l.display_name })} icon="trash" size="md" noTooltip onClick={() => revoke(l)} />
                  </div>
                  <div className="hidden h-10 grid-cols-[40px_1fr_220px_260px_120px] items-center pr-2 md:grid">
                    <span className="grid place-items-center"><UiIcon name="link" className="h-3.5 w-3.5 text-primary" /></span>
                    <span role="cell" className="flex min-w-0 items-center gap-2.5">
                      <FilesFileTypeIcon item={{ name: l.display_name }} className="h-4 w-4" />
                      <button type="button" className="truncate hover:underline" onClick={() => open(l)}>{l.display_name}</button>
                      {l.can_edit && <UiBadge tone="primary" tint size={18} className="shrink-0">{t('files.links.editable')}</UiBadge>}
                    </span>
                    <span role="cell" className="truncate text-muted-foreground">{parentLabel(l.file_path, tr) || '—'}</span>
                    <span role="cell" className="truncate font-mono text-[11px] text-muted-foreground">{linkMeta(l, tr)}</span>
                    <span role="cell" className="flex items-center justify-end gap-1">
                      <UiButton variant="outline" size="xs" aria-label={t('files.links.copyItem', { name: l.display_name })} onClick={() => copy(l)}>{t('common.copy')}</UiButton>
                      <UiIconButton label={t('files.links.revokeItem', { name: l.display_name })} icon="trash" onClick={() => revoke(l)} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
    </div>
  )
}

export default FilesFileLinksView
