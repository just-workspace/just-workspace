/**
 * 위키 페이지 트리 노드(시안 WK1·WM1, 06-2 결정 2·5) — Vue 판 components/wiki/WikiPageTreeNode.vue 이식.
 *  데스크톱 — 행 32, 들여쓰기 16, 셰브런 16, 선택 = primary/13 + 600, 선택·hover 때 +(하위 페이지)·⋯(메뉴) 24(히트 32).
 *  모바일   — 행 48, 들여쓰기 20, 셰브런 32×40(히트 40), ⋮ 40 상시.
 *  새 페이지는 모달 없이 트리 안 인라인 입력 행(Enter 만들기 / Esc 취소). 이름 바꾸기도 같은 행 안에서.
 *  끌어서 재정렬: 위 25% = 앞에, 아래 25% = 뒤에, 가운데 = 하위로.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import type { WikiPageNode } from '~/composables/useWiki'
import { UiIcon } from '~/components/ui/Icon'

export type TreeNode = WikiPageNode & { children: TreeNode[] }
export type DropPosition = 'before' | 'after' | 'inside'

export interface WikiPageTreeNodeProps {
  node: TreeNode
  selectedId: string | undefined
  depth: number
  mobile?: boolean
  /** 쓰기 권한 — 없으면 +·⋯·끌기 없음 */
  canWrite?: boolean
  /** 인라인 새 페이지 행을 띄울 부모 id(이 노드면 첫 자식 자리에) */
  draftParentId?: string | null
  /** 이름 바꾸는 중인 노드 id */
  renamingId?: string | null
  onSelect?: (id: string) => void
  onAddChild?: (id: string) => void
  onMenu?: (node: TreeNode, ev: MouseEvent<HTMLElement>) => void
  onRename?: (id: string, title: string) => void
  onCancelRename?: () => void
  onCreateDraft?: (parentId: string | null, title: string) => void
  onCancelDraft?: () => void
  onMove?: (payload: { id: string; targetId: string; position: DropPosition }) => void
}

/** 트리 노드 한 개(하위는 재귀). */
export function WikiPageTreeNode(props: WikiPageTreeNodeProps) {
  const {
    node, selectedId, depth, mobile = false, canWrite = false, draftParentId = null, renamingId = null,
    onSelect, onAddChild, onMenu, onRename, onCancelRename, onCreateDraft, onCancelDraft, onMove,
  } = props
  const { t } = useI18n()

  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children?.length > 0
  const selected = selectedId === node.id
  const showDraft = draftParentId === node.id
  const renaming = renamingId === node.id

  // 인라인 입력(새 페이지·이름 바꾸기)
  const [draftTitle, setDraftTitle] = useState('')
  const [renameTitle, setRenameTitle] = useState('')
  const draftInput = useRef<HTMLInputElement | null>(null)
  const renameInput = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (showDraft) { setExpanded(true); setDraftTitle(''); requestAnimationFrame(() => draftInput.current?.focus()) }
  }, [showDraft])
  useEffect(() => {
    if (renaming) { setRenameTitle(node.title); requestAnimationFrame(() => renameInput.current?.select()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming])
  // blur 와 Enter 가 겹칠 때 지금 값을 읽는다
  const draftRef = useRef(draftTitle); draftRef.current = draftTitle
  const renameRef = useRef(renameTitle); renameRef.current = renameTitle
  function submitDraft() { const v = draftRef.current.trim(); if (v) onCreateDraft?.(node.id, v); else onCancelDraft?.() }
  function submitRename() { const v = renameRef.current.trim(); if (v && v !== node.title) onRename?.(node.id, v); else onCancelRename?.() }

  // 끌어서 재정렬
  const [dropPos, setDropPos] = useState<DropPosition | null>(null)
  function onDragStart(e: DragEvent<HTMLDivElement>) {
    if (!canWrite) { e.preventDefault(); return }
    e.dataTransfer?.setData('text/wiki-page', node.id)
    e.dataTransfer!.effectAllowed = 'move'
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!canWrite || !e.dataTransfer?.types.includes('text/wiki-page')) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    setDropPos(y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside')
  }
  function onDragLeave() { setDropPos(null) }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    const id = e.dataTransfer?.getData('text/wiki-page')
    const pos = dropPos
    setDropPos(null)
    if (!id || !pos || id === node.id) return
    e.preventDefault()
    onMove?.({ id, targetId: node.id, position: pos })
  }

  function onRowKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return   // .self
    if (e.key === 'Enter') onSelect?.(node.id)
    else if (e.key === 'ArrowRight') setExpanded(true)
    else if (e.key === 'ArrowLeft') setExpanded(false)
  }

  const indent = depth * (mobile ? 20 : 16)

  return (
    <div role="none">
      {/* 행 */}
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-level={depth + 1}
        tabIndex={0}
        draggable={canWrite && !mobile && !renaming}
        className={cn(
          'group relative flex cursor-pointer select-none items-center rounded-sm outline-hidden transition-colors focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))]',
          mobile ? 'h-12 gap-1.5 pl-2 pr-1 text-[15px]' : 'h-8 gap-1 px-1 text-[13.5px]',
          selected ? 'bg-primary/[0.13] font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
          dropPos === 'inside' ? 'shadow-[inset_0_0_0_2px_hsl(var(--primary))]' : '',
          dropPos === 'before' ? 'shadow-[inset_0_2px_0_hsl(var(--primary))]' : '',
          dropPos === 'after' ? 'shadow-[inset_0_-2px_0_hsl(var(--primary))]' : '',
        )}
        onClick={() => onSelect?.(node.id)}
        onKeyDown={onRowKey}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {indent ? <span className="shrink-0" style={{ width: `${indent}px` }} aria-hidden="true" /> : null}

        {/* 펼침/접힘: 시각 16(모바일 32×40), 히트는 모바일 40 */}
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? t('wiki.tree.collapse') : t('wiki.tree.expand')}
            className={cn('grid shrink-0 place-items-center text-muted-foreground', mobile ? 'h-10 w-8' : 'h-6 w-4')}
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          >
            <UiIcon name={expanded ? 'chevron-down' : 'chevron-right'} className={mobile ? 'h-4 w-4' : 'h-3 w-3'} strokeWidth={2.4} />
          </button>
        ) : (
          <span className={cn('shrink-0', mobile ? 'w-8' : 'w-4')} aria-hidden="true" />
        )}

        {/* 제목 / 이름 바꾸기 */}
        {renaming ? (
          <input
            ref={renameInput}
            value={renameTitle}
            onChange={e => setRenameTitle(e.target.value)}
            type="text"
            aria-label={t('wiki.tree.pageName')}
            className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1.5 text-[13.5px] font-normal text-foreground outline-hidden ring-2 ring-ring/35"
            onClick={e => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitRename() }
              else if (e.key === 'Escape') { e.preventDefault(); onCancelRename?.() }
            }}
            onBlur={submitRename}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
        )}

        {node.is_pinned && !renaming && <UiIcon name="star" filled className="h-3 w-3 shrink-0 text-primary" aria-label={t('wiki.tree.pinned')} />}

        {/* 데스크톱: 선택·hover 때 + ⋯ (24, 히트 32) */}
        {!mobile && canWrite && !renaming ? (
          <>
            <button
              type="button"
              aria-label={t('wiki.tree.addChild')}
              className={cn("relative grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-muted-foreground opacity-0 transition-opacity before:absolute before:-inset-1 before:content-[''] hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100", selected ? 'opacity-100' : '')}
              onClick={(e) => { e.stopPropagation(); onAddChild?.(node.id) }}
            ><UiIcon name="plus" className="h-3.5 w-3.5" strokeWidth={2.4} /></button>
            <button
              type="button"
              aria-label={t('wiki.tree.menuLabel')}
              aria-haspopup="menu"
              className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100', selected ? 'opacity-100' : '')}
              onClick={(e) => { e.stopPropagation(); onMenu?.(node, e) }}
            ><UiIcon name="more-horizontal" className="h-3.5 w-3.5" /></button>
          </>
        ) : mobile && canWrite ? (
          /* 모바일: ⋮ 40 상시 */
          <button
            type="button"
            aria-label={t('wiki.tree.nodeMenu', { name: node.title })}
            aria-haspopup="menu"
            className="grid h-10 w-10 shrink-0 place-items-center text-muted-foreground"
            onClick={(e) => { e.stopPropagation(); onMenu?.(node, e) }}
          ><UiIcon name="more-vertical" className="h-[18px] w-[18px]" /></button>
        ) : null}
      </div>

      {/* 인라인 새 페이지 행(이 노드의 첫 자식 자리) */}
      {showDraft && (
        <div className={cn('flex items-center gap-1 rounded-sm', mobile ? 'h-12 pl-2 pr-1' : 'h-8 px-1')}>
          <span className="shrink-0" style={{ width: `${indent + (mobile ? 20 : 16)}px` }} aria-hidden="true" />
          <span className={cn('shrink-0', mobile ? 'w-8' : 'w-4')} aria-hidden="true" />
          <input
            ref={draftInput}
            value={draftTitle}
            onChange={e => setDraftTitle(e.target.value)}
            type="text"
            aria-label={t('wiki.tree.newTitle')}
            placeholder={t('wiki.tree.newTitle')}
            className="h-7 min-w-0 flex-1 rounded-sm border border-ring bg-background px-2 text-[13.5px] text-foreground outline-hidden ring-2 ring-ring/35 placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitDraft() }
              else if (e.key === 'Escape') { e.preventDefault(); onCancelDraft?.() }
            }}
            onBlur={submitDraft}
          />
        </div>
      )}

      {/* 하위 */}
      {hasChildren && expanded && (
        <div role="group">
          {node.children.map(child => (
            <WikiPageTreeNode
              key={child.id}
              {...props}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default WikiPageTreeNode
