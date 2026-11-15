// 문서 교정(E2): 꾸밈 위치 찾기(같은 구절 k 번째, 블록 경계를 넘는 구절은 못 찾음) · 바꾸기 · 모두 바꾸기(뒤에서부터).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

const api = vi.hoisted(() => ({ respond: (_u: string, _o?: any): any => ({}) }))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => api.respond(url, opts)
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { docText, locate, proofKey } = await import('~/utils/proofreadPm')
const { runProofread, applyProof, applyAllProof, proofStore, resetProofread } = await import('~/components/wiki/WikiProofread')

let editor: Editor
beforeEach(() => {
  editor = new Editor({ extensions: [StarterKit], content: '<p>터널이 8시간 마다 끊겼다. 주기가 <strong>서로 틀렸기</strong> 때문이다.</p><p>8시간 마다 재협상</p>' })
})
afterEach(() => { resetProofread(); editor.destroy() })

describe('위치 찾기', () => {
  it('블록 사이는 줄바꿈, 같은 구절은 k 번째 제안이 k 번째 자리', () => {
    const { text } = docText(editor.state.doc)
    expect(text).toBe('터널이 8시간 마다 끊겼다. 주기가 서로 틀렸기 때문이다.\n8시간 마다 재협상')
    const items = [
      { kind: 'spacing' as const, original: '8시간 마다', fixed: '8시간마다', reason: '' },
      { kind: 'spacing' as const, original: '8시간 마다', fixed: '8시간마다', reason: '' },
      { kind: 'style' as const, original: '없는 구절', fixed: 'x', reason: '' },
      { kind: 'style' as const, original: '때문이다.\n8시간', fixed: 'x', reason: '' },
    ]
    const r = locate(editor.state.doc, items)
    expect(editor.state.doc.textBetween(r[0]!.from, r[0]!.to)).toBe('8시간 마다')
    expect(r[1]!.from).toBeGreaterThan(r[0]!.to)
    expect(r[2]).toBeNull()
    expect(r[3]).toBeNull()
  })
})

describe('교정 흐름', () => {
  it('제안을 받아 꾸밈을 달고, 바꾸기는 서식을 지키며, 모두 바꾸기는 남은 것 전부', async () => {
    api.respond = (url, opts) => {
      expect(url).toBe('/api/ai/inline/doc_proofread')
      expect(opts.body.text).toContain('서로 틀렸기')
      return { model: 'm', ai_generated: true, external: false, masked: false, mode: 'all', items: [
        { kind: 'style', original: '서로 틀렸기', fixed: '서로 달랐기', reason: '다르다' },
        { kind: 'spacing', original: '8시간 마다', fixed: '8시간마다', reason: '' },
        { kind: 'spacing', original: '8시간 마다', fixed: '8시간마다', reason: '' },
      ] }
    }
    await runProofread(editor, 'all', '보고서', '실패')
    expect(proofStore.getState().items).toHaveLength(3)
    expect(proofKey.getState(editor.state)?.items).toHaveLength(3)

    expect(applyProof(editor, 0)).toBe(true)
    expect(editor.getHTML()).toContain('<strong>서로 달랐기</strong>')
    expect(proofStore.getState().items).toHaveLength(2)

    expect(applyAllProof(editor)).toBe(2)
    expect(docText(editor.state.doc).text).toBe('터널이 8시간마다 끊겼다. 주기가 서로 달랐기 때문이다.\n8시간마다 재협상')
    expect(proofStore.getState().items).toHaveLength(0)
  })

  it('글이 바뀌어 구절이 없으면 바꾸지 않는다', async () => {
    api.respond = () => ({ model: 'm', ai_generated: true, external: false, masked: false, mode: 'style', items: [
      { kind: 'style', original: '서로 틀렸기', fixed: '서로 달랐기', reason: '' },
    ] })
    await runProofread(editor, 'style', undefined, '실패')
    editor.commands.setContent('<p>완전히 다른 글</p>')
    expect(applyProof(editor, 0)).toBe(false)
  })
})
