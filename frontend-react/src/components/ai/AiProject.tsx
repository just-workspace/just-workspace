/**
 * 프로젝트.
 *  카드: r12 · card · 18 20 여백 — [폴더 20 primary] 이름 18/600 [나만 보기|공유 배지] … [지침 편집][파일 추가](주인만)
 *  · 지침(12/600 머리 + 13.5 본문) · 지식 파일 n · 크기(mono) + 칩(파일 종류 아이콘).
 *  공유받은 구성원: [사람들 아이콘] 이름 [공유받음] … "○○ 님이 그룹에 공유" · 지침 · 칩 2개 + "+N" · 읽기 전용 안내.
 * 편집 창: 이름 · 지침(n / 4,000, 넘으면 빨강 + 오류) · 지식 파일 목록(빼기) + [내 파일에서 고르기] — 저장 때 한꺼번에 반영.
 *  피커: 경로(내 파일 › …) · 이 폴더에서 검색 · 체크 줄(이미 들어 있음) · "n개 고름 · 한 번에 최대 20개 · 프로젝트 전체 a/50개".
 *  지식 파일은 복사하지 않고 연결(원본을 고치면 다음 답변부터 반영).
 * 공유 창: 그룹 체크(구성원 수) + 못 읽는 파일 경고(공유는 막지 않음 — 그 사람 답변에서만 빠짐).
 * 답변에서 빠진 지식 파일 줄 · 공유가 끊긴 프로젝트(구성원 쪽).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiChip } from '~/components/ui/Chip'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiInput } from '~/components/ui/Input'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiTextarea } from '~/components/ui/Textarea'
import { aiFileIcon, aiFormatBytes, type AiProject, type AiProjectFile } from '~/utils/aiAssist'

/** 서버와 같은 한도(app/ai/projects.py) */
export const AI_PROJECT_MAX_FILES = 50
export const AI_PROJECT_MAX_PICK = 20
export const AI_PROJECT_MAX_INSTRUCTIONS = 4000

export interface AiProjectCardProps {
  project: AiProject
  onEditInstructions?: () => void
  onAddFiles?: () => void
  onRemoveFile?: (f: AiProjectFile) => void
  onMenu?: (key: 'rename' | 'share' | 'delete') => void
}

export function AiProjectCard({ project, onEditInstructions, onAddFiles, onRemoveFile, onMenu }: AiProjectCardProps) {
  const { t } = useI18n()
  const files = project.files ?? []
  if (!project.editable) return <AiProjectMemberCard project={project} />
  const menu: UiMenuItem[] = [
    { key: 'rename', label: t('ai.project.rename'), icon: 'edit' },
    { key: 'share', label: t('ai.project.share'), icon: 'users' },
    { key: 'delete', label: t('ai.project.delete'), icon: 'trash', danger: true, separated: true },
  ]
  const groups = project.share_groups ?? []
  const sharedLabel = groups.length
    ? `${t('ai.project.shared')} · ${groups[0].name}${groups.length > 1 ? ` +${groups.length - 1}` : ''}`
    : project.share_group_name ? `${t('ai.project.shared')} · ${project.share_group_name}` : t('ai.project.shared')
  return (
    <section aria-label={project.name} className="flex flex-col gap-3.5 rounded-xl border border-border bg-card px-5 py-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <UiIcon name="folder" className="h-5 w-5 text-primary" />
        <h1 className="m-0 min-w-0 truncate text-lg font-semibold text-foreground">{project.name}</h1>
        <UiBadge tone="neutral" tint size={18}>{project.shared ? sharedLabel : t('ai.project.private')}</UiBadge>
        <span className="flex-1" />
        <UiButton variant="ghost" size="xs" icon="edit" onClick={() => onEditInstructions?.()}>{t('ai.project.editInstructions')}</UiButton>
        <UiButton variant="outline" size="xs" icon="upload" onClick={() => onAddFiles?.()}>{t('ai.project.addFiles')}</UiButton>
        <UiMenu items={menu} label={t('ai.project.menu')} triggerSize="sm" className="text-muted-foreground" onSelect={(k: string) => onMenu?.(k as 'rename' | 'share' | 'delete')} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-muted-foreground">{t('ai.project.instructions')}</span>
        <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-[21px] text-foreground">{project.instructions || <span className="text-muted-foreground">{t('ai.project.noInstructions')}</span>}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground">
          {t('ai.project.files')} <span className="font-mono">{files.length}</span>
          {!!project.files_size && <> · <span className="font-mono">{aiFormatBytes(project.files_size)}</span></>}
        </span>
        {files.length ? (
          <div className="flex flex-wrap gap-1.5">
            {files.map(f => (
              <UiChip key={f.id} label={f.name} icon={aiFileIcon(f.name)} variant="static" size="sm" removable onRemove={() => onRemoveFile?.(f)} />
            ))}
          </div>
        ) : <span className="text-[13px] text-muted-foreground">{t('ai.project.noFiles')}</span>}
      </div>
    </section>
  )
}

/** 공유받은 구성원이 보는 프로젝트 머리 — 고치는 단추 없음 */
function AiProjectMemberCard({ project }: { project: AiProject }) {
  const { t } = useI18n()
  const files = project.files ?? []
  const group = project.share_groups?.[0]?.name || project.share_group_name || ''
  const shown = files.slice(0, 2)
  return (
    <section aria-label={t('ai.project.memberLabel')} className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <UiIcon name="users" className="h-5 w-5 text-primary" />
        <h1 className="m-0 min-w-0 truncate text-lg font-semibold text-foreground">{project.name}</h1>
        <UiBadge tone="primary" tint size={18}>{t('ai.project.sharedWithMe')}</UiBadge>
        <span className="flex-1" />
        {project.owner_name && (
          <span className="text-[12.5px] text-muted-foreground">
            {group ? t('ai.project.sharedBy', { owner: project.owner_name, group }) : t('ai.project.sharedByNoGroup', { owner: project.owner_name })}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-muted-foreground">{t('ai.project.instructions')}</span>
        <p className="m-0 line-clamp-3 whitespace-pre-wrap text-[13.5px] leading-[21px] text-foreground">{project.instructions || <span className="text-muted-foreground">{t('ai.project.noInstructions')}</span>}</p>
      </div>
      {!!files.length && (
        <div className="flex flex-wrap gap-1.5">
          {shown.map(f => <UiChip key={f.id} label={f.name} icon={aiFileIcon(f.name)} variant="static" size="sm" />)}
          {files.length > 2 && <UiChip label={`+${files.length - 2}`} variant="static" size="sm" />}
        </div>
      )}
      <span className="text-xs text-muted-foreground">{t('ai.project.readOnlyNote')}</span>
    </section>
  )
}

/** 이번 답변에서 권한이 없어 빠진 지식 파일 */
export function AiKnowledgeSkipped({ files }: { files: AiProjectFile[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (!files.length) return null
  return (
    <div className="flex flex-col gap-1.5 pl-[38px] md:pl-10">
      <div role="status" className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[12.5px] text-muted-foreground">
        <UiIcon name="lock" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {t('ai.project.skippedPre')}<span className="font-mono">{files.length}</span>{t('ai.project.skippedPost')}
        </span>
        <button type="button" aria-expanded={open} className="shrink-0 text-[12.5px] text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpen(v => !v)}>
          {t('ai.project.skippedWhich')}
        </button>
      </div>
      {open && (
        <ul aria-label={t('ai.project.skippedList')} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {files.map(f => <li key={f.id}><UiChip label={f.name} icon={aiFileIcon(f.name)} variant="static" size="sm" /></li>)}
        </ul>
      )}
    </div>
  )
}

/** 공유가 끊긴 프로젝트(구성원 쪽) */
export function AiProjectGone() {
  const { t } = useI18n()
  return <UiEmptyState variant="panel" icon="ban" title={t('ai.project.goneTitle')} description={t('ai.project.goneDesc')} />
}

export interface AiProjectFormValue {
  name: string
  instructions: string
  /** 새로 연결할 파일 경로 */
  addPaths: string[]
  /** 뺄 지식 파일 id */
  removeIds: string[]
}

interface PickedFile { path: string; name: string; size?: number | null }

/** 프로젝트 만들기·편집(이름 · 지침 · 지식 파일). 피커는 같은 자리에서 열린다(창 하나) */
export function AiProjectFormModal({ initial, title, onSubmit, onClose, startPicking }: {
  initial?: { name: string; instructions: string; files?: AiProjectFile[] }
  title: string
  onSubmit: (v: AiProjectFormValue) => Promise<void> | void
  onClose: () => void
  /** 처음부터 피커를 연다(카드의 [파일 추가]) */
  startPicking?: boolean
}) {
  const { t } = useI18n()
  const [name, setName] = useState(initial?.name ?? '')
  const [instructions, setInstructions] = useState(initial?.instructions ?? '')
  const [removed, setRemoved] = useState<string[]>([])
  const [added, setAdded] = useState<PickedFile[]>([])
  const [picking, setPicking] = useState(!!startPicking)
  const [saving, setSaving] = useState(false)
  const existing = (initial?.files ?? []).filter(f => !removed.includes(f.id))
  const total = existing.length + added.length
  const len = instructions.length
  const over = len > AI_PROJECT_MAX_INSTRUCTIONS
  const fmt = (n: number) => n.toLocaleString('ko-KR')

  async function submit(extra?: PickedFile[]) {
    if (!name.trim() || over) return
    setSaving(true)
    const add = [...added, ...(extra ?? [])]
    try { await onSubmit({ name: name.trim(), instructions, addPaths: add.map(f => f.path), removeIds: removed }) } finally { setSaving(false) }
  }

  if (picking) {
    return (
      <AiProjectFilePicker
        existingPaths={[...existing.map(f => f.path), ...added.map(f => f.path)]}
        total={total}
        onSubmit={(items) => {
          setPicking(false)
          // 카드의 [파일 추가]로 바로 연 경우는 고르면 바로 저장
          if (startPicking && !added.length && !removed.length) { void submit(items); return }
          setAdded(l => [...l, ...items.filter(x => !l.some(y => y.path === x.path))])
        }}
        onClose={() => (startPicking && !added.length ? onClose() : setPicking(false))}
      />
    )
  }

  const rows: { key: string; name: string; size?: number | null; onRemove: () => void }[] = [
    ...existing.map(f => ({ key: f.id, name: f.name, size: f.size, onRemove: () => setRemoved(l => [...l, f.id]) })),
    ...added.map(f => ({ key: `+${f.path}`, name: f.name, size: f.size, onRemove: () => setAdded(l => l.filter(x => x.path !== f.path)) })),
  ]
  return (
    <UiModal
      title={title}
      size="520"
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="ghost" size="sm" onClick={onClose}>{t('ai.memory.cancel')}</UiButton>
          <UiButton size="sm" disabled={!name.trim() || saving || over} onClick={() => { void submit() }}>{t('ai.project.save')}</UiButton>
        </>
      )}
    >
      <UiInput modelValue={name} onUpdateModelValue={setName} label={t('ai.project.nameLabel')} placeholder={t('ai.project.namePlaceholder')} data-autofocus />
      <div className="flex flex-col gap-1">
        <UiTextarea
          modelValue={instructions}
          onUpdateModelValue={setInstructions}
          label={t('ai.project.instructionsLabel')}
          placeholder={t('ai.project.instructionsPlaceholder')}
          hint={over ? undefined : t('ai.project.instructionsHint')}
          error={over ? t('ai.project.instructionsTooLong') : undefined}
          rows={5}
        />
        <span data-testid="ai-project-count" className={cn('self-end font-mono text-xs', over ? 'text-danger' : 'text-muted-foreground')}>{fmt(len)} / {fmt(AI_PROJECT_MAX_INSTRUCTIONS)}</span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[13px] font-medium text-foreground">{t('ai.project.files')} <span className="font-mono text-muted-foreground">{total}</span></span>
          <UiButton variant="outline" size="xs" icon="folder" disabled={total >= AI_PROJECT_MAX_FILES} onClick={() => setPicking(true)}>{t('ai.project.pickFromMine')}</UiButton>
        </div>
        {!!rows.length && (
          <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-border p-0">
            {rows.map(r => (
              <li key={r.key} className="flex items-center gap-2.5 border-b border-border py-2 pl-3 pr-1.5 last:border-b-0">
                <UiIcon name={aiFileIcon(r.name)} className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{r.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{r.size ? aiFormatBytes(r.size) : '—'}</span>
                <UiIconButton label={t('ai.project.removeFile', { name: r.name })} icon="close" size="sm" onClick={r.onRemove} />
              </li>
            ))}
          </ul>
        )}
        <span className="text-xs text-muted-foreground">{t('ai.project.linkNote')}</span>
      </div>
    </UiModal>
  )
}

interface ShareTarget { id: string; name: string; members?: number }
interface ShareCheck { members: number; blocked_members: number; files: { id: string; name: string; blocked: number }[] }

/** 공유 — 내가 속한 그룹(여러 개) + 못 읽는 파일 경고. 빈 선택으로 저장 = 공유 해제 */
export function AiProjectShareModal({ project, onSubmit, onClose }: {
  project: AiProject
  onSubmit: (groupIds: string[]) => Promise<void> | void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [groups, setGroups] = useState<ShareTarget[] | null>(null)
  const [picked, setPicked] = useState<string[]>(project.share_group_ids?.length ? project.share_group_ids : (project.share_group_id ? [project.share_group_id] : []))
  const [check, setCheck] = useState<ShareCheck | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    $fetch<{ groups: ShareTarget[] }>('/api/ai/projects/share-targets', { credentials: 'include' })
      .then(r => setGroups(r?.groups || [])).catch(() => setGroups([]))
  }, [])
  // 고른 그룹이 바뀌면 잠깐 뒤 점검(경고만)
  const seq = useRef(0)
  useEffect(() => {
    const my = ++seq.current
    if (!picked.length || !(project.files?.length)) { setCheck(null); return }
    const tm = setTimeout(() => {
      $fetch<ShareCheck>(`/api/ai/projects/${encodeURIComponent(project.id)}/share-check?group_ids=${encodeURIComponent(picked.join(','))}`, { credentials: 'include' })
        .then(r => { if (seq.current === my) setCheck(r) }).catch(() => { if (seq.current === my) setCheck(null) })
    }, 250)
    return () => clearTimeout(tm)
  }, [picked, project.id, project.files?.length])

  const groupNames = (groups ?? []).filter(g => picked.includes(g.id)).map(g => g.name).join('·')
  const fileNames = (check?.files ?? []).map(f => f.name)
  const fileList = fileNames.length > 3 ? t('ai.project.shareWarnMore', { names: fileNames.slice(0, 3).join(', '), n: String(fileNames.length - 3) }) : fileNames.join(', ')

  async function submit() {
    setSaving(true)
    try { await onSubmit(picked) } finally { setSaving(false) }
  }
  return (
    <UiModal
      title={t('ai.project.shareTitleNamed', { name: project.name })}
      size="480"
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="ghost" size="sm" onClick={onClose}>{t('ai.memory.cancel')}</UiButton>
          <UiButton size="sm" disabled={saving || groups === null} onClick={() => { void submit() }}>{t('ai.project.shareSubmit')}</UiButton>
        </>
      )}
    >
      <p className="m-0 text-[13px] leading-5 text-muted-foreground">{t('ai.project.shareDescJ')}</p>
      <div className="flex flex-col gap-2.5">
        {groups === null ? <span className="text-xs text-muted-foreground">…</span>
          : !groups.length ? <span className="text-xs text-muted-foreground">{t('ai.project.noGroups')}</span>
            : groups.map(g => (
              <UiCheckbox
                key={g.id}
                label={g.name}
                description={g.members != null ? t('ai.project.memberCount', { n: String(g.members) }) : undefined}
                modelValue={picked.includes(g.id)}
                onUpdateModelValue={v => setPicked(l => (v ? [...l, g.id] : l.filter(x => x !== g.id)))}
              />
            ))}
      </div>
      {!!check?.blocked_members && !!fileNames.length && (
        <div role="note" className="flex gap-2 rounded-lg border border-warning/40 bg-warning/[0.08] px-3 py-2.5 text-[12.5px] leading-[19px] text-foreground">
          <UiIcon name="alert-triangle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            {t('ai.project.shareWarn1', { groups: groupNames })}<span className="font-mono">{check.blocked_members}</span>
            {t('ai.project.shareWarn2')}<span className="font-mono">{fileNames.length}</span>
            {t('ai.project.shareWarn3', { names: fileList })}
          </span>
        </div>
      )}
    </UiModal>
  )
}

interface FileItem { name: string; path: string; is_dir: boolean; size?: number }

/** 피커 — 내 파일·팀 폴더를 걸어 들어가 파일을 고른다(/api/files/list). 한 번에 20개, 프로젝트 전체 50개 */
export function AiProjectFilePicker({ onSubmit, onClose, existingPaths = [], total = 0 }: {
  onSubmit: (items: PickedFile[]) => Promise<void> | void
  onClose: () => void
  /** 이미 들어 있는 경로(체크된 채 잠김) */
  existingPaths?: string[]
  /** 지금 프로젝트에 든 파일 수 */
  total?: number
}) {
  const { t } = useI18n()
  const [path, setPath] = useState('')
  const [items, setItems] = useState<FileItem[] | null>(null)
  const [picked, setPicked] = useState<PickedFile[]>([])
  const [q, setQ] = useState('')
  const names = useRef<Record<string, string>>({})
  useEffect(() => {
    setItems(null)
    setQ('')
    $fetch<{ items: FileItem[] }>(`/api/files/list?path=${encodeURIComponent(path)}`, { credentials: 'include' })
      .then((r) => {
        const list = r?.items || []
        for (const it of list) if (it.is_dir) names.current[it.path.replace(/^\/+|\/+$/g, '')] = it.name
        setItems(list)
      }).catch(() => setItems([]))
  }, [path])
  const room = Math.max(0, Math.min(AI_PROJECT_MAX_PICK, AI_PROJECT_MAX_FILES - total))
  const full = picked.length >= room
  const isIn = (p: string) => existingPaths.includes(p)
  function toggle(it: FileItem, v: boolean) {
    setPicked(l => (v ? (l.length >= room || l.some(x => x.path === it.path) ? l : [...l, { path: it.path, name: it.name, size: it.size }]) : l.filter(x => x.path !== it.path)))
  }
  const crumbs = useMemo(() => {
    const segs = path ? path.split('/') : []
    return segs.map((s, i) => {
      const p = segs.slice(0, i + 1).join('/')
      return { path: p, label: names.current[p] || s }
    })
  }, [path, items]) // eslint-disable-line react-hooks/exhaustive-deps
  const needle = q.trim().toLowerCase()
  const shown = (items ?? []).filter(it => !needle || it.name.toLowerCase().includes(needle))
  const linkCls = 'text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-sm'
  return (
    <UiModal
      title={t('ai.project.pickTitleJ')}
      size="680"
      mobile="full"
      flush
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-3">
        <nav aria-label={t('ai.project.pickPath')} className="flex min-w-0 flex-[1_1_260px] flex-wrap items-center gap-1 text-[13px]">
          {crumbs.length ? <button type="button" className={linkCls} onClick={() => setPath('')}>{t('ai.project.pickRoot')}</button>
            : <span className="font-semibold text-foreground">{t('ai.project.pickRoot')}</span>}
          {crumbs.map((c, i) => (
            <span key={c.path} className="inline-flex items-center gap-1">
              <UiIcon name="chevron-right" className="h-3.5 w-3.5 text-muted-foreground" />
              {i === crumbs.length - 1
                ? <span className="font-semibold text-foreground">{c.label}</span>
                : <button type="button" className={linkCls} onClick={() => setPath(c.path)}>{c.label}</button>}
            </span>
          ))}
        </nav>
        <div className="w-full sm:w-60">
          <UiInput modelValue={q} onUpdateModelValue={setQ} aria-label={t('ai.project.pickSearch')} placeholder={t('ai.project.pickSearch')} icon="search" />
        </div>
      </div>
      <ul className="m-0 max-h-[55dvh] list-none overflow-y-auto p-0">
        {items === null ? <li className="px-5 py-4 text-xs text-muted-foreground">…</li>
          : !shown.length ? (
            <li className="p-4">
              {needle
                ? <UiEmptyState variant="inline" icon="search" title={t('ai.project.pickNoMatch', { q: q.trim() })} />
                : <UiEmptyState variant="inline" icon="folder" title={t('ai.project.pickEmpty')} />}
            </li>
          ) : shown.map((it) => {
            if (it.is_dir) {
              return (
                <li key={it.path} className="flex h-12 items-center gap-3 border-b border-border px-5">
                  <span className="w-[18px]" />
                  <UiIcon name="folder" className="h-[18px] w-[18px] text-muted-foreground" />
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-[13.5px] text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setPath(it.path.replace(/^\/+|\/+$/g, ''))}>{it.name}</button>
                </li>
              )
            }
            const already = isIn(it.path)
            const on = already || picked.some(x => x.path === it.path)
            return (
              <li key={it.path} className={cn('flex h-12 items-center gap-3 border-b border-border px-5', on && !already && 'bg-primary/[0.06]')}>
                <UiCheckbox ariaLabel={it.name} modelValue={on} disabled={already || (!on && full)} onUpdateModelValue={v => toggle(it, v)} />
                <UiIcon name={aiFileIcon(it.name)} className="h-[18px] w-[18px] shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{it.name}</span>
                {already && <span className="shrink-0 text-xs text-muted-foreground">{t('ai.project.pickAlready')}</span>}
                <span className="w-[72px] shrink-0 text-right font-mono text-xs text-muted-foreground">{it.size ? aiFormatBytes(it.size) : ''}</span>
              </li>
            )
          })}
      </ul>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <span className="min-w-0 flex-1 text-[13px] text-foreground">
          <span className="font-mono">{picked.length}</span>{t('ai.project.pickCount1')}
          <span className="font-mono">{AI_PROJECT_MAX_PICK}</span>{t('ai.project.pickCount2')}
          <span className="font-mono">{total + picked.length}/{AI_PROJECT_MAX_FILES}</span>{t('ai.project.pickCount3')}
        </span>
        <UiButton variant="ghost" size="sm" onClick={onClose}>{t('ai.memory.cancel')}</UiButton>
        <UiButton size="sm" disabled={!picked.length} onClick={() => { void onSubmit(picked) }}>{t('ai.project.pickAdd', { n: String(picked.length) })}</UiButton>
      </div>
    </UiModal>
  )
}
