/**
 * 작업 상세(Vue components/tasks/TasksDetail.vue).
 *  데스크톱 패널: 머리 44(작업 · 링크 복사 · ⋯ 복제·삭제 · ✕) → 제목 17/600 → 속성 격자(80 | 1fr) → 설명 상자 → 하위 작업.
 *  모바일 상세: 제목 20/700 → 상태 세그먼트(40, 균등) → 속성 카드(행 52 + ›) → 하위 작업. 머리 막대는 페이지가 그린다.
 * 상태는 할 일·진행 중·검토·완료(검토 = primary). 우선순위 긴급(↑↑ danger)·높음·보통·낮음.
 * 담당 = "아바타 이름 · 배정 만든 사람"(시안), 누르면 사람 고르기(나에게 배정 · 담당 없음 · 사람들). 바꾸기는 만든 사람만(서버 규칙).
 * 태그 = TasksTagEditor(자동완성 facets). 프로젝트 = 입력 + 자동완성(시안 격자에 없는 행 — 같은 격자 규격으로 덧붙임, 보고서).
 * 페이지는 작업마다 key 로 다시 만든다(Vue :key="selected.id").
 */
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import {
  useTasks, fetchSubtasks, createTask, updateTask, deleteTask, toggleTask, loadUsers, loadFacets, type Task,
} from '~/composables/useTasks'
import { dueLong, PRIORITY_META, PRIORITY_ORDER, ymd, type TaskPriority, type TaskStatus } from '~/utils/taskQuick'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiSegment, type SegmentItem } from '~/components/ui/Segment'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiButton } from '~/components/ui/Button'
import { TasksTagEditor } from './TasksTagEditor'
import { writeClipboard } from '~/lib/clipboard'

export type TaskPatch = Partial<Pick<Task, 'title' | 'description' | 'priority' | 'status' | 'due_date' | 'assignee_id' | 'assignee_name' | 'tags' | 'project'>>

export interface TasksDetailProps {
  task: Task
  className?: string
  /** 속성 바꾸기(페이지가 낙관적 갱신 후 저장) */
  onPatch?: (data: TaskPatch) => void
  onClose?: () => void
  onDuplicate?: () => void
  onRemove?: () => void
  /** 하위 작업 수가 바뀜 → 부모 행 n/m 갱신 */
  onSubtasksChanged?: () => void
}

const TONE_TEXT: Record<string, string> = { danger: 'text-danger', warning: 'text-warning', foreground: 'text-foreground', muted: 'text-muted-foreground' }

type DetailMenu = 'priority' | 'due' | 'more' | 'assignee'

/** 작업 상세 패널(데스크톱 360) · 전체 화면(모바일) */
export function TasksDetail({ task, className, onPatch, onClose, onDuplicate, onRemove, onSubtasksChanged }: TasksDetailProps) {
  const { user } = useAuth()
  const { taskUsers, facets } = useTasks()
  useEffect(() => { void loadUsers(); void loadFacets() }, [])
  const { t } = useI18n()

  // ── 제목·설명: 직접 고치고 벗어나면 저장 ──
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  useEffect(() => { setTitle(task.title) }, [task.title])
  useEffect(() => { setDescription(task.description ?? '') }, [task.description])

  function saveTitle() {
    const v = title.trim()
    if (!v) { setTitle(task.title); return }
    if (v !== task.title) onPatch?.({ title: v })
  }
  function saveDescription() {
    const v = description.trim()
    if (v !== (task.description ?? '')) onPatch?.({ description: v || null })
  }
  function onTitleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 한글 조합 중 Enter 는 글자 확정이다(macOS 는 조합 중에도 key='Enter') — 넘기면 마지막 글자가 남거나 두 번 들어간다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
    if (e.key === 'Escape') { setTitle(task.title); e.currentTarget.blur() }
  }

  // ── 상태 세그먼트 ──
  function setStatus(v: string | number | null) { if (v && v !== task.status) onPatch?.({ status: v as TaskStatus }) }
  // 선택 칸 글자색(시안: 진행 중 = warning · 완료 = success) — UiSegment tone
  const statusItems: SegmentItem[] = [
    { value: 'todo', label: t('tasks.statusLabel.todo') },
    { value: 'in_progress', label: t('tasks.statusInProgress'), tone: 'warning' },
    { value: 'review', label: t('tasks.statusLabel.review'), tone: 'primary' },
    { value: 'done', label: t('tasks.statusDone'), tone: 'success' },
  ]

  // ── 우선순위·마감 메뉴 ──
  const pr = PRIORITY_META[task.priority as TaskPriority] ?? PRIORITY_META.medium
  const due = dueLong(task.due_date, undefined, (k, p) => t(k, p ?? {}))

  const [menu, setMenu] = useState<{ kind: DetailMenu; anchor: DOMRect } | null>(null)
  function openMenu(kind: DetailMenu, e: MouseEvent<HTMLElement>) {
    setMenu({ kind, anchor: e.currentTarget.getBoundingClientRect() })
  }

  // ── 담당 ──
  const myName = user?.display_name || user?.username || t('tasks.detail.me')
  /** 담당자는 만든 사람만 바꿀 수 있다(서버 403). 예전 응답(user_id 없음)은 내 작업으로 본다 */
  const canAssign = !task.user_id || task.user_id === user?.id
  const assigneeName = task.assignee_name || ''
  /** "배정 박준호" — 만든 사람이 담당자와 다를 때만 */
  const assignedBy = (() => {
    const owner = task.user_id
    if (!owner || !task.assignee_id || owner === task.assignee_id) return ''
    if (owner === user?.id) return myName
    const u = taskUsers.find(x => x.id === owner)
    return u ? (u.display_name || u.username) : ''
  })()

  const menuItems: UiMenuItem[] = (() => {
    if (!menu) return []
    if (menu.kind === 'priority') {
      return PRIORITY_ORDER.map(p => ({
        key: p, label: `${PRIORITY_META[p].arrow} ${t(PRIORITY_META[p].labelKey)}`, radio: true, checked: task.priority === p,
      }))
    }
    if (menu.kind === 'assignee') {
      const me = user?.id
      const cur = task.assignee_id ?? null
      const items: UiMenuItem[] = [
        { key: 'me', label: t('tasks.assign.toMe'), icon: 'user', radio: true, checked: !!me && cur === me },
        { key: 'none', label: t('tasks.assign.none'), icon: 'close', radio: true, checked: !cur },
      ]
      const people = taskUsers.filter(u => u.id !== me)
      if (people.length) items.push({ key: 'h-people', label: t('tasks.assign.people'), heading: true, separated: true })
      for (const u of people) items.push({ key: `u:${u.id}`, label: u.display_name || u.username, hint: u.username, radio: true, checked: cur === u.id })
      return items
    }
    if (menu.kind === 'due') {
      return [
        { key: 'today', label: t('common.today'), icon: 'calendar' },
        { key: 'tomorrow', label: t('tasks.due.tomorrow'), icon: 'calendar' },
        { key: 'nextweek', label: t('tasks.due.nextMonday'), icon: 'calendar' },
        { key: 'pick', label: t('tasks.due.pick'), icon: 'edit' },
        { key: 'none', label: t('tasks.due.none'), icon: 'close', separated: true, disabled: !task.due_date },
      ]
    }
    return [
      { key: 'duplicate', label: t('tasks.menu.duplicate'), icon: 'copy' },
      { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true },
    ]
  })()

  const [dateEditing, setDateEditing] = useState(false)
  const dateEditingRef = useRef(false)
  const [dateValue, setDateValue] = useState('')

  function onMenuSelect(key: string) {
    const kind = menu?.kind
    if (kind === 'priority') { if (key !== task.priority) onPatch?.({ priority: key as TaskPriority }); return }
    if (kind === 'assignee') { assign(key); return }
    if (kind === 'due') {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const add = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return ymd(d) }
      if (key === 'today') onPatch?.({ due_date: add(0) })
      else if (key === 'tomorrow') onPatch?.({ due_date: add(1) })
      else if (key === 'nextweek') onPatch?.({ due_date: add(7 - ((today.getDay() + 6) % 7)) })
      else if (key === 'none') onPatch?.({ due_date: null })
      else if (key === 'pick') {
        setDateValue(task.due_date ? task.due_date.slice(0, 10) : '')
        dateEditingRef.current = true
        setDateEditing(true)
      }
      return
    }
    if (key === 'duplicate') onDuplicate?.()
    if (key === 'delete') onRemove?.()
  }
  /** v = 지금 입력 값(change 이벤트는 상태 반영 전에 온다) */
  function commitDate(v: string) {
    if (!dateEditingRef.current) return
    dateEditingRef.current = false
    setDateEditing(false)
    if ((v || null) !== (task.due_date ? task.due_date.slice(0, 10) : null)) onPatch?.({ due_date: v || null })
  }

  async function copyLink() {
    try {
      await writeClipboard(`${window.location.origin}/tasks?task=${task.id}`)
      addToast('success', t('tasks.toast.linkCopied'))
    } catch { addToast('error', t('common.copyFailed')) }
  }

  function assign(key: string) {
    const me = user
    let id: string | null = null
    let name: string | null = null
    if (key === 'me' && me) { id = me.id; name = myName }
    else if (key.startsWith('u:')) {
      const u = taskUsers.find(x => x.id === key.slice(2))
      if (!u) return
      id = u.id; name = u.display_name || u.username
    }
    if (id === (task.assignee_id ?? null)) return
    onPatch?.({ assignee_id: id, assignee_name: name })
  }
  function openAssignee(e: MouseEvent<HTMLElement>) {
    if (!canAssign) { addToast('info', t('tasks.assign.ownerOnly')); return }
    openMenu('assignee', e)
  }

  // ── 태그 · 프로젝트 ──
  const tags = task.tags ?? []
  function commitTags(next: string[]) { onPatch?.({ tags: next }) }
  const [project, setProject] = useState(task.project ?? '')
  useEffect(() => { setProject(task.project ?? '') }, [task.project])
  const projectListId = `task-projects-${useId().replace(/:/g, '')}`
  function saveProject() {
    const v = project.trim().slice(0, 100)
    if (v !== (task.project ?? '')) onPatch?.({ project: v || null })
  }
  function onProjectKey(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중 Enter 는 글자 확정이다(macOS 는 조합 중에도 key='Enter') — 넘기면 마지막 글자가 남거나 두 번 들어간다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
    if (e.key === 'Escape') { setProject(task.project ?? ''); e.currentTarget.blur() }
  }

  // ── 하위 작업 ──
  const [subs, setSubs] = useState<Task[]>([])
  const [subsLoading, setSubsLoading] = useState(false)
  const [subsError, setSubsError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newSub, setNewSub] = useState('')
  const [editingSub, setEditingSub] = useState<string | null>(null)
  const [editSubTitle, setEditSubTitle] = useState('')
  const subsRef = useRef<Task[]>([])
  subsRef.current = subs

  async function loadSubs() {
    setSubsLoading(true)
    setSubsError(false)
    try { setSubs(await fetchSubtasks(task.id)) }
    catch { setSubsError(true); setSubs([]) }
    finally { setSubsLoading(false) }
  }
  useEffect(() => { void loadSubs() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const subDone = subs.filter(s => s.status === 'done').length
  const subPct = subs.length ? Math.round(subDone / subs.length * 100) : 0

  const patchSub = (id: string, data: Partial<Task>) => setSubs(list => list.map(x => (x.id === id ? { ...x, ...data } : x)))

  async function toggleSub(s: Task) {
    const prev = s.status
    patchSub(s.id, { status: prev === 'done' ? 'todo' : 'done' })
    try { const saved = await toggleTask(s.id); patchSub(s.id, saved); onSubtasksChanged?.() }
    catch { patchSub(s.id, { status: prev }); addToast('error', t('tasks.toast.subStatusFailed')) }
  }
  async function addSub(e?: FormEvent) {
    e?.preventDefault()
    const v = newSub.trim()
    if (!v) return
    try {
      const created = await createTask({ title: v, parent_id: task.id })
      setSubs(list => [...list, created])
      setNewSub('')
      onSubtasksChanged?.()
    } catch (err: any) { addToast('error', err?.data?.detail || t('tasks.toast.subAddFailed')) }
  }
  function startEditSub(s: Task) { setEditingSub(s.id); setEditSubTitle(s.title) }
  // Enter 로 저장한 뒤 따라오는 blur 가 두 번 저장하지 않게(Vue 는 editingSub=null 로 입력이 사라져 blur 가 안 온다)
  const savingSub = useRef<string | null>(null)
  async function saveSub(s: Task) {
    if (savingSub.current === s.id) return
    savingSub.current = s.id
    const v = editSubTitle.trim()
    setEditingSub(null)
    queueMicrotask(() => { savingSub.current = null })
    if (!v || v === s.title) return
    const prev = s.title
    patchSub(s.id, { title: v })
    try { await updateTask(s.id, { title: v }) }
    catch { patchSub(s.id, { title: prev }); addToast('error', t('tasks.toast.subUpdateFailed')) }
  }
  async function removeSub(s: Task) {
    if (!await confirmBox(t('tasks.confirm.deleteSub', { title: s.title }), { danger: true, confirmLabel: t('common.delete') })) return
    try {
      await deleteTask(s.id)
      setSubs(list => list.filter(x => x.id !== s.id))
      onSubtasksChanged?.()
    } catch { addToast('error', t('tasks.toast.subDeleteFailed')) }
  }
  function onSubKey(e: KeyboardEvent<HTMLInputElement>, s: Task) {
    // 한글 조합 중 Enter 는 글자 확정이다(macOS 는 조합 중에도 key='Enter') — 넘기면 마지막 글자가 남거나 두 번 들어간다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') { e.preventDefault(); void saveSub(s) }
    if (e.key === 'Escape') { savingSub.current = s.id; setEditingSub(null); queueMicrotask(() => { savingSub.current = null }) }
  }

  const projectInputProps = {
    value: project,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setProject(e.target.value),
    list: projectListId,
    autoComplete: 'off',
    maxLength: 100,
    'aria-label': t('tasks.detail.project'),
    placeholder: t('tasks.detail.projectPlaceholder'),
    onKeyDown: onProjectKey,
    onBlur: saveProject,
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-background md:bg-card', className)}>
      {/* 데스크톱 머리 44 */}
      <div className="hidden h-11 shrink-0 items-center gap-1 border-b border-border pl-3.5 pr-1.5 text-xs text-muted-foreground md:flex">
        <span className="flex-1">{t('tasks.task')}</span>
        <UiIconButton label={t('tasks.detail.copyLink')} icon="link" onClick={copyLink} />
        <UiIconButton label={t('tasks.menu.more')} icon="more-horizontal" onClick={e => openMenu('more', e)} />
        <UiIconButton label={t('common.close')} icon="close" onClick={() => onClose?.()} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4 md:gap-3.5">
          {/* 제목 */}
          <textarea
            value={title}
            onChange={e => setTitle(e.target.value)}
            rows={1}
            aria-label={t('tasks.detail.titleLabel')}
            className="-mx-1 resize-none rounded-sm bg-transparent px-1 text-xl font-bold leading-[1.35] text-foreground outline-hidden [field-sizing:content] focus-visible:ring-2 focus-visible:ring-ring/35 md:text-[17px] md:font-semibold md:leading-[1.4]"
            onKeyDown={onTitleKey}
            onBlur={saveTitle}
          />

          {/* 모바일: 상태 세그먼트(균등 40) */}
          <UiSegment modelValue={task.status} onUpdateModelValue={setStatus} items={statusItems} size="lg" grow ariaLabel={t('tasks.filterStatus')} className="md:hidden" />

          {/* 데스크톱: 속성 격자 80 | 1fr */}
          <div className="hidden grid-cols-[80px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-[13px] md:grid">
            <span className="text-muted-foreground">{t('tasks.filterStatus')}</span>
            <UiSegment modelValue={task.status} onUpdateModelValue={setStatus} items={statusItems} ariaLabel={t('tasks.filterStatus')} className="w-max" />

            <span className="text-muted-foreground">{t('tasks.filterPriority')}</span>
            <button type="button" aria-haspopup="menu" className="-mx-1.5 inline-flex h-8 w-max items-center gap-1 rounded-sm px-1.5 font-semibold hover:bg-accent" onClick={e => openMenu('priority', e)}>
              <span className={TONE_TEXT[pr.tone]} aria-hidden="true">{pr.arrow}</span> {t(pr.labelKey)}
              <UiIcon name="chevron-down" className="h-3 w-3 text-muted-foreground" />
            </button>

            <span className="text-muted-foreground">{t('tasks.due.label')}</span>
            <div className="flex items-center gap-2">
              {dateEditing
                ? (
                  <UiInput
                    modelValue={dateValue}
                    onUpdateModelValue={setDateValue}
                    type="date"
                    aria-label={t('tasks.due.dateLabel')}
                    className="w-40"
                    inputClass="h-8"
                    onChange={e => commitDate(e.target.value)}
                    onBlur={e => commitDate(e.target.value)}
                  />
                )
                : (
                  <button type="button" aria-haspopup="menu" className="-mx-1.5 inline-flex h-8 w-max items-center gap-1 rounded-sm px-1.5 hover:bg-accent" onClick={e => openMenu('due', e)}>
                    {due
                      ? <span className={cn('font-mono font-semibold', TONE_TEXT[due.tone])}>{due.text}</span>
                      : <span className="text-muted-foreground">{t('common.none')}</span>}
                    <UiIcon name="chevron-down" className="h-3 w-3 text-muted-foreground" />
                  </button>
                )}
            </div>

            <span className="text-muted-foreground">{t('tasks.detail.assignee')}</span>
            <button
              type="button"
              aria-haspopup="menu"
              className={cn('-mx-1.5 inline-flex h-8 w-max max-w-full items-center gap-1.5 rounded-sm px-1.5 hover:bg-accent', canAssign ? '' : 'cursor-default hover:bg-transparent')}
              aria-label={t('tasks.assign.change', { name: assigneeName || t('tasks.assign.none') })}
              onClick={openAssignee}
            >
              {assigneeName
                ? (
                  <>
                    <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold">{assigneeName.charAt(0)}</span>
                    <span className="truncate">{assigneeName}</span>
                    {assignedBy && <span className="truncate">· <span className="text-muted-foreground">{t('tasks.assign.by', { name: assignedBy })}</span></span>}
                  </>
                )
                : <span className="text-muted-foreground">{t('tasks.assign.none')}</span>}
              {canAssign && <UiIcon name="chevron-down" className="h-3 w-3 shrink-0 text-muted-foreground" />}
            </button>

            <span className="text-muted-foreground">{t('tasks.detail.tags')}</span>
            <TasksTagEditor tags={tags} suggestions={facets.tags} onCommit={commitTags} />

            <span className="text-muted-foreground">{t('tasks.detail.project')}</span>
            <input
              {...projectInputProps}
              className="-mx-1.5 h-8 min-w-0 rounded-sm bg-transparent px-1.5 outline-hidden placeholder:text-muted-foreground hover:bg-accent focus:bg-background focus:ring-2 focus:ring-ring/35"
            />
          </div>
          <datalist id={projectListId}>
            {facets.projects.map(o => <option key={o} value={o} />)}
          </datalist>

          {/* 모바일: 속성 카드(행 52 + ›) */}
          <div className="overflow-hidden rounded-lg border border-border bg-card md:hidden">
            <button type="button" className="flex min-h-[52px] w-full items-center border-b border-border pl-4 pr-3 text-left text-[15px]" onClick={e => openMenu('priority', e)}>
              <span className="w-[84px] text-[13px] text-muted-foreground">{t('tasks.filterPriority')}</span>
              <span className="flex-1 font-medium"><span className={TONE_TEXT[pr.tone]} aria-hidden="true">{pr.arrow}</span> {t(pr.labelKey)}</span>
              <UiIcon name="chevron-right" className="h-4 w-4 text-muted-foreground" />
            </button>
            {dateEditing
              ? (
                <div className="flex min-h-[52px] items-center gap-2 border-b border-border pl-4 pr-3">
                  <span className="w-[84px] text-[13px] text-muted-foreground">{t('tasks.due.label')}</span>
                  <UiInput
                    modelValue={dateValue}
                    onUpdateModelValue={setDateValue}
                    type="date"
                    size="lg"
                    aria-label={t('tasks.due.dateLabel')}
                    className="flex-1"
                    onChange={e => commitDate(e.target.value)}
                    onBlur={e => commitDate(e.target.value)}
                  />
                </div>
              )
              : (
                <button type="button" className="flex min-h-[52px] w-full items-center border-b border-border pl-4 pr-3 text-left text-[15px]" onClick={e => openMenu('due', e)}>
                  <span className="w-[84px] text-[13px] text-muted-foreground">{t('tasks.due.label')}</span>
                  <span className="flex-1 font-medium">
                    {due
                      ? <span className={cn('font-mono', due.tone === 'danger' ? 'text-danger' : '')}>{due.text}</span>
                      : <span className="text-muted-foreground">{t('common.none')}</span>}
                  </span>
                  <UiIcon name="chevron-right" className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
            <button type="button" className="flex min-h-[52px] w-full items-center border-b border-border pl-4 pr-3 text-left text-[15px]" onClick={openAssignee}>
              <span className="w-[84px] text-[13px] text-muted-foreground">{t('tasks.detail.assignee')}</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {assigneeName || <span className="font-normal text-muted-foreground">{t('tasks.assign.none')}</span>}
              </span>
              {canAssign && <UiIcon name="chevron-right" className="h-4 w-4 text-muted-foreground" />}
            </button>
            <div className="flex min-h-[52px] items-center border-b border-border py-2 pl-4 pr-3 text-[15px]">
              <span className="w-[84px] shrink-0 text-[13px] text-muted-foreground">{t('tasks.detail.tags')}</span>
              <TasksTagEditor className="flex-1" size="lg" tags={tags} suggestions={facets.tags} onCommit={commitTags} />
            </div>
            <div className="flex min-h-[52px] items-center pl-4 pr-3 text-[15px]">
              <span className="w-[84px] shrink-0 text-[13px] text-muted-foreground">{t('tasks.detail.project')}</span>
              <input
                {...projectInputProps}
                className="h-10 min-w-0 flex-1 bg-transparent font-medium outline-hidden placeholder:font-normal placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* 설명 */}
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            aria-label={t('tasks.detail.description')}
            placeholder={t('tasks.detail.descriptionPlaceholder')}
            className="min-h-[64px] resize-none rounded-md border border-border bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground/90 outline-hidden [field-sizing:content] placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35 md:bg-background"
            onBlur={saveDescription}
          />

          {/* 하위 작업 */}
          <section aria-label={t('tasks.detail.subtasks')}>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-muted-foreground max-md:text-[13px]">
              {t('tasks.detail.subtasks')}
              <span className="font-mono">{subDone} / {subs.length}</span>
              {subs.length > 0 && (
                <span className="h-1 flex-1 rounded-full bg-muted" aria-hidden="true">
                  <span className="block h-full rounded-full bg-success transition-[width]" style={{ width: subPct + '%' }} />
                </span>
              )}
            </div>

            {subsLoading
              ? <UiSkeleton preset="text" rows={2} />
              : subsError
                ? <UiErrorTile placement="panel" title={t('tasks.detail.subLoadError')} onRetry={loadSubs} />
                : subs.map(s => (
                  <div key={s.id} className="group/sub flex min-h-9 items-center gap-2.5 text-[13px] max-md:min-h-11 max-md:text-[15px]">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={s.status === 'done'}
                      aria-label={s.status === 'done' ? t('tasks.detail.subUnmarkDone', { title: s.title }) : t('tasks.detail.subMarkDone', { title: s.title })}
                      className={cn(
                        "relative grid h-4 w-4 shrink-0 place-items-center rounded-full before:absolute before:-inset-3 before:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                        s.status === 'done' ? 'bg-success text-background' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground))]',
                      )}
                      onClick={() => toggleSub(s)}
                    >
                      {s.status === 'done' && <UiIcon name="check" className="h-2.5 w-2.5" strokeWidth={4} />}
                    </button>
                    {editingSub === s.id
                      ? (
                        <input
                          value={editSubTitle}
                          onChange={e => setEditSubTitle(e.target.value)}
                          autoFocus
                          aria-label={t('tasks.detail.subTitleLabel')}
                          className="h-8 min-w-0 flex-1 rounded-sm border border-ring bg-background px-2 outline-hidden ring-2 ring-ring/35"
                          onKeyDown={e => onSubKey(e, s)}
                          onBlur={() => saveSub(s)}
                        />
                      )
                      : (
                        <button
                          type="button"
                          className={cn('min-w-0 flex-1 truncate text-left', s.status === 'done' ? 'text-muted-foreground line-through' : '')}
                          aria-label={t('tasks.detail.subEdit', { title: s.title })}
                          onClick={() => startEditSub(s)}
                        >{s.title}</button>
                      )}
                    <UiIconButton
                      label={t('tasks.detail.subDelete', { title: s.title })}
                      icon="trash"
                      className="md:opacity-0 md:group-hover/sub:opacity-100 md:focus-visible:opacity-100"
                      onClick={() => removeSub(s)}
                    />
                  </div>
                ))}

            {adding
              ? (
                <form className="mt-1 flex items-center gap-2" onSubmit={addSub}>
                  <input
                    value={newSub}
                    onChange={e => setNewSub(e.target.value)}
                    autoFocus
                    aria-label={t('tasks.detail.newSubLabel')}
                    placeholder={t('tasks.detail.newSubPlaceholder')}
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-[13px] outline-hidden focus:border-ring focus:ring-2 focus:ring-ring/35"
                    onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setNewSub('') } }}
                  />
                  <UiButton size="xs" type="submit" disabled={!newSub.trim()}>{t('common.add')}</UiButton>
                </form>
              )
              : <button type="button" className="mt-1 h-8 text-xs font-semibold text-primary max-md:h-10 max-md:text-[13px]" onClick={() => setAdding(true)}>{t('tasks.detail.addSub')}</button>}
          </section>
        </div>
      </div>

      {menu && (
        <UiMenu
          dense
          width={220}
          items={menuItems}
          anchor={menu.anchor}
          title={menu.kind === 'priority' ? t('tasks.filterPriority') : menu.kind === 'due' ? t('tasks.due.label') : menu.kind === 'assignee' ? t('tasks.detail.assignee') : task.title}
          align={menu.kind === 'more' ? 'end' : 'start'}
          onSelect={onMenuSelect}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

export default TasksDetail
