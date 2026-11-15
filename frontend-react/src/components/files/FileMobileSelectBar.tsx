/**
 * 모바일 선택 바(Vue components/files/FileMobileSelectBar.vue · 시안 PatMobile P7 · 결정 3): 탭바 위 8 에 떠 있는 바 —
 * 56 · rounded 16 · 반전색(foreground 바탕), 항목 = 아이콘 18 위 + 글자 11/600, 최소 폭 56. 공유 · 이동 · 다운로드 · 삭제.
 */
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'

export interface FilesFileMobileSelectBarProps {
  onShare?: () => void
  onMove?: () => void
  onDownload?: () => void
  onDelete?: () => void
}

const ACTS = [
  { key: 'share', labelKey: 'common.share', icon: 'share-up' },
  { key: 'move', labelKey: 'common.move', icon: 'move' },
  { key: 'download', labelKey: 'common.download', icon: 'download' },
  { key: 'delete', labelKey: 'common.delete', icon: 'trash' },
] as const

export function FilesFileMobileSelectBar({ onShare, onMove, onDownload, onDelete }: FilesFileMobileSelectBarProps) {
  const { t } = useI18n()

  function act(k: typeof ACTS[number]['key']) {
    if (k === 'share') onShare?.()
    else if (k === 'move') onMove?.()
    else if (k === 'download') onDownload?.()
    else onDelete?.()
  }

  return (
    <div
      role="toolbar"
      aria-label={t('files.selectBar.label')}
      className="fixed left-3 right-3 z-drawer flex h-14 items-center justify-around rounded-sheet bg-foreground text-[11px] font-semibold text-background shadow-lg md:hidden"
      style={{ bottom: 'calc(64px + 8px + env(safe-area-inset-bottom))' }}
    >
      {ACTS.map(a => (
        <button
          key={a.key}
          type="button"
          className="flex h-full min-w-14 flex-col items-center justify-center gap-0.5 rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => act(a.key)}
        >
          <UiIcon name={a.icon} className="h-[18px] w-[18px]" />
          {t(a.labelKey)}
        </button>
      ))}
    </div>
  )
}

export default FilesFileMobileSelectBar
