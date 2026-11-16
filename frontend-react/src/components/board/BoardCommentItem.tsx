/**
 * 댓글 한 개("1단 답글 + @멘션, 아바타 24 통일").
 *  아바타 24 · 이름 600 + 시각 mono 11 · 본문 14/1.6(@언급 = accent 바탕 칩) · 행동 줄 12/600 muted(답글 · 수정 · 삭제)
 *  답글은 동일 열 안쪽(아바타 옆)에 이어서 배치된다. 답글의 답글은 지원하지 않는다(1단).
 */
import { Fragment, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { deleteComment, updateComment, type CommentInfo } from '~/composables/useBoard'
import { authorName, boardStamp, initialOf, splitResolvedMentions } from '~/utils/boardFormat'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiButton } from '~/components/ui/Button'
import { BoardCommentInput } from './BoardCommentInput'

export interface BoardCommentItemProps {
  comment: CommentInfo
  postId: string
  depth: number
  /** 답글 버튼 표시 여부(기본값 true) */
  canReply?: boolean
}

/** 댓글(+답글) */
export function BoardCommentItem({ comment, postId, depth, canReply = true }: BoardCommentItemProps) {
  const { t } = useI18n()
  const { user } = useAuth()

  const [showReply, setShowReply] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const name = authorName(comment.author) || t('common.unknownUser')
  // 서버가 해석한 멘션(mentions[])만 칩으로 표시 — 이전 댓글(mentions 없음)은 문자 그대로의 @언급을 칩으로 표시
  const parts = splitResolvedMentions(comment.content || '', comment.mentions)
  const canEdit = !user || comment.is_deleted ? false : (comment.author?.id === user.id || user.is_admin)

  function startEdit() {
    setEditContent(comment.content)
    setEditing(true)
  }
  async function saveEdit() {
    if (!editContent.trim()) return
    setSubmitting(true)
    try {
      await updateComment(comment.id, editContent.trim())
      setEditing(false)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.comment.editError'))
    } finally {
      setSubmitting(false)
    }
  }
  async function handleDelete() {
    if (!await confirmBox(t('board.comment.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) return
    try {
      await deleteComment(comment.id)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.comment.deleteError'))
    }
  }

  return (
    <div id={`comment-${comment.id}`} className={cn('flex gap-2.5', depth > 0 ? 'mt-2.5' : '')}>
      <UiAvatar src={comment.author?.avatar_url} alt={name} fallback={initialOf(name)} className="h-6 w-6 shrink-0" textSize={10} />
      <div className="min-w-0 flex-1 text-sm leading-[1.6]">
        {comment.is_deleted ? (
          <p className="italic text-muted-foreground">{comment.content}</p>
        ) : (
          <>
            <div className="flex min-w-0 items-baseline gap-1.5">
              <b className="truncate font-semibold text-foreground">{name}</b>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{boardStamp(comment.created_at)}</span>
              {comment.is_edited && <span className="shrink-0 text-[11px] text-muted-foreground">{t('board.comment.edited')}</span>}
            </div>

            {editing ? (
              <div className="mt-1">
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  autoComplete="off"
                  rows={3}
                  aria-label={t('board.comment.editLabel')}
                  className="w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-hidden focus:border-ring focus:ring-2 focus:ring-ring/30"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveEdit() }
                    else if (e.key === 'Escape') setEditing(false)
                  }}
                />
                <div className="mt-1 flex gap-1">
                  <UiButton size="xs" disabled={submitting || !editContent.trim()} onClick={() => { void saveEdit() }}>{t('common.save')}</UiButton>
                  <UiButton size="xs" variant="ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</UiButton>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words text-foreground">
                {parts.map((pt, i) => pt.mention
                  ? <span key={i} className="rounded-[4px] bg-accent px-[3px] font-medium" title={pt.user?.display_name || undefined}>{pt.text}</span>
                  : <Fragment key={i}>{pt.text}</Fragment>)}
              </p>
            )}

            {!editing && (
              <div className="mt-0.5 flex gap-3 text-xs font-semibold text-muted-foreground">
                {depth === 0 && canReply && <button type="button" className="-my-2 py-2 hover:text-foreground" onClick={() => setShowReply(!showReply)}>{t('board.reply.label')}</button>}
                {canEdit && (
                  <>
                    <button type="button" className="-my-2 py-2 hover:text-foreground" onClick={startEdit}>{t('common.edit')}</button>
                    <button type="button" className="-my-2 py-2 hover:text-danger" onClick={() => { void handleDelete() }}>{t('common.delete')}</button>
                  </>
                )}
              </div>
            )}

            {showReply && (
              <BoardCommentInput
                className="mt-2"
                postId={postId}
                parentId={comment.id}
                placeholder={t('board.reply.mentionPlaceholder', { name })}
                autofocus
                onDone={() => setShowReply(false)}
                onCancel={() => setShowReply(false)}
              />
            )}
          </>
        )}

        {/* 답글(1단) */}
        {(comment.replies || []).map(reply => (
          <BoardCommentItem key={reply.id} comment={reply} postId={postId} depth={depth + 1} canReply={canReply} />
        ))}
      </div>
    </div>
  )
}

export default BoardCommentItem
