/**
 * 문서 교정 표시 — ProseMirror 꾸밈(decoration) 플러그인. 문서 내용은 변경하지 않는다.
 *  빨강 물결 = 맞춤법, 주황 물결 = 띄어쓰기, 파랑(바탕 primary/15 + 아래 2px) = 문체. 현재 열람 중인 제안에는 테두리를 추가한다.
 *  제안은 원문 구절(original)로 보유하고 문서 변경 시마다 재탐색한다 — 동일 구절이 여러 번 나오면 k 번째 제안 = k 번째 위치.
 *  공동 편집(Yjs) 중 타 사용자의 수정으로 구절이 사라지면 해당 제안은 표시되지 않는다(바꾸기도 차단).
 */
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { ProofItem } from '~/utils/aiInline'

export interface ProofState { items: ProofItem[]; active: number }
export const proofKey = new PluginKey<ProofState>('jw-proofread')

/** 문서 → 평문(블록 사이 \n) + 글자마다 문서 위치(-1 = 블록 경계) */
export function docText(doc: PmNode): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  doc.descendants((node, pos) => {
    if (node.isText) {
      const s = node.text || ''
      for (let i = 0; i < s.length; i++) map.push(pos + i)
      text += s
    } else if (node.isBlock && text.length && !text.endsWith('\n')) {
      text += '\n'
      map.push(-1)
    }
    return true
  })
  return { text, map }
}

/** 제안별 문서 범위 — 탐색 실패 시 null. 한 글자 덩어리(같은 글 노드 줄) 안에서만 탐색 */
export function locate(doc: PmNode, items: readonly ProofItem[]): ({ from: number; to: number } | null)[] {
  const { text, map } = docText(doc)
  const cursor = new Map<string, number>()
  return items.map((it) => {
    let start = cursor.get(it.original) ?? 0
    while (start <= text.length) {
      const idx = text.indexOf(it.original, start)
      if (idx < 0) break
      const end = idx + it.original.length - 1
      let ok = map[idx] >= 0
      for (let j = idx; ok && j < end; j++) ok = map[j + 1] === map[j] + 1
      start = idx + 1
      if (ok) {
        cursor.set(it.original, idx + it.original.length)
        return { from: map[idx], to: map[end] + 1 }
      }
    }
    cursor.set(it.original, text.length + 1)
    return null
  })
}

const STYLE: Record<ProofItem['kind'], string> = {
  spelling: 'text-decoration: underline wavy hsl(var(--danger)); text-underline-offset: 4px;',
  spacing: 'text-decoration: underline wavy hsl(var(--warning)); text-underline-offset: 4px;',
  style: 'background: hsl(var(--primary) / 0.15); border-bottom: 2px solid hsl(var(--primary));',
}
const ACTIVE = 'outline: 2px solid hsl(var(--ring)); outline-offset: 1px; border-radius: 2px;'

export function proofDecorations(state: EditorState, ps: ProofState | undefined): DecorationSet {
  if (!ps || !ps.items.length) return DecorationSet.empty
  const ranges = locate(state.doc, ps.items)
  const decos: Decoration[] = []
  ranges.forEach((r, i) => {
    if (!r) return
    const it = ps.items[i]
    decos.push(Decoration.inline(r.from, r.to, {
      style: STYLE[it.kind] + (i === ps.active ? ACTIVE : ''),
      'data-proof': String(i),
      'aria-label': it.kind,
    }))
  })
  return DecorationSet.create(state.doc, decos)
}

/** 플러그인 — onPick(i): 꾸밈 클릭 시 해당 제안을 연다 */
export function proofreadPlugin(onPick: (i: number) => void) {
  return new Plugin<ProofState>({
    key: proofKey,
    state: {
      init: () => ({ items: [], active: 0 }),
      apply: (tr, prev) => (tr.getMeta(proofKey) as ProofState | undefined) ?? prev,
    },
    props: {
      decorations(state) { return proofDecorations(state, proofKey.getState(state)) },
      handleClick(view, _pos, event) {
        const el = (event.target as HTMLElement | null)?.closest?.('[data-proof]')
        if (!el) return false
        const i = Number(el.getAttribute('data-proof'))
        if (Number.isFinite(i)) onPick(i)
        return false
      },
    },
  })
}
