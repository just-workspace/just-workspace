/**
 * 게시글 보기.
 *  폭 680 하나 — 배지(필독 솔리드 warning 22) · 제목 26/700 · 메타(아바타 24 · 작성자 · 시각 mono · 조회 N · 오른쪽 북마크)
 *  · 본문 15/1.75 · 첨부 카드 · 리액션 · 댓글 N(1단 답글, @언급 칩) · 댓글 입력.
 *  커맨드 바: 경로(게시판 › 제목) · 편집 · ⋯(삭제·고정·링크 복사). 모바일: 상단 바(북마크 44 · ⋯ 44) + 하단 고정 댓글 바.
 * 경로 매개변수가 변경되면 화면을 재생성한다 — boardId·postId 를 key 로 재마운트한다.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute, routerApi } from '~/lib/router'
import { useSharedState, setSharedState, getSharedState } from '~/lib/state'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useBoard, boardStore } from '~/composables/useBoard'
import { authorName, boardStamp, initialOf } from '~/utils/boardFormat'
import { NuxtLink } from '~/components/NuxtLink'
import { BoardShell } from '~/components/board/BoardShell'
import { BoardCommandBar } from '~/components/board/BoardCommandBar'
import { BoardAttachments } from '~/components/board/BoardAttachments'
import { BoardReactions } from '~/components/board/BoardReactions'
import { BoardCommentList } from '~/components/board/BoardCommentList'
import { BoardCommentInput } from '~/components/board/BoardCommentInput'
import { stripLayoutStylesIn } from '~/components/editor/safeHtml'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { writeClipboard } from '~/lib/clipboard'

function PostPage({ boardId, postId }: { boardId: string; postId: string }) {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const router = routerApi

  const {
    init, cleanup, boards, currentPost, comments, loadingPost, loadingComments,
    fetchPost, fetchComments, deletePost, toggleBookmark, updatePost, fetchMustRead,
  } = useBoard()
  const { user } = useAuth()

  const board = boards.find(b => b.id === boardId) ?? null
  useHead({ title: `${currentPost?.title ?? t('board.title')} | ${appName}` })
  useBreadcrumb(board?.name ?? null)

  useEffect(() => {
    // 스토어는 화면 간에 공유된다 — 직전에 표시한 다른 글의 본문·댓글이 새 주소에서 잠시 노출되지 않도록 먼저 초기화한다
    if (boardStore.getState().currentPost?.id !== postId) boardStore.setState({ currentPost: null, comments: [], loadingPost: true })
    ;(async () => {
      await init()
      await Promise.all([fetchPost(postId), fetchComments(postId)])
      // 필독 글을 열면 서버가 읽음으로 기록한다 — 사이드바 필독 목록을 재조회한다
      if (boardStore.getState().currentPost?.is_must_read) void fetchMustRead()
    })()
    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 알림 링크(#comment-<id>)로 진입한 경우 댓글 렌더링 후 해당 댓글로 스크롤한다(1회만)
  const hashDone = useRef(false)
  useEffect(() => {
    if (hashDone.current || loadingComments || !comments.length) return
    const m = /^#(comment-[\w-]+)$/.exec(window.location.hash)
    if (!m) return
    hashDone.current = true
    document.getElementById(m[1])?.scrollIntoView({ block: 'center' })
  }, [loadingComments, comments.length])

  /** 본문 정화. 인라인 style 은 정렬 등은 유지하되 글자색·배경색, 위치·겹침(position 등)은 제거한다(다크 테마에서 보이지 않는 글 · 화면 덮기 방지). */
  const sanitizedContent = useMemo(() => {
    const raw = currentPost?.content
    if (!raw) return ''
    // 기존 설정(ALLOW_TAGS/ALLOW_ATTR)은 DOMPurify 가 인식하지 않는 옵션이어서 실제로는 기본 허용 목록이 적용됐다 — 해당 동작을 그대로 유지한다.
    const clean = DOMPurify.sanitize(raw, {
      FORBID_TAGS: ['script', 'style', 'meta', 'head', 'link', 'object', 'embed', 'form', 'input'],
    })
    const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html')
    doc.body.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
      for (const p of ['color', 'background', 'background-color']) el.style.removeProperty(p)
    })
    stripLayoutStylesIn(doc.body)
    doc.body.querySelectorAll('a[href]').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener') })
    return doc.body.innerHTML
  }, [currentPost?.content])

  const authorLabel = authorName(currentPost?.author) || t('common.unknownUser')
  const canEdit = !currentPost || !user ? false : (currentPost.author?.id === user.id || !!user.is_admin)
  const canPin = !!user && (board?.notice_permission === 'all' || !!user.is_admin)
  // 게시판 설정을 아직 알 수 없으면(목록 로딩 전) 표시하고, 비활성화된 게시판에서는 눌러도 실패할 버튼·입력을 렌더링하지 않는다
  const canReact = board ? board.allow_reactions !== false : true
  const canComment = board ? board.allow_comments !== false && (board.comment_permission !== 'admin' || !!user?.is_admin) : true

  useSharedState<number | null>('board-bookmark-count', () => null)
  async function onBookmark() {
    const r = await toggleBookmark(postId)
    const cnt = getSharedState<number | null>('board-bookmark-count')
    if (r && cnt !== null) setSharedState<number | null>('board-bookmark-count', cnt + (r.is_bookmarked ? 1 : -1))
    if (r) addToast('success', r.is_bookmarked ? t('board.post.bookmarkAdded') : t('board.post.bookmarkRemoved'))
  }

  async function handleDelete() {
    if (!await confirmBox(t('board.post.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) return
    try {
      await deletePost(postId)
      void router.push(`/board/${boardId}`)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.comment.deleteError'))
    }
  }

  async function copyLink() {
    try {
      await writeClipboard(`${window.location.origin}/board/${boardId}/${postId}`)
      addToast('success', t('board.post.linkCopied'))
    } catch {
      addToast('error', t('board.post.linkCopyError'))
    }
  }

  async function togglePin() {
    const p = boardStore.getState().currentPost
    if (!p) return
    try {
      await updatePost(postId, { is_pinned: !p.is_pinned })
      await fetchPost(postId)   // 리액션의 "내가 누름" 표시를 재계산
      addToast('success', p.is_pinned ? t('board.post.unpinned') : t('board.post.pinned'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.post.pinError'))
    }
  }

  const [menu, setMenu] = useState<{ anchor: DOMRect | null } | null>(null)
  const menuItems: UiMenuItem[] = (() => {
    const items: UiMenuItem[] = [{ key: 'link', label: t('board.post.copyLink'), icon: 'link' }]
    if (canPin) items.push({ key: 'pin', label: currentPost?.is_pinned ? t('board.post.unpin') : t('board.post.pin'), icon: 'star' })
    if (canEdit) {
      items.unshift({ key: 'edit', label: t('common.edit'), icon: 'edit' })
      items.push({ key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true })
    }
    return items
  })()
  function onMenu(key: string) {
    if (key === 'link') void copyLink()
    else if (key === 'pin') void togglePin()
    else if (key === 'edit') void router.push(`/board/${boardId}/write?edit=${postId}`)
    else if (key === 'delete') void handleDelete()
  }
  function openMenu(e: MouseEvent<HTMLElement>) {
    setMenu({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })
  }

  return (
    <BoardShell>
      {/* 모바일 상단 바 */}
      <LayoutMobileDetailBar
        title={board?.name ?? t('board.title')}
        backLabel={t('board.post.backToBoard', { name: board?.name ?? t('board.title') })}
        backTo={`/board/${boardId}`}
        actions={currentPost ? (
          <>
            <UiIconButton
              label={currentPost.is_bookmarked ? t('board.post.removeBookmark') : t('board.post.bookmarkAction')}
              size="lg"
              noTooltip
              pressed={currentPost.is_bookmarked}
              className={currentPost.is_bookmarked ? 'text-primary' : ''}
              onClick={() => { void onBookmark() }}
            >
              <UiIcon name="bookmark" filled={currentPost.is_bookmarked} className="h-5 w-5" />
            </UiIconButton>
            <UiIconButton label={t('common.more')} icon="more-horizontal" size="lg" noTooltip onClick={openMenu} />
          </>
        ) : null}
      />

      {/* 데스크톱 커맨드 바 */}
      <BoardCommandBar
        actions={currentPost ? (
          <>
            {canEdit && (
              <NuxtLink
                to={`/board/${boardId}/write?edit=${postId}`}
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >{t('common.edit')}</NuxtLink>
            )}
            <UiIconButton label={t('board.post.moreLabel')} icon="more-horizontal" aria-haspopup="menu" onClick={openMenu} />
          </>
        ) : null}
      >
        <nav aria-label={t('board.post.breadcrumb')} className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <NuxtLink to={`/board/${boardId}`} className="shrink-0 hover:text-foreground">{board?.name ?? t('board.title')}</NuxtLink>
          <UiIcon name="chevron-right" className="h-3.5 w-3.5 shrink-0" />
          <b className="min-w-0 truncate font-semibold text-foreground" aria-current="page">{currentPost?.title ?? ''}</b>
        </nav>
      </BoardCommandBar>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-[18px] md:px-6 md:pt-7">
        <div className="mx-auto flex max-w-reading flex-col gap-3.5">
          {loadingPost ? (
            <UiSkeleton preset="text" rows={8} />
          ) : !currentPost ? (
            <UiEmptyState
              variant="panel"
              icon="clipboard-list"
              title={t('board.post.notFound')}
              actionLabel={t('board.post.backToList')}
              actionTo={`/board/${boardId}`}
            />
          ) : (
            <>
              {/* 머리 */}
              <div>
                {(currentPost.is_must_read || currentPost.is_pinned || currentPost.category) && (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5 md:mb-2.5">
                    {currentPost.is_must_read && <span className="inline-flex h-5 items-center rounded-full bg-warning px-[7px] text-[11px] font-bold text-background md:h-[22px] md:px-2 md:text-xs">{t('common.mustRead')}</span>}
                    {currentPost.is_pinned && <span className="inline-flex h-5 items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-semibold text-foreground md:h-[22px] md:text-xs">{t('board.post.pinnedBadge')}</span>}
                    {currentPost.category && <span className="text-xs text-muted-foreground">{currentPost.category}</span>}
                  </div>
                )}
                <h1 className="break-words text-[22px] font-bold leading-[1.35] tracking-[-0.02em] text-foreground md:text-[26px]">{currentPost.title}</h1>
                <div className="mt-2.5 flex items-center gap-2 text-[13px] text-muted-foreground">
                  <UiAvatar src={currentPost.author?.avatar_url} alt={authorLabel} fallback={initialOf(authorLabel)} className="h-6 w-6 shrink-0" textSize={10} />
                  <span className="min-w-0 truncate">{authorLabel} · <span className="font-mono">{boardStamp(currentPost.created_at)}</span>{' · ' + t('board.table.views') + ' '}<span className="font-mono">{currentPost.view_count}</span>{currentPost.is_edited && <> · {t('board.post.edited')}</>}</span>
                  <button
                    type="button"
                    className="ml-auto hidden shrink-0 font-semibold text-primary hover:underline md:inline"
                    aria-pressed={currentPost.is_bookmarked}
                    onClick={() => { void onBookmark() }}
                  >{currentPost.is_bookmarked ? t('board.post.bookmarkedState') : t('board.post.bookmarkAction')}</button>
                </div>
              </div>

              {/* 본문 */}
              <div
                className="prose min-h-[60px] max-w-none break-words text-base leading-[1.75] dark:prose-invert md:text-[15px] prose-img:h-auto prose-img:max-w-full prose-pre:overflow-x-auto"
                dangerouslySetInnerHTML={{ __html: sanitizedContent }}
              />

              {currentPost.attachments?.length ? <BoardAttachments attachments={currentPost.attachments} /> : null}
              {currentPost.reactions && canReact && <BoardReactions reactions={currentPost.reactions} postId={postId} />}

              {/* 댓글 */}
              <div className="border-t border-border pt-3 text-sm font-semibold text-foreground md:pt-3.5">{t('board.table.comments')} <span className="font-mono">{currentPost.comment_count}</span></div>
              <BoardCommentList comments={comments} postId={postId} loading={loadingComments} canReply={canComment} />
              {canComment && <BoardCommentInput className="hidden md:flex" postId={postId} />}
            </>
          )}
        </div>
      </div>

      {/* 모바일 하단 고정 댓글 바 */}
      {currentPost && canComment && (
        <div className={cn('shrink-0 border-t border-border bg-background px-3 pb-[calc(8px+env(safe-area-inset-bottom))] pt-2 md:hidden')}>
          <BoardCommentInput postId={postId} />
        </div>
      )}

      {menu && (
        <UiMenu
          items={menuItems}
          anchor={menu.anchor}
          title={currentPost?.title}
          width={220}
          dense
          onSelect={onMenu}
          onClose={() => setMenu(null)}
        />
      )}
    </BoardShell>
  )
}

export default function Page() {
  const route = useRoute()
  const boardId = route.params.boardId as string
  const postId = route.params.postId as string
  return <PostPage key={`${boardId}/${postId}`} boardId={boardId} postId={postId} />
}
