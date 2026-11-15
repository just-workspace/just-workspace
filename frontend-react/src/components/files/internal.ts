/**
 * 파일 목록·그리드가 함께 쓰는 행 동작(Vue FileList.vue · FileGridView.vue 에 같은 코드로 두 번 있던 것을 한 곳에).
 * 동작은 Vue 와 같다:
 *  - 인라인 편집(새 폴더·이름 바꾸기): inlineEdit 가 바뀌면 이름을 채우고 포커스 + 이름 부분(확장자 제외) 선택. Enter/blur = 확정, Esc = 취소.
 *  - 길게 누르기(터치 500ms, 8px 넘게 움직이면 취소) = 선택 모드 진입, 직후 클릭 한 번은 무시.
 *  - 앱 안 끌기(DRAG_MIME): 선택된 행을 끌면 선택 전체, 아니면 그 행. 폴더 행에만 놓기.
 */
import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { getSharedState, setSharedState } from '~/lib/state'
import { canMoveInto, DRAG_MIME } from '~/lib/files'
import { filesStore, setInlineEdit, toggleSelect, type FileItem } from '~/composables/useFiles'

/** 끌고 있는 경로(목록·그리드·사이드바가 함께 본다 — Vue useState('files-dragging')) */
const DRAGGING = 'files-dragging'
const dragging = () => getSharedState<string[]>(DRAGGING, () => [])

export function useInlineEdit(opts: {
  sortedItems: FileItem[]
  onCommitNewFolder?: (name: string) => void
  onCommitRename?: (item: FileItem, name: string) => void
}) {
  const { t } = useI18n()
  const [editName, setEditName] = useState('')
  const editInput = useRef<HTMLInputElement | null>(null)
  const committing = useRef(false)
  const pendingSelect = useRef<{ dot: number; name: string } | null>(null)
  const items = useRef(opts.sortedItems)
  items.current = opts.sortedItems
  const cb = useRef(opts)
  cb.current = opts

  // watch(inlineEdit, …, { immediate: true })
  const cur = useStore(filesStore, s => s.inlineEdit)
  useEffect(() => {
    const v = cur
    if (!v) return
    committing.current = false
    const name = v.kind === 'new-folder' ? t('files.commandBar.newFolder') : (items.current.find(i => i.path === v.path)?.name ?? '')
    setEditName(name)
    // 이름만 선택(확장자 제외) — 탐색기 관례
    const dot = v.kind === 'rename' ? name.lastIndexOf('.') : -1
    pendingSelect.current = { dot: dot > 0 ? dot : name.length, name }
  }, [cur]) // eslint-disable-line react-hooks/exhaustive-deps
  // nextTick(focus + select)
  useEffect(() => {
    const p = pendingSelect.current
    const el = editInput.current
    // 새 이름이 입력에 반영된 뒤(Vue nextTick)에 고른다
    if (!p || !el || el.value !== p.name) return
    pendingSelect.current = null
    el.focus()
    el.setSelectionRange(0, p.dot)
  })

  function commitEdit() {
    const v = filesStore.getState().inlineEdit
    if (!v || committing.current) return
    committing.current = true
    const name = editName.trim()
    if (!name) { setInlineEdit(null); return }
    if (v.kind === 'new-folder') cb.current.onCommitNewFolder?.(name)
    else {
      const item = items.current.find(i => i.path === v.path)
      if (item && name !== item.name) cb.current.onCommitRename?.(item, name)
      else setInlineEdit(null)
    }
  }
  function cancelEdit() { committing.current = true; setInlineEdit(null) }
  function setEditInput(el: HTMLInputElement | null) { if (el) editInput.current = el }
  function isRenaming(item: FileItem) { return cur?.kind === 'rename' && cur.path === item.path }

  return { inlineEdit: cur, editName, setEditName, commitEdit, cancelEdit, setEditInput, isRenaming }
}

export function useLongPress(onToggle: (item: FileItem) => void) {
  const suppressClick = useRef(false)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressStart = useRef<{ x: number; y: number } | null>(null)
  const toggle = useRef(onToggle)
  toggle.current = onToggle

  function cancelPress() { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null } }
  function onPointerDown(e: PointerEvent, item: FileItem) {
    if (e.pointerType === 'mouse') return
    pressStart.current = { x: e.clientX, y: e.clientY }
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      suppressClick.current = true
      if (!filesStore.getState().selectedItems.has(item.path)) toggle.current(item)
      if (navigator.vibrate) navigator.vibrate(10)
    }, 500)
  }
  function onPointerMove(e: PointerEvent) {
    if (!pressTimer.current || !pressStart.current) return
    if (Math.abs(e.clientX - pressStart.current.x) > 8 || Math.abs(e.clientY - pressStart.current.y) > 8) cancelPress()
  }
  /** 클릭 처리 맨 앞에서 — 길게 누른 직후 클릭이면 true(그 클릭은 무시) */
  function consumeSuppressed() {
    if (suppressClick.current) { suppressClick.current = false; return true }
    return false
  }
  useEffect(() => () => cancelPress(), [])
  return { onPointerDown, onPointerMove, cancelPress, consumeSuppressed }
}

export function useRowDrag(onDropMove?: (paths: string[], dst: string) => void) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const cb = useRef(onDropMove)
  cb.current = onDropMove
  function onDragStart(e: DragEvent, item: FileItem) {
    const sel = filesStore.getState().selectedItems
    const paths = sel.has(item.path) ? [...sel] : [item.path]
    setSharedState(DRAGGING, paths)
    e.dataTransfer?.setData(DRAG_MIME, JSON.stringify(paths))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'
  }
  function onDragEnd() { setSharedState(DRAGGING, []); setDropTarget(null) }
  function onDragOver(e: DragEvent, item: FileItem) {
    if (!item.is_dir || !e.dataTransfer?.types.includes(DRAG_MIME)) return
    if (!canMoveInto(dragging(), item.path)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(item.path)
  }
  function onDrop(e: DragEvent, item: FileItem) {
    setDropTarget(null)
    if (!item.is_dir || !e.dataTransfer?.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    try {
      const paths = JSON.parse(e.dataTransfer.getData(DRAG_MIME) || '[]') as string[]
      if (paths.length && canMoveInto(paths, item.path)) cb.current?.(paths, item.path)
    } catch { /* 무시 */ }
  }
  return { dropTarget, setDropTarget, onDragStart, onDragEnd, onDragOver, onDrop }
}

/** 선택 토글 + 범위 기준점 */
export function useToggleWithAnchor() {
  const anchor = useRef<string | null>(null)
  function onToggle(item: FileItem) { toggleSelect(item.path); anchor.current = item.path }
  return { anchor, onToggle }
}

/** 체크박스·⋮ 표시 규칙: hover/포커스, 하나라도 선택되면 상시, 터치(hover 없음)는 상시 */
export function revealClass(anySelected: boolean) {
  return anySelected
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
}
