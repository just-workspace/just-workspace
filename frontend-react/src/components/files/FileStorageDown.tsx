/**
 * 파일 저장소가 끊겼을 때의 파일 탭 — 목록·올리기·새 폴더 대신 이 안내만 보인다.
 * 일반 사용자: 지금은 열 수 없다는 안내와 [다시 확인]. 관리자: 저장소 화면으로 가는 버튼이 더 있다.
 * 저장소가 돌아오면 composables/useStorageStatus 가 알아채 파일 탭이 원래대로 돌아간다.
 */
import { useI18n } from '~/i18n'
import { useStorageStatus } from '~/composables/useStorageStatus'
import { UiErrorTile } from '~/components/ui/ErrorTile'

export function FilesFileStorageDown({ admin = false }: { admin?: boolean }) {
  const { t } = useI18n()
  const { checking, recheck } = useStorageStatus()
  return (
    <div className="flex h-full flex-col items-center overflow-y-auto px-4 py-6 md:px-6" data-testid="files-storage-down">
      <div className="flex w-full max-w-[880px] flex-col gap-4">
        <h1 className="text-2xl font-bold text-foreground">{t('nav.files')}</h1>
        <div className="flex min-h-[420px] flex-col rounded-xl border border-border" aria-busy={checking}>
          <UiErrorTile
            placement="page"
            title={t('files.storageDown.title')}
            detail={admin ? t('files.storageDown.detailAdmin') : t('files.storageDown.detail')}
            retryLabel={checking ? t('files.storageDown.checking') : t('files.storageDown.recheck')}
            onRetry={() => { if (!checking) void recheck() }}
            secondaryLabel={admin ? t('files.storageDown.toAdmin') : undefined}
            secondaryTo={admin ? '/admin/storage' : undefined}
          />
        </div>
        <p className="text-xs leading-[18px] text-muted-foreground">{t('files.storageDown.note')}</p>
      </div>
    </div>
  )
}

export default FilesFileStorageDown
