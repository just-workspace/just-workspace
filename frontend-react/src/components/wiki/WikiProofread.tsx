/**
 * 위키 편집기 교정 — 편집 머리의 [교정 n](secondary xs, wand) · [문체](ghost xs, type)와
 * 본문 아래 제안 카드(popover 바탕 · 반지름 10 · 패딩 12×14): "✦ 문체 · 2/3" / 원문(취소선 muted) → 교정 문장(success) /
 * 사유 한 줄 / [바꾸기][무시] … [모두 바꾸기]. 색만으로 구분되지 않도록 카드에 종류를 문자로 표기한다.
 *  - [교정] = 맞춤법·띄어쓰기·문체 전체, [문체] = 문체만. 결과는 편집기 꾸밈(utils/proofreadPm)으로 밑줄 표시한다.
 *  - 입력은 현재 편집기에 있는 글(사용자에게 표시되는 글)로 한정한다 — 서버는 원문에 그대로 존재하는 구절의 제안만 반환한다.
 *  - 바꾸기는 ProseMirror 트랜잭션(insertText) — 공동 편집 상대에게도 동일하게 전달된다. 서식(굵게 등)은 유지된다.
 * 머리 버튼과 카드가 분리되어 있어 상태는 본 모듈의 store 하나로 연결한다.
 */
import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import type { Editor } from '@tiptap/react'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { useAiInline } from '~/composables/useAiInline'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { AiInlineButton, AiInlineErrorLine, AiInlineLoading, AiInlinePrivacy } from '~/components/aiInline/AiInlineParts'
import { inlineError, proofreadDoc, type ProofItem } from '~/utils/aiInline'
import { docText, locate, proofKey, proofreadPlugin } from '~/utils/proofreadPm'

interface ProofStore {
  open: boolean
  loading: boolean
  error: string
  mode: 'all' | 'style'
  items: ProofItem[]
  active: number
  model: string
  /** 1회 이상 실행 여부(결과 0개 안내용) */
  ran: boolean
}
const initial: ProofStore = { open: false, loading: false, error: '', mode: 'all', items: [], active: 0, model: '', ran: false }
export const proofStore = createStore<ProofStore>()(() => ({ ...initial }))
let seq = 0
let pluginEditor: Editor | null = null

function sync(editor: Editor | null) {
  if (!editor || editor.isDestroyed) return
  const { items, active } = proofStore.getState()
  editor.view.dispatch(editor.state.tr.setMeta(proofKey, { items, active }))
}

function ensurePlugin(editor: Editor) {
  if (pluginEditor === editor && proofKey.getState(editor.state)) return
  if (pluginEditor && !pluginEditor.isDestroyed) pluginEditor.unregisterPlugin(proofKey)
  editor.registerPlugin(proofreadPlugin((i) => { proofStore.setState({ active: i, open: true }); sync(editor) }))
  pluginEditor = editor
}

export function resetProofread() {
  seq++
  if (pluginEditor && !pluginEditor.isDestroyed) pluginEditor.unregisterPlugin(proofKey)
  pluginEditor = null
  proofStore.setState({ ...initial })
}

export async function runProofread(editor: Editor | null, mode: 'all' | 'style', title: string | undefined, failed: string) {
  if (!editor || editor.isDestroyed) return
  const my = ++seq
  ensurePlugin(editor)
  proofStore.setState({ open: true, loading: true, error: '', mode, items: [], active: 0 })
  sync(editor)
  try {
    const res = await proofreadDoc({ text: docText(editor.state.doc).text, mode, title: title || undefined })
    if (my !== seq) return
    proofStore.setState({ loading: false, items: res.items, active: 0, model: res.model, ran: true })
  } catch (e) {
    if (my !== seq) return
    proofStore.setState({ loading: false, error: inlineError(e, failed).message })
  }
  sync(editor)
}

function removeAt(i: number) {
  const s = proofStore.getState()
  const items = s.items.filter((_, j) => j !== i)
  proofStore.setState({ items, active: Math.min(i, Math.max(0, items.length - 1)) })
}

/** 바꾸기 — 성공 시 true(구절을 찾지 못하면 false) */
export function applyProof(editor: Editor | null, i: number): boolean {
  if (!editor || editor.isDestroyed) return false
  const { items } = proofStore.getState()
  const r = locate(editor.state.doc, items)[i]
  if (!r) return false
  const fixed = items[i].fixed
  removeAt(i)
  editor.view.dispatch(editor.state.tr.insertText(fixed, r.from, r.to).setMeta(proofKey, { items: proofStore.getState().items, active: proofStore.getState().active }))
  return true
}

/** 모두 바꾸기 — 뒤에서부터 단일 트랜잭션으로 적용. 변경 건수 반환 */
export function applyAllProof(editor: Editor | null): number {
  if (!editor || editor.isDestroyed) return 0
  const { items } = proofStore.getState()
  const ranges = locate(editor.state.doc, items)
  const order = ranges.map((r, i) => ({ r, i })).filter(x => x.r).sort((a, b) => b.r!.from - a.r!.from)
  let tr = editor.state.tr
  let lastFrom = Infinity
  let n = 0
  for (const { r, i } of order) {
    if (r!.to > lastFrom) continue   // 겹치는 제안은 생략
    tr = tr.insertText(items[i].fixed, r!.from, r!.to)
    lastFrom = r!.from
    n++
  }
  proofStore.setState({ items: [], active: 0 })
  editor.view.dispatch(tr.setMeta(proofKey, { items: [], active: 0 }))
  return n
}

// ─── 머리 버튼 ───────────────────────────────────────────
export function WikiProofreadButtons({ editor, title }: { editor: Editor | null; title?: string }) {
  const { t } = useI18n()
  const { status } = useAiInline()
  const { loading, items, ran, mode } = useStore(proofStore)
  // 편집기 변경 또는 편집 종료 시 초기화
  useEffect(() => () => resetProofread(), [editor])
  const count = ran && mode === 'all' ? items.length : null
  return (
    <>
      <AiInlineButton status={status} busy={loading} variant="secondary" size="xs" icon="wand" disabled={!editor} onClick={() => { void runProofread(editor, 'all', title, t('aiInline.failed')) }}>
        {t('aiInline.doc.proofread')}{count !== null && <span className="ml-1 font-mono">{count}</span>}
      </AiInlineButton>
      <AiInlineButton status={status} busy={loading} variant="ghost" size="xs" icon="type" disabled={!editor} onClick={() => { void runProofread(editor, 'style', title, t('aiInline.failed')) }}>
        {t('aiInline.doc.style')}
      </AiInlineButton>
    </>
  )
}

// ─── 제안 카드 ───────────────────────────────────────────
export function WikiProofreadCard({ editor, title }: { editor: Editor | null; title?: string }) {
  const { t } = useI18n()
  const { status } = useAiInline()
  const { open, loading, error, items, active, mode, ran } = useStore(proofStore)
  if (!open) return null
  const it = items[active]
  function go(d: number) {
    if (!items.length) return
    proofStore.setState({ active: (active + d + items.length) % items.length })
    sync(editor)
  }
  function apply() {
    if (!applyProof(editor, active)) addToast('warning', t('aiInline.doc.notFound'))
  }
  function ignore() { removeAt(active); sync(editor) }
  function applyAll() {
    const n = applyAllProof(editor)
    if (n) addToast('success', t('aiInline.doc.applied', { n }))
  }
  return (
    <div role="region" aria-label={t('aiInline.doc.region')} className="sticky bottom-4 z-10 mt-6 flex flex-col gap-2 rounded-[10px] border border-border bg-popover px-3.5 py-3 shadow-lg">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <UiIcon name="wand" className="h-3.5 w-3.5 text-primary" />
        <span className="flex-1">
          {it
            ? <>{t(`aiInline.doc.kind.${it.kind}`)} · <span className="font-mono">{active + 1}/{items.length}</span></>
            : t(mode === 'style' ? 'aiInline.doc.titleStyle' : 'aiInline.doc.title')}
        </span>
        {items.length > 1 && (
          <>
            <UiIconButton label={t('aiInline.doc.prev')} icon="chevron-left" size="sm" variant="ghost" onClick={() => go(-1)} />
            <UiIconButton label={t('aiInline.doc.next')} icon="chevron-right" size="sm" variant="ghost" onClick={() => go(1)} />
          </>
        )}
        <UiIconButton label={t('aiInline.doc.close')} icon="close" size="sm" variant="ghost" onClick={resetProofread} />
      </div>
      <AiInlinePrivacy status={status} />
      {error
        ? <AiInlineErrorLine message={error} onRetry={() => { void runProofread(editor, mode, title, t('aiInline.failed')) }} />
        : loading
          ? <AiInlineLoading label={t('aiInline.doc.loading')} rows={2} />
          : it
            ? (
              <>
                <span className="text-[13.5px] leading-[21px]">
                  <del className="text-muted-foreground">{it.original}</del> → <ins className="text-success no-underline">{it.fixed}</ins>
                </span>
                {it.reason && <span className="text-xs text-muted-foreground">{it.reason}</span>}
                <div className="flex gap-1.5">
                  <UiButton size="xs" icon="check" onClick={apply}>{t('aiInline.doc.apply')}</UiButton>
                  <UiButton size="xs" variant="ghost" onClick={ignore}>{t('aiInline.doc.ignore')}</UiButton>
                  <span className="flex-1" />
                  {items.length > 1 && <UiButton size="xs" variant="outline" onClick={applyAll}>{t('aiInline.doc.applyAll')}</UiButton>}
                </div>
                <p className="m-0 text-[11.5px] text-muted-foreground">{t('aiInline.doc.legend')}</p>
              </>
            )
            : <p role="status" className="m-0 text-[13px] text-muted-foreground">{ran ? t('aiInline.doc.none') : ''}</p>}
    </div>
  )
}
