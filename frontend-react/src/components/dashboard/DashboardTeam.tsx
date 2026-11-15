/**
 * 팀(시안 Dash17 team · "팀 출석" 대체): 자주 대화한 4~6명, 두 줄 행 56 = 아바타 28 + 상태 점 / 이름 · 상태 문구
 * + 호버 DM(chat 아이콘). 머리 "연락처 ›". 사람 수 = clamp(4, 상한 − 1, 6).
 * 서버: GET /api/dashboard/team (최근 30일 DM ×3 + 내가 글 쓴 채널의 그 사람 글 수, 활성 계정, 채팅 프레즌스 상태)
 * 상태는 채팅 소켓으로 바뀌는 앱 전역 값(chatStore.presences)에 그 사람이 있으면 그것을 앞세운다.
 */
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { chatStore } from '~/composables/useChat'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, useCardStatus, useDash } from './DashCard'

interface Person { id: string; username: string; display_name: string; avatar_url: string | null; state: string; emoji: string; text: string }

const DOT: Record<string, string> = { online: 'bg-success', away: 'bg-warning', dnd: 'bg-danger', offline: 'bg-muted-foreground' }

export function DashboardTeam() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const n = Math.max(4, Math.min(6, maxRows - 1))
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState(false)
  const live = useStore(chatStore, s => s.presences)

  async function load() {
    setError(false)
    try { setPeople((await $fetch<{ items: Person[] }>('/api/dashboard/team', { params: { limit: 6 } })).items || []) }
    catch { setError(true) }
  }
  useEffect(() => { void load() }, [])
  useCardStatus('team', error ? 'error' : people == null ? 'loading' : people.length ? 'ready' : 'empty')

  async function dm(p: Person) {
    try {
      const r = await $fetch<{ id: string }>('/api/chat/dm', { method: 'POST', body: { user_id: p.id } })
      void navigateTo(`/chat?channel=${encodeURIComponent(r.id)}`)
    } catch { addToast('error', t('dashboard.d17.team.dmFailed')) }
  }
  function status(p: Person): { state: string; line: string } {
    const s = live?.[p.id]
    const state = s?.state || p.state || 'offline'
    const text = (s?.text ?? p.text) || ''
    const emoji = (s?.emoji ?? p.emoji) || ''
    const label = t(`dashboard.d17.team.state.${state in DOT ? state : 'offline'}`)
    return { state, line: text ? `${emoji ? `${emoji} ` : ''}${text}` : label }
  }

  return (
    <DashCard cardKey="team" title={t('dashboard.d17.team.title')} link={{ label: t('nav.contacts'), to: '/contacts' }}>
      {error ? <UiErrorTile placement="card" title={t('dashboard.team.loadFailed')} className="m-3.5" onRetry={() => { void load() }} />
        : people == null ? <DashRowsSkeleton rows={4} />
          : (
            <DashRows>
              {people.slice(0, n).map((p) => {
                const st = status(p)
                return (
                  <DashRow
                    key={p.id}
                    avatar={(p.display_name || p.username).trim().charAt(0).toUpperCase()}
                    avatarSrc={p.avatar_url}
                    dot={DOT[st.state] ?? DOT.offline}
                    title={p.display_name || p.username}
                    meta={st.line}
                    to="/contacts"
                    iconAction={{ icon: 'chat', label: t('dashboard.d17.team.dm', { name: p.display_name || p.username }), onClick: () => { void dm(p) } }}
                  />
                )
              })}
            </DashRows>
          )}
    </DashCard>
  )
}

export default DashboardTeam
