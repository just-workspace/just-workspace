/**
 * 채널 파일 탭 › 공유 — 파일 모듈의 FilesFileShareModal(components/files/FileShareModal) 연결 다리.
 * 그 모달의 주인은 파일 모듈이다. 빌드 시점에 있으면 그것을(지연 로드),
 * 없으면 자리 표시를 띄운다 — 파일 모듈 쪽 파일만 있으면 이 파일을 고치지 않아도 진짜 모달이 뜬다.
 * 기대 계약: <FilesFileShareModal items={FileItem[]} initialTab="people" onClose={…} />
 */
import { Suspense, lazy, type ComponentType } from 'react'
import { useI18n } from '~/i18n'
import type { FileItem } from '~/composables/useFiles'
import { UiModal } from '~/components/ui/Modal'
import NotPortedYet from '~/components/NotPortedYet'

export interface ChatFileShareModalProps {
  items: FileItem[]
  initialTab?: 'link' | 'people' | null
  onClose?: () => void
}

const mods = import.meta.glob('../files/FileShareModal.tsx')
const loader = mods['../files/FileShareModal.tsx']
const LazyShare: ComponentType<ChatFileShareModalProps> | null = loader
  ? lazy(async () => {
    const m = await loader() as { FilesFileShareModal?: ComponentType<ChatFileShareModalProps>; default?: ComponentType<ChatFileShareModalProps> }
    return { default: (m.FilesFileShareModal ?? m.default)! }
  })
  : null

/** 파일 공유 모달(파일 모듈 것) — 없으면 자리 표시 */
export function ChatFileShareModal(props: ChatFileShareModalProps) {
  const { t } = useI18n()
  if (!LazyShare) {
    return (
      <UiModal title={t('common.share')} size="md" onClose={() => props.onClose?.()}>
        <NotPortedYet vuePath="components/files/FileShareModal.vue" />
      </UiModal>
    )
  }
  return (
    <Suspense fallback={null}>
      <LazyShare {...props} />
    </Suspense>
  )
}

export default ChatFileShareModal
