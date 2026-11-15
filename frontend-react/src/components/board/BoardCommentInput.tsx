/**
 * 댓글 입력(시안 BD3 바닥 · BM2 하단 고정 바) — Vue 판 components/board/BoardCommentInput.vue 이식.
 * 테두리 input · rounded-xl(12) · min 44 · card 바탕, 자리표시 "댓글 달기 — @로 언급", 오른쪽 등록 32(primary, 비면 50%). Ctrl/⌘+Enter 로 등록.
 * @멘션 자동완성(06-3 결정 4 "멘션 칩은 채팅과 같은 규칙"): "@" 뒤 글자로 GET /api/board/mention-users 를 찾아
 * 채팅 컴포저와 같은 후보 목록(아바타 24 · 이름 · @아이디)을 입력 위에 띄운다. ↑↓ 고르기, Enter/Tab 넣기, Esc 닫기.
 * 넣으면 "@아이디 " — 서버가 저장할 때 해석해 멘션 알림을 보낸다(댓글 mentions[]).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { createComment, searchMentionUsers, type MentionUser } from '~/composables/useBoard'
import { mentionQueryAt } from '~/utils/boardFormat'
import { UiMentionList } from '~/components/ui/MentionList'

export interface BoardCommentInputProps {
  postId: string
  /** 답글이면 부모 댓글 id */
  parentId?: string | null
  placeholder?: string
  autofocus?: boolean
  className?: string
  /** 등록을 마쳤을 때 */
  onDone?: () => void
  /** 답글 취소 */
  onCancel?: () => void
}

/** 댓글·답글 입력 */
export function BoardCommentInput({ postId, parentId = null, placeholder, autofocus = false, className, onDone, onCancel }: BoardCommentInputProps) {
  const { t } = useI18n()

  const [content, setContentState] = useState('')
  const contentRef = useRef(content)
  const setContent = (v: string) => { contentRef.current = v; setContentState(v) }
  const [submitting, setSubmitting] = useState(false)
  const box = useRef<HTMLTextAreaElement | null>(null)

  function grow() {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }
  // watch(content, () => nextTick(grow)) — 첫 값은 건너뜀
  const firstGrow = useRef(true)
  useLayoutEffect(() => {
    if (firstGrow.current) { firstGrow.current = false; return }
    grow()
  }, [content])
  useEffect(() => { if (autofocus) box.current?.focus() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ─── @멘션 자동완성 ───
  const [mention, setMentionState] = useState<{ start: number; query: string } | null>(null)
  const mentionRef = useRef(mention)
  const setMention = (v: { start: number; query: string } | null) => { mentionRef.current = v; setMentionState(v) }
  const [candidates, setCandidates] = useState<MentionUser[]>([])
  const [active, setActive] = useState(0)
  const [listId] = useState(() => `board-mention-${Math.random().toString(36).slice(2, 8)}`)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  function checkMention() {
    const el = box.current
    if (!el) return
    const text = el.value
    const m = mentionQueryAt(text, el.selectionStart ?? text.length)
    setMention(m)
    if (!m) { setCandidates([]); return }
    if (timer.current) clearTimeout(timer.current)
    const my = ++seq.current
    timer.current = setTimeout(async () => {
      try {
        const list = await searchMentionUsers(m.query)
        if (my !== seq.current || !mentionRef.current) return
        setCandidates(list.filter(u => u.id !== authStore.getState().user?.id))
        setActive(0)
      } catch {
        if (my === seq.current) setCandidates([])
      }
    }, 150)
  }
  function closeMention() {
    setMention(null)
    setCandidates([])
    seq.current++
  }
  const open = !!mention && candidates.length > 0

  function pick(u: MentionUser) {
    const m = mentionRef.current
    const el = box.current
    if (!m || !el) return
    const cur = contentRef.current
    const caret = el.selectionStart ?? cur.length
    const insert = `@${u.username} `
    setContent(cur.slice(0, m.start) + insert + cur.slice(caret))
    closeMention()
    requestAnimationFrame(() => {
      const pos = m.start + insert.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  function onKeydown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 한글 조합 중의 Enter·Tab 은 글자 확정이다 — 여기서 후보를 넣으면 확정 글자가 뒤에 한 번 더 붙는다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % candidates.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + candidates.length) % candidates.length); return }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') { e.preventDefault(); pick(candidates[active]); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMention(); return }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); return }
    if (e.key === 'Escape' && parentId) onCancel?.()
  }

  async function submit() {
    const text = contentRef.current
    if (!text.trim() || submitting) return
    setSubmitting(true)
    try {
      await createComment(postId, text.trim(), parentId)
      setContent('')
      closeMention()
      onDone?.()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t(parentId ? 'board.reply.createError' : 'board.comment.createError'))
    } finally {
      setSubmitting(false)
    }
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <div className={cn('relative flex min-h-11 items-end gap-2 rounded-xl border border-input bg-card py-1.5 pl-3 pr-1.5 transition-[box-shadow,border-color] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30', className)}>
      {/* 멘션 후보(채팅 컴포저와 같은 목록) */}
      {open && (
        <UiMentionList
          id={listId}
          ariaLabel={t('board.comment.mentionList')}
          options={candidates.map(u => ({ id: String(u.id), label: u.display_name || u.username, secondary: `@${u.username}`, avatarUrl: u.avatar_url }))}
          activeIndex={active}
          onActiveChange={setActive}
          onPick={i => pick(candidates[i])}
        />
      )}

      <textarea
        ref={box}
        value={content}
        onChange={(e) => { setContent(e.target.value); checkMention() }}
        rows={1}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={parentId ? t('board.reply.label') : t('board.table.comments')}
        placeholder={placeholder || t('board.comment.mentionPlaceholder')}
        className="max-h-40 min-h-8 flex-1 resize-none bg-transparent py-1 text-[15px] leading-6 text-foreground outline-hidden placeholder:text-muted-foreground md:text-sm"
        onKeyDown={onKeydown}
        onClick={checkMention}
        onBlur={closeMention}
      />
      {parentId && (
        <button
          type="button"
          className="inline-flex h-8 shrink-0 items-center rounded-sm px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onCancel?.()}
        >{t('common.cancel')}</button>
      )}
      <button
        type="button"
        disabled={submitting || !content.trim()}
        className="inline-flex h-8 shrink-0 items-center rounded-sm bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => { void submit() }}
      >{submitting ? t('board.comment.posting') : t('board.comment.post')}</button>
    </div>
  )
}

export default BoardCommentInput
