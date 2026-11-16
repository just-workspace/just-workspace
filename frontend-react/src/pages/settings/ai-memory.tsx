// 설정 › AI › 메모리.
//  머리(설정 › AI · 메모리 20/600 · 설명) → [메모리 사용] 스위치 + [전부 지우기](danger) → 검색 + 종류 칩 + 개수(mono)
//  → 행: 종류 배지 · 내용 13.5 · "대화 “…”에서 · MM-DD"(mono) · [수정][지우기]. 비활성화 시 빈 상태 "메모리를 쓰지 않습니다".
//  직접 추가 행(종류 + 한 문장). 비밀(비밀번호·토큰·주민번호·카드번호)은 서버가 422 로 거부 → 칸 오류.
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiChip } from '~/components/ui/Chip'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiSwitch } from '~/components/ui/Switch'
import type { AiMemoryItem } from '~/utils/aiAssist'

type Kind = AiMemoryItem['kind']
const KINDS: Kind[] = ['preference', 'work', 'person']

function errOf(e: any): { code?: string; message: string } {
  const d = e?.data?.detail
  if (d && typeof d === 'object') return { code: d.code, message: d.message || String(d) }
  return { message: typeof d === 'string' ? d : (e?.message || String(e)) }
}

export default function SettingsAiMemoryPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('ai.memory.title')} | ${appName}` })

  const [items, setItems] = useState<AiMemoryItem[] | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [total, setTotal] = useState(0)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind | ''>('')
  const [editing, setEditing] = useState<{ id: string; text: string; kind: Kind; error?: string } | null>(null)
  const [draft, setDraft] = useState<{ text: string; kind: Kind; error?: string } | null>(null)

  async function load() {
    setFailed(false)
    try {
      const r = await $fetch<{ enabled: boolean; total: number; items: AiMemoryItem[] }>('/api/ai/memory', { credentials: 'include' })
      setItems(r.items || [])
      setEnabled(r.enabled !== false)
      setTotal(r.total ?? (r.items || []).length)
    } catch { setFailed(true) }
  }
  useEffect(() => { void load() }, [])

  async function toggle(v: boolean) {
    setEnabled(v)
    try {
      await $fetch('/api/ai/memory-settings', { method: 'PUT', credentials: 'include', body: { enabled: v } })
    } catch (e) {
      setEnabled(!v)
      addToast('error', t('ai.memory.error', { msg: errOf(e).message }))
    }
  }

  async function remove(m: AiMemoryItem) {
    try {
      await $fetch(`/api/ai/memory/${encodeURIComponent(m.id)}`, { method: 'DELETE', credentials: 'include' })
      setItems(l => (l || []).filter(x => x.id !== m.id))
      setTotal(n => Math.max(0, n - 1))
    } catch (e) { addToast('error', t('ai.memory.error', { msg: errOf(e).message })) }
  }

  async function clearAll() {
    const ok = await confirmBox(t('ai.memory.clearMessage', { n: String(total) }), { title: t('ai.memory.clearTitle'), confirmLabel: t('ai.memory.clearAll'), danger: true })
    if (!ok) return
    try {
      await $fetch('/api/ai/memory', { method: 'DELETE', credentials: 'include' })
      setItems([])
      setTotal(0)
    } catch (e) { addToast('error', t('ai.memory.error', { msg: errOf(e).message })) }
  }

  async function saveEdit() {
    if (!editing) return
    try {
      const m = await $fetch<AiMemoryItem>(`/api/ai/memory/${encodeURIComponent(editing.id)}`, { method: 'PATCH', credentials: 'include', body: { text: editing.text, kind: editing.kind } })
      setItems(l => (l || []).map(x => (x.id === m.id ? { ...x, ...m } : x)))
      setEditing(null)
    } catch (e) {
      const er = errOf(e)
      setEditing(cur => (cur ? { ...cur, error: er.code === 'secret' ? t('ai.memory.secret') : er.message } : cur))
    }
  }

  async function saveDraft() {
    if (!draft?.text.trim()) return
    try {
      const m = await $fetch<AiMemoryItem>('/api/ai/memory', { method: 'POST', credentials: 'include', body: { text: draft.text, kind: draft.kind } })
      setItems(l => [m, ...(l || []).filter(x => x.id !== m.id)])
      setTotal(n => n + 1)
      setDraft(null)
    } catch (e) {
      const er = errOf(e)
      setDraft(cur => (cur ? { ...cur, error: er.code === 'secret' ? t('ai.memory.secret') : er.message } : cur))
    }
  }

  const q = query.trim().toLowerCase()
  const shown = (items || []).filter(m => (!kind || m.kind === kind) && (!q || m.text.toLowerCase().includes(q)))
  const kindOptions = KINDS.map(k => ({ value: k, label: t(`ai.memory.kind.${k}`) }))
  const day = (v?: string | null) => {
    const d = v ? new Date(v) : null
    return d && !Number.isNaN(d.getTime()) ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''
  }
  const short = (s: string) => (s.length > 12 ? `${s.slice(0, 12)}…` : s)

  return (
    <section aria-labelledby="mem-title" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-col gap-1.5 border-b border-border px-6 py-5">
        <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => { void navigateTo('/settings/ai') }}>{t('ai.memory.crumb')}</button>
        <h2 id="mem-title" className="m-0 text-xl font-semibold text-foreground">{t('ai.memory.title')}</h2>
        <p className="m-0 text-[13.5px] leading-[21px] text-muted-foreground">{t('ai.memory.desc')}</p>
      </div>

      {failed ? (
        <div className="p-6"><UiErrorTile placement="panel" title={t('ai.memory.error', { msg: '' })} onRetry={() => void load()} /></div>
      ) : items === null ? (
        <div className="p-6"><UiSkeleton preset="text" /></div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0 flex-[1_1_320px]">
              <UiSwitch label={t('ai.memory.switch')} description={t('ai.memory.switchDesc')} modelValue={enabled} onUpdateModelValue={v => { void toggle(v) }} />
            </div>
            <UiButton variant="danger" size="sm" icon="trash" disabled={!total} onClick={() => { void clearAll() }}>{t('ai.memory.clearAll')}</UiButton>
          </div>

          {!enabled ? (
            <div className="px-6 py-8">
              <UiEmptyState variant="panel" icon="memory-stick" title={t('ai.memory.offTitle')} description={t('ai.memory.offDesc', { n: String(total) })} />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2.5 px-6 py-3.5">
                <div className="min-w-0 flex-[1_1_260px]">
                  <UiInput modelValue={query} onUpdateModelValue={setQuery} aria-label={t('ai.memory.search')} placeholder={t('ai.memory.search')} icon="search" />
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('ai.memory.kindLabel')}>
                  <UiChip label={t('ai.memory.all')} modelValue={kind === ''} onUpdateModelValue={() => setKind('')} size="sm" />
                  {KINDS.map(k => (
                    <UiChip key={k} label={t(`ai.memory.kind.${k}`)} modelValue={kind === k} onUpdateModelValue={() => setKind(kind === k ? '' : k)} size="sm" />
                  ))}
                </div>
                <span className="text-[12.5px] text-muted-foreground"><span className="font-mono">{shown.length}</span>{t('ai.memory.count', { n: '' })}</span>
                {!draft && <UiButton variant="outline" size="sm" icon="plus" onClick={() => setDraft({ text: '', kind: 'preference' })}>{t('ai.memory.add')}</UiButton>}
              </div>

              {draft && (
                <div className="flex flex-wrap items-start gap-2.5 border-t border-border px-6 py-3.5">
                  <UiSelect size="sm" className="w-28" aria-label={t('ai.memory.kindLabel')} modelValue={draft.kind} options={kindOptions} onUpdateModelValue={v => setDraft(d => (d ? { ...d, kind: v as Kind } : d))} />
                  <div className="min-w-0 flex-[1_1_240px]">
                    <UiInput modelValue={draft.text} onUpdateModelValue={v => setDraft(d => (d ? { ...d, text: v, error: undefined } : d))} aria-label={t('ai.memory.addPlaceholder')} placeholder={t('ai.memory.addPlaceholder')} error={draft.error} data-autofocus />
                  </div>
                  <UiButton variant="ghost" size="sm" onClick={() => setDraft(null)}>{t('ai.memory.cancel')}</UiButton>
                  <UiButton size="sm" disabled={!draft.text.trim()} onClick={() => { void saveDraft() }}>{t('ai.memory.save')}</UiButton>
                </div>
              )}

              {!shown.length ? (
                <div className="border-t border-border px-6 py-8">
                  <UiEmptyState variant="inline" icon="memory-stick" title={t('ai.memory.empty')} description={t('ai.memory.emptyDesc')} />
                </div>
              ) : (
                <ul aria-label={t('ai.memory.title')} className="m-0 list-none p-0">
                  {shown.map(m => (
                    <li key={m.id} className="flex items-start gap-3 border-t border-border px-6 py-3.5">
                      <UiBadge tone="neutral" tint size={18}>{t(`ai.memory.kind.${m.kind}`)}</UiBadge>
                      {editing?.id === m.id ? (
                        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
                          <UiSelect size="sm" className="w-28" aria-label={t('ai.memory.kindLabel')} modelValue={editing.kind} options={kindOptions} onUpdateModelValue={v => setEditing(d => (d ? { ...d, kind: v as Kind } : d))} />
                          <div className="min-w-0 flex-[1_1_220px]">
                            <UiInput modelValue={editing.text} onUpdateModelValue={v => setEditing(d => (d ? { ...d, text: v, error: undefined } : d))} aria-label={t('ai.memory.edit', { text: short(m.text) })} error={editing.error} />
                          </div>
                          <UiButton variant="ghost" size="sm" onClick={() => setEditing(null)}>{t('ai.memory.cancel')}</UiButton>
                          <UiButton size="sm" disabled={!editing.text.trim()} onClick={() => { void saveEdit() }}>{t('ai.memory.save')}</UiButton>
                        </div>
                      ) : (
                        <>
                          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                            <span className="text-[13.5px] leading-[21px] text-foreground">{m.text}</span>
                            <span className="text-xs text-muted-foreground">
                              {m.source_conversation_id
                                ? (m.source_title ? t('ai.memory.fromConv', { title: m.source_title }) : t('ai.memory.fromDeleted'))
                                : t('ai.memory.manual')}
                              {' · '}<span className="font-mono">{day(m.created_at)}</span>
                            </span>
                          </span>
                          <UiIconButton label={t('ai.memory.edit', { text: short(m.text) })} icon="edit" size="sm" onClick={() => setEditing({ id: m.id, text: m.text, kind: m.kind })} />
                          <UiIconButton label={t('ai.memory.remove', { text: short(m.text) })} icon="trash" size="sm" onClick={() => { void remove(m) }} />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
