/**
 * 허용·거부 규칙 — Claude Code 의 /permissions(allow·deny) 자리.
 * 이 대화에서 허용(카드 "예, 이 대화에서는 다시 묻지 않기") · 항상 허용 · 거부를 보고 빼거나 더한다.
 * 거부가 허용보다 먼저다. 내장 AI 대화에만 적용(외부 커넥터는 승인 대기함 규칙 그대로).
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { UiSelect } from '~/components/ui/Select'
import { UiBadge } from '~/components/ui/Badge'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { approvalsApi, type PermissionRules } from '~/composables/useApprovals'
import { addToast } from '~/composables/useToast'

export function AiPermissionRules({ conversationId, onClose }: { conversationId?: string | null; onClose: () => void }) {
  const { t } = useI18n()
  const [data, setData] = useState<PermissionRules | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    approvalsApi.rules(conversationId).then(setData).catch(() => { addToast('error', t('ai.rules.loadFailed')); onClose() })
  }, [conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = (name: string) => data?.tools.find(x => x.name === name)?.title || name
  const risk = (name: string) => data?.tools.find(x => x.name === name)?.risk || 'low'

  async function save(allow: string[], deny: string[]) {
    if (!data) return
    setBusy(true)
    try {
      const r = await approvalsApi.setRules(allow, deny)
      setData({ ...data, ...r })
    } catch { addToast('error', t('ai.rules.saveFailed')) } finally { setBusy(false) }
  }
  async function dropConv(tool: string) {
    if (!data || !conversationId) return
    setBusy(true)
    try {
      const r = await approvalsApi.dropConversationRule(conversationId, tool)
      setData({ ...data, conversation: r.conversation })
    } catch { addToast('error', t('ai.rules.saveFailed')) } finally { setBusy(false) }
  }

  const row = (name: string, onRemove: () => void) => (
    <li key={name} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-[13px]">
      <span className="min-w-0 flex-1 truncate">{title(name)}</span>
      <span className="hidden font-mono text-[11.5px] text-muted-foreground sm:inline">{name}</span>
      {risk(name) === 'high' && <UiBadge tone="danger" tint size={18}>high</UiBadge>}
      <UiButton size="sm" variant="ghost" disabled={busy} onClick={onRemove} aria-label={t('ai.rules.remove', { title: title(name) })}>
        <UiIcon name="close" className="h-3.5 w-3.5" />
      </UiButton>
    </li>
  )
  const section = (label: string, hint: string, names: string[], onRemove: (n: string) => void) => (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="text-sm font-semibold">{label} <span className="font-normal text-muted-foreground">{names.length}</span></h3>
        <p className="text-[12.5px] text-muted-foreground">{hint}</p>
      </div>
      {names.length ? <ul className="flex flex-col gap-1.5">{names.map(n => row(n, () => onRemove(n)))}</ul>
        : <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">{t('ai.rules.none')}</p>}
    </section>
  )

  const free = data ? data.tools.filter(x => !data.allow.includes(x.name) && !data.deny.includes(x.name)) : []

  return (
    <UiModal title={t('ai.rules.title')} size="520" onClose={onClose}>
      {!data ? <UiSkeleton preset="text" rows={6} delay={false} /> : (
        <div className="flex flex-col gap-5">
          <p className="text-[13px] text-muted-foreground">{t('ai.rules.intro')}</p>
          {conversationId && section(t('ai.rules.conversation'), t('ai.rules.conversationHint'), data.conversation, n => { void dropConv(n) })}
          {section(t('ai.rules.allow'), t('ai.rules.allowHint'), data.allow, n => { void save(data.allow.filter(x => x !== n), data.deny) })}
          {section(t('ai.rules.deny'), t('ai.rules.denyHint'), data.deny, n => { void save(data.allow, data.deny.filter(x => x !== n)) })}
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">{t('ai.rules.add')}</h3>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[200px] flex-1">
                <UiSelect
                  modelValue={pick} onUpdateModelValue={v => setPick(String(v ?? ''))} placeholder={t('ai.rules.pickTool')}
                  aria-label={t('ai.rules.pickTool')} search
                  options={free.map(x => ({ value: x.name, label: `${x.title}${x.risk === 'high' ? ' · high' : ''}` }))}
                />
              </div>
              <UiButton size="sm" variant="outline" disabled={busy || !pick} onClick={() => { void save([...data.allow, pick], data.deny); setPick('') }}>{t('ai.rules.addAllow')}</UiButton>
              <UiButton size="sm" variant="outline" disabled={busy || !pick} onClick={() => { void save(data.allow, [...data.deny, pick]); setPick('') }}>{t('ai.rules.addDeny')}</UiButton>
            </div>
          </section>
        </div>
      )}
    </UiModal>
  )
}
