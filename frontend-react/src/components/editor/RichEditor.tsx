/**
 * 단독 편집기(게시판 작성용). TipTap StarterKit + 이미지·표.
 * 데스크톱: 카드(border-input, 포커스 시 ring) 안에 공용 툴바(40) + 본문(min 260).
 * 모바일: 카드 없이 본문만 표시한다. 툴바는 호스트 페이지가 키보드 위에 <UiEditorToolbar variant="mobile"> 로 렌더링한다(editor 노출).
 * 이미지·파일 버튼은 호스트가 처리한다(onImage). 게시판은 첨부 업로드 흐름과 동일하게 처리한다.
 *
 * TipTap v3: StarterKit 이 밑줄·링크를 기본 포함한다(별도 추가 시 중복 등록 경고 발생). 표는 @tiptap/extension-table 단일 패키지에서,
 * 자리표시(Placeholder)는 @tiptap/extensions 에서 가져온다.
 *
 * html·onUpdateHtml / text·onUpdateText — 편집기는 값을 출력만 한다(입력 값은 사용하지 않는다).
 * ref 핸들 = { editor, insertImage }. 호스트가 editor 기준으로 재렌더링해야 하는 경우 onUpdateEditor 를 사용한다.
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

/** ref 로 노출하는 항목 */
export interface RichEditorHandle {
  readonly editor: Editor | null
  insertImage: (src: string, alt?: string) => void
}

export interface RichEditorProps {
  initialContent?: string
  placeholder?: string
  /** 모바일 — 카드·상단 툴바 없이 본문만 표시 */
  bare?: boolean
  /** v-model:html 의 값(미사용, 쌍 구성용) */
  html?: string | null
  /** 본문 HTML 변경 시 호출 */
  onUpdateHtml?: (html: string | null) => void
  /** v-model:text 의 값(미사용, 쌍 구성용) */
  text?: string
  /** 본문 텍스트 변경 시 호출 */
  onUpdateText?: (text: string) => void
  /** 툴바 이미지 버튼 */
  onImage?: () => void
  /** 편집기 생성·제거 시 호출 — 호스트가 모바일 툴바에 전달 */
  onUpdateEditor?: (editor: Editor | null) => void
  className?: string
  ref?: Ref<RichEditorHandle | null>
}

/**
 * 게시판 글쓰기 편집기.
 * @example <RichEditor ref={richRef} onUpdateHtml={setHtml} onUpdateText={setText} initialContent={html} bare={isMobile} onImage={pick} />
 */
export function RichEditor({ initialContent, placeholder, bare = false, onUpdateHtml, onUpdateText, onImage, onUpdateEditor, className, ref }: RichEditorProps) {
  useI18n()   // 로캘 전환 시 재렌더링
  const latest = useRef({ placeholder, onUpdateHtml, onUpdateText })
  latest.current = { placeholder, onUpdateHtml, onUpdateText }

  const editor = useEditor({
    extensions: [
      // v3 StarterKit = 밑줄·링크·ListKeymap 포함. 링크는 v2 와 동일하게 클릭으로 열지 않는다(편집 중 이동 방지)
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

  // 편집 모드에서 기존 글이 지연 수신되면 본문이 비어 있을 때만 채운다(최초 값은 제외)
  // v3 setContent 는 기본적으로 update 를 발생시킨다 — v2 와 동일하게 비활성화한다(기존 글 채움은 사용자 편집이 아니므로 임시 저장에 영향을 주어서는 안 된다)
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
