/**
 * 회의 1회의 통계(회의 종료 화면 "'회의' · 58분 · 참가 6명" · "이번 회의").
 * 입장 시각부터 퇴장 시각까지의 분, 그동안 관측한 최대 참가자 수(본인 포함), 관측한 참가자(이름·손님 여부), 회의 채팅 수.
 * 서버 기록이 아니라 이 화면이 관측한 값이다(서버에는 참석 기록이 없다).
 * key 를 지정하면 값이 앱 수준(useSharedState)에 유지된다 — 회의 화면을 미니 창으로 전환했다가 복귀해도 통계가 이어진다.
 * 이 경우 참가자 감시는 이 함수를 호출한 화면마다 실행된다(회의 화면·미니 창 모두 호출한다).
 *
 * React: const stats = useMeetingSessionStats(() => participants.length, 'meetings-call-stats')
 *   stats.start() / stats.stop() / stats.result(값)
 *   participantCount 는 렌더마다 호출하여 값이 변경되면 최대값을 갱신한다(첫 값에는 실행되지 않음).
 *   stop() 은 leaveRoom 전에 호출한다(채팅 수는 그 시점의 회의 채팅 목록에서 집계한다).
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { getSharedState, setSharedState, useSharedState } from '~/lib/state'
import { meetingsStore } from '~/composables/useMeetings'

/** 회의에서 관측한 참가자 1명 */
export interface MeetingSessionPerson { id: string; name: string; guest: boolean }

export interface MeetingSessionResult {
  minutes: number
  participants: number
  /** 입장·퇴장 시각(epoch ms) */
  startedAt?: number
  endedAt?: number
  /** 그동안 관측한 참가자(입장 순서) */
  people?: MeetingSessionPerson[]
  /** 회의 채팅 메시지 수 */
  chats?: number
}

/** 손님(공유 링크로 승인받아 입장한 사용자) — LiveKit identity 가 guest-<신청 id> */
export const isGuestIdentity = (identity: string) => identity.startsWith('guest-')

/** 관측한 참가자 목록에 현재 참가자를 병합한다(신규 참가자만 뒤에 추가, 이름은 최신 값으로 갱신) */
export function mergeSeenPeople(
  seen: MeetingSessionPerson[],
  now: ReadonlyArray<{ identity: string; name: string }>,
): MeetingSessionPerson[] {
  const out = seen.slice()
  let changed = false
  for (const p of now) {
    const i = out.findIndex(x => x.id === p.identity)
    const name = p.name || p.identity
    if (i < 0) { out.push({ id: p.identity, name, guest: isGuestIdentity(p.identity) }); changed = true }
    else if (out[i].name !== name) { out[i] = { ...out[i], name }; changed = true }
  }
  return changed ? out : seen
}

let _localSeq = 0

export function useMeetingSessionStats(participantCount: () => number, key?: string) {
  // key 가 없으면 이 컴포넌트 전용 키 사용
  const [localKey] = useState(() => `__meeting-session-stats-${++_localSeq}`)
  const base = key ?? localKey
  const kJoined = `${base}-joined`
  const kMax = `${base}-max`
  const kResult = `${base}-result`
  const kPeople = `${base}-people`
  useSharedState<number | null>(kJoined, () => null)
  useSharedState<number>(kMax, () => 0)
  useSharedState<MeetingSessionPerson[]>(kPeople, () => [])
  const [result] = useSharedState<MeetingSessionResult | null>(kResult, () => null)

  const n = participantCount()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (getSharedState<number | null>(kJoined) !== null && n > getSharedState<number>(kMax)) setSharedState(kMax, n)
  }, [n, kJoined, kMax])

  // 관측한 참가자 — 입장해 있는 동안 참가자 변경 시마다 병합한다
  const participants = useStore(meetingsStore, s => s.participants)
  useEffect(() => {
    if (getSharedState<number | null>(kJoined) === null) return
    const prev = getSharedState<MeetingSessionPerson[]>(kPeople) ?? []
    const next = mergeSeenPeople(prev, participants)
    if (next !== prev) setSharedState(kPeople, next)
  }, [participants, kJoined, kPeople])

  // participantCount 는 렌더마다 새 함수일 수 있으므로 최신 참조를 유지한다
  const countRef = useRef(participantCount)
  useEffect(() => { countRef.current = participantCount })

  function start() {
    setSharedState<number | null>(kJoined, Date.now())
    setSharedState<number>(kMax, Math.max(1, countRef.current()))
    setSharedState<MeetingSessionPerson[]>(kPeople, mergeSeenPeople([], meetingsStore.getState().participants))
    setSharedState<MeetingSessionResult | null>(kResult, null)
  }

  /** 퇴장 시 호출한다(leaveRoom 전). 입장한 적이 없으면 null */
  function stop(): MeetingSessionResult | null {
    const joinedAt = getSharedState<number | null>(kJoined)
    if (joinedAt === null || joinedAt === undefined) return null
    const endedAt = Date.now()
    const minutes = Math.max(1, Math.round((endedAt - joinedAt) / 60000))
    const people = mergeSeenPeople(getSharedState<MeetingSessionPerson[]>(kPeople) ?? [], meetingsStore.getState().participants)
    const r: MeetingSessionResult = {
      minutes,
      participants: Math.max(1, getSharedState<number>(kMax), people.length),
      startedAt: joinedAt,
      endedAt,
      people,
      chats: meetingsStore.getState().chatMessages.length,
    }
    setSharedState<MeetingSessionResult | null>(kResult, r)
    setSharedState<number | null>(kJoined, null)
    return r
  }

  return { start, stop, result }
}
