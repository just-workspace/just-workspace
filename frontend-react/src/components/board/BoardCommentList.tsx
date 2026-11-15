/**
 * 댓글 목록 — Vue 판 components/board/BoardCommentList.vue 이식.
 */
import { useI18n } from '~/i18n'
import type { CommentInfo } from '~/composables/useBoard'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { BoardCommentItem } from './BoardCommentItem'

export interface BoardCommentListProps {
  comments: ReadonlyArray<CommentInfo>
  postId: string
  loading: boolean
  /** 답글을 달 수 있나(댓글을 끈 게시판·관리자만 댓글인 게시판에서는 false). 기본 true */
  canReply?: boolean
}

/** 댓글 목록(불러오는 중 · 없음 · 목록) */
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
