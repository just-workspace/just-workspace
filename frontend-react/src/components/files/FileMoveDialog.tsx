/**
 * 이동·복사: UiModal "N개 항목 이동",
 * 폴더 찾기(36) + 트리(300, 행 34, 들여쓰기 18, ▾/▸ 12, 폴더 아이콘 warning 15, 선택 primary/13 + 600) +
 * 푸터 "+ 새 폴더" · [복사] · ["폴더명"로 이동].
 * 루트: 내 파일 · 공유 파일. 하위 폴더는 펼칠 때 불러온다. 모바일은 UiModal 전체 화면 시트(mobile="full"), 데스크톱 480.
 * roots 를 주면 그 루트만(공동 소유자가 공유받은 항목을 옮길 때 = 그 공유 폴더 안).
 *
 * 트리 노드는 객체를 제자리에서 고치고(open·loaded·children) 다시 그리기만 알린다(bump).
 */
import { Fragment, useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { useFiles, type FileItem } from '~/composables/useFiles'
import { useToast } from '~/composables/useToast'
import { canMoveInto, isComposingKey, ROOT_LABELS } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { FilesFileTypeIcon } from './FileTypeIcon'

export interface FilesFileMoveDialogProps {
  /** 옮길 경로들 */
  paths: string[]
  /** 루트 제한(공유받은 항목 = 그 공유 폴더) */
  roots?: { path: string; name: string }[]
  onClose?: () => void
  /** 이동·복사를 마쳤다(실패가 있어도) */
  onDone?: () => void
}

interface Node { path: string; name: string; depth: number; open: boolean; loaded: boolean; loading: boolean; children: Node[] }

const mk = (path: string, name: string, depth: number): Node => ({ path, name, depth, open: false, loaded: false, loading: false, children: [] })

export function FilesFileMoveDialog({ paths, roots: rootsProp, onClose, onDone }: FilesFileMoveDialogProps) {
  const { listFolders, moveItems, mkdirAt, currentPath } = useFiles()
  const { toast, addToast } = useToast()
  const { t } = useI18n()
  const [, bump] = useReducer((x: number) => x + 1, 0)

  const roots = useRef<Node[]>(rootsProp?.length
    ? rootsProp.map(r => mk(r.path, r.name, 0))
    : [mk('my', t(ROOT_LABELS.my), 0), mk('shared', t(ROOT_LABELS.shared), 0)])
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  async function load(n: Node) {
    if (n.loaded || n.loading) return
    n.loading = true
    bump()
    try {
      const dirs = await listFolders(n.path)
      n.children = dirs.map((d: FileItem) => mk(d.path, d.name, n.depth + 1))
      n.loaded = true
    } catch {
      n.children = []
    } finally {
      n.loading = false
      bump()
    }
  }
  async function toggle(n: Node) {
    n.open = !n.open
    bump()
    if (n.open) await load(n)
  }

  // 현재 폴더까지 미리 펼친다
  useEffect(() => {
    void (async () => {
      // 루트를 따로 받았으면 옮길 항목의 상위 폴더까지, 아니면 현재 폴더까지
      const start = rootsProp?.length ? (paths[0] || '').split('/').slice(0, -1).join('/') : (currentPath || 'my')
      // 루트 경로가 여러 조각(shared-with-me/<id>)일 수 있어 루트부터 한 단계씩 앞부분을 만든다
      const base = roots.current.find(r => start === r.path || start.startsWith(`${r.path}/`))?.path ?? start.split('/')[0]
      const rest = start.slice(base.length).split('/').filter(Boolean)
      const prefixes = [base, ...rest.map((_, i) => `${base}/${rest.slice(0, i + 1).join('/')}`)]
      let list = roots.current
      for (const p of prefixes) {
        const n = list.find(x => x.path === p)
        if (!n) break
        n.open = true
        bump()
        await load(n)
        list = n.children
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const visible: Node[] = []
  {
    const f = filter.trim().toLowerCase()
    const walk = (ns: Node[]) => {
      for (const n of ns) {
        if (!f || n.name.toLowerCase().includes(f)) visible.push(n)
        if (n.open || f) walk(n.children)
      }
    }
    walk(roots.current)
  }

  function allowed(p: string) { return canMoveInto(paths, p) }
  const selectedName = !selected ? '' : (visible.find(n => n.path === selected)?.name ?? selected.split('/').pop() ?? '')

  // "+ 새 폴더" — 고른 폴더(없으면 내 파일) 아래 인라인 입력 행
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState(t('files.commandBar.newFolder'))
  const newInput = useRef<HTMLInputElement | null>(null)
  const focusNew = useRef(false)
  const newParent = selected ?? roots.current[0]?.path ?? 'my'
  function findNode(path: string, ns: Node[] = roots.current): Node | null {
    for (const n of ns) {
      if (n.path === path) return n
      const c = findNode(path, n.children)
      if (c) return c
    }
    return null
  }
  function startNew() {
    setCreating(true)
    setNewName(t('files.commandBar.newFolder'))
    const parent = findNode(newParent)
    if (parent && !parent.open) toggle(parent)
    focusNew.current = true
  }
  // nextTick(focus + select)
  useEffect(() => {
    if (!focusNew.current || !newInput.current) return
    focusNew.current = false
    newInput.current.focus()
    newInput.current.select()
  })
  const committingNew = useRef(false)
  async function commitNew() {
    // Enter 뒤 입력이 사라지며 blur 가 한 번 더 올 수 있다
    if (committingNew.current || !creating) return
    committingNew.current = true
    const name = newName.trim()
    setCreating(false)
    try {
      if (!name) return
      const path = `${newParent}/${name}`
      try {
        await mkdirAt(path)
        const parent = findNode(newParent)
        if (parent) { parent.loaded = false; await load(parent); parent.open = true; bump() }
        setSelected(path)
      } catch (e: any) {
        addToast('error', e?.data?.detail || t('files.move.mkdirError'))
      }
    } finally {
      committingNew.current = false
    }
  }

  const [busy, setBusy] = useState(false)
  async function run(copy: boolean) {
    const dst = selected
    if (!dst || busy) return
    if (!copy && !allowed(dst)) return
    setBusy(true)
    try {
      const failed = await moveItems(paths, dst, copy)
      const name = selectedName
      if (failed.length) addToast('error', t(copy ? 'files.move.copyFailed' : 'files.move.moveFailed', { n: failed.length, list: failed.join(', ') }))
      else toast({ type: 'success', title: copy ? t('files.move.copied', { name }) : t('files.move.moved', { name }) })
      onDone?.()
      onClose?.()
    } finally {
      setBusy(false)
    }
  }

  function onTreeKey(e: KeyboardEvent<HTMLDivElement>, n: Node, i: number) {
    const rows = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[i + 1]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[i - 1]?.focus() }
    else if (e.key === 'ArrowRight' && !n.open) { e.preventDefault(); toggle(n) }
    else if (e.key === 'ArrowLeft' && n.open) { e.preventDefault(); toggle(n) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(n.path) }
  }

  return (
    <UiModal
      title={t('files.move.title', { n: paths.length })}
      size="480"
      mobile="full"
      onClose={() => onClose?.()}
      footer={(
        <>
          <button type="button" className="mr-auto text-xs font-semibold text-primary hover:underline" onClick={startNew}>+ {t('files.commandBar.newFolder')}</button>
          <UiButton variant="outline" size="sm" disabled={!selected || busy} onClick={() => run(true)}>{t('common.copy')}</UiButton>
          <UiButton size="sm" disabled={!selected || !allowed(selected) || busy} className="max-w-[220px]" onClick={() => run(false)}>
            <span className="truncate">{selected ? t('files.move.moveTo', { name: selectedName }) : t('common.move')}</span>
          </UiButton>
        </>
      )}
    >
      <div className="-mx-2 -mt-2 flex min-h-0 flex-1 flex-col gap-2 sm:flex-none">
        <div className="relative">
          <UiIcon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            type="search"
            autoComplete="off"
            aria-label={t('files.move.findFolder')}
            placeholder={t('files.move.findFolder')}
            className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2.5 text-xs outline-hidden focus:border-ring focus:ring-2 focus:ring-ring/35"
          />
        </div>

        <div role="tree" aria-label={t('files.detail.folder')} className="min-h-0 flex-1 overflow-y-auto text-[13px] sm:h-[300px] sm:flex-none">
          {visible.map((n, i) => (
            <Fragment key={n.path}>
              <div
                role="treeitem"
                aria-expanded={n.open}
                aria-selected={selected === n.path}
                aria-disabled={!allowed(n.path) || undefined}
                tabIndex={(selected ? selected === n.path : i === 0) ? 0 : -1}
                className={clsx(
                  'flex h-[34px] cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))]',
                  selected === n.path ? 'bg-primary/[0.13] font-semibold' : 'hover:bg-accent/40',
                  !allowed(n.path) && selected !== n.path ? 'text-muted-foreground' : '',
                )}
                style={{ paddingLeft: `${10 + n.depth * 18}px` }}
                onClick={() => setSelected(n.path)}
                onDoubleClick={() => toggle(n)}
                onKeyDown={e => onTreeKey(e, n, i)}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={n.open ? t('files.transfer.collapse') : t('files.transfer.expand')}
                  className="relative grid h-3 w-3 shrink-0 place-items-center text-muted-foreground before:absolute before:-inset-3 before:content-['']"
                  onClick={(e) => { e.stopPropagation(); toggle(n) }}
                >
                  <UiIcon name={n.open ? 'chevron-down' : 'chevron-right'} className="h-3 w-3" strokeWidth={2.6} />
                </button>
                <FilesFileTypeIcon kind="folder" className="h-[15px] w-[15px]" />
                <span className="truncate">{n.name}</span>
                {n.loading && <span className="text-[11px] text-muted-foreground">…</span>}
              </div>
              {/* 새 폴더 입력 행(고른 폴더 바로 아래) */}
              {creating && n.path === newParent && (
                <div className="flex h-[34px] items-center gap-2 px-2.5" style={{ paddingLeft: `${10 + (n.depth + 1) * 18 + 20}px` }}>
                  <FilesFileTypeIcon kind="folder" className="h-[15px] w-[15px]" />
                  <input
                    ref={newInput}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    aria-label={t('files.list.newFolderName')}
                    autoComplete="off"
                    className="h-7 min-w-0 flex-1 rounded-[6px] border border-ring bg-background px-2 text-[13px] outline-hidden"
                    onKeyDown={(e) => {
                      if (isComposingKey(e)) return
                      if (e.key === 'Enter') { e.preventDefault(); commitNew() }
                      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreating(false) }
                    }}
                    onBlur={commitNew}
                  />
                </div>
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </UiModal>
  )
}

export default FilesFileMoveDialog
