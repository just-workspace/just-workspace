/**
 * 글쓰기·수정("전체 페이지 + 공용 편집기 툴바 + 첨부 끌어다 놓기").
 *  데스크톱: 커맨드 바(새 글 · 게시판 + 임시 저장됨 HH:MM | 취소 · 올리기) → 680 폭
 *    [카테고리 160×40][필독으로 표시][맨 위 고정] / 제목 52(20/700) / 편집기 카드(툴바 40 + 본문 260) / 첨부 드롭 영역 64.
 *  모바일: 56 헤더(✕ 닫기 — 임시 저장 · 새 글 · 게시판 · 올리기 36) / 카테고리·필독 52 / 제목 52 / 본문 / 키보드 위 툴바 48.
 * 임시 저장은 이 브라우저에만 보관한다(localStorage, 새 글일 때) — 서버 임시글 API 가 없다.
 * 경로 매개변수가 변경되면 화면을 재생성한다 — boardId 를 key 로 재마운트한다.
 */
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import type { Editor } from '@tiptap/react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute, routerApi, queryString } from '~/lib/router'
import { useSharedState } from '~/lib/state'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { useIsMobile } from '~/composables/useIsMobile'
import { useShareUpload } from '~/composables/useShareUpload'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useBoard, boardStore } from '~/composables/useBoard'
import { fileSize } from '~/utils/boardFormat'
import { BoardShell } from '~/components/board/BoardShell'
import { BoardCommandBar } from '~/components/board/BoardCommandBar'
import { RichEditor, type RichEditorHandle } from '~/components/editor/RichEditor'
import { textOfHtml } from '~/components/editor/safeHtml'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSelect } from '~/components/ui/Select'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEditorToolbar } from '~/components/ui/EditorToolbar'

type Attachment = { name: string; url: string; size?: number }

function WritePage({ boardId }: { boardId: string }) {
  const { t } = useI18n()
  const route = useRoute()
  // 마운트 시 1회 조회한다(동일 경로에서 ?edit 만 변경되면 재조회하지 않음) — 마운트 시점 값으로 고정
  const [editPostId] = useState(() => queryString(route.query.edit))
  const { appName } = useSiteConfig()
  const router = routerApi
  const isMobile = useIsMobile()
  const { upload } = useShareUpload()

  const { init, cleanup, boards, fetchPost, createPost, updatePost } = useBoard()
  const { user } = useAuth()

  const board = boards.find(b => b.id === boardId) ?? null
  const [isEditMode, setIsEditMode] = useState(!!editPostId)
  useHead({ title: `${isEditMode ? t('board.write.editTitle') : t('board.write.createTitle')} | ${appName}` })
  useBreadcrumb(board?.name ?? null)

  // 모바일: 작성 중 탭바 숨김(상세 화면 규칙)
  const [, setDetailOpen] = useSharedState<boolean>('mobile-detail-open', () => false)
  useEffect(() => { setDetailOpen(isMobile) }, [isMobile, setDetailOpen])
  useEffect(() => () => { setDetailOpen(false) }, [setDetailOpen])

  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [isPinned, setIsPinned] = useState(false)
  const [isMustRead, setIsMustRead] = useState(false)
  const [editorHtml, setEditorHtml] = useState<string | null>(null)
  const [editorText, setEditorText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [initialContent, setInitialContent] = useState('')
  const [ready, setReady] = useState(false)
  const richRef = useRef<RichEditorHandle | null>(null)
  const [richEditor, setRichEditor] = useState<Editor | null>(null)

  // ─── 임시 저장(새 글만) ───
  const DRAFT_KEY = `board-draft:${boardId}`
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftValues = useRef({ title, editorHtml, editorText, category, isPinned, isMustRead, attachments, ready, isEditMode })
  draftValues.current = { title, editorHtml, editorText, category, isPinned, isMustRead, attachments, ready, isEditMode }
  function saveDraft() {
    if (draftValues.current.isEditMode || !draftValues.current.ready) return
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      const v = draftValues.current
      const empty = !v.title.trim() && !v.editorText.trim() && !v.attachments.length
      try {
        if (empty) { localStorage.removeItem(DRAFT_KEY); setDraftSavedAt(null); return }
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          title: v.title, html: v.editorHtml, category: v.category,
          isPinned: v.isPinned, isMustRead: v.isMustRead, attachments: v.attachments, at: Date.now(),
        }))
        setDraftSavedAt(new Date())
      } catch { /* 저장소 접근 불가 — 임시 저장 없이 계속 */ }
    }, 800)
  }
  function dropDraft() {
    // 게시 직후 남아 있던 저장 예약이 방금 게시한 글을 임시글로 복원하지 않도록 함
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null }
    try { localStorage.removeItem(DRAFT_KEY) } catch { /* 무시 */ }
  }
  // watch([title, editorHtml, category, isPinned, isMustRead, attachments], saveDraft, { deep: true })
  const firstDraftWatch = useRef(true)
  useEffect(() => {
    if (firstDraftWatch.current) { firstDraftWatch.current = false; return }
    saveDraft()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, editorHtml, category, isPinned, isMustRead, attachments])
  const draftLabel = draftSavedAt ? `${String(draftSavedAt.getHours()).padStart(2, '0')}:${String(draftSavedAt.getMinutes()).padStart(2, '0')}` : ''

  useEffect(() => {
    ;(async () => {
      await init()
      if (editPostId) {
        await fetchPost(editPostId)
        const cur = boardStore.getState().currentPost
        if (cur) {
          setTitle(cur.title)
          setCategory(cur.category)
          setIsPinned(cur.is_pinned)
          setIsMustRead(cur.is_must_read)
          setInitialContent(cur.content)
          // 편집기는 "사용자가 수정한 내용"만 통지한다 — 본문을 수정하지 않고(제목·카테고리만 수정) 저장할 수 있도록 저장된 본문으로 채워 둔다
          setEditorHtml(cur.content)
          setEditorText(textOfHtml(cur.content))
          setAttachments((cur.attachments || []).map(a => ({ ...a })))   // 편집용 사본
        } else {
          setIsEditMode(false)
          draftValues.current.isEditMode = false
        }
      } else {
        try {
          const raw = localStorage.getItem(DRAFT_KEY)
          if (raw) {
            const d = JSON.parse(raw)
            setTitle(d.title ?? '')
            setCategory(d.category ?? null)
            setIsPinned(!!d.isPinned)
            setIsMustRead(!!d.isMustRead)
            setAttachments(Array.isArray(d.attachments) ? d.attachments : [])
            setInitialContent(d.html ?? '')
            setEditorHtml(d.html ?? null)
            // 텍스트도 함께 채운다 — 비워 두면 복원 직후 "내용 없음"으로 판정돼 올리기가 차단되고, 제목 없는 임시글은 빈 것으로 간주돼 삭제되는 문제가 있었다
            setEditorText(textOfHtml(d.html))
            setDraftSavedAt(d.at ? new Date(d.at) : null)
            addToast('info', t('board.write.draftRestored'))
          }
        } catch { /* 손상된 임시글은 무시 */ }
      }
      setReady(true)
      draftValues.current.ready = true
    })()
    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canSetNotice = !!user && (board?.notice_permission === 'all' || !!user.is_admin)
  const categoryOptions = [
    { value: '', label: t('board.write.noCategory') },
    ...(board?.categories ?? []).map(c => ({ value: c, label: t('board.write.categoryOption', { name: c }) })),
  ]

  // ─── 첨부(내 파일함 "게시판 첨부" + 공유 링크) ───
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)
  async function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      setUploading(u => [...u, file.name])
      try {
        const up = await upload(file, '게시판 첨부')
        setAttachments(a => [...a, { name: up.name, url: up.url, size: up.size }])
      } catch (e: any) {
        addToast('error', e?.data?.detail || t('board.write.fileUploadError'))
      } finally {
        setUploading(u => u.filter(n => n !== file.name))
      }
    }
  }
  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    if (input.files?.length) void addFiles(Array.from(input.files))
    input.value = ''
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
  }
  function removeAttachment(index: number) {
    setAttachments(a => a.filter((_, i) => i !== index))
  }

  // 편집기 툴바의 이미지·파일 버튼: 이미지는 본문에 삽입, 그 외는 첨부로 처리
  const imageInput = useRef<HTMLInputElement | null>(null)
  async function onImagePick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { void addFiles([file]); return }
    try {
      const up = await upload(file, '게시판 첨부')
      richRef.current?.insertImage(up.url, up.name)
    } catch (err: any) {
      addToast('error', err?.data?.detail || t('board.write.fileUploadError'))
    }
  }

  async function handleSubmit() {
    if (!title.trim()) { addToast('error', t('board.write.titleRequired')); return }
    const content = editorHtml || editorText
    if (!editorText.trim() && !/<img/i.test(content || '')) { addToast('error', t('board.write.contentRequired')); return }
    if (uploading.length) { addToast('info', t('board.write.stillUploading')); return }

    setSubmitting(true)
    const editing = isEditMode && !!editPostId
    const body = {
      title: title.trim(),
      content: content as string,
      category,
      // 고정·필독은 변경 권한이 있는 사용자만 전송한다(권한 없는 사용자가 전송하면 서버가 권한 오류로 처리한다)
      ...(canSetNotice ? { is_pinned: isPinned, is_must_read: isMustRead } : {}),
      // 수정 시에는 빈 목록을 그대로 전송해야 첨부가 삭제된다(null 은 새 글의 "첨부 없음")
      attachments: editing ? attachments : (attachments.length > 0 ? attachments : null),
    }
    try {
      if (isEditMode && editPostId) {
        await updatePost(editPostId, body)
        void router.push(`/board/${boardId}/${editPostId}`)
      } else {
        const result = await createPost(boardId, body)
        dropDraft()
        void router.push(`/board/${boardId}/${result.id}`)
      }
    } catch (e: any) {
      const detail = e?.data?.detail
      const msg = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: any) => d.msg).join(', ') : t('board.write.saveError')
      addToast('error', msg)
    } finally {
      setSubmitting(false)
    }
  }

  function cancel() {
    // 새 글은 임시 저장이 유지된다("닫기 — 임시 저장")
    if (window.history.length > 1) router.back()
    else void router.push(`/board/${boardId}`)
  }

  const heading = `${isEditMode ? t('board.write.editHeading') : t('board.write.newHeading')} · ${board?.name ?? t('board.title')}`
  const submitLabel = submitting ? t('common.saving') : isEditMode ? t('common.save') : t('board.write.publish')

  return (
    <BoardShell>
      {/* 모바일 헤더 */}
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-1 md:hidden">
        <UiIconButton label={isEditMode ? t('common.close') : t('board.write.closeWithDraft')} icon="close" size="lg" noTooltip className="text-foreground" onClick={cancel} />
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold text-foreground">{heading}</span>
        <button
          type="button"
          className="mr-1.5 inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          disabled={submitting}
          onClick={() => { void handleSubmit() }}
        >{submitLabel}</button>
      </header>

      {/* 데스크톱 커맨드 바 */}
      <BoardCommandBar
        actions={(
          <>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={cancel}
            >{t('common.cancel')}</button>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              disabled={submitting}
              onClick={() => { void handleSubmit() }}
            >{submitLabel}</button>
          </>
        )}
      >
        <b className="shrink-0 font-semibold text-foreground">{heading}</b>
        {draftLabel && !isEditMode && <span className="min-w-0 truncate text-muted-foreground" role="status">{t('board.write.draftSaved')} <span className="font-mono">{draftLabel}</span></span>}
      </BoardCommandBar>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:px-6 md:pb-10 md:pt-6">
        <div className="mx-auto flex w-full max-w-reading flex-1 flex-col md:flex-none md:gap-3.5">
          {/* 카테고리 · 필독 · 고정 */}
          {(board?.categories?.length || canSetNotice) ? (
            <div className="flex min-h-[52px] flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border px-4 py-2 text-sm md:min-h-0 md:border-0 md:p-0 md:text-[13px]">
              {board?.categories?.length ? (
                <UiSelect
                  modelValue={category ?? ''}
                  onUpdateModelValue={(v) => setCategory(v ? String(v) : null)}
                  options={categoryOptions}
                  placeholder={t('board.category.label')}
                  aria-label={t('board.category.label')}
                  className="w-40"
                />
              ) : null}
              {canSetNotice && (
                <>
                  <UiCheckbox modelValue={isMustRead} onUpdateModelValue={setIsMustRead} label={t('board.write.markMustRead')} />
                  <UiCheckbox modelValue={isPinned} onUpdateModelValue={setIsPinned} label={t('board.post.pin')} />
                </>
              )}
            </div>
          ) : null}

          {/* 제목 */}
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            type="text"
            autoComplete="off"
            aria-label={t('board.table.title')}
            placeholder={t('board.write.titlePlaceholder')}
            className="h-[52px] w-full shrink-0 border-b border-border bg-transparent px-4 text-[17px] font-semibold text-foreground outline-hidden placeholder:font-normal placeholder:text-muted-foreground md:rounded-[10px] md:border md:border-input md:bg-card md:px-3.5 md:text-xl md:font-bold md:focus:border-ring md:focus:ring-2 md:focus:ring-ring/30"
          />

          {/* 본문 */}
          {ready ? (
            <RichEditor
              ref={richRef}
              html={editorHtml}
              onUpdateHtml={setEditorHtml}
              text={editorText}
              onUpdateText={setEditorText}
              initialContent={initialContent}
              bare={isMobile}
              placeholder={t('board.write.contentPlaceholder')}
              className={isMobile ? 'flex-1' : ''}
              onImage={() => imageInput.current?.click()}
              onUpdateEditor={setRichEditor}
            />
          ) : (
            <UiSkeleton preset="text" rows={6} />
          )}

          {/* 첨부 */}
          <div
            className={cn('hidden h-16 items-center justify-center rounded-lg border border-dashed text-[13px] text-muted-foreground transition-colors md:flex', dragOver ? 'border-primary bg-primary/[0.06]' : 'border-border')}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {t('board.write.dropPrefix')}<button type="button" className="ml-1 font-semibold text-primary hover:underline" onClick={() => fileInput.current?.click()}>{t('board.write.attach')}</button>{t('board.write.dropSuffix')}
          </div>
          {(attachments.length > 0 || uploading.length > 0) && (
            <ul className="flex flex-col gap-1.5 px-4 py-2 md:p-0" aria-label={t('board.write.attachedFiles')}>
              {attachments.map((att, i) => (
                <li key={`${att.url}-${i}`} className="flex h-10 items-center gap-2 rounded-md border border-border bg-card pl-3 pr-1 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-foreground">{att.name}</span>
                  {att.size ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fileSize(att.size)}</span> : null}
                  <UiIconButton label={t('board.write.removeAttachment', { name: att.name })} icon="close" className="relative before:absolute before:-inset-1" onClick={() => removeAttachment(i)} />
                </li>
              ))}
              {uploading.map(n => (
                <li key={`up-${n}`} className="flex h-10 items-center gap-2 rounded-md border border-dashed border-border px-3 text-[13px] text-muted-foreground" role="status">
                  <span className="min-w-0 flex-1 truncate">{n}</span><span className="shrink-0 text-xs">{t('board.write.uploading')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 모바일 키보드 위 툴바(이미지·파일 버튼이 첨부도 처리한다) */}
      {isMobile && ready && (
        <UiEditorToolbar editor={richEditor} variant="mobile" tools={['block', '|', 'bold', 'italic', 'strike', '|', 'bullet', 'ordered', '|', 'link', 'quote', 'code', 'table', 'image']} onImage={() => imageInput.current?.click()} />
      )}

      <input ref={fileInput} type="file" multiple className="hidden" onChange={onPick} />
      <input ref={imageInput} type="file" className="hidden" onChange={(e) => { void onImagePick(e) }} />
    </BoardShell>
  )
}

export default function Page() {
  const route = useRoute()
  const boardId = route.params.boardId as string
  return <WritePage key={boardId} boardId={boardId} />
}
