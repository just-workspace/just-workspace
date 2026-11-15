/**
 * 채널 탭 — 파일(시안 ChannelTabs variant=files · 11 답 D6a). Vue 원본: frontend/components/chat/ChannelFilesTab.vue (ChatChannelFilesTab)
 *  줄 44: "연결된 폴더" muted + 굵게 "내 파일 › 프로젝트 › 개발" + muted "· 채널에 올린 파일 포함" … [파일에서 열기 32][업로드 32 primary]
 *  목록 행 48: [종류 타일 28 + 이름 | 올린 사람 · 메시지에서/폴더 160 | 시각 mono 11 120 | ⋮ 40(메시지로 가기·공유·다운로드)]
 *  모바일은 가운데 두 칸을 이름 아래 한 줄로 접는다.
 *  업로드: 내 폴더가 연결돼 있으면 그 폴더로, 아니면 채팅 첨부(메시지 탭으로 넘어가 입력창 첨부 칸에).
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { fetchFiles, fileKindLabel, type ChannelFileItem, type ChannelFolder, type ChannelTabKey } from '~/composables/useChannelTabs'
import { uploadFiles, type FileItem } from '~/composables/useFiles'
import { addFiles } from '~/composables/useChatAttachments'
import { openThread } from '~/composables/useChat'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiIconButton } from '~/components/ui/IconButton'
import { ChatFileShareModal } from './FileShareModalBridge'

export interface ChatChannelFilesTabProps {
  channelId: string
  /** 탭 관리 권한(폴더 연결 링크) */
  canManage: boolean
  /** 탭 관리 열기 */
  onManage?: () => void
  /** 다른 탭으로(메시지로 가기·채팅 첨부) */
  onSwitch?: (tab: ChannelTabKey) => void
  /** 폴더에 올림 — 요약 다시 읽기 */
  onChanged?: () => void
}

/** 채널 파일 탭 */
export function ChatChannelFilesTab({ channelId, canManage, onManage, onSwitch, onChanged }: ChatChannelFilesTabProps) {
  const { t } = useI18n()

  const [items, setItems] = useState<ChannelFileItem[]>([])
  const [folder, setFolder] = useState<ChannelFolder | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const r = await fetchFiles(channelId)
      setItems(r.items)
      setFolder(r.folder)
    } catch { setFailed(true) }
    finally { setLoading(false) }
  }, [channelId])
  useEffect(() => { void load() }, [load])

  const folderText = (() => {
    const f = folder
    if (!f) return ''
    const root = f.mine ? t('files.sidebar.myFiles') : f.owner_name
    return [root, ...f.segments].join(' › ')
  })()

  function openInFiles() {
    const f = folder
    if (!f) return
    if (f.mine && f.path) void navigateTo({ path: '/files', query: { path: f.path } })
    else void navigateTo({ path: '/files', query: { view: 'shared-with-me' } })
  }

  // ── 업로드 ──
  const picker = useRef<HTMLInputElement | null>(null)
  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const files = Array.from(input.files || [])
    input.value = ''
    if (!files.length) return
    const f = folder
    if (f?.mine && f.path && f.accessible) {
      await uploadFiles(files, f.path)
      await load()
      onChanged?.()
    } else {
      addFiles(channelId, files)
      onSwitch?.('messages')
    }
  }

  // ── 시각: 오늘 HH:MM · 어제 · MM/DD ──
  function when(iso: string | null) {
    if (!iso) return ''
    const d = new Date(iso)
    const now = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
    if (sameDay(d, now)) return `${p(d.getHours())}:${p(d.getMinutes())}`
    const y = new Date(now)
    y.setDate(now.getDate() - 1)
    if (sameDay(d, y)) return t('chat.tabs.yesterday')
    return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
  }
  function sourceText(it: ChannelFileItem) {
    return `${it.who} · ${it.source === 'message' ? t('chat.tabs.fromMessage') : t('chat.tabs.fromFolder')}`
  }

  // ── 행 메뉴 ──
  const [shareItem, setShareItem] = useState<FileItem[] | null>(null)
  function menuItems(it: ChannelFileItem): UiMenuItem[] {
    const out: UiMenuItem[] = []
    if (it.message_id) out.push({ key: 'goto', label: t('chat.tabs.gotoMessage'), icon: 'message-square' })
    if (it.source === 'folder' && folder?.mine && it.path) out.push({ key: 'share', label: t('common.share'), icon: 'share' })
    out.push({ key: 'download', label: t('common.download'), icon: 'download', disabled: !it.url })
    return out
  }
  function onMenu(it: ChannelFileItem, key: string) {
    if (key === 'goto' && it.message_id) {
      onSwitch?.('messages')
      void openThread(it.message_id)
    } else if (key === 'share' && it.path) {
      setShareItem([{ name: it.name, path: it.path, is_dir: false, size: it.size } as FileItem])
    } else if (key === 'download' && it.url) {
      const a = document.createElement('a')
      a.href = it.url
      a.download = it.name
      a.click()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 연결된 폴더 줄 44 */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-1.5 text-[13px]">
        {folder
          ? (
            <>
              <span className="text-muted-foreground">{t('chat.tabs.linkedFolder')}</span>
              <b className="min-w-0 truncate font-semibold">{folderText}</b>
              <span className="hidden text-muted-foreground sm:inline">· {folder.accessible ? t('chat.tabs.includesChannelFiles') : t('chat.tabs.folderUnavailable')}</span>
            </>
          )
          : (
            <>
              <span className="text-muted-foreground">{t('chat.tabs.noFolder')}</span>
              {canManage && <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => onManage?.()}>{t('chat.tabs.linkFolder')}</button>}
            </>
          )}
        <span className="flex-1" />
        {folder?.accessible && <UiButton variant="outline" size="xs" className="h-8 shrink-0 bg-transparent px-3" onClick={openInFiles}>{t('chat.tabs.openInFiles')}</UiButton>}
        <UiButton size="xs" className="h-8 shrink-0 px-3 font-semibold" onClick={() => picker.current?.click()}>{t('chat.tabs.upload')}</UiButton>
        <input ref={picker} type="file" multiple className="hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => { void onPick(e) }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading
          ? <UiSkeleton preset="list" rows={6} className="p-4" />
          : failed
            ? <UiErrorTile placement="panel" title={t('chat.tabs.filesFailed')} onRetry={() => { void load() }} />
            : !items.length
              ? <UiEmptyState variant="panel" icon="folder" title={t('chat.tabs.noFiles')} description={t('chat.tabs.noFilesHint')} />
              : (
                <ul aria-label={t('chat.tabs.files')}>
                  {items.map(it => (
                    <li
                      key={`${it.source}:${it.message_id || it.path || it.name}`}
                      className="grid min-h-12 grid-cols-[1fr_40px] items-center border-b border-border py-1 pl-4 pr-2 text-[13px] md:grid-cols-[1fr_160px_120px_40px]"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] bg-muted text-[9px] font-bold text-muted-foreground" aria-hidden="true">{fileKindLabel(it.name)}</span>
                        <span className="min-w-0">
                          {it.url
                            ? (
                              <a
                                href={it.url}
                                target="_blank"
                                rel="noopener"
                                className="block truncate hover:underline"
                              >{it.name}</a>
                            )
                            : <span className="block truncate">{it.name}</span>}
                          <span className="block truncate text-xs text-muted-foreground md:hidden">{sourceText(it)} · {when(it.at)}</span>
                        </span>
                      </span>
                      <span className="hidden truncate text-muted-foreground md:block">{sourceText(it)}</span>
                      <span className="hidden font-mono text-[11px] text-muted-foreground md:block">{when(it.at)}</span>
                      <UiMenu
                        items={menuItems(it)}
                        label={t('chat.tabs.fileMenu', { name: it.name })}
                        align="end"
                        onSelect={(k) => onMenu(it, k)}
                        trigger={({ toggle, open, controls }) => (
                          <UiIconButton
                            label={t('chat.tabs.fileMenu', { name: it.name })}
                            icon="more-vertical"
                            aria-haspopup="menu"
                            aria-expanded={open}
                            aria-controls={controls}
                            noTooltip
                            className="h-10 w-10 text-muted-foreground md:h-8 md:w-8"
                            onClick={toggle}
                          />
                        )}
                      />
                    </li>
                  ))}
                </ul>
              )}
      </div>

      {shareItem && <ChatFileShareModal items={shareItem} initialTab="people" onClose={() => setShareItem(null)} />}
    </div>
  )
}

export default ChatChannelFilesTab
