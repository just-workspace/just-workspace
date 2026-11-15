/**
 * 보조 영역 작은 카드들: 최근 게시글 · 공지 · 자주 쓰는 채널 · 내 저장 공간 · 진행 중 회의 · 둘러볼 채널.
 * 모두 카드 문법(DashCard · DashRow)으로. 비면 대시보드가 맨 아래 "비어 있는 카드" 묶음으로 옮긴다.
 *
 * 데이터(권한 = 내가 볼 수 있는 것만):
 *  - 최근 게시글   GET /api/board/recent-posts?limit=n        (게시판 · 댓글 n)
 *  - 공지          GET /api/board/notices?limit=n             (필독은 warning 아이콘 + semibold) — 기본 관리자 고정
 *  - 자주 쓰는 채널 GET /api/dashboard/frequent-channels      + 채널 목록의 미읽음(오른쪽 값)
 *  - 내 저장 공간  GET /api/dashboard/storage                 (모든 사용자: 사용량 막대 + 내 파일/공유한 파일)
 *  - 진행 중 회의  GET /api/meetings/rooms → status=live      (있을 때만 카드)
 *  - 둘러볼 채널   GET /api/dashboard/discover-channels       (신규 사용자, [참여] = POST …/join)
 */
import { useCallback, useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { chatStore, fetchChannels } from '~/composables/useChat'
import { meetingJoinPath } from '~/components/meetings/prejoin'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, shortTime, useCardStatus, useDash } from './DashCard'

/** 한 번 불러오기 + 다시 시도 */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState(false)
  const load = useCallback(async () => {
    setError(false)
    try { setData(await fn()) } catch { setError(true) }
    // fn 은 카드마다 고정된 요청(deps 로 행 수만 바뀐다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { void load() }, [load])
  return { data, error, reload: () => { void load() } }
}

export function bytes(n: number) {
  if (!n) return '0 GB'
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  // 바이트·KB 는 소수점이 의미 없다("2.0 B" 대신 "2 B").
  if (i <= 1) return `${Math.round(v)} ${u[i]}`
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

// ── 최근 게시글 ──
interface PostSummary { id: string; board_id: string; board_name?: string; title: string; comment_count: number; created_at: string }
export function DashboardBoard() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const limit = Math.max(3, maxRows - 2)
  const { data: raw, error, reload } = useLoad(() => $fetch<PostSummary[]>('/api/board/recent-posts', { params: { limit } }), [limit])
  const data = raw == null ? null : Array.isArray(raw) ? raw : []
  useCardStatus('board', error ? 'error' : data == null ? 'loading' : data.length ? 'ready' : 'empty')
  return (
    <DashCard cardKey="board" title={t('dashboard.recentBoard.title')} link={{ label: t('nav.board'), to: '/board' }}>
      {error ? <UiErrorTile placement="card" title={t('dashboard.d17.board.loadFailed')} className="m-3.5" onRetry={reload} />
        : data == null ? <DashRowsSkeleton rows={3} />
          : (
            <DashRows>
              {data.slice(0, limit).map(p => (
                <DashRow
                  key={p.id}
                  icon="clipboard-list"
                  title={p.title}
                  meta={[p.board_name, p.comment_count ? t('dashboard.d17.board.comments', { n: p.comment_count }) : ''].filter(Boolean).join(' · ')}
                  time={shortTime(p.created_at, t('common.yesterday'))}
                  to={`/board/${p.board_id}/${p.id}`}
                />
              ))}
            </DashRows>
          )}
    </DashCard>
  )
}

// ── 공지 ──
interface NoticePost { id: string; board_id: string; title: string; is_must_read: boolean; created_at: string; board_name: string }
export function DashboardNotices() {
  const { t } = useI18n()
  const { data: raw, error, reload } = useLoad(() => $fetch<NoticePost[]>('/api/board/notices', { params: { limit: 3 } }))
  const data = raw == null ? null : Array.isArray(raw) ? raw : []
  useCardStatus('notice', error ? 'error' : data == null ? 'loading' : data.length ? 'ready' : 'empty')
  return (
    <DashCard cardKey="notice" title={t('common.notice')} link={{ label: t('dashboard.d17.notice.link'), to: '/board' }}>
      {error ? <UiErrorTile placement="card" title={t('dashboard.notices.loadFailed')} className="m-3.5" onRetry={reload} />
        : data == null ? <DashRowsSkeleton rows={2} twoLine={false} />
          : (
            <DashRows>
              {data.map(n => (
                <DashRow
                  key={n.id}
                  icon="bell"
                  iconClass={n.is_must_read ? 'text-warning' : undefined}
                  title={n.title}
                  titleClass={n.is_must_read ? 'font-semibold' : undefined}
                  srPrefix={n.is_must_read ? `${t('common.mustRead')}: ` : undefined}
                  time={shortTime(n.created_at, t('common.yesterday'))}
                  to={`/board/${n.board_id}/${n.id}`}
                />
              ))}
            </DashRows>
          )}
    </DashCard>
  )
}

// ── 자주 쓰는 채널 ──
interface FreqChannel { id: string; name: string; type: string; count: number }
export function DashboardFrequentChannels() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const limit = Math.max(3, maxRows - 2)
  const { data, error, reload } = useLoad(() => $fetch<{ items: FreqChannel[] }>('/api/dashboard/frequent-channels', { params: { limit } }), [limit])
  // 미읽음은 앱이 이미 가진 채널 목록(실시간 갱신)에서
  const channels = useStore(chatStore, s => s.channels)
  const items = data?.items ?? []
  useCardStatus('chans', error ? 'error' : data == null ? 'loading' : items.length ? 'ready' : 'empty')
  return (
    <DashCard cardKey="chans" title={t('dashboard.frequentChannels.title')} link={{ label: t('nav.chat'), to: '/chat' }}>
      {error ? <UiErrorTile placement="card" title={t('dashboard.frequentChannels.loadFailed')} className="m-3.5" onRetry={reload} />
        : data == null ? <DashRowsSkeleton rows={3} twoLine={false} />
          : (
            <DashRows>
              {items.map((c) => {
                const unread = channels.find(x => x.id === c.id)?.unread_count ?? 0
                return (
                  <DashRow
                    key={c.id}
                    icon="hash"
                    title={`# ${c.name}`}
                    titleClass={unread ? 'font-semibold' : undefined}
                    srPrefix={unread ? t('dashboard.unreadSr') : undefined}
                    time={unread ? String(unread) : ''}
                    timeClass="text-foreground"
                    to={`/chat?channel=${encodeURIComponent(c.id)}`}
                  />
                )
              })}
            </DashRows>
          )}
    </DashCard>
  )
}

// ── 내 저장 공간(모든 사용자) ──
interface MyStorage { used: number; quota: number; shared: number; disk_total: number }
export function DashboardStorage() {
  const { t } = useI18n()
  const { data, error, reload } = useLoad(() => $fetch<MyStorage>('/api/dashboard/storage'))
  useCardStatus('store', error ? 'error' : data == null ? 'loading' : 'ready')
  const cap = data ? (data.quota || data.disk_total) : 0
  const pct = data && cap ? Math.max(1, Math.min(100, Math.round((data.used / cap) * 100))) : 0
  return (
    <DashCard cardKey="store" title={t('dashboard.d17.store.title')} link={{ label: t('nav.files'), to: '/files' }}>
      {error ? <UiErrorTile placement="card" title={t('dashboard.d17.store.loadFailed')} className="m-3.5" onRetry={reload} />
        : data == null ? <DashRowsSkeleton rows={1} />
          : (
            <div className="flex flex-col gap-3 border-t border-border px-4 py-4 text-[13px]">
              <div className="flex items-baseline">
                <span className="flex-1 font-mono text-[15px] font-semibold">{bytes(data.used)}</span>
                <span className="font-mono text-xs text-muted-foreground">{data.quota ? `/ ${bytes(data.quota)}` : t('dashboard.d17.store.noQuota')}</span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t('dashboard.d17.store.title')}
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              ><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
              <div className="flex text-xs text-muted-foreground">
                <span className="flex-1">{t('dashboard.d17.store.mine')} <span className="font-mono">{bytes(Math.max(0, data.used - data.shared))}</span></span>
                <span>{t('dashboard.d17.store.shared')} <span className="font-mono">{bytes(data.shared)}</span></span>
              </div>
            </div>
          )}
    </DashCard>
  )
}

// ── 진행 중 회의(있을 때만) ──
interface Room { name: string; title?: string; status?: string; num_participants: number; is_host?: boolean; my_response?: string | null; share_token?: string | null }
export function DashboardLiveMeetings() {
  const { t } = useI18n()
  const { data, error, reload } = useLoad(() => $fetch<{ rooms: Room[] }>('/api/meetings/rooms'))
  const live = (data?.rooms ?? []).filter(r => (r.status ?? 'live') === 'live')
  useCardStatus('meet', error ? 'error' : data == null ? 'loading' : live.length ? 'ready' : 'empty')
  return (
    <DashCard cardKey="meet" title={t('dashboard.liveMeetings.title')} count={live.length} link={{ label: t('nav.meetings'), to: '/meetings' }}>
      {error ? <UiErrorTile placement="card" title={t('dashboard.liveMeetings.loadFailed')} className="m-3.5" onRetry={reload} />
        : data == null ? <DashRowsSkeleton rows={1} />
          : (
            <DashRows>
              {live.slice(0, 5).map(r => (
                <DashRow
                  key={r.name}
                  icon="video"
                  iconClass="text-primary"
                  title={r.title || r.name}
                  meta={t('dashboard.liveMeetings.people', { n: r.num_participants })}
                  action={{ label: t('meetings.list.join'), variant: 'default', persistent: true, onClick: () => { void navigateTo(meetingJoinPath(r) ?? `/meetings/room/${encodeURIComponent(r.name)}`) } }}
                />
              ))}
            </DashRows>
          )}
    </DashCard>
  )
}

// ── 둘러볼 채널(신규 사용자) ──
interface Discover { id: string; name: string; description: string; members: number; messages_today: number }
export function DashboardDiscover() {
  const { t } = useI18n()
  const { data, error, reload } = useLoad(() => $fetch<{ items: Discover[] }>('/api/dashboard/discover-channels', { params: { limit: 3 } }))
  const [joined, setJoined] = useState<string[]>([])
  const items = (data?.items ?? []).filter(c => !joined.includes(c.id))
  useCardStatus('discover', error ? 'error' : data == null ? 'loading' : items.length ? 'ready' : 'empty')
  async function join(c: Discover) {
    try {
      await $fetch(`/api/dashboard/discover-channels/${encodeURIComponent(c.id)}/join`, { method: 'POST' })
      setJoined(j => [...j, c.id])
      void fetchChannels()
      addToast('success', t('dashboard.d17.discover.joined', { name: c.name }))
    } catch { addToast('error', t('dashboard.d17.discover.joinFailed')) }
  }
  return (
    <DashCard cardKey="discover" title={t('dashboard.d17.discover.title')} link={{ label: t('dashboard.d17.discover.link'), to: '/chat' }}>
      {error ? <UiErrorTile placement="card" title={t('dashboard.frequentChannels.loadFailed')} className="m-3.5" onRetry={reload} />
        : data == null ? <DashRowsSkeleton rows={3} />
          : (
            <DashRows>
              {items.map(c => (
                <DashRow
                  key={c.id}
                  icon="hash"
                  title={`# ${c.name}`}
                  meta={[t('dashboard.d17.discover.members', { n: c.members }), c.messages_today ? t('dashboard.d17.discover.today', { n: c.messages_today }) : c.description].filter(Boolean).join(' · ')}
                  action={{ label: t('dashboard.d17.discover.join'), variant: 'outline', persistent: true, onClick: () => { void join(c) } }}
                />
              ))}
            </DashRows>
          )}
    </DashCard>
  )
}
