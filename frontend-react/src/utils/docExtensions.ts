/**
 * 문서 편집기용 TipTap 확장.
 *
 * TipTap 기본 확장에 없지만 Word 리본에서 자리를 차지하는 것들이다. 글자 크기와
 * 단락 서식(줄 간격·들여쓰기·단락 앞뒤 간격)은 없으면 리본이 반쯤 비어 보인다.
 *
 * 단락 속성을 하나의 확장(BlockStyle)으로 묶은 이유: 줄 간격·들여쓰기·간격을 각각
 * 확장으로 만들면 같은 노드에 addGlobalAttributes 를 세 번 얹게 되고, 그때마다
 * 스키마가 갈라져 협업 중 문서가 어긋날 여지가 생긴다.
 */
import { Extension } from '@tiptap/core'

/** 글자 크기 — TextStyle 마크 위에 얹는다. */
export const FontSize = Extension.create({
  name: 'fontSize',
  addOptions: () => ({ types: ['textStyle'] }),
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.fontSize || null,
          renderHTML: (attrs: any) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}),
        },
      },
    }]
  },
  addCommands() {
    return {
      setFontSize: (size: string) => ({ chain }: any) =>
        chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize: () => ({ chain }: any) =>
        chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    } as any
  },
})

/** 단락 서식 — 줄 간격 / 들여쓰기 / 단락 앞뒤 간격. */
export const BlockStyle = Extension.create({
  name: 'blockStyle',
  addOptions: () => ({ types: ['paragraph', 'heading', 'blockquote', 'listItem'] }),
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.lineHeight || null,
          renderHTML: (a: any) => (a.lineHeight ? { style: `line-height:${a.lineHeight}` } : {}),
        },
        indent: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.marginLeft || null,
          renderHTML: (a: any) => (a.indent ? { style: `margin-left:${a.indent}` } : {}),
        },
        spaceBefore: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.marginTop || null,
          renderHTML: (a: any) => (a.spaceBefore ? { style: `margin-top:${a.spaceBefore}` } : {}),
        },
        spaceAfter: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.marginBottom || null,
          renderHTML: (a: any) => (a.spaceAfter ? { style: `margin-bottom:${a.spaceAfter}` } : {}),
        },
        // 캡션·각주·목차처럼 "이건 이런 문단이다" 를 표시해야 하는 것들이 있다.
        // 클래스를 스키마에 넣지 않으면 삽입하는 순간 TipTap 이 떼어 버린다.
        cls: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute('class') || null,
          renderHTML: (a: any) => (a.cls ? { class: a.cls } : {}),
        },
        // 책갈피 — 상호 참조가 걸 자리. id 가 있어야 문서 안 링크(#이름)가 성립한다.
        anchor: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute('id') || null,
          renderHTML: (a: any) => (a.anchor ? { id: a.anchor } : {}),
        },
      },
    }]
  },
  addCommands() {
    // 선택 영역에 걸친 모든 블록에 같은 값을 준다. Word 의 단락 서식과 같은 감각.
    const setAll = (attr: string) => (value: string | null) => ({ state, chain }: any) => {
      const types: string[] = (this as any).options.types
      let c = chain()
      for (const t of types) {
        if (state.schema.nodes[t]) c = c.updateAttributes(t, { [attr]: value })
      }
      return c.run()
    }
    return {
      setLineHeight: setAll('lineHeight'),
      setIndent: setAll('indent'),
      setSpaceBefore: setAll('spaceBefore'),
      setSpaceAfter: setAll('spaceAfter'),
    } as any
  },
})

/** 용지 규격 (cm). 세로 기준이고 가로는 뒤집어 쓴다. */
export const PAGE_SIZES: Record<string, { w: number; h: number; label: string }> = {
  A4: { w: 21, h: 29.7, label: 'A4 (21 × 29.7cm)' },
  Letter: { w: 21.59, h: 27.94, label: 'Letter (21.59 × 27.94cm)' },
  A5: { w: 14.8, h: 21, label: 'A5 (14.8 × 21cm)' },
  B5: { w: 18.2, h: 25.7, label: 'B5 (18.2 × 25.7cm)' },
  A3: { w: 29.7, h: 42, label: 'A3 (29.7 × 42cm)' },
}

/** 여백 프리셋 (cm) — 위/오른쪽/아래/왼쪽. Word 의 기본 목록과 같은 값이다. */
export const MARGINS: Record<string, { v: [number, number, number, number]; labelKey: string }> = {
  normal: { v: [2.54, 2.54, 2.54, 2.54], labelKey: 'files.office.margin.normal' },
  narrow: { v: [1.27, 1.27, 1.27, 1.27], labelKey: 'files.office.margin.narrow' },
  moderate: { v: [2.54, 1.91, 2.54, 1.91], labelKey: 'files.office.margin.moderate' },
  wide: { v: [2.54, 5.08, 2.54, 5.08], labelKey: 'files.office.margin.wide' },
}

/** 문서 서식 테마 — 본문 글꼴·크기·줄간격 한 벌. 디자인 탭의 갤러리가 이걸 고른다. */
export interface DocTheme {
  id: string
  /** 이름 i18n 키 */
  labelKey: string
  bodyFont: string
  bodySize: string
  lineHeight: string
  headingFont: string
  headingColor: string
}

export const DOC_THEMES: DocTheme[] = [
  { id: 'basic', labelKey: 'files.office.theme.basic', bodyFont: '맑은 고딕', bodySize: '11pt', lineHeight: '1.6', headingFont: '맑은 고딕', headingColor: '#111827' },
  { id: 'report', labelKey: 'files.office.theme.report', bodyFont: '맑은 고딕', bodySize: '11pt', lineHeight: '1.75', headingFont: '맑은 고딕', headingColor: '#1d4ed8' },
  { id: 'thesis', labelKey: 'files.office.theme.thesis', bodyFont: '바탕', bodySize: '11pt', lineHeight: '2.0', headingFont: '바탕', headingColor: '#111827' },
  { id: 'modern', labelKey: 'files.office.theme.modern', bodyFont: '나눔고딕', bodySize: '10.5pt', lineHeight: '1.7', headingFont: '나눔고딕', headingColor: '#0f766e' },
  { id: 'classic', labelKey: 'files.office.theme.classic', bodyFont: 'Times New Roman', bodySize: '12pt', lineHeight: '1.8', headingFont: 'Times New Roman', headingColor: '#7c2d12' },
  { id: 'compact', labelKey: 'files.office.theme.compact', bodyFont: '맑은 고딕', bodySize: '10pt', lineHeight: '1.4', headingFont: '맑은 고딕', headingColor: '#374151' },
]

export function themeById(id: string): DocTheme {
  return DOC_THEMES.find(t => t.id === id) || DOC_THEMES[0]
}
