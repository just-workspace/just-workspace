/**
 * 메시지 첨부(handover-22 "첨부" · Rich22 #att #att2 · Mob22 #m-att).
 *  · 이미지 그리드: 6칸 격자 · 간격 4 · radius 8 · 최대 550.
 *    1 = 16:9(크기를 알면 원래 비율, 최대 550×350) · 2 = 반반 정사각 · 3 = 큰 1 + 작은 2 · 4 = 2×2 ·
 *    5–10 = 위 줄 나머지(2 → 위 2 + 아래 3, 디스코드식) + 아래 3씩 · 10장 넘으면 10칸째에 "+N"
 *  · 영상 = 포스터 + 길이 꼬리표 + 아래 컨트롤 36(play/pause) · 소리 = 카드 + 재생 줄 · 파일 카드 radius 8 · 패딩 16
 *  · 스포일러 첨부 = 덮개 + "스포일러" 알약(누르면 보임) · 이미지는 누르면 전체 화면 보기(ChatImageViewer)
 *  · 업로드 중(COMPOSER 낙관 메시지 `_upload`): 진행 막대 + 취소 / 실패 = danger 카드 + 다시 시도 / 크기 초과 = 다시 시도 없음
 *  · 옛 단일 file_meta 메시지(attachments 없음)도 1장짜리로 같은 그림.
 */
import { memo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { apiUrl, isBundledApp } from '~/lib/runtimeConfig'
import { downloadApi } from '~/utils/apiDownload'
import type { ChatMessage } from '~/composables/useChat'
import { discardUpload, formatChatFileSize, retryUpload } from '~/composables/useChatAttachments'
import { userPrefsStore } from '~/composables/useUserPrefs'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'
export interface ViewAttachment {
  id: string
  filename: string
  size: number
  mime: string
  /** 원본(다운로드·전체 화면) — API 경로면 apiUrl 전 */
  url: string
  /** 미리보기(그리드 칸) */
  thumb: string
  width: number | null
  height: number | null
  duration: number | null
  spoiler: boolean
  alt: string | null
  kind: AttachmentKind
  ext: string
}

const IMG_EXT = /^(jpg|jpeg|png|webp|gif|svg|bmp|avif)$/
const VID_EXT = /^(mp4|mov|webm|mkv|m4v)$/
const AUD_EXT = /^(mp3|wav|m4a|ogg|oga|flac|aac|opus)$/

export function extOf(name: string): string {
  const n = (name || '').toLowerCase()
  const d = n.lastIndexOf('.')
  return d >= 0 ? n.slice(d + 1) : ''
}
export function attachmentKind(mime: string | null | undefined, filename: string): AttachmentKind {
  const m = mime || ''
  const e = extOf(filename)
  if (m.startsWith('image/') || (!m && IMG_EXT.test(e))) return 'image'
  if (m.startsWith('video/') || (!m && VID_EXT.test(e))) return 'video'
  if (m.startsWith('audio/') || (!m && AUD_EXT.test(e))) return 'audio'
  if (!m.startsWith('application/') && IMG_EXT.test(e)) return 'image'
  return 'file'
}

/** 메시지 → 보여 줄 첨부. attachments 가 있으면 그것, 없으면 옛 file_meta 한 장 */
export function messageAttachments(msg: Pick<ChatMessage, 'id' | 'attachments' | 'file_meta' | 'content' | 'message_type'>): ViewAttachment[] {
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    return msg.attachments.map((a) => {
      const kind = attachmentKind(a.mime_type, a.filename)
      return {
        id: a.id, filename: a.filename, size: a.size || 0, mime: a.mime_type || '', url: a.url, thumb: a.url,
        width: a.width ?? null, height: a.height ?? null, duration: a.duration ?? null,
        spoiler: !!a.spoiler, alt: a.alt ?? null, kind, ext: extOf(a.filename),
      }
    })
  }
  if (!msg.file_meta) return []
  let fm: Record<string, any> | null
  try { fm = JSON.parse(msg.file_meta) } catch { fm = null }
  if (!fm || fm.kind === 'pin') return []
  const filename: string = fm.name || fm.filename || msg.content || ''
  const mime: string = fm.mime_type || ''
  const kind = attachmentKind(mime, filename)
  const isGif = mime === 'image/gif' || extOf(filename) === 'gif'
  const url: string = fm.path ? `/api/files/download?path=${encodeURIComponent(fm.path)}` : (fm.url || '')
  const thumb = fm.path && kind === 'image' && !isGif ? `/api/files/preview?path=${encodeURIComponent(fm.path)}` : url
  if (!url) return []
  return [{
    id: msg.id + ':0', filename, size: fm.size || 0, mime, url, thumb,
    width: fm.width ?? null, height: fm.height ?? null, duration: fm.duration ?? null,
    spoiler: !!fm.spoiler, alt: fm.alt ?? null, kind, ext: extOf(filename),
  }]
}

// ─── 그리드 배치(순수 함수 — 테스트) ───
export interface GridCell { span: 2 | 3 | 4 | 6; shape: 'video' | 'square' | 'tall' }
export interface GridLayout { cells: GridCell[]; more: number }
export const GRID_MAX = 10

/** n 장 → 6칸 격자의 칸들 + 마지막 칸 "+N"(10장 넘을 때) */
export function gridLayout(n: number): GridLayout {
  if (n <= 0) return { cells: [], more: 0 }
  const shown = Math.min(n, GRID_MAX)
  const more = n - shown
  if (shown === 1) return { cells: [{ span: 6, shape: 'video' }], more }
  if (shown === 2) return { cells: [{ span: 3, shape: 'square' }, { span: 3, shape: 'square' }], more }
  if (shown === 3) return { cells: [{ span: 4, shape: 'tall' }, { span: 2, shape: 'square' }, { span: 2, shape: 'square' }], more }
  if (shown === 4) return { cells: Array.from({ length: 4 }, () => ({ span: 3 as const, shape: 'video' as const })), more }
  // 5–10: 위 줄 = 나머지(0 이면 3), 아래는 3칸씩. 5 = 2+3 · 6 = 3+3 · 7 = 1+3+3 · 8 = 2+3+3 · 9 = 3+3+3 · 10 = 1+3+3+3
  const top = shown % 3 || 3
  const cells: GridCell[] = []
  const topCell: GridCell = top === 1 ? { span: 6, shape: 'video' } : top === 2 ? { span: 3, shape: 'video' } : { span: 2, shape: 'square' }
  for (let i = 0; i < top; i++) cells.push({ ...topCell })
  for (let i = top; i < shown; i++) cells.push({ span: 2, shape: 'square' })
  return { cells, more }
}
const SPAN_CLS: Record<GridCell['span'], string> = { 2: 'col-span-2', 3: 'col-span-3', 4: 'col-span-4 row-span-2', 6: 'col-span-6' }
const SHAPE_CLS: Record<GridCell['shape'], string> = { video: 'aspect-video', square: 'aspect-square', tall: '' }

export async function downloadAttachment(a: Pick<ViewAttachment, 'url' | 'filename'>) {
  if (!a.url) return
  if (isBundledApp() && a.url.startsWith('/api')) { await downloadApi(a.url, a.filename || 'download').catch(() => {}); return }
  const el = document.createElement('a')
  el.href = apiUrl(a.url)
  el.download = a.filename || ''
  el.target = '_blank'
  el.rel = 'noopener'
  document.body.appendChild(el)
  el.click()
  document.body.removeChild(el)
}

function fmtDur(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '0:00'
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

function fileIcon(ext: string, kind: AttachmentKind): { icon: string; cls: string } {
  if (ext === 'pdf') return { icon: 'file-pdf', cls: 'text-danger' }
  if (/^(xls|xlsx|csv|ods|jwsheet)$/.test(ext)) return { icon: 'file-sheet', cls: 'text-success' }
  if (/^(ppt|pptx|odp|key)$/.test(ext)) return { icon: 'file-slide', cls: 'text-warning' }
  if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(ext)) return { icon: 'file-zip', cls: 'text-warning' }
  if (/^(doc|docx|odt|txt|md|rtf|jwdoc)$/.test(ext)) return { icon: 'file-doc', cls: 'text-primary' }
  if (kind === 'image') return { icon: 'file-image', cls: 'text-primary' }
  return { icon: 'file', cls: 'text-muted-foreground' }
}

/** 스포일러 덮개 */
function SpoilerCover({ onReveal, className }: { onReveal: () => void; className?: string }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      aria-expanded={false}
      aria-label={t('chat.msg.att.spoilerReveal')}
      className={cn('absolute inset-0 z-[1] flex items-center justify-center bg-muted', className)}
      onClick={(e) => { e.stopPropagation(); onReveal() }}
    >
      <span className="absolute inset-0 bg-foreground/20" aria-hidden="true" />
      <span className="relative rounded-full bg-background px-3 py-1 text-[13px] font-bold tracking-wide text-foreground">{t('chat.msg.att.spoiler')}</span>
    </button>
  )
}

/** 파일 카드 — 최대 520 · radius 8 · 패딩 16 */
export function FileCard({ a }: { a: ViewAttachment }) {
  const { t } = useI18n()
  const ic = fileIcon(a.ext, a.kind)
  const size = a.size ? formatChatFileSize(a.size) : ''
  const type = a.ext ? a.ext.toUpperCase() : (a.mime.split('/').pop() || '').toUpperCase()
  return (
    <div className="flex max-w-[520px] items-center gap-3 rounded-lg border border-border bg-card p-4" data-att="file">
      <UiIcon name={ic.icon} className={cn('h-8 w-8 shrink-0', ic.cls)} />
      <div className="min-w-0 flex-1">
        <button type="button" className="block max-w-full truncate text-left text-[14px] font-medium text-primary hover:underline" title={a.filename} onClick={() => { void downloadAttachment(a) }}>{a.filename || t('chat.file.file')}</button>
        <p className="font-mono text-[11px] text-muted-foreground">{[size, type].filter(Boolean).join(' · ')}</p>
      </div>
      <button type="button" aria-label={t('chat.file.downloadNamed', { name: a.filename })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-overlay-hover hover:text-foreground" onClick={() => { void downloadAttachment(a) }}>
        <UiIcon name="download" className="h-5 w-5" />
      </button>
    </div>
  )
}

/** 영상 — 포스터(첫 장면) + 길이 꼬리표 + 아래 컨트롤 36 */
function VideoCard({ a }: { a: ViewAttachment }) {
  const { t } = useI18n()
  const ref = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState<number | null>(a.duration)
  const [muted, setMuted] = useState(false)
  const [hidden, setHidden] = useState(a.spoiler)
  function toggle() {
    const v = ref.current
    if (!v) return
    if (v.paused) { void v.play()?.catch?.(() => {}); setStarted(true) } else v.pause()
  }
  function seek(e: React.MouseEvent<HTMLSpanElement>) {
    const v = ref.current
    if (!v || !dur) return
    const r = e.currentTarget.getBoundingClientRect()
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur
  }
  return (
    <div className="relative flex aspect-video w-[550px] max-w-full flex-col justify-end overflow-hidden rounded-lg border border-border bg-muted" data-att="video">
      <video
        ref={ref}
        src={apiUrl(a.url) + '#t=0.1'}
        preload="metadata"
        muted={muted}
        playsInline
        aria-label={a.alt || a.filename}
        className="absolute inset-0 h-full w-full object-contain"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={e => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={e => { if (isFinite(e.currentTarget.duration)) setDur(e.currentTarget.duration) }}
      />
      {hidden && <SpoilerCover onReveal={() => setHidden(false)} />}
      {!playing && (
        <button type="button" aria-label={t('chat.msg.att.play')} className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white" onClick={toggle}>
          <UiIcon name="play" className="h-6 w-6" filled />
        </button>
      )}
      {!started && dur != null && <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 font-mono text-[12px] text-white">{fmtDur(dur)}</span>}
      <div className="relative flex h-9 items-center gap-2 bg-black/60 px-3 font-mono text-[12px] text-white">
        <button type="button" aria-label={playing ? t('chat.msg.att.pause') : t('chat.msg.att.play')} className="flex h-7 w-7 items-center justify-center" onClick={toggle}>
          <UiIcon name={playing ? 'pause' : 'play'} className="h-4 w-4" filled />
        </button>
        <span className="relative h-1 flex-1 cursor-pointer rounded-full bg-muted-foreground/60" role="presentation" onClick={seek}>
          <span className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: dur ? `${(cur / dur) * 100}%` : 0 }} />
        </span>
        <span>{fmtDur(cur)} / {fmtDur(dur)}</span>
        <button type="button" aria-label={muted ? t('chat.msg.att.unmute') : t('chat.msg.att.mute')} aria-pressed={muted} className="flex h-7 w-7 items-center justify-center" onClick={() => setMuted(v => !v)}>
          <UiIcon name={muted ? 'volume-x' : 'volume-2'} className="h-4 w-4" />
        </button>
        <button type="button" aria-label={t('chat.msg.att.fullscreen')} className="flex h-7 w-7 items-center justify-center" onClick={() => { void ref.current?.requestFullscreen?.()?.catch?.(() => {}) }}>
          <UiIcon name="maximize" className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/** 소리 — 카드 + 재생 줄 */
function AudioCard({ a }: { a: ViewAttachment }) {
  const { t } = useI18n()
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState<number | null>(a.duration)
  const [muted, setMuted] = useState(false)
  function toggle() {
    const v = ref.current
    if (!v) return
    if (v.paused) void v.play()?.catch?.(() => {}); else v.pause()
  }
  function seek(e: React.MouseEvent<HTMLSpanElement>) {
    const v = ref.current
    if (!v || !dur) return
    const r = e.currentTarget.getBoundingClientRect()
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur
  }
  return (
    <div className="flex max-w-[520px] flex-col gap-2 rounded-lg border border-border bg-card p-4" data-att="audio">
      <div className="flex items-center gap-3">
        <UiIcon name="music" className="h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-primary" title={a.filename}>{a.filename}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{a.size ? formatChatFileSize(a.size) : ''}</p>
        </div>
        <button type="button" aria-label={t('chat.file.downloadNamed', { name: a.filename })} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-overlay-hover hover:text-foreground" onClick={() => { void downloadAttachment(a) }}>
          <UiIcon name="download" className="h-5 w-5" />
        </button>
      </div>
      <div className="flex items-center gap-3 rounded-md bg-muted px-3 py-2 font-mono text-[12px]">
        <audio
          ref={ref}
          src={apiUrl(a.url)}
          preload="metadata"
          muted={muted}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={e => setCur(e.currentTarget.currentTime)}
          onLoadedMetadata={e => { if (isFinite(e.currentTarget.duration)) setDur(e.currentTarget.duration) }}
        />
        <button type="button" aria-label={playing ? t('chat.msg.att.pause') : t('chat.msg.att.play')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" onClick={toggle}>
          <UiIcon name={playing ? 'pause' : 'play'} className="h-3.5 w-3.5" filled />
        </button>
        <span>{fmtDur(cur)} / {fmtDur(dur)}</span>
        <span className="relative h-1 flex-1 cursor-pointer rounded-full bg-muted-foreground/40" role="presentation" onClick={seek}>
          <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: dur ? `${(cur / dur) * 100}%` : 0 }} />
        </span>
        <button type="button" aria-label={muted ? t('chat.msg.att.unmute') : t('chat.msg.att.mute')} aria-pressed={muted} className="flex h-6 w-6 items-center justify-center text-muted-foreground" onClick={() => setMuted(v => !v)}>
          <UiIcon name={muted ? 'volume-x' : 'volume-2'} className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/** 업로드 상태(COMPOSER 낙관 메시지 `_upload`) */
export type UploadInfo = NonNullable<ChatMessage['_upload']>

function UploadCard({ info, files }: { info: UploadInfo; files: ViewAttachment[] }) {
  const { t } = useI18n()
  const names = files.map(f => f.filename).join(', ') || t('chat.file.file')
  if (info.state === 'uploading') {
    const pct = Math.round(Math.max(0, Math.min(1, info.progress || 0)) * 100)
    return (
      <div className="flex max-w-[520px] items-center gap-3 rounded-lg border border-border bg-card p-4" data-att="uploading">
        <UiIcon name="upload" className="h-6 w-6 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium">{t('chat.msg.att.uploading', { name: names, pct })}</p>
          <span className="mt-1.5 block h-1.5 rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('chat.msg.att.progress')}>
            <span className="block h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
          </span>
        </div>
        <UiButton variant="ghost" size="xs" onClick={() => discardUpload(info.localId)}>{t('common.cancel')}</UiButton>
      </div>
    )
  }
  const tooLarge = info.state === 'too_large'
  const size = files[0]?.size ? formatChatFileSize(files[0].size) : ''
  return (
    <div role="alert" className="flex max-w-[520px] items-center gap-3 rounded-lg border border-danger/60 bg-danger/10 p-4" data-att={tooLarge ? 'too-large' : 'failed'}>
      <UiIcon name="alert-circle" className="h-6 w-6 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">{tooLarge ? t('chat.msg.att.tooLarge') : t('chat.msg.att.failed')}</p>
        <p className="truncate text-[13px] text-muted-foreground">
          {tooLarge
            ? t('chat.msg.att.tooLargeDesc', { name: names, size })
            : [names, info.error || t('chat.msg.att.failedDesc')].join(' · ')}
        </p>
      </div>
      {!tooLarge && <UiButton variant="outline" size="xs" onClick={() => retryUpload(info.localId)}>{t('chat.msg.att.retry')}</UiButton>}
      <button type="button" aria-label={t('chat.msg.att.discard')} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-overlay-hover" onClick={() => discardUpload(info.localId)}>
        <UiIcon name="close" className="h-4 w-4" />
      </button>
    </div>
  )
}

export interface ChatAttachmentGridProps {
  message: ChatMessage
  /** 이미지 칸을 눌렀다(이미지만 모은 목록의 index) */
  onOpenImage?: (images: ViewAttachment[], index: number) => void
  className?: string
}

/** 메시지 첨부 전부(이미지 그리드 · 영상 · 소리 · 파일 · 업로드 상태) */
export const ChatAttachmentGrid = memo(function ChatAttachmentGrid({ message, onOpenImage, className }: ChatAttachmentGridProps) {
  const { t } = useI18n()
  const autoExpand = useStore(userPrefsStore, s => s.prefs.chatMediaAutoExpand)
  const all = messageAttachments(message)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [broken, setBroken] = useState<Record<string, boolean>>({})
  if (message._upload) return <div className={cn('mt-1 flex flex-col gap-1', className)}><UploadCard info={message._upload} files={all} /></div>
  if (!all.length) return null

  const images = autoExpand ? all.filter(a => a.kind === 'image' && !broken[a.id]) : []
  const rest = all.filter(a => !images.includes(a))
  const layout = gridLayout(images.length)
  const single = images.length === 1 ? images[0] : null
  // 하나면 크기를 알 때 원래 비율(최대 550×350)
  const singleBox = single?.width && single?.height
    ? (() => { const s = Math.min(1, 550 / single.width, 350 / single.height); return { width: Math.round(single.width * s), aspectRatio: `${single.width} / ${single.height}` } })()
    : null

  return (
    <div className={cn('mt-1 flex flex-col gap-1', className)}>
      {images.length > 0 && (
        <div
          className="grid max-w-full grid-cols-6 gap-1"
          style={{ width: singleBox ? singleBox.width : 550 }}
          role="group"
          aria-label={t('chat.msg.att.images', { n: images.length })}
          data-att="grid"
          data-count={images.length}
        >
          {layout.cells.map((cell, i) => {
            const a = images[i]
            const isMore = layout.more > 0 && i === layout.cells.length - 1
            const hidden = a.spoiler && !revealed[a.id]
            return (
              <div key={a.id} className={cn('relative overflow-hidden rounded-lg bg-muted', SPAN_CLS[cell.span], singleBox ? '' : SHAPE_CLS[cell.shape])} style={singleBox ? { aspectRatio: singleBox.aspectRatio } : undefined}>
                <button
                  type="button"
                  className="block h-full w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  aria-label={t('chat.msg.att.openImage', { name: a.alt || a.filename })}
                  onClick={() => onOpenImage?.(images, i)}
                >
                  <img
                    src={apiUrl(a.thumb)}
                    alt={a.alt || a.filename}
                    loading="lazy"
                    draggable={false}
                    className={cn('h-full w-full', singleBox ? 'object-contain' : 'object-cover', hidden ? 'blur-xl' : '')}
                    onError={() => setBroken(b => ({ ...b, [a.id]: true }))}
                  />
                </button>
                {isMore && (
                  <button type="button" className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-[22px] font-bold text-white" aria-label={t('chat.msg.att.moreImages', { n: layout.more })} onClick={() => onOpenImage?.(images, i)}>+{layout.more}</button>
                )}
                {hidden && <SpoilerCover onReveal={() => setRevealed(r => ({ ...r, [a.id]: true }))} />}
              </div>
            )
          })}
        </div>
      )}
      {rest.map((a) => {
        if (a.kind === 'video' && autoExpand) return <VideoCard key={a.id} a={a} />
        if (a.kind === 'audio') return <AudioCard key={a.id} a={a} />
        if (a.spoiler && !revealed[a.id]) {
          return (
            <div key={a.id} className="relative max-w-[520px] overflow-hidden rounded-lg">
              <FileCard a={a} />
              <SpoilerCover className="rounded-lg" onReveal={() => setRevealed(r => ({ ...r, [a.id]: true }))} />
            </div>
          )
        }
        return <FileCard key={a.id} a={a} />
      })}
    </div>
  )
})

export default ChatAttachmentGrid
