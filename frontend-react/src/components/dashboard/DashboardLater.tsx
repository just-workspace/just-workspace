/**
 * 나중에 볼 것: 범위 [저장|스레드], 두 줄 행 56 = bookmark/threads 아이콘 + 메시지 앞부분 /
 * "#채널 · 보낸 사람"(스레드는 "· 안 읽은 답글 n") + 시각. 헤더 개수 = 저장 수(스레드 탭은 안 읽은 스레드 수), "저장 보기 ›".
 * 서버: GET /api/chat/saved · GET /api/chat/threads (모두 본인 항목만). 둘 다 비어 있으면 빈 카드.
 */
import { useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { useI18n } from '~/i18n'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, shortTime, useCardStatus, useDash } from './DashCard'

interface SavedMsg {
  id: string; channel_id: string; channel_name: string; channel_type: string; sender_name: string; content: string; created_at: string
  unread_replies?: number; last_reply?: { created_at?: string | null } | null
}

type Tab = 'saved' | 'threads'

/** 메시지 본문 한 줄(마크다운·줄바꿈 정리) */
export function oneLine(s: string): string {
  return (s || '').replace(/[`*_>#~]/g, '').replace(/\s+/g, ' ').trim()
}

export function DashboardLater() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const limit = Math.max(3, maxRows - 2)
  const [tab, setTab] = useState<Tab>('saved')
  const [saved, setSaved] = useState<SavedMsg[] | null>(null)
  const [threads, setThreads] = useState<SavedMsg[] | null>(null)
  const [error, setError] = useState(false)

  async function load() {
    setError(false)
    try {
      const [s, th] = await Promise.all([
        $fetch<{ items: SavedMsg[] }>('/api/chat/saved', { params: { limit: 20 } }),
        $fetch<{ items: SavedMsg[] }>('/api/chat/threads', { params: { limit: 20 } }),
      ])
      setSaved(s.items || [])
      setThreads(th.items || [])
    } catch { setError(true) }
  }
  useEffect(() => { void load() }, [])
  const loaded = saved != null && threads != null
  useCardStatus('later', error ? 'error' : !loaded ? 'loading' : !saved!.length && !threads!.length ? 'empty' : 'ready')

  const rows = (tab === 'saved' ? saved : threads) ?? []
  const unreadThreads = (threads ?? []).filter(x => (x.unread_replies ?? 0) > 0).length
  const where = (m: SavedMsg) => (m.channel_type === 'dm' ? 'DM' : `#${m.channel_name}`)
  return (
    <DashCard
      cardKey="later"
      title={t('dashboard.d17.later.title')}
      count={tab === 'saved' ? saved?.length : unreadThreads}
      scope={{ label: t('dashboard.d17.scope'), value: tab, onChange: v => setTab(v === 'threads' ? 'threads' : 'saved'), items: [
        { value: 'saved', label: t('dashboard.d17.later.saved') }, { value: 'threads', label: t('dashboard.d17.later.threads') },
      ] }}
      link={{ label: t('dashboard.d17.later.link'), to: `/chat?view=${tab}` }}
    >
      {error ? <UiErrorTile placement="card" title={t('dashboard.d17.later.loadFailed')} className="m-3.5" onRetry={() => { void load() }} />
        : !loaded ? <DashRowsSkeleton rows={3} />
          : !rows.length ? <DashRows><DashRow icon={tab === 'saved' ? 'bookmark' : 'threads'} title={t(tab === 'saved' ? 'dashboard.d17.later.emptySaved' : 'dashboard.d17.later.emptyThreads')} titleClass="text-muted-foreground" meta=" " /></DashRows>
            : (
              <DashRows>
                {rows.slice(0, limit).map(m => {
                  const unread = m.unread_replies ?? 0
                  return (
                    <DashRow
                      key={m.id}
                      icon={tab === 'saved' ? 'bookmark' : 'threads'}
                      title={oneLine(m.content) || t('dashboard.d17.later.attachment')}
                      titleClass={tab === 'threads' && unread ? 'font-semibold' : undefined}
                      meta={[where(m), m.sender_name, tab === 'threads' && unread ? t('dashboard.d17.later.unreadReplies', { n: unread }) : ''].filter(Boolean).join(' · ')}
                      time={shortTime(tab === 'threads' ? (m.last_reply?.created_at || m.created_at) : m.created_at, t('common.yesterday'))}
                      to={`/chat?channel=${encodeURIComponent(m.channel_id)}${tab === 'threads' ? `&thread=${encodeURIComponent(m.id)}` : ''}`}
                    />
                  )
                })}
              </DashRows>
            )}
    </DashCard>
  )
}

export default DashboardLater
