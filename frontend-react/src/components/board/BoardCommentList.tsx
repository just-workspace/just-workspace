/**
 * 댓글 목록.
 */
import { useI18n } from '~/i18n'
import type { CommentInfo } from '~/composables/useBoard'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { BoardCommentItem } from './BoardCommentItem'

export interface BoardCommentListProps {
  comments: ReadonlyArray<CommentInfo>
  postId: string
  loading: boolean
  /** 답글 작성 가능 여부(댓글을 비활성화한 게시판·관리자만 댓글 가능한 게시판에서는 false). 기본값 true */
  canReply?: boolean
}

/** 댓글 목록(로딩 중 · 없음 · 목록) */
export function BoardCommentList({ comments, postId, loading, canReply = true }: BoardCommentListProps) {
  const { t } = useI18n()
  return (
    <div>
      {loading ? (
        <UiSkeleton preset="list" rows={3} />
      ) : comments.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t('board.comment.empty')}</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {comments.map(comment => (
            <BoardCommentItem key={comment.id} comment={comment} postId={postId} depth={0} canReply={canReply} />
          ))}
        </div>
      )}
    </div>
  )
}

export default BoardCommentList
