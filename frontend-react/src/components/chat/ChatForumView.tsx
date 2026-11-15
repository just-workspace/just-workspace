/**
 * 포럼 채널 보기(handover-22 §5.1 b — 게시판 데이터의 채팅 쪽 보기). Channel.forum_board_id 가 있는 채널을 열면 대화 대신 이것.
 * 채널 탭(메시지·파일·회의·작업)은 없다 — 헤더에는 글 목록/갤러리 전환만(ForumViewToggle — SHELL 이 헤더 자리에 놓는다).
 * 시안에 포럼 그림이 없어 디스코드 포럼 구조를 따랐다(참고):
 *   위 줄 48: "새 글"(게시판 글쓰기 화면으로) · 태그 칩(게시판 분류, 전체 + 분류들) · 정렬(최신 글 · 댓글 많은 순 · 조회 많은 순).
 *   글 목록: 카드(rounded-lg 1px bg-card p-3, 호버 bg-overlay-hover) — 고정 pin · 태그 11 · 제목 16/600(안 읽음) · 작성자 아바타 20 + 이름
 *     · message-circle 댓글 수 · "최근 활동 10분 전".
 *   갤러리: 200 이상 칸 격자 · 첫 이미지 썸네일 16:9(없으면 글자 타일) · 제목 14/600 두 줄 · 댓글 수.
 *   글 열기: 오른쪽에 글 + 댓글(스레드처럼, 400 — 좁은 화면·모바일은 전체 화면). "게시판에서 열기"로 게시판 글 화면.
 * 같은 글이 게시판에서도 보인다(데이터 = 게시판). 글·댓글은 useBoard(fetchPost·fetchComments)와 게시판 댓글 부품을 그대로 쓴다.
 */
import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import DOMPurify from 'dompurify'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { authStore } from '~/composables/useAuth'
import type { Channel } from '~/composables/useChat'
import { boardStore, fetchBoards, fetchComments, fetchPost, type BoardSort } from '~/composables/useBoard'
import {
  forumStore, loadForum, postActivity, postThumb, setForumOpenPost, setForumView, useForum, useForumView, type ForumPost, type ForumView,
} from '~/composables/useChatForum'
import { threadAgo } from '~/composables/useChatThreadList'
import { authorName, initialOf } from '~/utils/boardFormat'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { UiSelect } from '~/components/ui/Select'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { BoardAttachments } from '~/components/board/BoardAttachments'
import { BoardCommentList } from '~/components/board/BoardCommentList'
import { BoardCommentInput } from '~/components/board/BoardCommentInput'

/** 헤더 자리 보기 전환(글 목록 / 갤러리) — SHELL 이 포럼 채널 헤더의 채널 탭 자리에 놓는다 */
export function ForumViewToggle({ className }: { className?: string }) {
  const { t } = useI18n()
  const view = useForumView()
  return (
    <UiSegment
      ariaLabel={t('chat.right.forum.viewLabel')}
      size="sm"
      className={className}
      items={[
        { value: 'list', icon: 'list', label: t('chat.right.forum.list') },
        { value: 'gallery', icon: 'layout-grid', label: t('chat.right.forum.gallery') },
      ]}
      modelValue={view}
      onUpdateModelValue={(v) => setForumView(v as ForumView)}
    />
  )
}

function sanitize(raw: string | null | undefined): string {
  if (!raw) return ''
  const clean = DOMPurify.sanitize(raw, { FORBID_TAGS: ['script', 'style', 'meta', 'head', 'link', 'object', 'embed', 'form', 'input'] })
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html')
  doc.body.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    for (const p of ['color', 'background', 'background-color']) el.style.removeProperty(p)
  })
  doc.body.querySelectorAll('a[href]').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener') })
  return doc.body.innerHTML
}

function PostMeta({ p }: { p: ForumPost }) {
  const { t } = useI18n()
  const name = authorName(p.author) || t('common.unknownUser')
  return (
    <span className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
      <UiAvatar src={p.author?.avatar_url} fallback={initialOf(name)} textSize={9} className="h-5 w-5" />
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
      <span className="flex shrink-0 items-center gap-1" aria-label={t('chat.right.forum.comments', { n: p.comment_count })}>
        <UiIcon name="message-circle" className="h-3.5 w-3.5" /><span className="font-mono">{p.comment_count}</span>
      </span>
      <span className="shrink-0">{t('chat.right.forum.activity', { time: threadAgo(postActivity(p)) })}</span>
    </span>
  )
}

function PostRow({ p, active, onOpen }: { p: ForumPost; active: boolean; onOpen: (p: ForumPost) => void }) {
  const { t } = useI18n()
  const unread = p.is_read === false
  return (
    <li>
      <button
        type="button"
        aria-current={active || undefined}
        className={cn('flex w-full flex-col gap-1.5 rounded-lg border border-border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', active ? 'bg-overlay-selected' : 'bg-card hover:bg-overlay-hover')}
        onClick={() => onOpen(p)}
      >
        {(p.is_pinned || p.is_must_read || p.category) && (
          <span className="flex flex-wrap items-center gap-1.5">
            {p.is_pinned && <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground"><UiIcon name="pin" className="h-3 w-3" />{t('chat.right.forum.pinned')}</span>}
            {p.is_must_read && <span className="rounded-full bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">{t('chat.right.forum.mustRead')}</span>}
            {p.category && <span className="rounded-sm bg-primary/15 px-1.5 text-[11px] font-medium text-primary">{p.category}</span>}
          </span>
        )}
        <span className={cn('line-clamp-2 text-[16px] leading-snug', unread ? 'font-semibold text-foreground' : 'font-medium')}>{p.title}</span>
        <PostMeta p={p} />
      </button>
    </li>
  )
}

function PostTile({ p, active, onOpen }: { p: ForumPost; active: boolean; onOpen: (p: ForumPost) => void }) {
  const thumb = postThumb(p)
  return (
    <li>
      <button
        type="button"
        aria-current={active || undefined}
        className={cn('flex h-full w-full flex-col overflow-hidden rounded-lg border border-border text-left outline-none focus-visible:ring-2 focus-visible:ring-ring', active ? 'bg-overlay-selected' : 'bg-card hover:bg-overlay-hover')}
        onClick={() => onOpen(p)}
      >
        <span className="relative block aspect-video w-full bg-muted">
          {thumb
            ? <img src={thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
            : <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-[28px] font-semibold text-muted-foreground">{initialOf(p.title)}</span>}
          {p.category && <span className="absolute left-2 top-2 rounded-sm bg-background/80 px-1.5 text-[11px] font-medium text-primary">{p.category}</span>}
        </span>
        <span className="flex flex-1 flex-col gap-1.5 p-3">
          <span className={cn('line-clamp-2 text-[14px] leading-snug', p.is_read === false ? 'font-semibold' : 'font-medium')}>{p.title}</span>
          <PostMeta p={p} />
        </span>
      </button>
    </li>
  )
}

/** 연 글 + 댓글(오른쪽 400 / 모바일 전체 화면) */
function ForumPostPane({ boardId, postId, onClose }: { boardId: string; postId: string; onClose: () => void }) {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const post = useStore(boardStore, s => (s.currentPost?.id === postId ? s.currentPost : null))
  const loadingPost = useStore(boardStore, s => s.loadingPost)
  const comments = useStore(boardStore, s => s.comments)
  const loadingComments = useStore(boardStore, s => s.loadingComments)
  useEffect(() => {
    void fetchPost(postId)
    void fetchComments(postId)
  }, [postId])
  const html = useMemo(() => sanitize(post?.content), [post?.content])
  const name = authorName(post?.author) || t('common.unknownUser')
  return (
    <aside aria-label={post?.title || t('chat.right.forum.postLabel')} className="flex h-full w-full shrink-0 flex-col border-border bg-background md:w-[400px] md:border-l">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 max-md:h-14 max-md:px-1">
        {mobile && <UiIconButton label={t('chat.right.back')} icon="chevron-left" size="lg" noTooltip onClick={onClose} />}
        <UiIcon name="messages-square" className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{post?.title || ''}</h2>
        <NuxtLink to={`/board/${boardId}/${postId}`} aria-label={t('chat.right.forum.openInBoard')} title={t('chat.right.forum.openInBoard')} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-overlay-hover hover:text-foreground max-md:h-11 max-md:w-11">
          <UiIcon name="external-link" className="h-4 w-4" />
        </NuxtLink>
        {!mobile && <UiIconButton label={t('chat.right.forum.closePost')} icon="close" keys={['Esc']} onClick={onClose} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!post && loadingPost
          ? <UiSkeleton preset="text" rows={4} />
          : !post
            ? <p className="py-6 text-center text-[13px] text-muted-foreground">{t('chat.right.forum.postMissing')}</p>
            : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <UiAvatar src={post.author?.avatar_url} fallback={initialOf(name)} textSize={10} className="h-6 w-6" />
                  <span className="min-w-0 truncate"><b className="font-medium text-foreground">{name}</b> · {threadAgo(post.created_at)}</span>
                </div>
                <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-img:h-auto prose-img:max-w-full prose-pre:overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
                {post.attachments?.length ? <BoardAttachments attachments={post.attachments} /> : null}
                <p className="border-t border-border pt-3 text-[12px] font-semibold text-muted-foreground">{t('chat.right.forum.comments', { n: post.comment_count })}</p>
                <BoardCommentList comments={comments} postId={postId} loading={loadingComments} />
              </div>
            )}
      </div>
      {post && <div className="shrink-0 border-t border-border px-3 py-2"><BoardCommentInput postId={postId} /></div>}
    </aside>
  )
}

export interface ChatForumViewProps {
  channel: Pick<Channel, 'id' | 'name' | 'forum_board_id'>
  /** 보기(헤더가 따로 들고 있으면 넘긴다). 없으면 ForumViewToggle 과 같이 쓰는 기억값(사람마다) */
  view?: ForumView
}

/** 포럼 채널 본문(헤더 아래 전부) */
export function ChatForumView({ channel, view: viewProp }: ChatForumViewProps) {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const boardId = channel.forum_board_id || null
  const storedView = useForumView()
  const view = viewProp ?? storedView
  const { pinned, posts, total, page, pageSize, sort, category, loading, error, openPostId, boardId: loadedBoard } = useForum()
  const board = useStore(boardStore, s => s.boards.find(b => b.id === boardId) || null)
  const user = useStore(authStore, s => s.user)

  useEffect(() => {
    if (!boardId) return
    void loadForum(boardId)
    if (!boardStore.getState().boards.some(b => b.id === boardId)) void fetchBoards()
  }, [boardId])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented && forumStore.getState().openPostId && !document.querySelector('[role="dialog"]')) setForumOpenPost(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!boardId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><UiIcon name="messages-square" className="h-6 w-6 text-muted-foreground" /></span>
        <p className="text-[15px] font-semibold">{t('chat.right.forum.noBoard')}</p>
      </div>
    )
  }

  const shownPinned = loadedBoard === boardId ? pinned : []
  const shownPosts = loadedBoard === boardId ? posts : []
  const all = [...shownPinned, ...shownPosts.filter(p => !shownPinned.some(x => x.id === p.id))]
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const canWrite = !board || board.write_permission === 'all' || !!user?.is_admin
  const sorts = [
    { value: 'latest', label: t('chat.right.forum.sortLatest') },
    { value: 'comments', label: t('chat.right.forum.sortComments') },
    { value: 'views', label: t('chat.right.forum.sortViews') },
  ]
  const tags = board?.categories || []
  const open = (p: ForumPost) => setForumOpenPost(p.id)
  const openMobile = mobile && !!openPostId

  return (
    <div className="relative flex min-h-0 flex-1">
      <section aria-label={t('chat.right.forum.listLabel', { name: channel.name })} className={cn('flex min-w-0 flex-1 flex-col', openMobile && 'hidden')}>
        {/* 위 줄 — 새 글 · 태그 · 정렬 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 max-md:px-3">
          {canWrite && (
            <NuxtLink to={`/board/${boardId}/write`} className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 max-md:h-11">
              <UiIcon name="plus" className="h-4 w-4" />{t('chat.right.forum.newPost')}
            </NuxtLink>
          )}
          {mobile && !viewProp && <ForumViewToggle className="shrink-0" />}
          <div role="group" aria-label={t('chat.right.forum.tagsLabel')} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
            {tags.length > 0 && [null, ...tags].map(tag => (
              <button
                key={tag ?? '__all'}
                type="button"
                aria-pressed={category === tag}
                className={cn('flex h-7 shrink-0 items-center rounded-full border px-2.5 text-[12px] font-medium max-md:h-9', category === tag ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-overlay-hover')}
                onClick={() => { void loadForum(boardId, { category: tag, page: 1 }) }}
              >
                {tag ?? t('chat.right.forum.allTags')}
              </button>
            ))}
          </div>
          <UiSelect
            aria-label={t('chat.right.forum.sortLabel')}
            size="sm"
            options={sorts}
            modelValue={sort}
            onUpdateModelValue={(v) => { void loadForum(boardId, { sort: v as BoardSort, page: 1 }) }}
            className="w-36 shrink-0 max-md:w-32"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 max-md:px-3">
          {loading && all.length === 0
            ? <UiSkeleton preset={view === 'gallery' ? 'grid' : 'list'} rows={4} />
            : error && all.length === 0
              ? (
                <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center">
                  <p className="text-[15px] font-semibold">{t('chat.right.forum.loadError')}</p>
                  <p className="text-[13px] text-muted-foreground">{error}</p>
                  <button type="button" className="h-8 rounded-md px-3 text-[13px] font-semibold text-primary hover:bg-overlay-hover max-md:h-11" onClick={() => { void loadForum(boardId) }}>{t('chat.right.retry')}</button>
                </div>
              )
              : all.length === 0
                ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><UiIcon name="messages-square" className="h-6 w-6 text-muted-foreground" /></span>
                    <p className="text-[15px] font-semibold">{t('chat.right.forum.emptyTitle')}</p>
                    <p className="text-[13px] leading-relaxed text-muted-foreground">{t('chat.right.forum.emptyDesc')}</p>
                  </div>
                )
                : view === 'gallery'
                  ? (
                    <ul className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                      {all.map(p => <PostTile key={p.id} p={p} active={p.id === openPostId} onOpen={open} />)}
                    </ul>
                  )
                  : (
                    <ul className="flex flex-col gap-1">
                      {all.map(p => <PostRow key={p.id} p={p} active={p.id === openPostId} onOpen={open} />)}
                    </ul>
                  )}
          {pages > 1 && (
            <nav aria-label={t('chat.right.forum.pagerLabel')} className="mt-3 flex items-center justify-center gap-1 text-[13px]">
              <UiIconButton label={t('chat.right.search.prev')} icon="chevron-left" size={mobile ? 'lg' : 'sm'} disabled={page <= 1} onClick={() => { void loadForum(boardId, { page: page - 1 }) }} />
              <span className="px-2 font-mono">{page} / {pages}</span>
              <UiIconButton label={t('chat.right.search.next')} icon="chevron-right" size={mobile ? 'lg' : 'sm'} disabled={page >= pages} onClick={() => { void loadForum(boardId, { page: page + 1 }) }} />
            </nav>
          )}
        </div>
      </section>

      {openPostId && <ForumPostPane boardId={boardId} postId={openPostId} onClose={() => setForumOpenPost(null)} />}
    </div>
  )
}

export default ChatForumView
