/**
 * 카테고리 ⋯ 메뉴(항목·순서·단축키 글자 그대로).
 *  사용자 카테고리(MANAGE_CHANNELS): 채널 만들기 · 이름 바꾸기 F2 · 카테고리 권한 · 알림 설정 › | 위로 옮기기 Alt ↑ · 아래로 옮기기 Alt ↓ · 모두 접기 | 카테고리 삭제
 *  시스템 "보관된 프로젝트": 이름 바꾸기 · 카테고리 권한 · 알림 설정 › | 모두 접기 (삭제·옮기기 없음)
 *  권한 없음: 알림 설정 › · 모두 접기
 * 알림 설정 › = 안의 채널 전부에 음소거 기간(채널 메뉴와 같은 6개) + 알림 켜기. 카테고리 권한 = 채팅 설정 category-perm.
 */
import { useI18n } from '~/i18n'
import { openChatSettings } from '~/composables/useChatUi'
import { addToast } from '~/composables/useToast'
import type { SidebarSection } from '~/composables/useChatLayout'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { muteChildren, muteFor, muteKeyMinutes, unmute } from './ChatChannelMenu'

export interface ChatCategoryMenuProps {
  section: SidebarSection
  anchor: DOMRect | HTMLElement
  canManage: boolean
  /** 위·아래로 옮길 수 있나(사용자 카테고리 목록 끝이면 false) */
  canUp: boolean
  canDown: boolean
  onClose: () => void
  onCreateChannel: () => void
  onRename: () => void
  onMove: (delta: -1 | 1) => void
  onCollapseAll: () => void
  onDelete: () => void
}

export function ChatCategoryMenu({ section, anchor, canManage, canUp, canDown, onClose, onCreateChannel, onRename, onMove, onCollapseAll, onDelete }: ChatCategoryMenuProps) {
  const { t } = useI18n()
  const user = section.kind === 'user'
  const sys = section.kind === 'system'
  const hasCat = !!section.category
  const notify: UiMenuItem = {
    key: 'notify', label: t('chat.side.cat.notify'), panelWidth: 200,
    children: [...muteChildren(t), { key: 'unmute-all', label: t('chat.side.cat.unmuteAll'), separated: true }],
  }

  const items: UiMenuItem[] = [{ key: 'title', label: section.name, heading: true }]
  if (canManage && user) {
    items.push(
      { key: 'create', label: t('chat.side.cat.createChannel') },
      { key: 'rename', label: t('chat.side.cat.rename'), hint: 'F2' },
      { key: 'perm', label: t('chat.side.cat.perm') },
      notify,
      { key: 'up', label: t('chat.side.cat.up'), hint: 'Alt ↑', separated: true, disabled: !canUp },
      { key: 'down', label: t('chat.side.cat.down'), hint: 'Alt ↓', disabled: !canDown },
      { key: 'collapse', label: t('chat.side.cat.collapseAll') },
      { key: 'delete', label: t('chat.side.cat.delete'), danger: true, separated: true },
    )
  } else if (canManage && sys && hasCat) {
    items.push(
      { key: 'rename', label: t('chat.side.cat.rename'), hint: 'F2' },
      { key: 'perm', label: t('chat.side.cat.perm') },
      notify,
      { key: 'collapse', label: t('chat.side.cat.collapseAll'), separated: true },
    )
  } else {
    items.push(notify, { key: 'collapse', label: t('chat.side.cat.collapseAll'), separated: true })
  }

  async function run(key: string) {
    const mins = muteKeyMinutes(key)
    if (mins !== undefined || key === 'unmute-all') {
      try {
        await Promise.all(section.channels.map(c => (mins !== undefined ? muteFor(c.id, mins) : unmute(c.id))))
      } catch {
        addToast('error', t('chat.side.muteFailed'))
      }
      return
    }
    if (key === 'create') onCreateChannel()
    else if (key === 'rename') onRename()
    else if (key === 'perm' && section.category) openChatSettings('category-perm', section.category.id)
    else if (key === 'up') onMove(-1)
    else if (key === 'down') onMove(1)
    else if (key === 'collapse') onCollapseAll()
    else if (key === 'delete') onDelete()
  }

  return (
    <UiMenu
      anchor={anchor}
      align="start"
      width={236}
      dense
      label={t('chat.side.catMenu')}
      title={section.name}
      items={items}
      onSelect={(k) => { void run(k) }}
      onClose={onClose}
    />
  )
}

export default ChatCategoryMenu
