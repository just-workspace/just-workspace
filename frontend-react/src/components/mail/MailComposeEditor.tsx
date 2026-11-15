/**
 * 메일 작성 본문 에디터 (하단 툴바 · 인라인 답장 Aa).
 *  toolbar="desktop" : 본문 위 40 줄 — 굵게·기울임·밑줄 | 글머리·번호 | 링크·인용·코드·이미지 (32 버튼)
 *  toolbar="mobile"  : 본문 아래 48 줄 — Aa · B · I · 글머리 · 링크 … toolbarEnd(서명)
 *  toolbar="none"    : 툴바 없음(인라인 답장 — Aa 로 desktop 툴바를 펼친다)
 * v-model:html / v-model:text → html·onUpdateHtml / text·onUpdateText (편집기가 값을 내보내기만 한다 — 들어오는 값은 initialContent).
 * ref: { focus, setContent }
 * TipTap v3: setContent(content, { emitUpdate }) 서명. 자리표시는 @tiptap/extensions.
 */
import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extensions'
import { useI18n } from '~/i18n'
// class 를 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지운다)
import { clsx as cx } from 'clsx'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { UiEditorToolbar, type EditorToolKey } from '~/components/ui/EditorToolbar'
import './MailComposeEditor.css'

// 메일 서식 도구('|' = 구분선) — 공용 UiEditorToolbar
const TOOLS: Array<EditorToolKey | '|'> = ['bold', 'italic', 'underline', '|', 'bullet', 'ordered', '|', 'link', 'quote', 'code', 'image']
const MOBILE_TOOLS: EditorToolKey[] = ['bold', 'italic', 'bullet', 'link']

export interface MailComposeEditorHandle {
  /** 본문 끝에 포커스 */
  focus: () => void
  /** 본문 통째로 바꾸기(update 이벤트를 낸다) */
  setContent: (v: string) => void
}

export interface MailComposeEditorProps {
  /** 처음 내용(HTML). 비동기로 늦게 오면 아직 아무것도 안 썼을 때만 채운다 */
  initialContent?: string
  /** desktop(기본) · mobile · none */
  toolbar?: 'desktop' | 'mobile' | 'none'
  /** 빈 본문 안내 */
  placeholder?: string
  /** 본문 글자 크기·줄 간격(데스크톱 14/1.7, 모바일 15/1.65) */
  bodyClass?: string
  /** 본문 HTML 바뀜(비면 null) */
  onUpdateHtml?: (v: string | null) => void
  /** 본문 텍스트 바뀜 */
  onUpdateText?: (v: string) => void
  /** 본문 아래 붙는 것(서명·첨부·오류) — 모바일 하단 툴바보다 위 */
  below?: ReactNode
  /** 모바일 툴바 오른쪽 끝 */
  toolbarEnd?: ReactNode
  /** 루트에 덧붙일 클래스 */
  className?: string
  /** { focus, setContent } */
  ref?: Ref<MailComposeEditorHandle | null>
}

/** 메일 작성 본문 편집기(TipTap) */
export function MailComposeEditor({
  initialContent, toolbar = 'desktop', placeholder = '', bodyClass = 'text-[14px] leading-[1.7]',
  onUpdateHtml, onUpdateText, below, toolbarEnd, className, ref,
}: MailComposeEditorProps) {
  const { t } = useI18n()
  const L = useRef({ placeholder, onUpdateHtml, onUpdateText })
  L.current = { placeholder, onUpdateHtml, onUpdateText }

  const editor = useEditor({
    extensions: [
      // v3 StarterKit = 밑줄·링크 포함(따로 넣으면 중복 등록 경고). 링크는 편집 중 클릭으로 열지 않는다
      StarterKit.configure({ link: { openOnClick: false } }),
      Image.configure({ inline: true, allowBase64: true }),
      Placeholder.configure({ placeholder: () => L.current.placeholder }),
    ],
    content: initialContent || '',
    onUpdate: ({ editor: e }) => {
      L.current.onUpdateHtml?.(e.isEmpty ? null : e.getHTML())
      L.current.onUpdateText?.(e.getText({ blockSeparator: '\n' }))
    },
  }, [])

  // 원문 인용 등 비동기로 늦게 오는 초기값 — 아직 아무것도 안 썼을 때만 채운다(첫 값은 건너뜀)
  const firstInit = useRef(true)
  useEffect(() => {
    if (firstInit.current) { firstInit.current = false; return }
    if (editor && initialContent && editor.isEmpty) {
      editor.commands.setContent(initialContent, { emitUpdate: true })
    }
  }, [initialContent, editor])

  function run(fn: (c: any) => any) { const c = editor?.chain().focus(); if (c) fn(c).run() }

  function insertImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const formData = new FormData()
        formData.append('file', file)
        const result = await $fetch<{ url: string }>('/api/mail/upload-inline', { method: 'POST', body: formData })
        run(c => c.setImage({ src: result.url, alt: file.name }))
      } catch (e: any) {
        addToast('error', e?.data?.detail || t('mail.editor.imageUploadFailed'))
      }
    }
    input.click()
  }

  const LABELS = { code: t('mail.editor.code'), image: t('mail.editor.image') }

  useImperativeHandle(ref, () => ({
    focus: () => { editor?.commands.focus('end') },
    setContent: (v: string) => { editor?.commands.setContent(v, { emitUpdate: true }) },
  }), [editor])

  // 언마운트 때 편집기 해제는 @tiptap/react useEditor 가 한다

  return (
    <div className={cx('flex min-h-0 flex-col', className ?? '')}>
      {/* 데스크톱 서식 툴바 40 */}
      {toolbar === 'desktop' && (
        <UiEditorToolbar
          editor={editor}
          tools={TOOLS}
          labels={LABELS}
          align="start"
          className="border-b border-border"
          onImage={insertImage}
        />
      )}

      <EditorContent
        editor={editor}
        className={cx('mail-compose-editor min-h-0 flex-1 overflow-y-auto [&_.ProseMirror]:min-h-full [&_.ProseMirror]:outline-hidden', bodyClass)}
      />
      {/* 본문 아래 붙는 것(서명·첨부·오류) — 모바일 하단 툴바보다 위 */}
      {below}

      {/* 모바일 하단 툴바 48 (Aa · B · I · 글머리 · 링크 … 서명, Aa 로 나머지 서식 한 줄 더) */}
      {toolbar === 'mobile' && (
        <UiEditorToolbar
          editor={editor}
          variant="mobile"
          tools={TOOLS}
          mobileTools={MOBILE_TOOLS}
          labels={LABELS}
          letterMarks
          onImage={insertImage}
          end={toolbarEnd}
        />
      )}
    </div>
  )
}

export default MailComposeEditor
