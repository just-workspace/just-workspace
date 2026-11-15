/**
 * 회의 녹화 파일 목록(최소 진입점) — 지난 회의 행 ⋮ "녹화 파일" · 회의 결과 화면 [녹화 파일].
 *  GET /api/meetings/recordings?room=<방 이름> (서버가 볼 수 있는 것만 거른다: 호스트·초대 대상·채널 멤버·관리자)
 *  행: 녹화 시각(파일 이름의 YYYYmmdd-HHMMSS) · 크기 · [내려받기](GET /api/meetings/recordings/{파일}, 쿠키 인증 링크).
 *  비었으면 안내 한 줄. 키트 UiModal(440) + 행은 목록 카드와 같은 border 행.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { apiUrl } from '~/lib/runtimeConfig'
import { formatSize } from '~/lib/files'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'

export interface MeetingRecordingItem { filename: string; size: number; mtime: number }

export interface MeetingsRecordingsModalProps {
  /** 방 이름(room_name) */
  room: string
  /** 머리 표시용 회의 제목 */
  title?: string
  onClose: () => void
}

/** 파일 이름 `<방>_<YYYYmmdd-HHMMSS>.mp4` → "2026-10-18 21:05". 모양이 다르면 수정 시각(mtime) */
export function recordingWhen(item: MeetingRecordingItem): string {
  const m = /_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}\.\w+$/.exec(item.filename)
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  const d = new Date(item.mtime * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function MeetingsRecordingsModal({ room, title, onClose }: MeetingsRecordingsModalProps) {
  const { t } = useI18n()
  const [items, setItems] = useState<MeetingRecordingItem[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    $fetch<{ recordings: MeetingRecordingItem[] }>('/api/meetings/recordings', { query: { room } })
      .then((r) => { if (alive) setItems(r.recordings || []) })
      .catch(() => { if (alive) { setError(true); setItems([]) } })
    return () => { alive = false }
  }, [room])

  return (
    <UiModal
      size="440"
      title={t('meetings.recordings.title', { name: title || room })}
      onClose={onClose}
      footer={<UiButton variant="outline" size="sm" onClick={onClose}>{t('common.close')}</UiButton>}
    >
      {items === null
        ? <UiSkeleton preset="text" rows={2} />
        : error
          ? <p role="alert" className="text-[13px] text-danger">{t('meetings.recordings.loadError')}</p>
          : items.length === 0
            ? <p className="text-[13px] leading-[1.6] text-muted-foreground">{t('meetings.recordings.empty')}</p>
            : (
              <ul role="list" className="overflow-hidden rounded-lg border border-border">
                {items.map(it => (
                  <li key={it.filename} className="flex min-h-12 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[13px] font-semibold">{recordingWhen(it)}</div>
                      <div className="truncate text-xs text-muted-foreground">{formatSize(it.size)}</div>
                    </div>
                    <a
                      href={apiUrl(`/api/meetings/recordings/${encodeURIComponent(it.filename)}`)}
                      download={it.filename}
                      aria-label={t('meetings.recordings.downloadName', { name: recordingWhen(it) })}
                      className="inline-flex h-7 shrink-0 items-center rounded-sm border border-border px-2.5 text-xs font-semibold hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >{t('meetings.recordings.download')}</a>
                  </li>
                ))}
              </ul>
            )}
    </UiModal>
  )
}

export default MeetingsRecordingsModal
