/**
 * 게시글 행(시안 BD2 데스크톱 56 · BM1 모바일, 결정 1 "2줄 56 + 아바타 28 통일") — Vue 판 components/board/BoardPostRow.vue 이식.
 *  아바타 28(모바일 32) · [필독 솔리드 warning 알약][고정 중립 틴트] 제목(안 읽음 700 / 읽음 foreground·80) [댓글 수 mono primary]
 *  · 둘째 줄 "작성자 · 조회 N"(모바일 "작성자 · 날짜 · 댓글 N") · 오른쪽 날짜 mono 11(데스크톱).
 */
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import type { PostSummary } from '~/composables/useBoard'
import { authorName, boardDay, initialOf } from '~/utils/boardFormat'
import { NuxtLink } from '~/components/NuxtLink'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'

export interface BoardPostRowProps {
  post: PostSummary
  unread: boolean
  /** 고정 글 묶음에서 왔는지(목록 응답의 pinned) */
  pinned?: boolean
  /** 검색·북마크처럼 여러 게시판이 섞일 때 게시판 이름 표시 */
  showBoard?: boolean
}

/** 게시글 목록 한 행(글로 가는 링크) */
export function BoardPostRow({ post, unread, pinned, showBoard }: BoardPostRowProps) {
  const { t } = useI18n()
  const name = authorName(post.author) || t('common.unknownUser')
  const isPinned = pinned || post.is_pinned

  return (
    <NuxtLink
      to={`/board/${post.board_id}/${post.id}`}
      className="flex items-center gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:h-14 md:py-0"
    >
      <UiAvatar
        src={post.author?.avatar_url}
        alt={name}
        fallback={initialOf(name)}
        className="h-8 w-8 shrink-0 md:h-7 md:w-7"
        textSize="text-xs md:text-[11px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[15px] md:text-sm">
          {post.is_must_read && <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-warning px-[7px] text-[11px] font-bold text-background">{t('common.mustRead')}</span>}
          {isPinned && <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-semibold text-foreground">{t('board.post.pinnedBadge')}</span>}
          {showBoard && post.board_name && <span className="shrink-0 text-xs text-muted-foreground">{post.board_name} ·</span>}
          <span className={cn('min-w-0 truncate', unread ? 'font-bold text-foreground' : 'text-foreground/80')}>{post.title}</span>
          {post.comment_count > 0 && <span className="hidden shrink-0 font-mono text-xs font-semibold text-primary md:inline">[{post.comment_count}]</span>}
          {post.has_attachments && <span role="img" aria-label={t('board.post.hasAttachmentsLabel')} className="hidden shrink-0 text-muted-foreground md:inline-flex"><UiIcon name="paperclip" className="h-3.5 w-3.5" /></span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          <span>{name}</span>
          <span className="md:hidden"> · <span className="font-mono">{boardDay(post.created_at)}</span>{post.comment_count ? <>{' · ' + t('board.table.comments') + ' '}<span className="font-mono">{post.comment_count}</span></> : null}</span>
          {post.view_count !== undefined && <span className="hidden md:inline">{' · ' + t('board.table.views') + ' '}<span className="font-mono">{post.view_count}</span></span>}
        </div>
      </div>
      <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground md:inline">{boardDay(post.created_at)}</span>
    </NuxtLink>
  )
}

export default BoardPostRow
