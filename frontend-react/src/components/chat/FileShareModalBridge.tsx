/**
 * 채널 파일 탭 › 공유 — 파일 모듈의 FilesFileShareModal(components/files/FileShareModal) 연결 다리.
 * 그 모달의 주인은 파일 모듈이다. 채팅 묶음에 싣지 않고 열 때 지연 로드한다.
 */
import { Suspense, lazy } from 'react'
import type { FileItem } from '~/composables/useFiles'

export interface ChatFileShareModalProps {
  items: FileItem[]
  initialTab?: 'link' | 'people' | null
  onClose?: () => void
}

const LazyShare = lazy(async () => ({ default: (await import('../files/FileShareModal')).FilesFileShareModal }))

/** 파일 공유 모달(파일 모듈 것) */
export function ChatFileShareModal(props: ChatFileShareModalProps) {
  return (
    <Suspense fallback={null}>
      <LazyShare {...props} />
    </Suspense>
  )
}

export default ChatFileShareModal
