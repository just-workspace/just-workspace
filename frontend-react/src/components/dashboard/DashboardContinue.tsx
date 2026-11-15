/**
 * 이어서 하기(기본 2칸): 탭 [최근 연 것 · 즐겨찾기 · 공유받은 것], 두 줄 행 56 =
 * 종류 아이콘 + 이름 / "종류 · 이유"("어제 편집", "○○님이 공유", "○○님이 수정", "안 읽음 3") + 오른쪽 시각.
 * 최근 파일 · 최근 위키 카드를 흡수했다(따로 두지 않음). 행 수 = 상한 − 1(시안).
 * 서버: GET /api/dashboard/continue?tab=… (파일·위키·채널·게시글을 한 목록으로, 볼 수 있는 것만)
 * 세 탭이 모두 비어야 빈 카드(맨 아래 묶음)로 간다.
 */
import { useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { useI18n } from '~/i18n'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, shortTime, useCardStatus, useDash } from './DashCard'

export type ContinueTab = 'recent' | 'favorites' | 'shared'
export interface ContinueItem {
  key: string
  kind: 'file' | 'wiki' | 'channel' | 'dm' | 'post'
  name: string
  to: string
  reason: 'opened' | 'edited' | 'edited_by_me' | 'edited_by' | 'shared_by' | 'unread' | 'starred' | 'bookmarked'
  actor?: string | null
  n?: number
  at: string | null
  path?: string
  is_dir?: boolean
}

const TABS: ContinueTab[] = ['recent', 'favorites', 'shared']

/** 파일 이름 → 종류(문서·시트는 우리 오피스 형식) · 아이콘 · 색 */
export function fileKind(name: string, isDir?: boolean): { kind: 'file' | 'doc' | 'sheet' | 'folder'; icon: string; cls: string; label: string } {
  if (isDir) return { kind: 'folder', icon: 'folder', cls: 'text-muted-foreground', label: name }
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : ''
  const base = m ? name.slice(0, -(ext.length + 1)) : name
  if (ext === 'jwdoc') return { kind: 'doc', icon: 'file-text', cls: 'text-muted-foreground', label: base }
  if (ext === 'jwsheet') return { kind: 'sheet', icon: 'file-sheet', cls: 'text-success', label: base }
  if (['doc', 'docx', 'odt', 'rtf', 'hwp', 'hwpx'].includes(ext)) return { kind: 'file', icon: 'file-doc', cls: 'text-primary', label: name }
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return { kind: 'file', icon: 'file-sheet', cls: 'text-success', label: name }
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return { kind: 'file', icon: 'file-slide', cls: 'text-warning', label: name }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'fig', 'psd', 'heic'].includes(ext)) return { kind: 'file', icon: 'file-image', cls: 'text-warning', label: name }
  if (ext === 'pdf') return { kind: 'file', icon: 'file-pdf', cls: 'text-danger', label: name }
  if (['zip', '7z', 'tar', 'gz', 'rar'].includes(ext)) return { kind: 'file', icon: 'file-zip', cls: 'text-muted-foreground', label: name }
  return { kind: 'file', icon: 'file', cls: 'text-muted-foreground', label: name }
}

export function DashboardContinue() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const limit = Math.max(3, maxRows - 1)
  const [tab, setTab] = useState<ContinueTab>('recent')
  const [data, setData] = useState<Partial<Record<ContinueTab, ContinueItem[]>>>({})
  const [error, setError] = useState(false)

  async function load() {
    setError(false)
    try {
      const all = await Promise.all(TABS.map(tb => $fetch<{ items: ContinueItem[] }>('/api/dashboard/continue', { params: { tab: tb, limit } })))
      setData(Object.fromEntries(TABS.map((tb, i) => [tb, all[i].items || []])))
    } catch { setError(true) }
  }
  useEffect(() => { void load() }, [limit]) // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = TABS.every(tb => data[tb])
  const empty = loaded && TABS.every(tb => !data[tb]!.length)
  useCardStatus('cont', error ? 'error' : !loaded ? 'loading' : empty ? 'empty' : 'ready')

  const yesterday = t('common.yesterday')
  function when(at: string | null): string {
    const s = shortTime(at, yesterday)
    return s.includes(':') ? t('common.today') : s
  }
  function reason(it: ContinueItem): string {
    switch (it.reason) {
      case 'opened': return t('dashboard.d17.cont.opened', { when: when(it.at) })
      case 'edited': return t('dashboard.d17.cont.edited', { when: when(it.at) })
      case 'edited_by_me': return t('dashboard.d17.cont.editedByMe')
      case 'edited_by': return t('dashboard.d17.cont.editedBy', { name: it.actor || '?' })
      case 'shared_by': return t('dashboard.d17.cont.sharedBy', { name: it.actor || '?' })
      case 'unread': return t('dashboard.d17.cont.unread', { n: it.n ?? 0 })
      case 'starred': return t('dashboard.d17.cont.starred')
      case 'bookmarked': return it.actor ? t('dashboard.d17.cont.bookmarkedIn', { board: it.actor }) : t('dashboard.d17.cont.bookmarked')
    }
  }
  function view(it: ContinueItem): { icon: string; cls: string; kind: string; name: string } {
    if (it.kind === 'wiki') return { icon: 'book-open', cls: 'text-muted-foreground', kind: t('nav.wiki'), name: it.name }
    if (it.kind === 'channel') return { icon: 'hash', cls: 'text-muted-foreground', kind: t('dashboard.d17.cont.channel'), name: `# ${it.name}` }
    if (it.kind === 'dm') return { icon: 'chat', cls: 'text-muted-foreground', kind: 'DM', name: it.name }
    if (it.kind === 'post') return { icon: 'clipboard-list', cls: 'text-muted-foreground', kind: t('dashboard.d17.cont.post'), name: it.name }
    const f = fileKind(it.name, it.is_dir)
    const kind = f.kind === 'doc' ? t('dashboard.d17.cont.doc') : f.kind === 'sheet' ? t('dashboard.d17.cont.sheet') : f.kind === 'folder' ? t('dashboard.d17.cont.folder') : t('nav.files')
    return { icon: f.icon, cls: f.cls, kind, name: f.label }
  }

  const rows = data[tab] ?? []
  return (
    <DashCard
      cardKey="cont"
      title={t('dashboard.d17.cont.title')}
      scope={{ label: t('dashboard.d17.scope'), value: tab, onChange: v => setTab(v as ContinueTab), items: [
        { value: 'recent', label: t('dashboard.d17.cont.recent') },
        { value: 'favorites', label: t('dashboard.d17.cont.favorites') },
        { value: 'shared', label: t('dashboard.d17.cont.shared') },
      ] }}
    >
      {error ? <UiErrorTile placement="card" title={t('dashboard.d17.cont.loadFailed')} className="m-3.5" onRetry={() => { void load() }} />
        : !loaded ? <DashRowsSkeleton rows={3} />
          : !rows.length ? <DashRows><DashRow icon="inbox" title={t(`dashboard.d17.cont.empty.${tab}`)} titleClass="text-muted-foreground" meta=" " /></DashRows>
            : (
              <DashRows>
                {rows.slice(0, limit).map((it) => {
                  const v = view(it)
                  return (
                    <DashRow key={it.key} icon={v.icon} iconClass={v.cls} title={v.name} meta={`${v.kind} · ${reason(it)}`} time={shortTime(it.at, yesterday)} to={it.to} />
                  )
                })}
              </DashRows>
            )}
    </DashCard>
  )
}

export default DashboardContinue
