/**
 * 단독 편집기(게시판 쓰기 — 시안 BD4·BM3). TipTap StarterKit + 이미지·표. Vue 판 components/editor/RichEditor.vue 이식.
 * 데스크톱: 카드(border-input, 포커스 시 ring) 안에 공용 툴바(40) + 본문(min 260).
 * 모바일: 카드 없이 본문만 — 툴바는 호스트 페이지가 키보드 위에 <UiEditorToolbar variant="mobile"> 로 그린다(editor 노출).
 * 이미지·파일 버튼은 호스트가 받는다(onImage) — 게시판은 첨부 업로드 흐름과 같이 간다.
 *
 * TipTap v3: StarterKit 이 밑줄·링크를 기본 포함한다(따로 넣으면 중복 등록 경고). 표는 @tiptap/extension-table 하나에서,
 * 자리표시(Placeholder)는 @tiptap/extensions 에서 가져온다.
 *
 * Vue v-model:html / v-model:text → html·onUpdateHtml / text·onUpdateText (편집기가 값을 내보내기만 한다 — Vue 판도 들어오는 값은 쓰지 않았다).
 * Vue defineExpose({ editor, insertImage }) → ref 핸들. 호스트가 editor 로 다시 그려야 하면 onUpdateEditor.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extensions'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import { cn } from '~/lib/utils'
import { useI18n, i18n } from '~/i18n'
import { UiEditorToolbar } from '~/components/ui/EditorToolbar'
import './RichEditor.css'

/** ref 로 쓰는 것(Vue defineExpose) */
export interface RichEditorHandle {
  readonly editor: Editor | null
  insertImage: (src: string, alt?: string) => void
}

export interface RichEditorProps {
  initialContent?: string
  placeholder?: string
  /** 모바일 — 카드·상단 툴바 없이 본문만 */
  bare?: boolean
  /** v-model:html 의 값(쓰지 않음, 짝 맞춤용) */
  html?: string | null
  /** 본문 HTML 이 바뀔 때(Vue update:html) */
  onUpdateHtml?: (html: string | null) => void
  /** v-model:text 의 값(쓰지 않음, 짝 맞춤용) */
  text?: string
  /** 본문 글자가 바뀔 때(Vue update:text) */
  onUpdateText?: (text: string) => void
  /** 툴바 이미지 버튼 */
  onImage?: () => void
  /** 편집기가 생기거나 사라질 때 — 호스트가 모바일 툴바에 넘긴다 */
  onUpdateEditor?: (editor: Editor | null) => void
  className?: string
  ref?: Ref<RichEditorHandle | null>
}

/**
 * 게시판 글쓰기 편집기.
 * @example <RichEditor ref={richRef} onUpdateHtml={setHtml} onUpdateText={setText} initialContent={html} bare={isMobile} onImage={pick} />
 */
export function RichEditor({ initialContent, placeholder, bare = false, onUpdateHtml, onUpdateText, onImage, onUpdateEditor, className, ref }: RichEditorProps) {
  useI18n()   // 로캘 전환에 다시 그린다
  const latest = useRef({ placeholder, onUpdateHtml, onUpdateText })
  latest.current = { placeholder, onUpdateHtml, onUpdateText }

  const editor = useEditor({
    extensions: [
      // v3 StarterKit = 밑줄·링크·ListKeymap 포함. 링크는 v2 때처럼 클릭으로 열지 않는다(편집 중 이동 방지)
      StarterKit.configure({ link: { openOnClick: false } }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: () => latest.current.placeholder || i18n.t('editor.placeholder') }),
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
    ],
    content: initialContent || '',
    onUpdate: ({ editor: e }) => {
      latest.current.onUpdateHtml?.(e.getHTML())
      latest.current.onUpdateText?.(e.getText())
    },
  })

  // 편집 모드에서 기존 글이 뒤늦게 오면 비어 있을 때만 채운다(Vue watch — 첫 값은 건너뜀)
  // v3 setContent 는 기본으로 update 를 내보낸다 — v2 와 같게 끈다(기존 글을 채우는 것은 "내가 고친 것"이 아니라 임시 저장을 건드리면 안 된다)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (editor && initialContent && !editor.getText()) editor.commands.setContent(initialContent, { emitUpdate: false })
  }, [initialContent, editor])

  const onEd = useRef(onUpdateEditor); onEd.current = onUpdateEditor
  useEffect(() => { onEd.current?.(editor) }, [editor])
  useEffect(() => () => { onEd.current?.(null) }, [])

  useImperativeHandle(ref, () => ({
    get editor() { return editor },
    insertImage(src: string, alt?: string) {
      editor?.chain().focus().setImage({ src, alt }).run()
    },
  }), [editor])

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        bare ? '' : 'rounded-lg border border-input bg-card transition-[box-shadow,border-color] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
        className,
      )}
    >
      {!bare && (
        <div className="border-b border-border">
          <UiEditorToolbar editor={editor} align="start" tools={['block', '|', 'bold', 'italic', 'strike', '|', 'bullet', 'ordered', '|', 'link', 'quote', 'code', 'table', 'image']} onImage={() => onImage?.()} />
        </div>
      )}
      <EditorContent
        editor={editor}
        className={cn(
          'rich-editor prose prose-sm max-w-none flex-1 overflow-auto break-words dark:prose-invert [&_.ProseMirror]:outline-hidden',
          bare ? 'px-4 py-3.5 text-base leading-[1.7] [&_.ProseMirror]:min-h-[160px]' : 'min-h-[260px] p-4 text-[15px] leading-[1.75] [&_.ProseMirror]:min-h-[220px]',
        )}
      />
    </div>
  )
}

export default RichEditor
