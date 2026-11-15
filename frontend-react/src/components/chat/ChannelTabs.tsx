/**
 * 채널 탭 줄(12 답 A6 · 시안 R12Channel). Vue 원본: frontend/components/chat/ChannelTabs.vue (Nuxt 이름 ChatChannelTabs)
 * UiTabs(밑줄 탭, 40) + trailing 톱니(탭 관리 — 관리 권한이 있을 때만).
 *  메시지 · 파일 n · 위키 n(스페이스 페이지 수) · 회의 n(예정) · 작업 n(열림) — 순서·끄기는 채널 설정(layout)을 따른다.
 *  모듈이 꺼진 탭과 스페이스가 연결 안 된 위키 탭은 줄에서 뺀다(탭 관리 창에서는 흐리게 보인다).
 */
import { useI18n } from '~/i18n'
import { usePlatform } from '~/composables/usePlatform'
import { orderedTabs, type ChannelTabKey, type ChannelTabMovable, type ChannelTabsSummary } from '~/composables/useChannelTabs'
import { UiTabs, type TabItem } from '~/components/ui/Tabs'
import { UiIconButton } from '~/components/ui/IconButton'

export interface ChatChannelTabsProps {
  /** 탭 요약(파일 수·위키·회의·작업·순서·관리 권한). 읽기 전 null */
  summary: ChannelTabsSummary | null
  /** 고른 탭(Vue v-model) */
  modelValue: ChannelTabKey
  onUpdateModelValue?: (v: ChannelTabKey) => void
  /** 톱니 › 탭 관리 */
  onManage?: () => void
}

/** 탭 키 → 모듈 id(모듈이 꺼지면 탭도 꺼진다) */
export const TAB_MODULE: Record<ChannelTabMovable, string> = { files: 'files', wiki: 'wiki', meetings: 'meetings', tasks: 'tasks' }

/** 지금 줄에 보일 탭(메시지 제외) — 순서·끄기·모듈·위키 스페이스 연결을 반영 */
export function visibleChannelTabs(summary: ChannelTabsSummary | null, moduleOn: (id: string) => boolean): ChannelTabMovable[] {
  return orderedTabs(summary)
    .filter(x => x.visible && moduleOn(TAB_MODULE[x.key]))
    .filter(x => x.key !== 'wiki' || !!(summary?.wiki_space || summary?.wiki))
    .map(x => x.key)
}

/** 채널 탭 줄 */
export function ChatChannelTabs({ summary, modelValue, onUpdateModelValue, onManage }: ChatChannelTabsProps) {
  const { t } = useI18n()
  const { isModuleEnabled } = usePlatform()

  const count = (k: ChannelTabMovable): number | undefined => {
    if (!summary) return undefined
    if (k === 'files') return summary.files_count
    if (k === 'wiki') return summary.wiki_space?.pages
    if (k === 'meetings') return summary.meetings_upcoming
    return summary.tasks_open
  }
  const items: TabItem[] = [
    { key: 'messages', label: t('chat.tabs.messages') },
    ...visibleChannelTabs(summary, isModuleEnabled).map(k => ({ key: k, label: t(`chat.tabs.${k}`), count: count(k) })),
  ]

  return (
    <UiTabs
      ariaLabel={t('chat.tabs.label')}
      modelValue={modelValue}
      onUpdateModelValue={(v) => { if (v) onUpdateModelValue?.(v as ChannelTabKey) }}
      items={items}
      className="border-b border-border px-2"
      trailing={summary?.can_manage ? <UiIconButton icon="settings" label={t('chat.tabs.manage')} onClick={() => onManage?.()} /> : undefined}
    />
  )
}

export default ChatChannelTabs
