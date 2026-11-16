/**
 * 폴더 목록 조회 실패 시(권한 없음·없는 폴더·네트워크) — 목록·그리드가 공용으로 사용한다.
 * 이전에는 실패를 무시하고 목록을 비워 "이 폴더는 비어 있습니다"로 표시되었다. 빈 폴더와 구분하여 원인 + [다시 시도]를 표시한다.
 * 이전에 조회한 폴더 목록은 스토어에 유지되므로, [돌아가기]를 누르면 해당 목록으로 복귀한다.
 */
import { useI18n } from '~/i18n'
import { useFiles } from '~/composables/useFiles'
import { textOr } from '~/lib/files'
import { UiErrorTile } from '~/components/ui/ErrorTile'

export function FilesFileListError() {
  const { listError, retryList, dismissListError } = useFiles()
  const { t } = useI18n()
  if (!listError) return null
  const name = listError.path.split('/').filter(Boolean).pop() || ''
  const title = listError.status === 404
    ? textOr(t, 'files.list.loadNotFound', '"{name}" 폴더를 찾을 수 없습니다', { name })
    : listError.status === 403
      ? textOr(t, 'files.list.loadForbidden', '"{name}" 폴더를 열 권한이 없습니다', { name })
      : textOr(t, 'files.list.loadError', '폴더를 불러오지 못했습니다')
  return (
    <div className="flex flex-col items-center gap-2">
      <UiErrorTile placement="panel" title={title} detail={listError.message || undefined} onRetry={() => { void retryList() }} />
      <button
        type="button"
        className="text-[13px] font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={dismissListError}
      >{textOr(t, 'files.list.loadBack', '보던 폴더로 돌아가기')}</button>
    </div>
  )
}

export default FilesFileListError
