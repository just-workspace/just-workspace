/**
 * 빈 대화(Vue components/ai/AiEmptyChat.vue · 시안 AI2 AiDesktop:31): 가운데 정렬 · 간격 20 · 타일 48(r14 secondary + 반짝임 24) · h1 22/700
 *  · 추천 2열 680(간격 10, 카드 14 16 · r12 · 제목 14/600 + 설명 12 muted) · 아래 줄 12 muted(켜진 도구 — 모델 성격).
 * 모바일은 1열.
 */
import { useI18n } from '~/i18n'
import { useAiLabels } from '~/composables/useAiLabels'
import { UiIcon } from '~/components/ui/Icon'
import type { AiStatus } from '~/utils/aiAssist'

export interface AiEmptyChatProps {
  /** /api/ai/status 응답(모델 성격·도구 이름) */
  status: AiStatus | null
  /** 이 대화에서 도구가 켜졌는가 */
  toolsEnabled: boolean
  /** 추천 카드 고름 — 카드의 프롬프트 */
  onPick?: (prompt: string) => void
}

const KEYS = ['today', 'mail', 'draft', 'find'] as const

export function AiEmptyChat({ status, toolsEnabled, onPick }: AiEmptyChatProps) {
  const { t } = useI18n()
  const { labelledGroups } = useAiLabels()

  const suggestions = KEYS.map(k => ({
    key: k,
    title: t(`ai.empty.suggestions.${k}.title`),
    desc: t(`ai.empty.suggestions.${k}.desc`),
    prompt: t(`ai.empty.suggestions.${k}.prompt`),
  }))

  const footnote = (() => {
    const s = status
    const groups = labelledGroups(s?.tools ?? [])
    const tools = toolsEnabled && groups.length
      ? t('ai.empty.toolsOn', { tools: groups.map(g => g.label).join(' · ') })
      : t('ai.empty.toolsOff')
    const model = s?.using_personal ? t('ai.empty.personal') : s?.external ? t('ai.empty.external') : t('ai.empty.local')
    return `${tools} — ${model}`
  })()

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 p-4 md:p-6">
      <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-[14px] bg-secondary text-foreground">
        <UiIcon name="sparkles" className="h-6 w-6" />
      </span>
      <h2 className="m-0 text-[22px] font-bold text-foreground">{t('ai.empty.title')}</h2>
      <div className="grid w-full max-w-[680px] grid-cols-1 gap-2.5 sm:grid-cols-2">
        {suggestions.map(s => (
          <button
            key={s.key}
            type="button"
            className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onPick?.(s.prompt)}
          >
            <b className="text-sm font-semibold text-foreground">{s.title}</b>
            <span className="text-xs text-muted-foreground">{s.desc}</span>
          </button>
        ))}
      </div>
      <p className="m-0 max-w-[680px] text-center text-xs text-muted-foreground">{footnote}</p>
    </div>
  )
}

export default AiEmptyChat
