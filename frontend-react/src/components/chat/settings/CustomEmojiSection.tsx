/**
 * 커스텀 이모지 관리(Settings22 #emoji #emoji-noperm #emoji-empty · 모바일 #m-emoji).
 * 제목에 개수("커스텀 이모지 — 12 / 200") · 안내 한 줄(형식 · 크기 · 이름 규칙) + [이모지 올리기](여러 파일).
 * 표 64 / 1fr / 160 / 120 / 48: 그림 36(primary/10) · :이름:(mono, GIF 꼬리표 · 눌러서 이름 바꾸기) · 올린 사람 · 날짜 mono · 삭제.
 * 권한 없음(can_manage false) = banner + 올리기·삭제·이름 바꾸기 잠김. 빈 상태 = 점선 칸.
 * 바꾼 뒤 컴포저 캐시(useChatEmoji.loadCustomEmojis(true))를 갱신한다.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import {
  deleteCustomEmoji, emojiErrorCode, fetchCustomEmojis, renameCustomEmoji, type CustomEmoji, type EmojiErrorCode,
} from '~/composables/chatApi22'
import { loadCustomEmojis } from '~/composables/useChatEmoji'
import { EMOJI_TYPES, checkEmojiName, emojiErrorKey } from './settingsLogic'
import { EmojiUploadDialog } from './EmojiUploadDialog'
import { MobileHeader, SettingsBanner, SettingsHeader, errorText, useSettingsCtx } from './parts'

const GRID = { gridTemplateColumns: '64px 1fr 160px 120px 48px' }
const ymd = (iso: string) => (iso || '').slice(0, 10)

export function CustomEmojiSection() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const { mobile, backToMenu } = useSettingsCtx()
  const [items, setItems] = useState<CustomEmoji[] | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [limit, setLimit] = useState(200)
  const [loadErr, setLoadErr] = useState('')
  const [files, setFiles] = useState<File[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editErr, setEditErr] = useState<EmojiErrorCode | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  async function reload(refreshCache = false) {
    try {
      const r = await fetchCustomEmojis()
      setItems(r.items || []); setCanManage(!!r.can_manage); setLimit(r.limit || 200); setLoadErr('')
    } catch (e) { setItems([]); setLoadErr(errorText(e, t('chat.settings.emoji.loadFail'))) }
    if (refreshCache) void loadCustomEmojis(true).catch(() => {})
  }
  useEffect(() => { void reload() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function pick() { fileRef.current?.click() }
  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    if (list.length) setFiles(list)
  }
  async function remove(em: CustomEmoji) {
    if (!(await confirmBox(t('chat.settings.emoji.deleteConfirm', { name: `:${em.name}:` }), { danger: true, confirmLabel: t('common.delete') }))) return
    try { await deleteCustomEmoji(em.id); await reload(true) } catch (e) { addToast('error', errorText(e, t('chat.settings.emoji.deleteFail'))) }
  }
  function startRename(em: CustomEmoji) {
    if (!canManage) return
    setEditing(em.id); setEditName(em.name); setEditErr(null)
  }
  async function commitRename(em: CustomEmoji) {
    const name = editName.trim().toLowerCase()
    if (name === em.name) { setEditing(null); return }
    const err = checkEmojiName(name, (items || []).filter(x => x.id !== em.id).map(x => x.name))
    if (err) { setEditErr(err); return }
    try {
      await renameCustomEmoji(em.id, name)
      setEditing(null)
      await reload(true)
    } catch (e) { setEditErr(emojiErrorCode(e) ?? ('failed' as EmojiErrorCode)) }
  }

  const n = items?.length ?? 0
  const title = t('chat.settings.emoji.title', { n, limit })
  const banner = loadErr
    ? <SettingsBanner tone="danger" icon="alert-circle">{loadErr}</SettingsBanner>
    : items && !canManage ? <SettingsBanner tone="info" icon="lock">{t('chat.settings.emoji.noPerm')}</SettingsBanner> : null
  const input = (
    <input ref={fileRef} type="file" multiple accept={EMOJI_TYPES.join(',')} className="hidden" aria-hidden="true" tabIndex={-1} onChange={onFiles} />
  )
  const dialog = files && (
    <EmojiUploadDialog
      files={files}
      existing={(items || []).map(x => x.name)}
      limit={limit}
      onClose={() => setFiles(null)}
      onUploaded={k => { addToast('success', t('chat.settings.emoji.uploaded', { n: k })); void reload(true) }}
    />
  )
  const empty = items && !items.length && !loadErr && (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-14 text-center">
      <span className="text-3xl" aria-hidden="true">🙂</span>
      <p className="text-[15px] font-semibold">{t('chat.settings.emoji.emptyTitle')}</p>
      <p className="text-[13px] text-muted-foreground">{t('chat.settings.emoji.emptyDesc', { app: appName })}</p>
    </div>
  )

  const nameCell = (em: CustomEmoji) => editing === em.id
    ? (
      <span className="flex min-w-0 flex-col gap-0.5 pr-3">
        <span className="flex h-8 items-center rounded-md border-2 border-ring bg-background px-2 font-mono text-[14px]">
          <span aria-hidden="true" className="text-muted-foreground">:</span>
          <input
            autoFocus
            aria-label={t('chat.settings.emoji.renameAria', { name: em.name })}
            aria-invalid={!!editErr}
            className="min-w-0 flex-1 bg-transparent outline-hidden"
            value={editName}
            maxLength={32}
            spellCheck={false}
            onChange={e => { setEditName(e.target.value.toLowerCase()); setEditErr(null) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); void commitRename(em) }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null) }
            }}
            onBlur={() => void commitRename(em)}
          />
          <span aria-hidden="true" className="text-muted-foreground">:</span>
        </span>
        {editErr && <span role="alert" className="text-[12px] text-danger">{t(emojiErrorKey(editErr), { name: `:${editName}:`, limit })}</span>}
      </span>
    )
    : (
      <span className="flex min-w-0 items-center gap-2 font-mono">
        {canManage
          ? <button type="button" title={t('chat.settings.emoji.rename')} className="truncate rounded-sm text-left hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => startRename(em)}>:{em.name}:</button>
          : <span className="truncate">:{em.name}:</span>}
        {em.animated && <span className="rounded bg-muted px-1 text-[10px] font-bold text-muted-foreground">GIF</span>}
      </span>
    )
  const by = (em: CustomEmoji) => em.created_by?.display_name || em.created_by?.username || '—'

  if (mobile) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title={t('chat.settings.emoji.titleMobile', { n, limit })} onBack={backToMenu} addLabel={canManage ? t('chat.settings.emoji.upload') : undefined} onAdd={pick} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
          {banner && <div className="pb-2">{banner}</div>}
          {empty}
          {(items || []).map(em => (
            <div key={em.id} className="flex min-h-14 items-center gap-3 border-b border-border px-1 py-1.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10"><img src={em.url} alt="" className="h-7 w-7 object-contain" /></span>
              <div className="min-w-0 flex-1">
                <div className="text-[16px]">{nameCell(em)}</div>
                <p className="text-[13px] text-muted-foreground">{by(em)} · {ymd(em.created_at)}</p>
              </div>
              <UiIconButton icon="trash" label={t('chat.settings.emoji.deleteAria', { name: em.name })} size="lg" disabled={!canManage} onClick={() => void remove(em)} />
            </div>
          ))}
        </div>
        {input}{dialog}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title={title} sub={t('chat.settings.emoji.sub')} />
      {banner}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <p className="flex-1 text-[13px] text-muted-foreground">{t('chat.settings.emoji.hint')}</p>
          <UiButton type="button" icon="upload" disabled={!canManage} onClick={pick}>{t('chat.settings.emoji.upload')}</UiButton>
        </div>
        {empty}
        {items && items.length > 0 && (
          <div role="table" aria-label={title} className="flex flex-col">
            <div role="row" className="grid border-b border-border pb-2 text-[12px] font-semibold text-muted-foreground" style={GRID}>
              <span role="columnheader">{t('chat.settings.emoji.colImage')}</span>
              <span role="columnheader">{t('chat.settings.emoji.colName')}</span>
              <span role="columnheader">{t('chat.settings.emoji.colBy')}</span>
              <span role="columnheader">{t('chat.settings.emoji.colAt')}</span>
              <span role="columnheader"><span className="sr-only">{t('common.delete')}</span></span>
            </div>
            {items.map(em => (
              <div key={em.id} role="row" className="grid items-center border-b border-border py-2 text-[14px]" style={GRID}>
                <span role="cell" className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10"><img src={em.url} alt={`:${em.name}:`} className="h-7 w-7 object-contain" /></span>
                <span role="cell" className="min-w-0">{nameCell(em)}</span>
                <span role="cell" className="truncate text-muted-foreground">{by(em)}</span>
                <span role="cell" className="font-mono text-[12px] text-muted-foreground">{ymd(em.created_at)}</span>
                <span role="cell"><UiIconButton icon="trash" label={t('chat.settings.emoji.deleteAria', { name: em.name })} size="sm" disabled={!canManage} onClick={() => void remove(em)} /></span>
              </div>
            ))}
          </div>
        )}
        {items === null && <p className="py-6 text-[13px] text-muted-foreground">{t('common.loading')}</p>}
      </div>
      {input}{dialog}
    </div>
  )
}

export default CustomEmojiSection
