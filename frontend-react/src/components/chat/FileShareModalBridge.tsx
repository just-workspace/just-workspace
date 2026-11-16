/**
 * 채널 파일 탭 › 공유 — 파일 모듈의 FilesFileShareModal(components/files/FileShareModal) 연결 브리지.
 * 해당 모달의 소유 모듈은 파일 모듈이다. 채팅 번들에 포함하지 않고 열 때 지연 로드한다.
 */
import { Suspense, lazy } from 'react'
import type { FileItem } from '~/composables/useFiles'

export interface ChatFileShareModalProps {
  items: FileItem[]
  initialTab?: 'link' | 'people' | null
  onClose?: () => void
}

const LazyShare = lazy(async () => ({ default: (await import('../files/FileShareModal')).FilesFileShareModal }))

/** 파일 공유 모달(파일 모듈 소유) */
export function ChatFileShareModal(props: ChatFileShareModalProps) {
  return (
    <Suspense fallback={null}>
      <LazyShare {...props} />
    </Suspense>
  )
}

export default ChatFileShareModal
