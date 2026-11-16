/**
 * 채팅 서버 설정(개요 이름·설명 · 알림 기본값) 캐시 — 사이드바 헤더 이름과 설정 화면이 공용으로 조회한다.
 * 네트워크는 chatApi22.fetchServerSettings/updateServerSettings. 서버 미지원이면(404) unsupported.
 * useChatServerName(): 이름이 비어 있으면 사이트 이름(useSiteConfig appName).
 */
import { createStore, useStore } from 'zustand'
import { useEffect } from 'react'
import { siteConfigStore } from '~/composables/useSiteConfig'
import { fetchServerSettings, updateServerSettings, type ChatServerSettings } from '~/composables/chatApi22'
import { errorStatus } from '~/lib/api'

interface ServerState {
  settings: ChatServerSettings | null
  state: 'idle' | 'loading' | 'ok' | 'unsupported' | 'error'
}
export const chatServerStore = createStore<ServerState>()(() => ({ settings: null, state: 'idle' }))

let inflight: Promise<ChatServerSettings | null> | null = null
export function loadServerSettings(force = false): Promise<ChatServerSettings | null> {
  const s = chatServerStore.getState()
  if (!force && (s.state === 'ok' || s.state === 'unsupported')) return Promise.resolve(s.settings)
  if (inflight && !force) return inflight
  chatServerStore.setState({ state: 'loading' })
  inflight = fetchServerSettings()
    .then(r => { chatServerStore.setState({ settings: r, state: 'ok' }); return r })
    .catch(e => { chatServerStore.setState({ settings: null, state: errorStatus(e) === 404 ? 'unsupported' : 'error' }); return null })
    .finally(() => { inflight = null })
  return inflight
}
export async function saveServerSettings(patch: Partial<Omit<ChatServerSettings, 'can_edit'>>) {
  const r = await updateServerSettings(patch)
  chatServerStore.setState({ settings: r, state: 'ok' })
  return r
}
export function useChatServer<T>(sel: (s: ServerState) => T): T {
  return useStore(chatServerStore, sel)
}
/** 채팅 이름(사이드바 헤더) — 서버 설정 이름, 비어 있으면 사이트 이름 */
export function useChatServerName(): string {
  const name = useStore(chatServerStore, s => s.settings?.name?.trim() || '')
  const appName = useStore(siteConfigStore, s => s.appName)
  useEffect(() => { void loadServerSettings() }, [])
  return name || appName
}
