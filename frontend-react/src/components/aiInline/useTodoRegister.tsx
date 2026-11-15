/**
 * [할일에 등록] 공용 — 고른 항목을 /api/ai/inline/tasks 로(서버가 writes.request_write → 승인 → 실행).
 * 등록 뒤 한 줄: "n개를 할일에 등록했습니다 [되돌리기] [할일 보기]"(10분 안 되돌리기 — S3 되돌리기 창).
 */
import { useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { createInlineTasks, idemKey, inlineError, undoInlineTasks, type TaskCreateItem } from '~/utils/aiInline'

export interface TodoRegisterState {
  busy: boolean
  done: { count: number; requestIds: string[]; failed: number } | null
  error: string
}

export function useTodoRegister(source: 'mail' | 'meeting' | 'chat', room?: string) {
  const { t } = useI18n()
  const [state, setState] = useState<TodoRegisterState>({ busy: false, done: null, error: '' })
  /** 같은 묶음을 다시 누르면(네트워크 재시도) 같은 키 — 서버가 첫 결과를 돌려준다 */
  const keys = useRef(new Map<string, string>())

  async function register(items: TaskCreateItem[]) {
    if (!items.length || state.busy) return
    setState(s => ({ ...s, busy: true, error: '' }))
    try {
      const withKeys = items.map((it) => {
        const k = `${it.title}|${it.assignee_id || ''}|${it.due_date || ''}`
        if (!keys.current.has(k)) keys.current.set(k, idemKey(source, k))
        return { ...it, idempotency_key: keys.current.get(k) }
      })
      const res = await createInlineTasks({ source, room, items: withKeys })
      const ok = res.results.filter(r => r.ok)
      const failed = res.results.length - ok.length
      setState({ busy: false, error: failed && !ok.length ? (res.results[0]?.error || t('aiInline.todo.failed')) : '', done: ok.length ? { count: ok.length, requestIds: ok.map(r => r.request_id!).filter(Boolean), failed } : null })
      if (failed && ok.length) addToast('warning', t('aiInline.todo.partial', { n: failed }))
    } catch (e) {
      setState(s => ({ ...s, busy: false, error: inlineError(e, t('aiInline.todo.failed')).message }))
    }
  }

  async function undo() {
    const d = state.done
    if (!d) return
    const n = await undoInlineTasks(d.requestIds)
    if (n) {
      addToast('info', t('aiInline.todo.undone', { n }))
      keys.current.clear()
      setState(s => ({ ...s, done: null }))
    } else {
      addToast('error', t('aiInline.todo.undoFailed'))
    }
  }

  return { ...state, register, undo }
}

/** 등록 결과 한 줄 */
export function TodoRegisteredLine({ count, onUndo }: { count: number; onUndo: () => void }) {
  const { t } = useI18n()
  return (
    <p role="status" className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <UiIcon name="check" className="h-3.5 w-3.5 text-success" strokeWidth={2.6} />
      <span>{t('aiInline.todo.registered', { n: count })}</span>
      <button type="button" className="font-semibold text-primary hover:underline" onClick={onUndo}>{t('aiInline.todo.undo')}</button>
      <NuxtLink to="/tasks" className="text-primary hover:underline">{t('aiInline.todo.open')}</NuxtLink>
    </p>
  )
}
