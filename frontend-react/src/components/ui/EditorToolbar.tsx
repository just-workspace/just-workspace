/**
 * 공용 편집기 툴바("툴바 3종 → 한 규격").
 *  desktop — 40 높이, 아이콘 버튼 32(아이콘 15, 선 2.2). tools 순서대로, '|' 는 구분선, 'block' 은 [본문 ▾] 블록 형식.
 *  mobile  — 48 높이, 키보드 위 한 줄: Aa(펼침) + mobileTools(44) … end(서명 등). Aa 를 누르면 위에 나머지 한 줄(블록 형식 + 나머지 도구).
 * 위키(실시간 공동 편집)·게시판(단독 편집)·메일 작성이 같은 툴바를 쓴다. 편집기에 없는 확장(표·밑줄 등)은 tools 에서 빼면 된다.
 * ※ 시안의 "할 일 목록"·"@언급" 버튼은 편집기 확장(task-list·mention)이 없어 뺐다.
 * 편집기 상태(굵게 켜짐 등)는 편집기 transaction 마다 다시 그린다.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
// 명령 타입(toggleBold·setLink·toggleUnderline 등)은 확장 패키지가 Editor 에 덧붙인다 — 타입만 불러온다.
// v3 StarterKit 이 링크·밑줄까지 품으므로 한 줄로 충분하다. 표(insertTable)는 편집기마다 넣을지 말지 달라 any 로 부른다.
import type {} from '@tiptap/starter-kit'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { promptBox } from '~/composables/useDialog'
import { useClickOutside } from '~/lib/dom'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import { UiIcon } from './Icon'
import { UiTooltip } from './Tooltip'

export type EditorToolKey =
  | 'block' | 'bold' | 'italic' | 'underline' | 'strike'
  | 'bullet' | 'ordered' | 'link' | 'quote' | 'code' | 'table' | 'image' | 'hr'

export interface UiEditorToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** TipTap 편집기(@tiptap/react useEditor 결과). 없으면 데스크톱 도구가 비고 모바일 도구는 눌러도 아무것도 안 한다 */
  editor: Editor | null | undefined
  /** desktop(기본, 40) · mobile(48, 키보드 위) */
  variant?: 'desktop' | 'mobile'
  /** 툴바 정렬 — 위키는 가운데(기본), 게시판·메일은 왼쪽 */
  align?: 'center' | 'start'
  /** 데스크톱 도구 순서('|' = 구분선). 모바일 펼침 줄도 이 목록에서 mobileTools 를 뺀 나머지 */
  tools?: Array<EditorToolKey | '|'>
  /** 모바일 한 줄에 상시 보일 도구(기본 bold·bullet·link·image) */
  mobileTools?: EditorToolKey[]
  /** 모바일 한 줄의 굵게·기울임을 글자(B · I)로(메일) */
  letterMarks?: boolean
  /** 도구 이름 바꾸기(예: image → "이미지") */
  labels?: Partial<Record<EditorToolKey, string>>
  /** 이미지 도구 클릭 — 부르는 쪽이 파일 고르기·업로드를 한다 */
  onImage?: () => void
  /** 모바일 한 줄 오른쪽 끝 내용(서명 등) */
  end?: ReactNode
}

interface Tool { key: EditorToolKey; label: string; icon: string; run: () => void; active?: () => boolean }

const DEFAULT_TOOLS: Array<EditorToolKey | '|'> = ['block', '|', 'bold', 'italic', 'strike', '|', 'bullet', 'ordered', '|', 'link', 'quote', 'code', 'table', 'image', 'hr']
const DEFAULT_MOBILE_TOOLS: EditorToolKey[] = ['bold', 'bullet', 'link', 'image']
const NO_LABELS: Partial<Record<EditorToolKey, string>> = {}

/**
 * 편집기 서식 툴바.
 * @example <UiEditorToolbar editor={editor} align="start" tools={['bold', 'italic', '|', 'bullet', 'ordered', '|', 'link', 'image']} onImage={pickImage} />
 */
export function UiEditorToolbar({
  editor, variant = 'desktop', align = 'center', tools = DEFAULT_TOOLS, mobileTools: mobileToolKeys = DEFAULT_MOBILE_TOOLS,
  letterMarks = false, labels = NO_LABELS, onImage, end, className, ...rest
}: UiEditorToolbarProps) {
  const { t } = useI18n()

  // 편집기 상태가 바뀔 때마다 다시 그린다(활성 표시)
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!editor) return
    editor.on('transaction', bump)
    return () => { editor.off('transaction', bump) }
  }, [editor])

  const ed = () => editor!

  async function setLink() {
    const e = editor
    if (!e) return
    const prev = e.getAttributes('link').href as string | undefined
    const url = await promptBox(t('ui.editor.linkUrl'), { placeholder: 'https://', defaultValue: prev ?? '' })
    if (url === null) return
    if (!url) { e.chain().focus().extendMarkRange('link').unsetLink().run(); return }
    e.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  // 기본 이름은 i18n 키 ui.editor.<key>
  function makeTool(key: Exclude<EditorToolKey, 'block'>): Tool {
    const label = labels[key] ?? t(`ui.editor.${key}`)
    switch (key) {
      case 'bold': return { key, label, icon: 'bold', run: () => ed().chain().focus().toggleBold().run(), active: () => ed().isActive('bold') }
      case 'italic': return { key, label, icon: 'italic', run: () => ed().chain().focus().toggleItalic().run(), active: () => ed().isActive('italic') }
      case 'underline': return { key, label, icon: 'underline', run: () => ed().chain().focus().toggleUnderline().run(), active: () => ed().isActive('underline') }
      case 'strike': return { key, label, icon: 'strike', run: () => ed().chain().focus().toggleStrike().run(), active: () => ed().isActive('strike') }
      case 'bullet': return { key, label, icon: 'list-bullet', run: () => ed().chain().focus().toggleBulletList().run(), active: () => ed().isActive('bulletList') }
      case 'ordered': return { key, label, icon: 'list-ordered', run: () => ed().chain().focus().toggleOrderedList().run(), active: () => ed().isActive('orderedList') }
      case 'link': return { key, label, icon: 'link', run: () => { void setLink() }, active: () => ed().isActive('link') }
      case 'quote': return { key, label, icon: 'quote', run: () => ed().chain().focus().toggleBlockquote().run(), active: () => ed().isActive('blockquote') }
      case 'code': return { key, label, icon: 'code', run: () => ed().chain().focus().toggleCodeBlock().run(), active: () => ed().isActive('codeBlock') }
      case 'table': return { key, label, icon: 'table', run: () => (ed().chain().focus() as any).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), active: () => ed().isActive('table') }
      case 'image': return { key, label, icon: 'image', run: () => onImage?.() }
      case 'hr': return { key, label, icon: 'hr', run: () => ed().chain().focus().setHorizontalRule().run() }
    }
  }

  /** 데스크톱 줄: 'block' · '|' · 도구 */
  const toolList: (Tool | '|' | 'block')[] = !editor ? [] : tools.map(k => (k === '|' || k === 'block' ? k : makeTool(k)))
  const hasBlock = tools.includes('block')
  const mobileTools = mobileToolKeys.filter(k => k !== 'block').map(k => makeTool(k as Exclude<EditorToolKey, 'block'>))
  const mobileMore = toolList.filter((x): x is Tool => typeof x !== 'string' && !mobileToolKeys.includes(x.key))
  const [moreOpen, setMoreOpen] = useState(false)

  // 블록 형식(본문 · 제목 1~3)
  const BLOCKS = [
    { key: 'p', label: t('ui.editor.paragraph') },
    { key: 'h1', label: t('ui.editor.heading', { n: 1 }) },
    { key: 'h2', label: t('ui.editor.heading', { n: 2 }) },
    { key: 'h3', label: t('ui.editor.heading', { n: 3 }) },
  ]
  const [blockOpen, setBlockOpen] = useState(false)
  let currentBlock = BLOCKS[0]
  if (editor) for (const lv of [1, 2, 3]) if (editor.isActive('heading', { level: lv })) { currentBlock = BLOCKS[lv]; break }
  function setBlock(key: string) {
    const e = editor
    setBlockOpen(false)
    if (!e) return
    if (key === 'p') e.chain().focus().setParagraph().run()
    else e.chain().focus().setHeading({ level: Number(key[1]) as 1 | 2 | 3 }).run()
  }

  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault()

  // 데스크톱 40
  if (variant === 'desktop') {
    return (
      <div
        {...rest}
        role="toolbar"
        aria-label={t('ui.editor.format')}
        className={cn('flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto px-1.5 text-muted-foreground scrollbar-none', align === 'center' ? 'justify-center' : 'justify-start', className)}
      >
        {toolList.map((tl, i) => {
          if (tl === '|') return <span key={`${tl}-${i}`} className="mx-1 h-[18px] w-px shrink-0 bg-border" aria-hidden="true" />
          if (tl === 'block') {
            return (
              <BlockSelect
                key={`${tl}-${i}`}
                open={blockOpen}
                setOpen={setBlockOpen}
                disabled={!editor}
                blocks={BLOCKS}
                current={currentBlock}
                label={t('ui.editor.blockType')}
                onPick={setBlock}
              />
            )
          }
          const on = tl.active?.()
          return (
            <UiTooltip key={tl.key} text={tl.label}>
              <button
                type="button"
                aria-label={tl.label}
                aria-pressed={tl.active ? tl.active() : undefined}
                className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', on ? 'bg-primary/[0.13] text-foreground' : '')}
                onMouseDown={keepFocus}
                onClick={() => tl.run()}
              >
                <UiIcon name={tl.icon} className="h-[15px] w-[15px]" strokeWidth={2.2} />
              </button>
            </UiTooltip>
          )
        })}
      </div>
    )
  }

  // 모바일 48(키보드 위 한 줄) + Aa 펼침
  return (
    <div {...rest} className={cn('shrink-0 border-t border-border bg-card text-muted-foreground', className)}>
      {moreOpen && (
        <div role="toolbar" aria-label={t('ui.editor.formatMore')} className="flex h-11 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 scrollbar-none">
          {hasBlock && (
            <>
              {BLOCKS.map(b => (
                <button
                  key={b.key}
                  type="button"
                  className={cn('inline-flex h-9 shrink-0 items-center rounded-sm px-2.5 text-[13px]', currentBlock.key === b.key ? 'bg-primary/[0.13] font-semibold text-foreground' : '')}
                  onMouseDown={keepFocus}
                  onClick={() => setBlock(b.key)}
                >{b.label}</button>
              ))}
              <span className="mx-1 h-[18px] w-px shrink-0 bg-border" aria-hidden="true" />
            </>
          )}
          {mobileMore.map(tl => (
            <button
              key={tl.key}
              type="button"
              aria-label={tl.label}
              aria-pressed={tl.active ? tl.active() : undefined}
              className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-sm', tl.active?.() ? 'bg-primary/[0.13] text-foreground' : '')}
              onMouseDown={keepFocus}
              onClick={() => tl.run()}
            >
              <UiIcon name={tl.icon} className="h-[18px] w-[18px]" strokeWidth={2.2} />
            </button>
          ))}
        </div>
      )}
      <div role="toolbar" aria-label={t('ui.editor.format')} className="flex h-12 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-1.5 scrollbar-none">
        <button
          type="button"
          aria-label={t('ui.editor.formatMore')}
          aria-expanded={moreOpen}
          className={cn('grid h-11 w-11 shrink-0 place-items-center text-sm font-semibold', moreOpen ? 'text-foreground' : 'text-primary')}
          onMouseDown={keepFocus}
          onClick={() => setMoreOpen(v => !v)}
        >Aa</button>
        {mobileTools.map(tl => (
          <button
            key={tl.key}
            type="button"
            aria-label={tl.label}
            aria-pressed={editor && tl.active ? tl.active() : undefined}
            className={cn(
              'grid h-11 w-11 shrink-0 place-items-center',
              editor && tl.active?.() ? 'text-foreground' : '',
              letterMarks && tl.key === 'bold' ? 'font-bold' : '',
              letterMarks && tl.key === 'italic' ? 'italic' : '',
            )}
            onMouseDown={keepFocus}
            onClick={() => { if (editor) tl.run() }}
          >
            {letterMarks && (tl.key === 'bold' || tl.key === 'italic')
              ? (tl.key === 'bold' ? 'B' : 'I')
              : <UiIcon name={tl.icon} className="h-[18px] w-[18px]" strokeWidth={2.2} />}
          </button>
        ))}
        {end != null && (
          <>
            <span className="flex-1" />
            {end}
          </>
        )}
      </div>
    </div>
  )
}

/** 데스크톱 [본문 ▾] 블록 형식 고르기 — 바깥 클릭으로 닫힌다 */
function BlockSelect({ open, setOpen, disabled, blocks, current, label, onPick }: {
  open: boolean
  setOpen: (v: boolean) => void
  disabled: boolean
  blocks: { key: string; label: string }[]
  current: { key: string; label: string }
  label: string
  onPick: (key: string) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  // 목록은 body 로 포털해 fixed 로 띄운다 — 툴바가 overflow-x-auto(세로도 auto 로 계산된다)라
  // 안에서 absolute 로 그리면 40 높이 상자에 잘려 보이지 않았다(UiSelect·UiMenu 와 같은 방식)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  function place() {
    const btn = ref.current?.querySelector('button')
    if (!btn) return
    const r = toCssRect(btn.getBoundingClientRect())
    const { vw, vh } = viewportCss()
    const h = listRef.current?.offsetHeight ?? 0
    const left = Math.max(8, Math.min(r.left, vw - 160 - 8))
    const top = h && r.bottom + 4 + h > vh - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4
    setPos({ left, top })
  }
  useClickOutside(ref, (e) => { if (listRef.current?.contains(e.target as Node)) return; setOpen(false) })
  useLayoutEffect(() => { if (open) place(); else setPos(null) }, [open])
  useEffect(() => {
    if (!open) return
    const on = () => place()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('resize', on)
    window.addEventListener('scroll', on, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('resize', on)
      window.removeEventListener('scroll', on, true)
      document.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className="inline-flex h-8 items-center gap-1 rounded-sm px-2.5 text-xs text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {current.label}
        <UiIcon name="chevron-down" className="h-3 w-3 text-muted-foreground" strokeWidth={2.4} />
      </button>
      {open && createPortal(
        <ul
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="fixed z-overlay w-40 rounded-lg border border-border bg-popover p-1 text-foreground shadow-md"
          style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: 0, top: 0, visibility: 'hidden' }}
          // 편집기 포커스(선택 영역)를 잃지 않게
          onMouseDown={e => e.preventDefault()}
        >
          {blocks.map(b => (
            <li
              key={b.key}
              role="option"
              aria-selected={current.key === b.key}
              className={cn('flex h-8 cursor-pointer items-center rounded-sm px-2.5 text-[13px] hover:bg-accent', current.key === b.key ? 'font-semibold text-foreground' : 'text-foreground/85')}
              style={b.key === 'h1' ? { fontSize: '15px', fontWeight: 700 } : b.key === 'h2' ? { fontSize: '14px', fontWeight: 600 } : undefined}
              onClick={() => onPick(b.key)}
            >{b.label}</li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  )
}

export default UiEditorToolbar
